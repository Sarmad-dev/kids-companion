import { router } from 'expo-router';

import type { LearningIndicators, ParentProgress } from '../../src/api/client';
import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Banner,
  BarChart,
  Body,
  Card,
  CardTitle,
  ChartHeader,
  Faint,
  Helper,
  Note,
  ParentScreen,
  Pill,
  Wrap,
} from '../../src/components/parent/index';
import { useResource } from '../../src/hooks/use-resource';
import { useApp } from '../../src/state/app-context';
import { parentTheme } from '../../src/theme/parent-theme';

/**
 * Progress, over ninety days.
 *
 * Three charts and a word list, and then — at the bottom, in plain language —
 * what the numbers mean AND what they do not. That last block is the reason the
 * screen exists in this shape: a chart of a small child's week is an object a
 * parent will interpret whether or not it can bear interpretation, and the only
 * responsible thing to do with one is to say what it measures.
 *
 * "A quiet week means a quiet week." Not a regression, not a plateau, not
 * anything at all.
 */
const normalise = (values: readonly number[]): number[] => {
  const peak = Math.max(1, ...values);
  return values.map((value) => value / peak);
};

export default function ParentProgressScreen() {
  const { api, child } = useApp();

  const progress = useResource(
    async () =>
      await api.get<ParentProgress>(`/api/parent/progress/${child.childId ?? ''}?days=90`),
    [api, child.childId],
  );

  // Same rollup window, but the individual observations — not just their
  // preamble — live on the dedicated learning endpoint.
  const indicators = useResource(
    async () =>
      await api.get<LearningIndicators>(`/api/learning/indicators?childId=${child.childId ?? ''}`),
    [api, child.childId],
  );

  const daily = progress.data?.daily ?? [];

  return (
    <>
      <ParentHeader
        title="Progress"
        onBack={() => {
          router.back();
        }}
      />
      <ParentScreen testID="screen-parent-progress">
        {progress.failure !== undefined && (
          <Banner tone="danger">{progress.failure.message}</Banner>
        )}

        <Card>
          <ChartHeader title="Minutes chatting" meta="90 days" />
          <BarChart
            values={normalise(daily.map((day) => day.conversationMinutes))}
            height={80}
            gap={1}
            testID="chart-minutes"
          />
        </Card>

        <Card>
          <ChartHeader title="New words per day" meta="90 days" />
          <BarChart
            values={normalise(daily.map((day) => day.newVocabulary))}
            colour={parentTheme.colors.good}
            height={80}
            gap={1}
            testID="chart-words"
          />
        </Card>

        <Card>
          <ChartHeader title="Practice recognised" meta="90 days" />
          <BarChart
            values={normalise(daily.map((day) => day.pronunciationAverage ?? 0))}
            colour={parentTheme.colors.warn}
            height={80}
            gap={1}
            testID="chart-practice"
          />
        </Card>

        <Card gap={10}>
          <CardTitle>Recent new words</CardTitle>
          {(progress.data?.vocabulary.recent ?? []).length === 0 ? (
            <Faint>No new words in this window.</Faint>
          ) : (
            <Wrap>
              {(progress.data?.vocabulary.recent ?? []).map((entry) => (
                <Pill key={entry.word} label={entry.word} />
              ))}
            </Wrap>
          )}
        </Card>

        {(indicators.data?.indicators.length ?? 0) > 0 && (
          <Card gap={14}>
            <CardTitle>Observations</CardTitle>
            {(indicators.data?.indicators ?? []).map((indicator) => (
              <Card
                key={indicator.key}
                gap={4}
                style={{ backgroundColor: parentTheme.colors.inset, borderWidth: 0 }}
              >
                <Body>{indicator.observation}</Body>
                <Helper>{indicator.suggestion}</Helper>
                <Faint>{indicator.notAClaim}</Faint>
              </Card>
            ))}
          </Card>
        )}

        <Card gap={8} style={{ backgroundColor: parentTheme.colors.inset, borderWidth: 0 }}>
          <CardTitle>What these numbers mean</CardTitle>
          <Faint>
            {indicators.data?.preamble ??
              progress.data?.indicatorsPreamble ??
              'They describe how the app was used: minutes spent, words that appeared for the first time, and how often our speech model recognised an attempt. They are not a test, not a ranking, and not a developmental assessment. A quiet week means a quiet week.'}
          </Faint>
        </Card>

        <Note>{progress.data?.pronunciation.disclaimer ?? ''}</Note>
      </ParentScreen>
    </>
  );
}
