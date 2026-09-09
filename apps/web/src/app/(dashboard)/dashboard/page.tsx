import Link from 'next/link';

import { BarChart, LevelMeter } from '../../../components/charts';
import {
  Card,
  EmptyState,
  ErrorState,
  MetricCard,
  PageHeader,
  Pill,
  WarningBanner,
} from '../../../components/ui';
import { getChildren, getDashboard, getProgress } from '../../../lib/api';
import { count, longDate, minutes, scoreBand } from '../../../lib/format';

export const dynamic = 'force-dynamic';

/**
 * The dashboard.
 *
 * Seven cards, all of them things we can actually observe, each carrying what it
 * is and what it is not. The temptation is to add a "learning score" or a
 * "readiness index" — parents are the buyers and a dense dashboard looks like
 * value — and every one of those would imply something this product cannot
 * support (Q-12).
 *
 * All four states are here: loading is the Suspense fallback in `loading.tsx`,
 * empty is a new account with no children, error is a failed fetch, and success
 * is the rest of the file.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const children = await getChildren();

  if (children.state === 'error') {
    return (
      <>
        <PageHeader title="Dashboard" />
        <ErrorState message={children.message} />
      </>
    );
  }
  if (children.state === 'unauthorised') {
    return (
      <>
        <PageHeader title="Dashboard" />
        <ErrorState message="Your session has expired. Please sign in again." />
      </>
    );
  }

  const items = children.state === 'ok' ? children.data.items : [];
  if (items.length === 0) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <EmptyState
          title="No children yet"
          description="Add a child profile and this page will fill in after their first chat."
          action={
            <Link className="button" href="/children">
              Add a child
            </Link>
          }
        />
      </>
    );
  }

  const requested = typeof params.childId === 'string' ? params.childId : undefined;
  const child = items.find((c) => c.id === requested) ?? items[0]!;

  const [dashboard, progress] = await Promise.all([
    getDashboard(child.id),
    getProgress(child.id, 30),
  ]);

  if (dashboard.state !== 'ok') {
    return (
      <>
        <PageHeader title="Dashboard" />
        <ErrorState
          message={dashboard.state === 'error' ? dashboard.message : 'Please sign in again.'}
        />
      </>
    );
  }

  const data = dashboard.data;
  const daily = progress.state === 'ok' ? progress.data.daily : [];
  const chartPoints = [...daily]
    .reverse()
    .map((d) => ({ label: d.day, value: Math.round(d.conversationMinutes) }));

  const nothingYet = data.today.conversationCount === 0 && data.thisWeek.conversationCount === 0;

  return (
    <>
      <PageHeader
        title={`${data.displayName}’s week`}
        description="Everything here describes how the app was used. None of it is an assessment of your child."
        actions={
          items.length > 1 ? (
            <nav aria-label="Choose a child" className="row">
              {items.map((c) => (
                <Link
                  key={c.id}
                  className={c.id === child.id ? 'button' : 'button button-secondary'}
                  href={`/dashboard?childId=${c.id}`}
                >
                  {c.displayName}
                </Link>
              ))}
            </nav>
          ) : undefined
        }
      />

      {data.usage.currentlyBlockedBy !== null && (
        <WarningBanner>
          {data.displayName} cannot start a chat right now
          {data.usage.currentlyBlockedBy === 'paused'
            ? ' because you have paused the app.'
            : data.usage.currentlyBlockedBy === 'daily_limit_reached'
              ? " because today's time limit has been reached."
              : data.usage.currentlyBlockedBy === 'quiet_hours'
                ? ' because it is quiet hours.'
                : ' because of a setting you have chosen.'}{' '}
          <Link href="/controls">Review your settings</Link>.
        </WarningBanner>
      )}

      {nothingYet ? (
        <EmptyState
          title="Nothing yet this week"
          description={`Once ${data.displayName} has a chat or plays a practice game, their activity appears here.`}
        />
      ) : (
        <div className="stack">
          <div className="grid">
            <MetricCard
              metricKey="conversation_minutes"
              value={minutes(data.today.conversationMinutes)}
              sub="today"
            />
            <MetricCard
              metricKey="conversation_minutes"
              value={minutes(data.thisWeek.conversationMinutes)}
              sub="this week"
            />
            <MetricCard
              metricKey="conversation_count"
              value={count(data.thisWeek.conversationCount, 'chat')}
              sub="this week"
            />
            <MetricCard
              metricKey="active_days"
              value={count(data.thisWeek.activeDays, 'day')}
              sub="this week"
            />
            <MetricCard
              metricKey="new_vocabulary"
              value={count(data.thisWeek.newVocabulary, 'word')}
              sub="this week"
            />
            <MetricCard
              metricKey="pronunciation_average"
              value={scoreBand(data.thisWeek.pronunciationAverage)}
              sub={count(data.thisWeek.pronunciationAttempts, 'try', 'tries')}
            />
          </div>

          <Card title="Time chatting, last 30 days">
            {chartPoints.length === 0 ? (
              <p className="muted small">Nothing to chart yet.</p>
            ) : (
              <BarChart points={chartPoints} title="Minutes chatting per day" unit="minutes" />
            )}
          </Card>

          <div className="grid">
            <Card title="Levels">
              <div className="stack">
                <LevelMeter level={data.levels.vocabularyLevel} label="Vocabulary" />
                <LevelMeter level={data.levels.pronunciationLevel} label="Pronunciation" />
                <LevelMeter level={data.levels.conversationSkillLevel} label="Conversation" />
              </div>
              <p className="stat-caveat">{data.levels.note}</p>
            </Card>

            <Card title="Milestones">
              {data.milestones.length === 0 ? (
                <p className="muted small">
                  None yet. These appear as {data.displayName} does things in the app.
                </p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {data.milestones.slice(0, 6).map((m) => (
                    <li key={m.key} className="small">
                      {m.title} <span className="muted">— {longDate(m.achievedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="stat-caveat">
                These are things your child has done, not stages they are expected to reach by a
                particular age.
              </p>
            </Card>

            <Card title="Your plan" action={<Link href="/subscription">Manage</Link>}>
              <p className="stat-value" style={{ fontSize: '1.3rem' }}>
                {data.usage.dailyMinuteLimit === 0
                  ? 'No daily limit set'
                  : `${String(data.usage.dailyMinuteLimit)} minutes a day`}
              </p>
              <p className="small muted">
                {data.usage.minutesRemainingToday === null
                  ? 'Time is not limited for this child.'
                  : `${String(data.usage.minutesRemainingToday)} minutes left today.`}
              </p>
              <p className="stat-explain">
                The daily limit is a setting you chose, enforced on our servers — not something the
                app on your child’s device can be persuaded to ignore.
              </p>
            </Card>
          </div>

          <Card title="Safety moments, last 30 days">
            <div className="row" style={{ gap: 'var(--space-4)' }}>
              <div>
                <p className="stat-value">{String(data.safety.total)}</p>
                <p className="small muted">topics steered away from</p>
              </div>
              {data.safety.escalated > 0 && (
                <Pill tone="flagged">{`${String(data.safety.escalated)} sent for review`}</Pill>
              )}
            </div>
            {data.safety.byCategory.length > 0 && (
              <ul
                className="row small muted"
                style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}
              >
                {data.safety.byCategory.slice(0, 5).map((c) => (
                  <li key={c.category}>
                    <Pill>{`${c.category.replace(/_/g, ' ')} ×${String(c.count)}`}</Pill>
                  </li>
                ))}
              </ul>
            )}
            <p className="stat-caveat">{data.safety.note}</p>
          </Card>
        </div>
      )}
    </>
  );
}
