import { router } from 'expo-router';
import { useEffect } from 'react';
import { ScrollView, View } from 'react-native';

import type { ChildSummary, ParentDashboard, ParentProgress } from '../../../src/api/client';
import { ParentHeader } from '../../../src/components/parent/chrome';
import {
  Banner,
  BarChart,
  Card,
  CardTitle,
  ChartHeader,
  Chip,
  Faint,
  LevelMeter,
  MiniStat,
  Note,
  ParentScreen,
  Row,
  SecondaryButton,
  StatTile,
  Wrap,
} from '../../../src/components/parent/index';
import { useResource } from '../../../src/hooks/use-resource';
import { useApp } from '../../../src/state/app-context';
import { parentTheme } from '../../../src/theme/parent-theme';

/**
 * The dashboard.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DESCRIPTIVE BANDS, NEVER SCORES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything on this screen describes how the app was USED: minutes, counts of
 * things that happened, and three levels expressed as phrases. None of it is an
 * assessment of the child, and the note at the bottom says so in as many words —
 * because a parent looking at a chart of their four-year-old's week will supply
 * that interpretation themselves unless told not to.
 *
 * The levels only ever go up, which is a property of how they are computed
 * rather than a kindness: a band that could fall would be a grade, and a parent
 * watching a grade fall would change how they talk to their child about it.
 */

/**
 * Three levels, four segments. The fourth is deliberately never filled.
 *
 * A level a client does not recognise reads as the lowest one rather than
 * throwing: a new band added server-side should make this screen look slightly
 * out of date, not blank.
 */
const STARTING = { filled: 1, band: 'getting started' } as const;

const LEVEL_FILL: Readonly<Record<string, { filled: number; band: string }>> = {
  getting_started: STARTING,
  growing: { filled: 2, band: 'growing steadily' },
  confident: { filled: 3, band: 'chatting freely' },
};

const level = (value: string | undefined): { filled: number; band: string } =>
  LEVEL_FILL[value ?? 'getting_started'] ?? STARTING;

export default function Dashboard() {
  const { api, child, setChild } = useApp();

  const children = useResource(
    async () => await api.get<{ items: ChildSummary[] }>('/v1/children'),
    [api],
  );

  // A parent arriving from the child side already has one selected; one arriving
  // cold gets the first, so the screen is never a chooser with nothing on it.
  useEffect(() => {
    const first = children.data?.items[0];
    if (child.childId === undefined && first !== undefined) {
      setChild({ childId: first.id, childName: first.displayName });
    }
  }, [children.data, child.childId, setChild]);

  const dashboard = useResource(
    async () => await api.get<ParentDashboard>(`/api/parent/dashboard/${child.childId ?? ''}`),
    [api, child.childId],
  );

  const progress = useResource(
    async () =>
      await api.get<ParentProgress>(`/api/parent/progress/${child.childId ?? ''}?days=30`),
    [api, child.childId],
  );

  const data = dashboard.data;
  const daily = progress.data?.daily ?? [];
  // Normalised against the busiest day in the window rather than the daily
  // limit: a family whose limit is 240 but whose real days are 12 minutes long
  // would otherwise see thirty flat bars and learn nothing.
  const peak = Math.max(1, ...daily.map((day) => day.conversationMinutes));

  const remaining = data?.usage.minutesRemainingToday;
  const limit = data?.usage.dailyMinuteLimit ?? 0;

  return (
    <>
      <ParentHeader title={data === undefined ? 'Dashboard' : `${data.displayName} · this month`} />
      <ParentScreen testID="screen-parent-dashboard">
        {dashboard.failure !== undefined && (
          <Banner tone="danger">{dashboard.failure.message}</Banner>
        )}

        {/* Chips rather than a picker: a family has up to four children, and a
            dropdown for four things is a tap nobody needs to make. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
        >
          {(children.data?.items ?? []).map((kid) => (
            <Chip
              key={kid.id}
              label={kid.displayName}
              on={kid.id === child.childId}
              testID={`kid-chip-${kid.id}`}
              onPress={() => {
                setChild({ childId: kid.id, childName: kid.displayName });
              }}
            />
          ))}
        </ScrollView>

        <Row gap={12} align="stretch">
          <StatTile
            caption="Chatting today"
            value={String(Math.round(data?.today.conversationMinutes ?? 0))}
            unit="min"
            meta={limit > 0 ? `of ${String(limit)} allowed` : 'no daily limit set'}
            testID="stat-today"
          />
          <StatTile
            caption="This week"
            value={String(Math.round(data?.thisWeek.conversationMinutes ?? 0))}
            unit="min"
            meta={`${String(data?.thisWeek.activeDays ?? 0)} active days`}
            testID="stat-week"
          />
        </Row>

        {data?.usage.currentlyBlockedBy != null && (
          <Banner tone="warn">
            {data.displayName} cannot play right now: {data.usage.currentlyBlockedBy}.
            {remaining === 0 ? ' The daily limit has been reached.' : ''}
          </Banner>
        )}

        <Card>
          <ChartHeader title="Minutes per day" meta="last 30 days" />
          <BarChart
            values={daily.map((day) => day.conversationMinutes / peak)}
            highlight={0.9}
            testID="chart-minutes"
          />
          <Row gap={0} align="center" style={{ justifyContent: 'space-between', marginTop: 6 }}>
            <Faint>{daily[0]?.day ?? ''}</Faint>
            <Faint>{daily[daily.length - 1]?.day ?? ''}</Faint>
          </Row>
        </Card>

        <Wrap gap={10}>
          <MiniStat value={String(data?.thisWeek.conversationCount ?? 0)} caption="conversations" />
          <MiniStat value={String(data?.thisWeek.wordsUsed ?? 0)} caption="words used" />
          <MiniStat value={String(data?.thisWeek.newVocabulary ?? 0)} caption="new vocabulary" />
          <MiniStat
            value={String(data?.thisWeek.storiesCompleted ?? 0)}
            caption="stories completed"
          />
          <MiniStat
            value={String(data?.thisWeek.pronunciationAttempts ?? 0)}
            caption="practice attempts"
          />
          <MiniStat value={String(data?.thisWeek.activeDays ?? 0)} caption="active days" />
        </Wrap>

        <Card gap={14}>
          <CardTitle>Levels</CardTitle>
          <LevelMeter
            name="Vocabulary"
            band={level(data?.levels.vocabularyLevel).band}
            filled={level(data?.levels.vocabularyLevel).filled}
          />
          <LevelMeter
            name="Pronunciation"
            band={level(data?.levels.pronunciationLevel).band}
            filled={level(data?.levels.pronunciationLevel).filled}
          />
          <LevelMeter
            name="Conversation skill"
            band={level(data?.levels.conversationSkillLevel).band}
            filled={level(data?.levels.conversationSkillLevel).filled}
          />
        </Card>

        <Card gap={10}>
          <CardTitle>Milestones</CardTitle>
          {(data?.milestones ?? []).length === 0 ? (
            <Faint>Nothing yet. Milestones appear as they happen.</Faint>
          ) : (
            (data?.milestones ?? []).map((milestone) => (
              <Row key={milestone.key} gap={10} align="flex-start">
                <View
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    backgroundColor: parentTheme.colors.goodWash,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Faint>✓</Faint>
                </View>
                <View style={{ flex: 1, gap: 1 }}>
                  <CardTitle>{milestone.title}</CardTitle>
                  <Faint>{new Date(milestone.achievedAt).toLocaleDateString()}</Faint>
                </View>
              </Row>
            ))
          )}
        </Card>

        <Note>{data?.levels.note ?? 'None of this is an assessment of your child.'}</Note>

        {/* The three screens that belong to this child but are too long to
            live on a dashboard. Reached from here rather than from Account,
            because they are about the child and Account is about the parent. */}
        <SecondaryButton
          label="Safety moments"
          testID="go-safety"
          onPress={() => {
            router.push('/(parent)/safety');
          }}
        />
        <SecondaryButton
          label="Speech practice"
          testID="go-practice"
          onPress={() => {
            router.push('/(parent)/practice');
          }}
        />
        <SecondaryButton
          label="Progress over 90 days"
          testID="go-progress"
          onPress={() => {
            router.push('/(parent)/progress');
          }}
        />
      </ParentScreen>
    </>
  );
}
