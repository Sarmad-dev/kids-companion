import { router } from 'expo-router';

import type { ParentDashboard } from '../../src/api/client';
import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Banner,
  Card,
  CardTitle,
  CountBar,
  Note,
  ParentScreen,
  Row,
  SecondaryButton,
  StatTile,
} from '../../src/components/parent/index';
import { useResource } from '../../src/hooks/use-resource';
import { useApp } from '../../src/state/app-context';

/**
 * Safety moments.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * COUNTS AND CATEGORIES ONLY. NEVER WHAT WAS SAID.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The product records THAT a moment happened and what kind it was. It does not
 * store the message that caused it — which is why there is nothing on this
 * screen to tap through to, and why that absence is stated rather than left to
 * look like an unfinished feature.
 *
 * A parent seeing "three moments were steered away this month, one about
 * personal details" has what they need to start a conversation with their
 * child. Showing them the transcript of it would mean this product kept one,
 * and a store of the most sensitive things children have said is exactly the
 * store that should not exist.
 */
const CATEGORY_WORDS: Readonly<Record<string, string>> = {
  upsetting_topic: 'Upsetting topic, steered away',
  personal_details: 'Asked for personal details',
  language_filter: 'Language filter triggered',
  escalated: 'Escalated to a human reviewer',
  self_harm: 'Sensitive topic, handled with care',
  violence: 'Violent theme, steered away',
};

export default function Safety() {
  const { api, child } = useApp();

  const dashboard = useResource(
    async () => await api.get<ParentDashboard>(`/api/parent/dashboard/${child.childId ?? ''}`),
    [api, child.childId],
  );

  const safety = dashboard.data?.safety;
  const peak = Math.max(1, ...(safety?.byCategory ?? []).map((row) => row.count));

  return (
    <>
      <ParentHeader
        title="Safety moments"
        onBack={() => {
          router.back();
        }}
      />
      <ParentScreen testID="screen-parent-safety">
        {dashboard.failure !== undefined && (
          <Banner tone="danger">{dashboard.failure.message}</Banner>
        )}

        <Row gap={12} align="stretch">
          <StatTile
            caption="Moments"
            value={String(safety?.total ?? 0)}
            meta="last 30 days"
            testID="safety-total"
          />
          <StatTile
            caption="Escalated"
            value={String(safety?.escalated ?? 0)}
            meta="reviewed by a human"
            tone="danger"
            testID="safety-escalated"
          />
        </Row>

        <Card gap={12}>
          <CardTitle>By category</CardTitle>
          {(safety?.byCategory ?? []).length === 0 ? (
            <Note>Nothing so far in this window.</Note>
          ) : (
            (safety?.byCategory ?? []).map((row) => (
              <CountBar
                key={row.category}
                label={CATEGORY_WORDS[row.category] ?? row.category.replace(/_/g, ' ')}
                count={row.count}
                fraction={row.count / peak}
              />
            ))
          )}
        </Card>

        <Note>
          {safety?.note ??
            'We record that a moment happened and what kind it was — never what was said. That means there is nothing here to open, and nothing stored that could leak.'}
        </Note>

        <SecondaryButton
          label="Notify me when this happens"
          testID="safety-notify"
          onPress={() => {
            router.push('/(parent)/notifications');
          }}
        />
      </ParentScreen>
    </>
  );
}
