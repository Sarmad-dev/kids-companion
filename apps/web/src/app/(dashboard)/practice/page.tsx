import {
  Card,
  EmptyState,
  ErrorState,
  PageHeader,
  Pill,
  WarningBanner,
} from '../../../components/ui';
import { getChildren, getPractice } from '../../../lib/api';
import { count, longDate, scoreBand } from '../../../lib/format';

export const dynamic = 'force-dynamic';

/**
 * Speech practice.
 *
 * The disclaimer is at the TOP of this page rather than in a footnote, because
 * it is the most important thing on it. A parent looking at a list of scores
 * about their child's speech will draw conclusions, and this is the page where
 * that goes wrong.
 */
export default async function PracticePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const children = await getChildren();

  if (children.state !== 'ok') {
    return (
      <>
        <PageHeader title="Speech practice" />
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
        <PageHeader title="Speech practice" />
        <EmptyState title="No children yet" description="Add a child profile to see practice." />
      </>
    );
  }

  const requested = typeof params.childId === 'string' ? params.childId : undefined;
  const child = items.find((c) => c.id === requested) ?? items[0]!;
  const practice = await getPractice(child.id);

  if (practice.state !== 'ok') {
    return (
      <>
        <PageHeader title="Speech practice" />
        <ErrorState
          message={practice.state === 'error' ? practice.message : 'Please sign in again.'}
        />
      </>
    );
  }

  const data = practice.data;

  return (
    <>
      <PageHeader title={`${child.displayName}’s practice`} />

      <WarningBanner>{data.disclaimer}</WarningBanner>

      {data.sessions.length === 0 ? (
        <EmptyState
          title="No practice yet"
          description={`Practice games are in the app under “Say it”. Sessions appear here once ${child.displayName} has played one.`}
        />
      ) : (
        <div className="stack">
          <Card title="Recent sessions">
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Recent practice sessions</caption>
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Game</th>
                    <th scope="col">Tries</th>
                    <th scope="col">How it went</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sessions.map((session) => (
                    <tr key={session.id}>
                      <th scope="row" style={{ fontWeight: 500 }}>
                        {longDate(session.startedAt)}
                      </th>
                      <td>{session.exerciseKey.replace(/[._]/g, ' ')}</td>
                      <td>{count(session.attemptCount, 'try', 'tries')}</td>
                      <td>{scoreBand(session.averageScore)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {data.achievements.length > 0 && (
            <Card title="Rewards earned">
              <div className="row">
                {data.achievements.map((achievement) => (
                  <Pill key={achievement.key}>{achievement.title}</Pill>
                ))}
              </div>
              <p className="stat-caveat">
                These reward effort rather than ability — practising, finishing, coming back. A
                child who finds a sound hard earns exactly the same rewards.
              </p>
            </Card>
          )}

          {data.skills.length > 0 && (
            <Card title="Sounds practised">
              <div className="row">
                {data.skills.map((skill) => (
                  <Pill key={skill.skillKey}>
                    {skill.skillKey.replace(/[._]/g, ' ')} · {String(skill.exposureCount)}
                  </Pill>
                ))}
              </div>
              <p className="stat-caveat">
                This counts how often a sound came up, not how well it was said.
              </p>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
