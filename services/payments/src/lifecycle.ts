import type {
  BillingInterval,
  PlanPolicy,
  SubscriptionStatus,
  VerifiedWebhookEvent,
} from './ports.js';

/**
 * The subscription state machine.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. NO DATABASE, NO CLOCK, NO NETWORK.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every transition in this product is decided here, by a function that takes
 * the current state and one verified event and returns the next state. That is
 * not architectural neatness for its own sake: billing bugs are expensive,
 * rare, and almost impossible to reproduce against a live vendor, and this is
 * the only shape in which "what happens if a renewal lands during a grace
 * window after a cancellation?" is a unit test rather than an incident.
 *
 * The rules that are easy to get wrong, stated once:
 *
 *   * **Grace does not extend.** A second failure during a grace window keeps
 *     the original deadline. Refreshing it on every dunning retry is a free
 *     subscription for anyone whose card keeps declining.
 *   * **A trial is once per account.** `trialConsumed` survives cancellation,
 *     so cancel-and-resubscribe is not an unlimited free trial.
 *   * **Stale events change nothing.** An event older than the newest applied
 *     one is ignored — not rejected, ignored and recorded. A correctly signed
 *     `payment.succeeded` from last month is still correctly signed.
 *   * **Cancelling does not revoke.** A parent who cancels on day 2 of a month
 *     they paid for keeps it until day 30. Taking it away immediately is theft
 *     of a purchased period, and it is also how you generate refund requests.
 */

export interface SubscriptionState {
  readonly status: SubscriptionStatus;
  readonly planCode: string;
  readonly currentPeriodStart?: string | undefined;
  readonly currentPeriodEnd?: string | undefined;
  readonly trialEndsAt?: string | undefined;
  readonly graceEndsAt?: string | undefined;
  readonly cancelAt?: string | undefined;
  readonly cancelledAt?: string | undefined;
  readonly trialConsumed: boolean;
  /** `occurred_at` of the newest event already applied. */
  readonly lastEventAt?: string | undefined;
}

export type LifecycleOutcome =
  | { readonly kind: 'applied'; readonly next: SubscriptionState; readonly reason: string }
  | { readonly kind: 'ignored'; readonly reason: IgnoredReason };

export type IgnoredReason = 'stale_event' | 'duplicate_state' | 'not_applicable' | 'unknown_event';

export interface LifecycleInput {
  /** Absent for a first subscription — the account is on the free tier. */
  readonly current?: SubscriptionState | undefined;
  readonly event: VerifiedWebhookEvent;
  readonly plan: PlanPolicy;
}

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

const DAY_MS = 86_400_000;

/**
 * Advances a date by one billing interval.
 *
 * Calendar months, not 30 days: a parent billed on the 31st of January renews
 * on the 28th of February, which is what every payment vendor does and what
 * every parent expects. `setUTCMonth` clamps for us.
 */
export const advancePeriod = (fromIso: string, interval: BillingInterval): string | undefined => {
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) return undefined;

  const next = new Date(from.getTime());
  switch (interval) {
    case 'week':
      next.setUTCDate(next.getUTCDate() + 7);
      break;
    case 'month': {
      const day = next.getUTCDate();
      next.setUTCDate(1);
      next.setUTCMonth(next.getUTCMonth() + 1);
      const lastDay = new Date(
        Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
      ).getUTCDate();
      next.setUTCDate(Math.min(day, lastDay));
      break;
    }
    case 'year':
      next.setUTCFullYear(next.getUTCFullYear() + 1);
      break;
    case 'once':
    case 'none':
      // A one-off purchase and the free tier have no next period. Returning
      // undefined rather than a far-future date keeps "does this renew?"
      // answerable from the data.
      return undefined;
  }
  return next.toISOString();
};

const addDays = (fromIso: string, days: number): string =>
  new Date(new Date(fromIso).getTime() + days * DAY_MS).toISOString();

/** Strictly newer. Equal timestamps are treated as the same event arriving twice. */
const isNewer = (candidate: string, existing: string | undefined): boolean => {
  if (existing === undefined) return true;
  const a = new Date(candidate).getTime();
  const b = new Date(existing).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return a > b;
};

/* -------------------------------------------------------------------------- */
/* The machine                                                                 */
/* -------------------------------------------------------------------------- */

const FREE_STATE = (planCode: string): SubscriptionState => ({
  status: 'free',
  planCode,
  trialConsumed: false,
});

export const applyLifecycleEvent = (input: LifecycleInput): LifecycleOutcome => {
  const { event, plan } = input;
  const current = input.current ?? FREE_STATE(plan.code);
  const at = event.occurredAt;

  /* ---------------------------------------------------------------------- */
  /* Ordering                                                                */
  /* ---------------------------------------------------------------------- */
  /* Checked before anything else, and by the VENDOR's timestamp. This is what
   * makes a captured-and-replayed event inert even though its signature is
   * genuine: it is a real message that has already had its effect.
   *
   * A vendor that reuses a timestamp across two distinct events would lose the
   * second, so this is deliberately `>` on a strict compare — duplicates are
   * already handled upstream by the unique index on the event id, and the two
   * defences are meant to overlap. */
  if (!isNewer(at, current.lastEventAt)) {
    return { kind: 'ignored', reason: 'stale_event' };
  }

  const applied = (
    next: Omit<SubscriptionState, 'lastEventAt'>,
    reason: string,
  ): LifecycleOutcome => ({
    kind: 'applied',
    next: { ...next, lastEventAt: at },
    reason,
  });

  switch (event.type) {
    /* -------------------------------------------------------------------- */
    case 'subscription.trial_started': {
      // A trial the account has already had is not a trial. Rails do not know
      // our history, so this is checked here rather than trusted from them.
      if (current.trialConsumed) return { kind: 'ignored', reason: 'not_applicable' };
      if (plan.trialDays <= 0) return { kind: 'ignored', reason: 'not_applicable' };

      const trialEndsAt = addDays(at, plan.trialDays);
      return applied(
        {
          status: 'trialing',
          planCode: plan.code,
          currentPeriodStart: at,
          currentPeriodEnd: trialEndsAt,
          trialEndsAt,
          trialConsumed: true,
        },
        `trial of ${String(plan.trialDays)} days started`,
      );
    }

    /* -------------------------------------------------------------------- */
    case 'subscription.activated':
    case 'subscription.renewed': {
      // The vendor's period end wins when it sends one — it is the authority on
      // what it charged for. Ours is the fallback, computed from the plan.
      const periodEnd = event.periodEnd ?? advancePeriod(at, plan.billingInterval);

      return applied(
        {
          status: 'active',
          planCode: plan.code,
          currentPeriodStart: at,
          currentPeriodEnd: periodEnd,
          trialEndsAt: current.trialEndsAt,
          // A successful payment closes any grace window, and clears a pending
          // cancellation only if the parent has since resumed — a cancelled
          // subscription that renews once more keeps its end date.
          graceEndsAt: undefined,
          cancelAt: current.cancelAt,
          cancelledAt: current.cancelledAt,
          trialConsumed: current.trialConsumed || plan.trialDays > 0,
        },
        event.type === 'subscription.renewed' ? 'renewal cleared' : 'first payment cleared',
      );
    }

    /* -------------------------------------------------------------------- */
    case 'payment.failed': {
      // Already in grace: the deadline does NOT move. Dunning retries arrive
      // every couple of days, and extending on each one would mean a card that
      // never works buys unlimited service.
      if (current.status === 'grace') {
        return applied(
          { ...current, status: 'grace' },
          'further failure during grace — deadline unchanged',
        );
      }

      // Nothing to lose. A failure against a free or already-dead subscription
      // is a vendor talking about something we do not have.
      if (current.status === 'free' || current.status === 'expired') {
        return { kind: 'ignored', reason: 'not_applicable' };
      }

      // No grace on this plan: the failure ends it now. Weekly plans in
      // particular cannot carry a long window without the next charge falling
      // due inside it.
      if (plan.graceDays <= 0) {
        return applied(
          {
            ...current,
            status: 'expired',
            graceEndsAt: undefined,
            currentPeriodEnd: at,
          },
          'payment failed with no grace window on this plan',
        );
      }

      return applied(
        {
          ...current,
          status: 'grace',
          graceEndsAt: addDays(at, plan.graceDays),
        },
        `payment failed — ${String(plan.graceDays)} day grace window opened`,
      );
    }

    /* -------------------------------------------------------------------- */
    case 'subscription.cancelled': {
      if (current.status === 'cancelled' || current.status === 'expired') {
        return { kind: 'ignored', reason: 'duplicate_state' };
      }
      if (current.status === 'free') return { kind: 'ignored', reason: 'not_applicable' };

      // Access runs to the end of the period already paid for. A parent who
      // cancels on day 2 of a month they bought keeps it until day 30 — taking
      // it back is theft of a purchased period, and it generates exactly the
      // refund request it was trying to avoid.
      //
      // A cancellation during grace is the exception: nothing has been paid for
      // the current window, so there is nothing to run out.
      const endsAt = current.status === 'grace' ? at : (current.currentPeriodEnd ?? at);

      return applied(
        {
          ...current,
          status: 'cancelled',
          cancelAt: endsAt,
          cancelledAt: at,
          currentPeriodEnd: endsAt,
          graceEndsAt: undefined,
        },
        'cancelled — access continues to the end of the paid period',
      );
    }

    /* -------------------------------------------------------------------- */
    case 'subscription.resumed': {
      // Only a cancellation that has not yet taken effect can be reversed.
      // Past its end date there is nothing to resume, and the honest answer is
      // a new checkout rather than a resurrection.
      if (current.status !== 'cancelled') return { kind: 'ignored', reason: 'not_applicable' };
      if (current.currentPeriodEnd !== undefined && !isNewer(current.currentPeriodEnd, at)) {
        return { kind: 'ignored', reason: 'not_applicable' };
      }

      return applied(
        {
          ...current,
          status: 'active',
          cancelAt: undefined,
          cancelledAt: undefined,
        },
        'cancellation reversed before it took effect',
      );
    }

    /* -------------------------------------------------------------------- */
    case 'subscription.expired': {
      if (current.status === 'expired') return { kind: 'ignored', reason: 'duplicate_state' };
      if (current.status === 'free') return { kind: 'ignored', reason: 'not_applicable' };

      return applied(
        {
          ...current,
          status: 'expired',
          currentPeriodEnd: current.currentPeriodEnd ?? at,
          graceEndsAt: undefined,
        },
        'expired',
      );
    }

    /* -------------------------------------------------------------------- */
    case 'payment.refunded': {
      // Money went back, so entitlement goes back with it. Immediate rather
      // than at period end: the parent has not paid for the period they are in.
      if (current.status === 'free' || current.status === 'expired') {
        return { kind: 'ignored', reason: 'not_applicable' };
      }

      return applied(
        {
          ...current,
          status: 'expired',
          currentPeriodEnd: at,
          graceEndsAt: undefined,
        },
        'refunded — entitlement ends with the money',
      );
    }
  }
};

/* -------------------------------------------------------------------------- */
/* Deadlines that pass without an event                                        */
/* -------------------------------------------------------------------------- */

/**
 * The state a subscription is actually in, given the time.
 *
 * A grace window closes whether or not a vendor tells us. A trial ends whether
 * or not a sweep has run. Between the deadline and the job that notices it lies
 * a window in which a stored status is a lie, and every entitlement check in
 * this system resolves through this function — and through the matching SQL in
 * `app.subscription_state` — so that window is never a free subscription.
 */
export const effectiveStatus = (
  state: Pick<SubscriptionState, 'status' | 'graceEndsAt' | 'trialEndsAt' | 'currentPeriodEnd'>,
  nowIso: string,
): SubscriptionStatus => {
  const now = new Date(nowIso).getTime();
  const past = (iso: string | undefined): boolean => {
    if (iso === undefined) return false;
    const time = new Date(iso).getTime();
    return !Number.isNaN(time) && time <= now;
  };

  switch (state.status) {
    case 'grace':
      return past(state.graceEndsAt) ? 'expired' : 'grace';
    case 'trialing':
      return past(state.trialEndsAt) || past(state.currentPeriodEnd) ? 'expired' : 'trialing';
    case 'active':
      return past(state.currentPeriodEnd) ? 'expired' : 'active';
    case 'cancelled':
      // A cancelled subscription still runs to the end of what was paid for.
      return state.currentPeriodEnd === undefined || past(state.currentPeriodEnd)
        ? 'expired'
        : 'cancelled';
    case 'free':
    case 'past_due':
    case 'expired':
      return state.status;
  }
};

/**
 * Whether a child may talk, given the RESOLVED state.
 *
 * Takes a status that has already been through `effectiveStatus`. `cancelled`
 * is entitled because the period was paid for; once it runs out the resolved
 * status is `expired` and this returns false.
 */
export const isEntitled = (status: SubscriptionStatus): boolean =>
  status === 'trialing' ||
  status === 'active' ||
  status === 'grace' ||
  status === 'past_due' ||
  status === 'cancelled';
