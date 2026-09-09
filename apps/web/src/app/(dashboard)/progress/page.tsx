import { BarChart, LineChart } from '../../../components/charts';
import {
  Card,
  EmptyState,
  ErrorState,
  InfoBanner,
  MetricCard,
  PageHeader,
} from '../../../components/ui';
import { getChildren, getProgress } from '../../../lib/api';
import { count, scoreBand, shortDate } from '../../../lib/format';
import { allMetrics } from '../../../lib/metrics';

export const dynamic = 'force-dynamic';

/**
 * Progress over time.
 *
 * Three charts and a glossary. No trend line, no projection, and no "on track"
 * language — a line that goes up is a fact about last month; a line that
 * continues past today is a claim, and this product has no basis for one.
 */
export default async function ProgressPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const children = await getChildren();

  if (children.state !== 'ok') {
    return (
      <>
        <PageHeader title="Progress" />
        <ErrorState
          message={children.state === 'error' ? children.message : 'Please sign in again.'}
        />
      </>
    );
  }

  const items = children.data.items;
  if (items.length === 0) {
    return (
      <>
        <PageHeader title="Progress" />
        <EmptyState title="No children yet" description="Add a child profile to see progress." />
      </>
    );
  }

  const requested = typeof params.childId === 'string' ? params.childId : undefined;
  const child = items.find((c) => c.id === requested) ?? items[0]!;
  const progress = await getProgress(child.id, 90);

  if (progress.state !== 'ok') {
    return (
      <>
        <PageHeader title="Progress" />
        <ErrorState
          message={progress.state === 'error' ? progress.message : 'Please sign in again.'}
        />
      </>
    );
  }

  const data = progress.data;
  const ordered = [...data.daily].reverse();
  const hasData = ordered.some((d) => d.active);

  return (
    <>
      <PageHeader
        title={`${child.displayName}’s progress`}
        description="Ninety days of activity. These are counts of things that happened, not measurements of ability."
      />

      {!hasData ? (
        <EmptyState
          title="Nothing to show yet"
          description={`This page fills in once ${child.displayName} has used the app a few times.`}
        />
      ) : (
        <div className="stack">
          <div className="grid">
            <MetricCard
              metricKey="new_vocabulary"
              value={count(data.vocabulary.distinctWords, 'word')}
              sub="all time"
            />
            <MetricCard
              metricKey="pronunciation_average"
              value={scoreBand(data.pronunciation.average)}
              sub={count(data.pronunciation.attempts, 'try', 'tries')}
            />
            <MetricCard
              metricKey="conversation_count"
              value={count(
                ordered.reduce((sum, d) => sum + d.conversationCount, 0),
                'chat',
              )}
              sub="last 90 days"
            />
          </div>

          <Card title="Time chatting">
            <BarChart
              points={ordered.map((d) => ({
                label: d.day,
                value: Math.round(d.conversationMinutes),
              }))}
              title="Minutes chatting per day"
              unit="minutes"
            />
          </Card>

          <Card title="New words used">
            <LineChart
              points={ordered.map((d) => ({ label: d.day, value: d.newVocabulary }))}
              title="New words per day"
              unit="words"
            />
          </Card>

          {data.pronunciation.recentByDay.length > 0 && (
            <Card title="Practice feedback over time">
              <LineChart
                points={[...data.pronunciation.recentByDay]
                  .reverse()
                  .map((p) => ({ label: p.day, value: Math.round(p.average * 100) }))}
                title="Practice recognition per day"
                unit="out of 100"
              />
              <p className="stat-caveat">{data.pronunciation.disclaimer}</p>
            </Card>
          )}

          {data.vocabulary.recent.length > 0 && (
            <Card title="Recent new words">
              <div className="row">
                {data.vocabulary.recent.map((word) => (
                  <span key={word.word} className="pill">
                    {word.word}
                    <span className="muted"> · {shortDate(word.firstUsedAt)}</span>
                  </span>
                ))}
              </div>
              <p className="stat-caveat">
                Only words from our curated list are counted. Your child almost certainly knows many
                more words than this.
              </p>
            </Card>
          )}

          <Card title="What these numbers mean">
            <InfoBanner>{data.indicatorsPreamble}</InfoBanner>
            <dl style={{ margin: 0 }}>
              {allMetrics().map((definition) => (
                <div key={definition.key} style={{ marginBottom: 'var(--space-4)' }}>
                  <dt style={{ fontWeight: 600 }}>{definition.label}</dt>
                  <dd style={{ margin: '2px 0 0' }} className="small">
                    {definition.explanation}
                  </dd>
                  <dd className="stat-caveat" style={{ margin: '4px 0 0' }}>
                    {definition.notMeasuring}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      )}
    </>
  );
}
