import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView } from 'react-native';

import type { ChildSummary, ParentalControls } from '../../src/api/client';
import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Banner,
  Card,
  Chip,
  Helper,
  ParentScreen,
  SettingRow,
  Switch,
} from '../../src/components/parent/index';
import { useResource } from '../../src/hooks/use-resource';
import { useApp } from '../../src/state/app-context';

/**
 * Notifications.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SAFETY FLAGS DEFAULT ON. SUMMARIES DEFAULT OFF.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A daily nudge to open an app is not a safety feature, and defaulting it on
 * would be this product doing to parents the thing it refuses to do to
 * children. The one notification that is on by default is the one a parent
 * would be angry to have missed.
 *
 * Four switches PER CHILD, because families are not uniform: a parent may want
 * to hear about every moment for their four-year-old and nothing at all for
 * their ten-year-old, and one global setting cannot express that.
 *
 * Each saves on toggle. A notification preference is a single boolean with no
 * relationship to any other, so there is nothing a Save button would protect.
 */
export default function Notifications() {
  const { api, child, setChild } = useApp();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<ParentalControls['notifications'] | undefined>(undefined);

  const children = useResource(
    async () => await api.get<{ items: ChildSummary[] }>('/v1/children'),
    [api],
  );

  useEffect(() => {
    const first = children.data?.items[0];
    if (child.childId === undefined && first !== undefined) {
      setChild({ childId: first.id, childName: first.displayName });
    }
  }, [children.data, child.childId, setChild]);

  const controls = useResource(
    async () => await api.get<ParentalControls>(`/api/parent/controls/${child.childId ?? ''}`),
    [api, child.childId],
  );

  useEffect(() => {
    if (controls.data === undefined) return;
    setDraft(controls.data.notifications);
  }, [controls.data]);

  const toggle = async (key: keyof ParentalControls['notifications']) => {
    if (draft === undefined || child.childId === undefined || saving) return;
    const next = { ...draft, [key]: !draft[key] };
    // Optimistic: a switch that waits for a round trip before moving feels
    // broken, and the rollback below is the honest correction if it fails.
    setDraft(next);
    setSaving(true);
    setError(undefined);

    const result = await api.put<ParentalControls>(`/api/parent/controls/${child.childId}`, {
      notifications: { [key]: next[key] },
    });
    setSaving(false);

    if (!result.ok) {
      setDraft(draft);
      setError('We could not save that. Nothing has changed.');
      return;
    }
    if (result.data !== undefined) controls.set(result.data);
  };

  return (
    <>
      <ParentHeader
        title="Notifications"
        onBack={() => {
          router.back();
        }}
      />
      <ParentScreen testID="screen-notifications">
        {error !== undefined && <Banner tone="danger">{error}</Banner>}
        {controls.failure !== undefined && (
          <Banner tone="danger">{controls.failure.message}</Banner>
        )}

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
              testID={`notif-kid-${kid.id}`}
              onPress={() => {
                setChild({ childId: kid.id, childName: kid.displayName });
              }}
            />
          ))}
        </ScrollView>

        {draft !== undefined && (
          <Card gap={0} style={{ paddingVertical: 4 }}>
            <SettingRow
              label="When a safety moment happens"
              hint="Sent within minutes. We recommend leaving this on."
            >
              <Switch
                on={draft.onSafetyFlag}
                label="Safety moment alerts"
                testID="notif-safety"
                onToggle={() => {
                  void toggle('onSafetyFlag');
                }}
              />
            </SettingRow>
            <SettingRow label="Daily summary" hint="One message in the evening.">
              <Switch
                on={draft.onDailySummary}
                label="Daily summary"
                testID="notif-daily"
                onToggle={() => {
                  void toggle('onDailySummary');
                }}
              />
            </SettingRow>
            <SettingRow label="Weekly summary" hint="Sunday morning.">
              <Switch
                on={draft.onWeeklySummary}
                label="Weekly summary"
                testID="notif-weekly"
                onToggle={() => {
                  void toggle('onWeeklySummary');
                }}
              />
            </SettingRow>
            <SettingRow
              label="When a time limit is reached"
              hint="So you know why the app went quiet."
              last
            >
              <Switch
                on={draft.onTimeLimit}
                label="Time limit reached"
                testID="notif-time"
                onToggle={() => {
                  void toggle('onTimeLimit');
                }}
              />
            </SettingRow>
          </Card>
        )}

        <Helper>
          Safety flags are on by default. Summaries are off, because a daily nudge to open an app is
          not a safety feature.
        </Helper>
      </ParentScreen>
    </>
  );
}
