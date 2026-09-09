import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';

import type { CharacterSummary, ChildSummary, ParentalControls } from '../../../src/api/client';
import { Avatar } from '../../../src/components/child/Avatar';
import { ParentHeader } from '../../../src/components/parent/chrome';
import {
  Banner,
  Card,
  CheckRow,
  Chip,
  Faint,
  Field,
  GroupLabel,
  Helper,
  Note,
  ParentScreen,
  PrimaryButton,
  Row,
  Segmented,
  SettingRow,
  Stepper,
  Switch,
} from '../../../src/components/parent/index';
import { useResource } from '../../../src/hooks/use-resource';
import { useApp } from '../../../src/state/app-context';
import { castMember } from '../../../src/theme/child-theme';

/**
 * Parental controls.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THESE ARE ENFORCED ON OUR SERVERS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every control on this screen is checked in `parental-gate.ts` on every path a
 * child can reach — starting a conversation, sending a turn, opening a practice
 * session. The app on the child's device cannot be persuaded to ignore them,
 * because the app on the child's device is not what enforces them. The header
 * note says exactly that, because "parental controls" in a lot of products
 * means "a setting the app respects until it crashes".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY EVERY NUMBER IS A STEPPER AND NEVER A TEXT FIELD
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A text field admits "6O" and "sixty" and "-5", and each of those becomes a
 * server-side validation error a parent has to read and decode. A stepper with
 * a stated range cannot produce an invalid value at all, which leaves exactly
 * one error worth writing: per-session cannot exceed daily, which is a
 * relationship between two valid numbers rather than a typo.
 */
const DAYS = [
  { value: 1, label: 'M' },
  { value: 2, label: 'T' },
  { value: 3, label: 'W' },
  { value: 4, label: 'T' },
  { value: 5, label: 'F' },
  { value: 6, label: 'S' },
  { value: 7, label: 'S' },
] as const;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export default function Controls() {
  const { api, child, setChild } = useApp();

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

  const characters = useResource(
    async () => await api.get<{ items: CharacterSummary[] }>('/v1/characters'),
    [api],
  );

  const loaded = useResource(
    async () => await api.get<ParentalControls>(`/api/parent/controls/${child.childId ?? ''}`),
    [api, child.childId],
  );

  /** The edited copy. `undefined` until the server's version arrives. */
  const [draft, setDraft] = useState<ParentalControls | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [topicsText, setTopicsText] = useState('');

  useEffect(() => {
    if (loaded.data === undefined) return;
    setDraft(loaded.data);
    setTopicsText(loaded.data.blockedTopics.join('\n'));
    setSaved(false);
    setError(undefined);
  }, [loaded.data]);

  const patch = (next: Partial<ParentalControls>) => {
    setDraft((current) => (current === undefined ? current : { ...current, ...next }));
    setSaved(false);
  };

  const sessionTooLong = draft !== undefined && draft.sessionMinuteLimit > draft.dailyMinuteLimit;
  const noDays = draft?.allowedDays.length === 0;
  const halfQuiet =
    draft !== undefined && (draft.quietHoursStart === null) !== (draft.quietHoursEnd === null);

  const save = async () => {
    if (draft === undefined || child.childId === undefined) return;
    if (sessionTooLong || noDays || halfQuiet) return;

    setSaving(true);
    setError(undefined);
    const result = await api.put<ParentalControls>(`/api/parent/controls/${child.childId}`, {
      dailyMinuteLimit: draft.dailyMinuteLimit,
      sessionMinuteLimit: draft.sessionMinuteLimit,
      quietHoursStart: draft.quietHoursStart,
      quietHoursEnd: draft.quietHoursEnd,
      allowedDays: draft.allowedDays,
      allowedCharacterIds: draft.allowedCharacterIds,
      blockedTopics: topicsText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length >= 2),
      languageLock: draft.languageLock,
      contentFilterLevel: draft.contentFilterLevel,
      transcriptRetentionDays: draft.transcriptRetentionDays,
      isPaused: draft.isPaused,
    });
    setSaving(false);

    if (!result.ok || result.data === undefined) {
      // NOTHING was applied. Saying so matters: a parent who thinks a limit
      // saved and did not will not check again for a week.
      setError(
        "We could not save your changes. Nothing was applied — your child's limits are unchanged.",
      );
      return;
    }
    setDraft(result.data);
    loaded.set(result.data);
    setSaved(true);
  };

  return (
    <>
      <ParentHeader title="Parental controls" />
      <ParentScreen testID="screen-parent-controls">
        {saved && (
          <Banner tone="good">✓ Saved. These are enforced on our servers within a minute.</Banner>
        )}
        {error !== undefined && <Banner tone="danger">{error}</Banner>}
        {loaded.failure !== undefined && <Banner tone="danger">{loaded.failure.message}</Banner>}

        <Banner tone="info">
          These are enforced on our servers. The app on your child&apos;s device cannot be persuaded
          to ignore them.
        </Banner>

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
              testID={`controls-kid-${kid.id}`}
              onPress={() => {
                setChild({ childId: kid.id, childName: kid.displayName });
              }}
            />
          ))}
        </ScrollView>

        {draft !== undefined && (
          <>
            {/* ── Access ─────────────────────────────────────────────────── */}
            <Card gap={12}>
              <GroupLabel>Access</GroupLabel>
              <SettingRow
                label="Pause the app"
                emphasis
                last
                hint={`${child.childName ?? 'Your child'} sees a friendly "let's play again a bit later". They are never told they were blocked, or by whom.`}
              >
                <Switch
                  on={draft.isPaused}
                  large
                  tone="warn"
                  label="Pause the app"
                  testID="control-pause"
                  onToggle={() => {
                    patch({ isPaused: !draft.isPaused });
                  }}
                />
              </SettingRow>
            </Card>

            {/* ── Time ───────────────────────────────────────────────────── */}
            <Card gap={14}>
              <GroupLabel>Time</GroupLabel>

              <Stepper
                label="Minutes a day"
                range="0–240"
                value={`${String(draft.dailyMinuteLimit)} min`}
                testID="control-daily"
                onDecrement={() => {
                  patch({ dailyMinuteLimit: clamp(draft.dailyMinuteLimit - 15, 0, 240) });
                }}
                onIncrement={() => {
                  patch({ dailyMinuteLimit: clamp(draft.dailyMinuteLimit + 15, 0, 240) });
                }}
              />

              <Stepper
                label="Minutes in one sitting"
                range="0–120"
                value={`${String(draft.sessionMinuteLimit)} min`}
                testID="control-session"
                {...(sessionTooLong ? { error: 'Per-session cannot exceed the daily limit.' } : {})}
                onDecrement={() => {
                  patch({ sessionMinuteLimit: clamp(draft.sessionMinuteLimit - 5, 0, 120) });
                }}
                onIncrement={() => {
                  patch({ sessionMinuteLimit: clamp(draft.sessionMinuteLimit + 5, 0, 120) });
                }}
              />

              <View style={{ gap: 8 }}>
                <Helper>Quiet hours</Helper>
                <Row gap={10}>
                  <View style={{ flex: 1 }}>
                    <Field
                      value={draft.quietHoursStart ?? ''}
                      placeholder="20:30"
                      state={halfQuiet ? 'error' : 'rest'}
                      testID="control-quiet-start"
                      onChangeText={(next) => {
                        patch({ quietHoursStart: next === '' ? null : next });
                      }}
                    />
                  </View>
                  <Faint>until</Faint>
                  <View style={{ flex: 1 }}>
                    <Field
                      value={draft.quietHoursEnd ?? ''}
                      placeholder="07:00"
                      state={halfQuiet ? 'error' : 'rest'}
                      testID="control-quiet-end"
                      onChangeText={(next) => {
                        patch({ quietHoursEnd: next === '' ? null : next });
                      }}
                    />
                  </View>
                </Row>
                {halfQuiet && <Banner tone="danger">Set both times or neither.</Banner>}
                <Faint>May cross midnight.</Faint>
              </View>

              <View style={{ gap: 8 }}>
                <Helper>Allowed days</Helper>
                <Row gap={6}>
                  {DAYS.map((day) => (
                    <Chip
                      key={day.value}
                      label={day.label}
                      grow
                      on={draft.allowedDays.includes(day.value)}
                      testID={`control-day-${String(day.value)}`}
                      onPress={() => {
                        patch({
                          allowedDays: draft.allowedDays.includes(day.value)
                            ? draft.allowedDays.filter((d) => d !== day.value)
                            : [...draft.allowedDays, day.value].sort((a, b) => a - b),
                        });
                      }}
                    />
                  ))}
                </Row>
                {noDays && <Banner tone="danger">Choose at least one day.</Banner>}
              </View>
            </Card>

            {/* ── Content ────────────────────────────────────────────────── */}
            <Card gap={14}>
              <GroupLabel>Content</GroupLabel>

              <View style={{ gap: 8 }}>
                <Helper>Safety filter</Helper>
                <Segmented
                  value={draft.contentFilterLevel}
                  testID="control-filter"
                  options={[
                    { value: 'standard', label: 'Standard' },
                    { value: 'strict', label: 'Strict' },
                  ]}
                  onChange={(next) => {
                    patch({ contentFilterLevel: next });
                  }}
                />
                {/* Load-bearing: a segmented control with two options invites the
                    reading that one of them is "off". Neither of them is. */}
                <Faint>
                  Safety runs either way and cannot be turned off. Strict also steers away from mild
                  peril and scary imagery.
                </Faint>
              </View>

              <View style={{ gap: 8 }}>
                <Helper>Steer away from</Helper>
                <Field
                  value={topicsText}
                  onChangeText={(next) => {
                    setTopicsText(next);
                    setSaved(false);
                  }}
                  multiline
                  placeholder={"injections\nour neighbour's dog"}
                  testID="control-topics"
                />
                <Faint>One per line.</Faint>
              </View>

              <View style={{ gap: 8 }}>
                <Helper>Language lock</Helper>
                <Segmented<'either' | 'en' | 'ur'>
                  value={(draft.languageLock ?? 'either') as 'either' | 'en' | 'ur'}
                  testID="control-language-lock"
                  options={[
                    { value: 'either', label: 'Either' },
                    { value: 'en', label: 'English only' },
                    { value: 'ur', label: 'Urdu only' },
                  ]}
                  onChange={(next) => {
                    patch({ languageLock: next === 'either' ? null : next });
                  }}
                />
              </View>
            </Card>

            {/* ── Characters ─────────────────────────────────────────────── */}
            <Card gap={10}>
              <GroupLabel>Characters</GroupLabel>
              <Faint>Tick none to allow every character. Tick some to allow only those.</Faint>
              {(characters.data?.items ?? []).map((character) => {
                const member = castMember(character.slug);
                const on = draft.allowedCharacterIds.includes(character.id);
                return (
                  <CheckRow
                    key={character.id}
                    label={member.name}
                    trailing={member.ages}
                    on={on}
                    testID={`control-character-${character.slug}`}
                    leading={<Avatar slug={character.slug} size={30} />}
                    onPress={() => {
                      patch({
                        allowedCharacterIds: on
                          ? draft.allowedCharacterIds.filter((id) => id !== character.id)
                          : [...draft.allowedCharacterIds, character.id],
                      });
                    }}
                  />
                );
              })}
            </Card>

            {/* ── Retention ──────────────────────────────────────────────── */}
            <Card gap={12}>
              <GroupLabel>Retention</GroupLabel>

              <Stepper
                label="Keep transcripts for"
                range="0–365 days"
                value={`${String(draft.transcriptRetentionDays)} days`}
                testID="control-retention"
                onDecrement={() => {
                  patch({
                    transcriptRetentionDays: clamp(draft.transcriptRetentionDays - 30, 0, 365),
                  });
                }}
                onIncrement={() => {
                  patch({
                    transcriptRetentionDays: clamp(draft.transcriptRetentionDays + 30, 0, 365),
                  });
                }}
              />

              {/* What retention is DOING, not what was asked for. A parent who
                  asks for 365 where our own ceiling is 90 is told 90, rather
                  than shown their own request back and quietly given something
                  else. */}
              <Note>
                Actually applied: {String(draft.transcriptRetention.effectiveDays)} days.{' '}
                {draft.transcriptRetention.effectiveDays < draft.transcriptRetentionDays
                  ? `You asked for ${String(
                      draft.transcriptRetentionDays,
                    )}. Our own ceiling is ${String(
                      draft.transcriptRetention.effectiveDays,
                    )} days, so that is what happens — we will not hold anything longer than we said we would.`
                  : 'This matches what you asked for. Transcripts older than this are deleted nightly.'}{' '}
                Held: {String(draft.transcriptRetention.heldMessages)} messages. Deleted:{' '}
                {String(draft.transcriptRetention.deletedMessages)}.
              </Note>

              <Banner tone="warn">
                Voice recordings are deleted within hours, whatever this is set to. This setting is
                only about the written transcript.
              </Banner>
            </Card>

            <PrimaryButton
              label="Save changes"
              loading={saving}
              disabled={sessionTooLong || noDays || halfQuiet}
              onPress={() => {
                void save();
              }}
              testID="controls-save"
            />
          </>
        )}
      </ParentScreen>
    </>
  );
}
