import { router } from 'expo-router';

import type { PracticeProgress } from '../../src/api/client';
import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Banner,
  BarChart,
  Card,
  CardTitle,
  ChartHeader,
  Faint,
  Note,
  ParentScreen,
  Pill,
  SettingRow,
  Wrap,
} from '../../src/components/parent/index';
import { useResource } from '../../src/hooks/use-resource';
import { useApp } from '../../src/state/app-context';
import { parentTheme } from '../../src/theme/parent-theme';

/**
 * Speech practice, for a parent.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RECOGNITION MEASURES OUR SPEECH MODEL, NOT YOUR CHILD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is the one screen in the product with a percentage on it, and the
 * disclaimer travels with it every time — it is returned by the API alongside
 * the number rather than written here, so it cannot be dropped by a redesign.
 *
 * A quiet room moves this figure more than a month of practice does. A parent
 * who does not know that will read a dip as their child regressing, which is
 * both wrong and the kind of wrong that changes how they talk to their child.
 *
 * The child's own version of this screen has none of these numbers on it.
 */
export default function ParentPractice() {
  const { api, child } = useApp();

  const progress = useResource(
    async () =>
      await api.get<PracticeProgress>(`/api/practice/progress?childId=${child.childId ?? ''}`),
    [api, child.childId],
  );

  const data = progress.data;
  // Newest first from the server; reversed so the chart reads left to right.
  const recent = [...(data?.sessions ?? [])].reverse();

  return (
    <>
      <ParentHeader
        title="Speech practice"
        onBack={() => {
          router.back();
        }}
      />
      <ParentScreen testID="screen-parent-practice">
        {progress.failure !== undefined && (
          <Banner tone="danger">{progress.failure.message}</Banner>
        )}

        <Card>
          <ChartHeader title="Recognised on first try" meta="recent sessions" />
          <BarChart
            values={recent.map((session) => session.averageScore ?? 0)}
            colour={parentTheme.colors.good}
            height={88}
            gap={4}
            testID="chart-recognition"
          />
        </Card>

        <Card gap={10}>
          <CardTitle>Sounds practised</CardTitle>
          {(data?.skills ?? []).length === 0 ? (
            <Faint>Nothing practised yet.</Faint>
          ) : (
            <Wrap>
              {(data?.skills ?? []).map((skill) => (
                <Pill key={skill.skillKey} label={skill.skillKey} mono />
              ))}
            </Wrap>
          )}
        </Card>

        <Card gap={0} style={{ paddingVertical: 4 }}>
          {recent.map((session, index) => (
            <SettingRow
              key={session.id}
              label={new Date(session.startedAt).toLocaleString()}
              hint={`${String(session.attemptCount)} attempts`}
              last={index === recent.length - 1}
            >
              <Faint>
                {session.averageScore === null
                  ? '—'
                  : `${String(Math.round(session.averageScore * 100))}%`}
              </Faint>
            </SettingRow>
          ))}
          {recent.length === 0 && <Faint>No practice sessions in this window.</Faint>}
        </Card>

        <Card gap={10}>
          <CardTitle>Rewards earned</CardTitle>
          <Wrap>
            {(data?.achievements ?? []).map((achievement) => (
              <Pill key={achievement.key} label={`⭐ ${achievement.title}`} />
            ))}
          </Wrap>
          {(data?.achievements ?? []).length === 0 && <Faint>None yet.</Faint>}
        </Card>

        <Note>
          {data?.disclaimer ??
            'Recognition is a measure of our speech model, not of your child. A quiet room moves this number more than practice does.'}
        </Note>
      </ParentScreen>
    </>
  );
}
