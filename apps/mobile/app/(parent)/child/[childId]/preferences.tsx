import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import type { ChildPreferences } from '../../../../src/api/client';
import { ParentHeader } from '../../../../src/components/parent/chrome';
import {
  Banner,
  Card,
  CardTitle,
  Chip,
  Faint,
  ParentScreen,
  RadioRow,
  Segmented,
  SettingRow,
  Switch,
  Wrap,
} from '../../../../src/components/parent/index';
import { useResource } from '../../../../src/hooks/use-resource';
import { useApp } from '../../../../src/state/app-context';

/**
 * A child's preferences.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PREFERENCES SHAPE THE CONVERSATION. CONTROLS BOUND IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That is the whole reason these are a different screen from Parental controls.
 * Everything here changes what the character is LIKE — how long it keeps a
 * conversation going, whether it offers stories, whether it corrects a
 * mispronounced word and how gently. Nothing here can make a session longer
 * than the limit, allow a blocked topic, or unlock a character.
 *
 * Correction style defaults to "gentle" for a reason: a character that never
 * corrects teaches nothing, and one that stops to correct every word teaches a
 * child that talking is a test they keep failing.
 */
const TOPICS = [
  'space',
  'animals',
  'trucks',
  'cooking',
  'dinosaurs',
  'football',
  'music',
  'the sea',
] as const;

export default function ChildPrefs() {
  const { childId } = useLocalSearchParams<{ childId: string }>();
  const { api } = useApp();

  const [draft, setDraft] = useState<ChildPreferences | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const loaded = useResource(
    async () => await api.get<ChildPreferences>(`/v1/children/${childId}/preferences`),
    [api, childId],
  );

  useEffect(() => {
    if (loaded.data === undefined) return;
    setDraft(loaded.data);
    setSaved(false);
  }, [loaded.data]);

  const patch = (next: Partial<ChildPreferences>) => {
    setDraft((current) => (current === undefined ? current : { ...current, ...next }));
    setSaved(false);
    setError(undefined);
  };

  const save = async () => {
    if (draft === undefined) return;
    setSaving(true);
    const result = await api.put<ChildPreferences>(`/v1/children/${childId}/preferences`, draft);
    setSaving(false);
    if (!result.ok) {
      setError('We could not save those preferences. Try again in a moment.');
      return;
    }
    if (result.data !== undefined) {
      setDraft(result.data);
      loaded.set(result.data);
    }
    setSaved(true);
  };

  return (
    <>
      <ParentHeader
        title="Preferences"
        onBack={() => {
          router.back();
        }}
        action={{
          label: 'Save',
          disabled: saving || draft === undefined,
          onPress: () => {
            void save();
          },
        }}
      />
      <ParentScreen testID="screen-child-prefs">
        {saved && <Banner tone="good">✓ Saved.</Banner>}
        {error !== undefined && <Banner tone="danger">{error}</Banner>}
        {loaded.failure !== undefined && <Banner tone="danger">{loaded.failure.message}</Banner>}

        {draft !== undefined && (
          <>
            <Card gap={10}>
              <CardTitle>Session length</CardTitle>
              <Segmented
                value={draft.sessionLength}
                testID="pref-session-length"
                options={[
                  { value: 'short', label: 'Short' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'long', label: 'Long' },
                ]}
                onChange={(next) => {
                  patch({ sessionLength: next });
                }}
              />
              <Faint>
                How long the character keeps a conversation going before winding it down warmly.
              </Faint>
            </Card>

            <Card gap={0} style={{ paddingVertical: 4 }}>
              <SettingRow label="Storytelling" hint="The character can offer to make up a story">
                <Switch
                  on={draft.storytellingEnabled}
                  label="Storytelling"
                  testID="pref-storytelling"
                  onToggle={() => {
                    patch({ storytellingEnabled: !draft.storytellingEnabled });
                  }}
                />
              </SettingRow>
              <SettingRow label="Role-play" hint="Pretending to be a shopkeeper, a vet, a pilot">
                <Switch
                  on={draft.roleplayEnabled}
                  label="Role-play"
                  testID="pref-roleplay"
                  onToggle={() => {
                    patch({ roleplayEnabled: !draft.roleplayEnabled });
                  }}
                />
              </SettingRow>
              <SettingRow
                label="Pronunciation practice"
                hint='Adds the "Say it" activity to their home screen'
                last
              >
                <Switch
                  on={draft.pronunciationPractice}
                  label="Pronunciation practice"
                  testID="pref-practice"
                  onToggle={() => {
                    patch({ pronunciationPractice: !draft.pronunciationPractice });
                  }}
                />
              </SettingRow>
            </Card>

            <Card gap={10}>
              <CardTitle>Correction style</CardTitle>
              <RadioRow
                label="None"
                hint="Never corrects. Just talks."
                on={draft.correctionStyle === 'none'}
                testID="pref-correction-none"
                onPress={() => {
                  patch({ correctionStyle: 'none' });
                }}
              />
              <RadioRow
                label="Gentle"
                hint="Repeats the word correctly in its reply, without pointing it out."
                on={draft.correctionStyle === 'gentle'}
                testID="pref-correction-gentle"
                onPress={() => {
                  patch({ correctionStyle: 'gentle' });
                }}
              />
              <RadioRow
                label="Active"
                hint="Asks them to try the word again, warmly, once."
                on={draft.correctionStyle === 'active'}
                testID="pref-correction-active"
                onPress={() => {
                  patch({ correctionStyle: 'active' });
                }}
              />
            </Card>

            <Card gap={10}>
              <CardTitle>Topics of interest</CardTitle>
              <Wrap>
                {TOPICS.map((topic) => {
                  const on = draft.topicKeys.includes(topic);
                  return (
                    <Chip
                      key={topic}
                      label={topic}
                      on={on}
                      testID={`pref-topic-${topic.replace(' ', '-')}`}
                      onPress={() => {
                        patch({
                          topicKeys: on
                            ? draft.topicKeys.filter((value) => value !== topic)
                            : [...draft.topicKeys, topic],
                        });
                      }}
                    />
                  );
                })}
              </Wrap>
              <Faint>
                The character leans towards these when a conversation needs somewhere to go. It is
                not a syllabus.
              </Faint>
            </Card>

            <View style={{ height: 8 }} />
          </>
        )}
      </ParentScreen>
    </>
  );
}
