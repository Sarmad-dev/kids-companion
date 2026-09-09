import { describe, expect, it } from 'vitest';

import {
  advancePeriod,
  applyLifecycleEvent,
  effectiveStatus,
  isEntitled,
  type SubscriptionState,
} from './lifecycle.js';
import type { PlanPolicy, VerifiedWebhookEvent, WebhookEventType } from './ports.js';

/**
 * The subscription state machine.
 *
 * These are the cases that cost money when they are wrong, and every one of
 * them is unreproducible against a live vendor: you cannot ask Stripe to
 * redeliver last month's renewal during a grace window to see what happens.
 * Here it is three lines.
 */

const MONTHLY: PlanPolicy = {
  code: 'monthly',
  displayName: 'Monthly',
  tier: 'paid',
  price: { amountMinor: 49_900, currency: 'PKR' },
  billingInterval: 'month',
  trialDays: 7,
  graceDays: 7,
};

const WEEKLY_NO_GRACE: PlanPolicy = {
  ...MONTHLY,
  code: 'weekly',
  billingInterval: 'week',
  trialDays: 0,
  graceDays: 0,
};

/**
 * The fields a test actually varies.
 *
 * Narrower than `Partial<VerifiedWebhookEvent>` on purpose:
 * `exactOptionalPropertyTypes` rejects a spread of maybe-undefined values, and
 * widening the type to allow them would let a test build an event the API could
 * never produce.
 */
interface EventOverrides {
  readonly periodEnd?: string;
  readonly failureCode?: string;
  readonly reference?: string;
}

const event = (
  type: WebhookEventType,
  occurredAt: string,
  extra: EventOverrides = {},
): VerifiedWebhookEvent => ({
  rail: 'mock',
  externalEventId: `evt_${type}_${occurredAt}`,
  type,
  occurredAt: occurredAt as VerifiedWebhookEvent['occurredAt'],
  payload: {},
  ...(extra.periodEnd === undefined
    ? {}
    : { periodEnd: extra.periodEnd as VerifiedWebhookEvent['periodEnd'] }),
  ...(extra.failureCode === undefined ? {} : { failureCode: extra.failureCode }),
  ...(extra.reference === undefined ? {} : { reference: extra.reference }),
});

const activeAt = (iso: string, periodEnd: string): SubscriptionState => ({
  status: 'active',
  planCode: 'monthly',
  currentPeriodStart: iso,
  currentPeriodEnd: periodEnd,
  trialConsumed: true,
  lastEventAt: iso,
});

/* ========================================================================== */
/* Successful payment                                                         */
/* ========================================================================== */

describe('a successful payment', () => {
  it('activates a subscription that did not exist', () => {
    const outcome = applyLifecycleEvent({
      event: event('subscription.activated', '2026-03-01T10:00:00.000Z'),
      plan: MONTHLY,
    });

    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;

    expect(outcome.next.status).toBe('active');
    expect(outcome.next.planCode).toBe('monthly');
    expect(outcome.next.currentPeriodEnd).toBe('2026-04-01T10:00:00.000Z');
  });

  it('prefers the vendor’s period end over our own arithmetic', () => {
    // The rail is the authority on what it charged for. Computing our own and
    // ignoring theirs is how a subscription silently expires a day early.
    const outcome = applyLifecycleEvent({
      event: event('subscription.activated', '2026-03-01T10:00:00.000Z', {
        periodEnd: '2026-04-15T00:00:00.000Z',
      }),
      plan: MONTHLY,
    });

    expect(outcome.kind === 'applied' && outcome.next.currentPeriodEnd).toBe(
      '2026-04-15T00:00:00.000Z',
    );
  });

  it('starts a trial once, and never again', () => {
    const first = applyLifecycleEvent({
      event: event('subscription.trial_started', '2026-03-01T10:00:00.000Z'),
      plan: MONTHLY,
    });

    expect(first.kind).toBe('applied');
    if (first.kind !== 'applied') return;
    expect(first.next.status).toBe('trialing');
    expect(first.next.trialEndsAt).toBe('2026-03-08T10:00:00.000Z');
    expect(first.next.trialConsumed).toBe(true);

    // Cancel, then try to trial again. Without `trialConsumed` this is an
    // unlimited free subscription for anyone willing to click twice a week.
    const cancelled = applyLifecycleEvent({
      current: first.next,
      event: event('subscription.cancelled', '2026-03-03T10:00:00.000Z'),
      plan: MONTHLY,
    });
    expect(cancelled.kind).toBe('applied');
    if (cancelled.kind !== 'applied') return;

    const again = applyLifecycleEvent({
      current: cancelled.next,
      event: event('subscription.trial_started', '2026-03-04T10:00:00.000Z'),
      plan: MONTHLY,
    });

    expect(again).toEqual({ kind: 'ignored', reason: 'not_applicable' });
  });
});

/* ========================================================================== */
/* Renewal                                                                    */
/* ========================================================================== */

describe('a renewal', () => {
  it('rolls the period forward', () => {
    const current = activeAt('2026-03-01T10:00:00.000Z', '2026-04-01T10:00:00.000Z');

    const outcome = applyLifecycleEvent({
      current,
      event: event('subscription.renewed', '2026-04-01T10:05:00.000Z'),
      plan: MONTHLY,
    });

    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(outcome.next.status).toBe('active');
    expect(outcome.next.currentPeriodEnd).toBe('2026-05-01T10:05:00.000Z');
  });

  it('closes an open grace window', () => {
    const inGrace: SubscriptionState = {
      status: 'grace',
      planCode: 'monthly',
      currentPeriodEnd: '2026-04-01T10:00:00.000Z',
      graceEndsAt: '2026-04-08T10:00:00.000Z',
      trialConsumed: true,
      lastEventAt: '2026-04-01T10:00:00.000Z',
    };

    const outcome = applyLifecycleEvent({
      current: inGrace,
      event: event('subscription.renewed', '2026-04-03T09:00:00.000Z'),
      plan: MONTHLY,
    });

    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(outcome.next.status).toBe('active');
    expect(outcome.next.graceEndsAt).toBeUndefined();
  });

  it('keeps a monthly subscriber on their own day of the month', () => {
    // Billed on the 31st, renewed in February. Every payment vendor clamps to
    // the last day; 30-day arithmetic would drift the billing date by a day a
    // year and generate a support ticket every time.
    expect(advancePeriod('2026-01-31T00:00:00.000Z', 'month')).toBe('2026-02-28T00:00:00.000Z');
    expect(advancePeriod('2026-02-28T00:00:00.000Z', 'month')).toBe('2026-03-28T00:00:00.000Z');
  });

  it('has no next period for a one-off or the free tier', () => {
    expect(advancePeriod('2026-01-31T00:00:00.000Z', 'once')).toBeUndefined();
    expect(advancePeriod('2026-01-31T00:00:00.000Z', 'none')).toBeUndefined();
  });
});

/* ========================================================================== */
/* Failed payment and grace                                                   */
/* ========================================================================== */

describe('a failed payment', () => {
  it('opens a grace window rather than cutting a child off', () => {
    const current = activeAt('2026-03-01T10:00:00.000Z', '2026-04-01T10:00:00.000Z');

    const outcome = applyLifecycleEvent({
      current,
      event: event('payment.failed', '2026-04-01T10:05:00.000Z', { failureCode: 'card_declined' }),
      plan: MONTHLY,
    });

    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(outcome.next.status).toBe('grace');
    expect(outcome.next.graceEndsAt).toBe('2026-04-08T10:05:00.000Z');
    // Grace is entitled. The whole point is that the child keeps talking.
    expect(isEntitled(outcome.next.status)).toBe(true);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THE ONE THAT MATTERS: GRACE DOES NOT EXTEND.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Dunning retries arrive every couple of days. If each failure reset the
   * window, a card that never works would buy unlimited service — and it would
   * look like correct, sympathetic behaviour in every code review.
   */
  it('does not extend the window on a second failure', () => {
    const inGrace: SubscriptionState = {
      status: 'grace',
      planCode: 'monthly',
      currentPeriodEnd: '2026-04-01T10:00:00.000Z',
      graceEndsAt: '2026-04-08T10:00:00.000Z',
      trialConsumed: true,
      lastEventAt: '2026-04-01T10:00:00.000Z',
    };

    let state = inGrace;
    for (const day of ['2026-04-03', '2026-04-05', '2026-04-07']) {
      const outcome = applyLifecycleEvent({
        current: state,
        event: event('payment.failed', `${day}T10:00:00.000Z`),
        plan: MONTHLY,
      });
      expect(outcome.kind).toBe('applied');
      if (outcome.kind !== 'applied') return;
      state = outcome.next;
    }

    expect(state.status).toBe('grace');
    expect(state.graceEndsAt).toBe('2026-04-08T10:00:00.000Z');
  });

  it('expires immediately on a plan with no grace window', () => {
    const current: SubscriptionState = {
      status: 'active',
      planCode: 'weekly',
      currentPeriodEnd: '2026-04-08T10:00:00.000Z',
      trialConsumed: false,
      lastEventAt: '2026-04-01T10:00:00.000Z',
    };

    const outcome = applyLifecycleEvent({
      current,
      event: event('payment.failed', '2026-04-08T10:05:00.000Z'),
      plan: WEEKLY_NO_GRACE,
    });

    expect(outcome.kind === 'applied' && outcome.next.status).toBe('expired');
  });

  it('ignores a failure against a free account', () => {
    const outcome = applyLifecycleEvent({
      event: event('payment.failed', '2026-04-01T10:00:00.000Z'),
      plan: MONTHLY,
    });

    expect(outcome).toEqual({ kind: 'ignored', reason: 'not_applicable' });
  });
});

/* ========================================================================== */
/* Cancellation and resume                                                    */
/* ========================================================================== */

describe('cancellation', () => {
  it('lets the paid period run out instead of revoking on the spot', () => {
    const current = activeAt('2026-03-01T10:00:00.000Z', '2026-04-01T10:00:00.000Z');

    const outcome = applyLifecycleEvent({
      current,
      event: event('subscription.cancelled', '2026-03-02T12:00:00.000Z'),
      plan: MONTHLY,
    });

    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(outcome.next.status).toBe('cancelled');
    expect(outcome.next.cancelAt).toBe('2026-04-01T10:00:00.000Z');
    expect(outcome.next.cancelledAt).toBe('2026-03-02T12:00:00.000Z');

    // Still entitled on the day after cancelling — they paid for the month.
    expect(effectiveStatus(outcome.next, '2026-03-03T00:00:00.000Z')).toBe('cancelled');
    expect(isEntitled(effectiveStatus(outcome.next, '2026-03-03T00:00:00.000Z'))).toBe(true);

    // And not, once the month is over.
    expect(effectiveStatus(outcome.next, '2026-04-02T00:00:00.000Z')).toBe('expired');
    expect(isEntitled(effectiveStatus(outcome.next, '2026-04-02T00:00:00.000Z'))).toBe(false);
  });

  it('ends immediately when cancelled during grace', () => {
    // Nothing has been paid for the current window, so there is nothing to run
    // out. Granting a further week here would be paying the parent to leave.
    const inGrace: SubscriptionState = {
      status: 'grace',
      planCode: 'monthly',
      currentPeriodEnd: '2026-04-01T10:00:00.000Z',
      graceEndsAt: '2026-04-08T10:00:00.000Z',
      trialConsumed: true,
      lastEventAt: '2026-04-01T10:00:00.000Z',
    };

    const outcome = applyLifecycleEvent({
      current: inGrace,
      event: event('subscription.cancelled', '2026-04-04T10:00:00.000Z'),
      plan: MONTHLY,
    });

    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(outcome.next.cancelAt).toBe('2026-04-04T10:00:00.000Z');
    expect(effectiveStatus(outcome.next, '2026-04-05T00:00:00.000Z')).toBe('expired');
  });

  it('is idempotent', () => {
    const current = activeAt('2026-03-01T10:00:00.000Z', '2026-04-01T10:00:00.000Z');
    const first = applyLifecycleEvent({
      current,
      event: event('subscription.cancelled', '2026-03-02T12:00:00.000Z'),
      plan: MONTHLY,
    });
    if (first.kind !== 'applied') throw new Error('expected applied');

    const second = applyLifecycleEvent({
      current: first.next,
      event: event('subscription.cancelled', '2026-03-02T13:00:00.000Z'),
      plan: MONTHLY,
    });

    expect(second).toEqual({ kind: 'ignored', reason: 'duplicate_state' });
  });
});

describe('resume', () => {
  it('reverses a cancellation that has not taken effect', () => {
    const cancelled: SubscriptionState = {
      status: 'cancelled',
      planCode: 'monthly',
      currentPeriodEnd: '2026-04-01T10:00:00.000Z',
      cancelAt: '2026-04-01T10:00:00.000Z',
      cancelledAt: '2026-03-02T12:00:00.000Z',
      trialConsumed: true,
      lastEventAt: '2026-03-02T12:00:00.000Z',
    };

    const outcome = applyLifecycleEvent({
      current: cancelled,
      event: event('subscription.resumed', '2026-03-05T09:00:00.000Z'),
      plan: MONTHLY,
    });

    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(outcome.next.status).toBe('active');
    expect(outcome.next.cancelAt).toBeUndefined();
    expect(outcome.next.cancelledAt).toBeUndefined();
  });

  it('refuses to resurrect a period that has already ended', () => {
    // The honest answer past the end date is a new checkout. Resuming would
    // grant a month nobody paid for.
    const cancelled: SubscriptionState = {
      status: 'cancelled',
      planCode: 'monthly',
      currentPeriodEnd: '2026-04-01T10:00:00.000Z',
      cancelAt: '2026-04-01T10:00:00.000Z',
      cancelledAt: '2026-03-02T12:00:00.000Z',
      trialConsumed: true,
      lastEventAt: '2026-03-02T12:00:00.000Z',
    };

    const outcome = applyLifecycleEvent({
      current: cancelled,
      event: event('subscription.resumed', '2026-04-09T09:00:00.000Z'),
      plan: MONTHLY,
    });

    expect(outcome).toEqual({ kind: 'ignored', reason: 'not_applicable' });
  });
});

/* ========================================================================== */
/* Expiry and refunds                                                         */
/* ========================================================================== */

describe('expiry', () => {
  it('applies a deadline the moment it passes, with no sweep involved', () => {
    // The window between a deadline and the job that notices it is exactly
    // where a free subscription would hide.
    const inGrace: SubscriptionState = {
      status: 'grace',
      planCode: 'monthly',
      graceEndsAt: '2026-04-08T10:00:00.000Z',
      currentPeriodEnd: '2026-04-01T10:00:00.000Z',
      trialConsumed: true,
    };

    expect(effectiveStatus(inGrace, '2026-04-08T09:59:59.000Z')).toBe('grace');
    expect(effectiveStatus(inGrace, '2026-04-08T10:00:01.000Z')).toBe('expired');
  });

  it('ends entitlement when money goes back', () => {
    const current = activeAt('2026-03-01T10:00:00.000Z', '2026-04-01T10:00:00.000Z');

    const outcome = applyLifecycleEvent({
      current,
      event: event('payment.refunded', '2026-03-10T10:00:00.000Z'),
      plan: MONTHLY,
    });

    expect(outcome.kind).toBe('applied');
    if (outcome.kind !== 'applied') return;
    expect(outcome.next.status).toBe('expired');
    expect(outcome.next.currentPeriodEnd).toBe('2026-03-10T10:00:00.000Z');
  });
});

/* ========================================================================== */
/* Replay                                                                     */
/* ========================================================================== */

describe('replay and ordering', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * A REPLAYED EVENT IS A GENUINE EVENT.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Its signature verifies, because it really was sent by the rail. The only
   * thing wrong with it is that it already happened. Signature verification
   * cannot catch this; ordering can.
   */
  it('ignores an event older than the one already applied', () => {
    const current = activeAt('2026-04-01T10:00:00.000Z', '2026-05-01T10:00:00.000Z');

    const replayed = applyLifecycleEvent({
      current,
      event: event('subscription.renewed', '2026-03-01T10:00:00.000Z'),
      plan: MONTHLY,
    });

    expect(replayed).toEqual({ kind: 'ignored', reason: 'stale_event' });
  });

  it('ignores an event with the same timestamp as the last applied one', () => {
    const current = activeAt('2026-04-01T10:00:00.000Z', '2026-05-01T10:00:00.000Z');

    const same = applyLifecycleEvent({
      current,
      event: event('subscription.renewed', '2026-04-01T10:00:00.000Z'),
      plan: MONTHLY,
    });

    expect(same).toEqual({ kind: 'ignored', reason: 'stale_event' });
  });

  it('does not let a replayed renewal extend a cancelled subscription', () => {
    const cancelled: SubscriptionState = {
      status: 'cancelled',
      planCode: 'monthly',
      currentPeriodEnd: '2026-04-01T10:00:00.000Z',
      cancelAt: '2026-04-01T10:00:00.000Z',
      cancelledAt: '2026-03-15T12:00:00.000Z',
      trialConsumed: true,
      lastEventAt: '2026-03-15T12:00:00.000Z',
    };

    // The renewal that was legitimately processed on 1 March, replayed after
    // the cancellation. This is the attack the ordering check exists for.
    const outcome = applyLifecycleEvent({
      current: cancelled,
      event: event('subscription.renewed', '2026-03-01T10:00:00.000Z'),
      plan: MONTHLY,
    });

    expect(outcome).toEqual({ kind: 'ignored', reason: 'stale_event' });
  });
});

/* ========================================================================== */
/* The free tier                                                              */
/* ========================================================================== */

describe('the free tier', () => {
  it('is what an account with no subscription is', () => {
    expect(isEntitled('free')).toBe(false);
    expect(
      effectiveStatus(
        { status: 'free', trialConsumed: false } as SubscriptionState,
        '2026-04-01T00:00:00.000Z',
      ),
    ).toBe('free');
  });

  it('is unaffected by a cancellation or an expiry event', () => {
    for (const type of ['subscription.cancelled', 'subscription.expired'] as const) {
      expect(
        applyLifecycleEvent({ event: event(type, '2026-04-01T10:00:00.000Z'), plan: MONTHLY }),
      ).toEqual({ kind: 'ignored', reason: 'not_applicable' });
    }
  });
});
