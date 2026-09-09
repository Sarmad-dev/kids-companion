import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  Card,
  ErrorBanner,
  ErrorState,
  InfoBanner,
  PageHeader,
  Pill,
  SuccessBanner,
  WarningBanner,
} from '../../../components/ui';
import {
  cancelSubscription,
  getPlans,
  getSubscriptionStatus,
  resumeSubscription,
} from '../../../lib/api';
import { count, longDate } from '../../../lib/format';

export const dynamic = 'force-dynamic';

/**
 * Subscription.
 *
 * A statement of what the account is on, and two buttons. Not a checkout —
 * payment happens through the app store or wallet a parent signed up with, and
 * this page says so rather than collecting a card. The rails available in
 * Pakistan are still open (Q-02), and a web form taking card details would put
 * this application in PCI scope it has been carefully designed to stay out of.
 *
 * There is no card number here because there is no card number stored anywhere.
 * `subscriptions` holds an opaque vendor token, a brand, and four digits.
 *
 * ONE THING WORTH NOTICING: this page renders `status.explanation`, written by
 * the API, rather than deriving its own sentence from the status code. The
 * mobile app and a support agent reading the API see the same words, which is
 * what stops "past due" meaning three different things in three places.
 */

const money = (minor: number, currency: string): string => {
  if (minor === 0) return 'Free';
  const major = (minor / 100).toFixed(2).replace(/\.00$/, '');
  return `${currency} ${major}`;
};

const INTERVAL_WORD: Record<string, string> = {
  week: 'a week',
  month: 'a month',
  year: 'a year',
};

const STATUS_LABEL: Record<string, string> = {
  free: 'Free plan',
  trialing: 'Free trial',
  active: 'Active',
  grace: 'Payment needs attention',
  past_due: 'Payment outstanding',
  cancelled: 'Cancelled',
  expired: 'Ended',
};

const ERRORS: Record<string, string> = {
  cancel: 'We could not cancel your plan just now. Nothing has changed — please try again.',
  resume: 'We could not restart your plan just now. Nothing has changed — please try again.',
};

export default async function SubscriptionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const [status, plans] = await Promise.all([getSubscriptionStatus(), getPlans()]);

  if (status.state !== 'ok') {
    return (
      <>
        <PageHeader title="Subscription" />
        <ErrorState message={status.state === 'error' ? status.message : 'Please sign in again.'} />
      </>
    );
  }

  const data = status.data;
  const catalogue = plans.state === 'ok' ? plans.data.items : [];
  const saved = typeof params.saved === 'string' ? params.saved : undefined;
  const failure = typeof params.error === 'string' ? ERRORS[params.error] : undefined;

  const cancel = async (): Promise<void> => {
    'use server';

    const result = await cancelSubscription();
    if (result.state !== 'ok') redirect('/subscription?error=cancel');

    revalidatePath('/subscription');
    revalidatePath('/dashboard');
    redirect('/subscription?saved=cancelled');
  };

  const resume = async (): Promise<void> => {
    'use server';

    const result = await resumeSubscription();
    if (result.state !== 'ok') redirect('/subscription?error=resume');

    revalidatePath('/subscription');
    revalidatePath('/dashboard');
    redirect('/subscription?saved=resumed');
  };

  const { plan, limits } = { plan: data.plan, limits: data.plan.limits };

  return (
    <>
      <PageHeader
        title="Subscription"
        description="What your account is on today, and what it allows."
      />

      {saved === 'cancelled' && (
        <SuccessBanner>
          Your plan will not renew. Everything keeps working until{' '}
          {data.currentPeriodEnd === null
            ? 'the end of your paid period'
            : longDate(data.currentPeriodEnd)}
          .
        </SuccessBanner>
      )}
      {saved === 'resumed' && <SuccessBanner>Your plan is active again.</SuccessBanner>}
      {failure !== undefined && <ErrorBanner>{failure}</ErrorBanner>}

      {data.status === 'grace' && (
        <WarningBanner>
          {data.explanation}
          {data.graceEndsAt !== null && ` You have until ${longDate(data.graceEndsAt)}.`}
        </WarningBanner>
      )}

      <div className="stack">
        <Card title="Your plan">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <p className="stat-value" style={{ fontSize: '1.6rem' }}>
                {plan.displayName}
              </p>
              <p className="small muted">{plan.description}</p>
            </div>
            <Pill tone={data.entitled && plan.tier === 'paid' ? 'active' : 'neutral'}>
              {STATUS_LABEL[data.status] ?? data.status}
            </Pill>
          </div>

          <dl className="stack" style={{ marginTop: 'var(--space-4)', gap: 'var(--space-2)' }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <dt className="small muted">Price</dt>
              <dd className="small" style={{ margin: 0 }}>
                {money(plan.priceMinor, plan.currency)}
                {plan.priceMinor > 0 ? ` ${INTERVAL_WORD[plan.billingInterval] ?? ''}` : ''}
              </dd>
            </div>

            {data.trialEndsAt !== null && data.status === 'trialing' && (
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <dt className="small muted">Trial ends</dt>
                <dd className="small" style={{ margin: 0 }}>
                  {longDate(data.trialEndsAt)}
                </dd>
              </div>
            )}

            {data.currentPeriodEnd !== null && (
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <dt className="small muted">
                  {data.status === 'cancelled' ? 'Access until' : 'Renews'}
                </dt>
                <dd className="small" style={{ margin: 0 }}>
                  {longDate(data.currentPeriodEnd)}
                </dd>
              </div>
            )}

            {data.paymentMethod.last4 !== null && (
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <dt className="small muted">Paid with</dt>
                <dd className="small" style={{ margin: 0 }}>
                  {`${data.paymentMethod.brand ?? 'card'} ending ${data.paymentMethod.last4}`}
                </dd>
              </div>
            )}
          </dl>

          <p className="stat-explain">{data.explanation}</p>
          <p className="stat-caveat">
            We never see or store your full card number. Our payment provider holds it and gives us
            a token, a brand, and the last four digits — enough for you to recognise which card, and
            nothing more.
          </p>

          {plan.tier === 'paid' && data.status !== 'expired' && (
            <div className="row" style={{ marginTop: 'var(--space-4)' }}>
              {data.status === 'cancelled' ? (
                <form action={resume}>
                  <button className="button" type="submit">
                    Restart my plan
                  </button>
                </form>
              ) : (
                <form action={cancel}>
                  <button className="button button-secondary" type="submit">
                    Cancel my plan
                  </button>
                </form>
              )}
            </div>
          )}
        </Card>

        <Card title="What this plan allows">
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Plan limits</caption>
              <thead>
                <tr>
                  <th scope="col">Limit</th>
                  <th scope="col">On your plan</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Child profiles</th>
                  <td>
                    {`${String(data.childProfilesUsed)} of ${String(limits.childProfileLimit)} used`}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Messages a day</th>
                  <td>{count(limits.dailyTurnLimit, 'message')}</td>
                </tr>
                <tr>
                  <th scope="row">Minutes a day</th>
                  <td>
                    {limits.dailyMinuteLimit === 0
                      ? 'No limit from the plan'
                      : count(limits.dailyMinuteLimit, 'minute')}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Messages in one chat</th>
                  <td>{count(limits.maxConversationTurns, 'message')}</td>
                </tr>
                <tr>
                  <th scope="row">Talking out loud</th>
                  <td>
                    {limits.voiceEnabled
                      ? `${count(limits.dailyVoiceTurnLimit, 'voice message')} a day`
                      : 'Not on this plan'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="stat-caveat">
            Your own daily time limit sits on top of these and can only make them smaller. If you
            set 20 minutes a day, 20 minutes is what applies.
          </p>
        </Card>

        {catalogue.length > 1 && (
          <Card title="All plans">
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Available plans</caption>
                <thead>
                  <tr>
                    <th scope="col">Plan</th>
                    <th scope="col">Price</th>
                    <th scope="col">Children</th>
                    <th scope="col">Minutes a day</th>
                    <th scope="col">Free trial</th>
                  </tr>
                </thead>
                <tbody>
                  {catalogue.map((option) => (
                    <tr key={option.code}>
                      <th scope="row">
                        {option.displayName}
                        {option.code === plan.code && (
                          <>
                            {' '}
                            <Pill tone="active">Your plan</Pill>
                          </>
                        )}
                      </th>
                      <td>{money(option.priceMinor, option.currency)}</td>
                      <td>{String(option.limits.childProfileLimit)}</td>
                      <td>
                        {option.limits.dailyMinuteLimit === 0
                          ? 'No limit'
                          : String(option.limits.dailyMinuteLimit)}
                      </td>
                      <td>
                        {option.trialDays === 0
                          ? '—'
                          : data.trialAvailable
                            ? count(option.trialDays, 'day')
                            : 'Already used'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <InfoBanner>
              To change plan, use the app store or payment provider you signed up with. We do not
              take card details on this page.
            </InfoBanner>
          </Card>
        )}

        <Card title="If a payment fails">
          <p className="small">
            Nothing switches off on the day a card is declined. Every paid plan has a grace period —{' '}
            {plan.graceDays === 0 ? 'set per plan' : count(plan.graceDays, 'day')} on yours — during
            which your family keeps full access while you sort the payment out.
          </p>
          <p className="stat-caveat">
            We do this because the person who loses access is a child who had nothing to do with the
            card. Conversations, progress, and profiles are never deleted for non-payment.
          </p>
        </Card>
      </div>
    </>
  );
}
