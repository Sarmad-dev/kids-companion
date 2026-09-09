import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { CharacterSummary, ChildDetail } from '../../../../src/api/client';
import { Avatar } from '../../../../src/components/child/Avatar';
import { ParentHeader } from '../../../../src/components/parent/chrome';
import {
  Banner,
  Card,
  CardTitle,
  Faint,
  Field,
  Helper,
  ParentScreen,
  RadioRow,
  Row,
  SettingRow,
  Switch,
  Tag,
  TAG_TONES,
} from '../../../../src/components/parent/index';
import { useResource } from '../../../../src/hooks/use-resource';
import { useApp } from '../../../../src/state/app-context';
import { CAST_SLUGS, castMember } from '../../../../src/theme/child-theme';
import { parentTheme } from '../../../../src/theme/parent-theme';

/**
 * A child's profile.
 *
 * Name, birth month and year, the age band that follows from them, an avatar,
 * languages with exactly one primary, and a preferred character. That is the
 * whole of what this product knows about a child, and the screen is deliberately
 * the same length as that list.
 *
 * The age band is READ-ONLY and says where it comes from. A parent who could
 * set it directly would be able to give a four-year-old a nine-year-old's
 * content, which is precisely the thing the band exists to prevent.
 */
/** The server's enum, in the words a parent uses. */
const AGE_LABEL: Readonly<Record<string, string>> = {
  AGE_3_5: '3–5',
  AGE_6_8: '6–8',
  AGE_9_10: '9–10',
};

export default function ChildProfile() {
  const { childId } = useLocalSearchParams<{ childId: string }>();
  const { api } = useApp();

  const [displayName, setDisplayName] = useState('');
  const [birthYear, setBirthYear] = useState('');
  const [birthMonth, setBirthMonth] = useState('');
  const [avatarKey, setAvatarKey] = useState<string | undefined>(undefined);
  const [preferred, setPreferred] = useState<string | null>(null);
  const [languages, setLanguages] = useState<ChildDetail['languages']>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const detail = useResource(
    async () => await api.get<ChildDetail>(`/v1/children/${childId}`),
    [api, childId],
  );

  const characters = useResource(
    async () => await api.get<{ items: CharacterSummary[] }>('/v1/characters'),
    [api],
  );

  useEffect(() => {
    const data = detail.data;
    if (data === undefined) return;
    setDisplayName(data.displayName);
    setBirthYear(String(data.birthYear));
    setBirthMonth(String(data.birthMonth));
    setAvatarKey(data.avatarKey ?? undefined);
    setPreferred(data.preferredCharacterId);
    setLanguages(data.languages);
    setSaved(false);
  }, [detail.data]);

  const touched = () => {
    setSaved(false);
    setError(undefined);
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);

    const profile = await api.patch<ChildDetail>(`/v1/children/${childId}`, {
      displayName: displayName.trim(),
      birthYear: Number(birthYear),
      birthMonth: Number(birthMonth),
      avatarKey: avatarKey ?? null,
      preferredCharacterId: preferred,
    });

    // Languages are a separate resource because they replace wholesale — a
    // partial update could leave a child with two primaries or none, and "none"
    // means the generation language is undefined at the next turn.
    const languagesSaved =
      languages.length === 0
        ? { ok: true }
        : await api.put(`/v1/children/${childId}/languages`, {
            languages: languages.map((language) => ({
              languageCode: language.languageCode,
              isPrimary: language.isPrimary,
              proficiency: language.proficiency,
            })),
          });

    setSaving(false);

    if (!profile.ok || !languagesSaved.ok) {
      setError('We could not save those changes. Check the details and try again.');
      return;
    }
    if (profile.data !== undefined) detail.set(profile.data);
    setSaved(true);
  };

  const makePrimary = (code: string) => {
    setLanguages((current) =>
      current.map((language) => ({ ...language, isPrimary: language.languageCode === code })),
    );
    touched();
  };

  return (
    <>
      <ParentHeader
        title={detail.data?.displayName ?? 'Child'}
        onBack={() => {
          router.back();
        }}
        action={{
          label: 'Save',
          disabled: saving,
          onPress: () => {
            void save();
          },
        }}
      />
      <ParentScreen testID="screen-child-profile" gap={14}>
        {saved && <Banner tone="good">✓ Saved.</Banner>}
        {error !== undefined && <Banner tone="danger">{error}</Banner>}
        {detail.failure !== undefined && <Banner tone="danger">{detail.failure.message}</Banner>}

        <Card gap={12}>
          <Field
            label="Name"
            value={displayName}
            onChangeText={(next) => {
              setDisplayName(next);
              touched();
            }}
            autoCapitalize="words"
            testID="profile-name"
          />
          <Row gap={12} align="stretch">
            <View style={{ flex: 1 }}>
              <Field
                label="Birth month"
                value={birthMonth}
                onChangeText={(next) => {
                  setBirthMonth(next);
                  touched();
                }}
                keyboardType="number-pad"
                testID="profile-birth-month"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Field
                label="Birth year"
                value={birthYear}
                onChangeText={(next) => {
                  setBirthYear(next);
                  touched();
                }}
                keyboardType="number-pad"
                testID="profile-birth-year"
              />
            </View>
          </Row>
          <View style={styles.ageBand}>
            <Helper>Age band</Helper>
            <CardTitle>{AGE_LABEL[detail.data?.ageGroup ?? ''] ?? '—'} · from birth date</CardTitle>
          </View>
        </Card>

        <Card gap={10}>
          <CardTitle>Avatar</CardTitle>
          <Row gap={10}>
            {CAST_SLUGS.map((slug) => (
              <Pressable
                key={slug}
                accessibilityRole="radio"
                accessibilityState={{ selected: avatarKey === slug }}
                accessibilityLabel={castMember(slug).name}
                testID={`avatar-${slug}`}
                style={[
                  styles.avatarChoice,
                  {
                    borderColor:
                      avatarKey === slug ? parentTheme.colors.action : parentTheme.colors.border,
                  },
                ]}
                onPress={() => {
                  setAvatarKey(slug);
                  touched();
                }}
              >
                <Avatar slug={slug} size={44} />
              </Pressable>
            ))}
          </Row>
        </Card>

        <Card gap={12}>
          <CardTitle>Languages</CardTitle>
          {languages.map((language, index) => (
            <SettingRow
              key={language.languageCode}
              label={language.languageCode === 'ur' ? 'اردو Urdu' : 'English'}
              last={index === languages.length - 1}
            >
              <Row gap={10}>
                <Tag
                  label={language.isPrimary ? 'Primary' : 'Also spoken'}
                  bg={language.isPrimary ? TAG_TONES.action.bg : TAG_TONES.neutral.bg}
                  fg={language.isPrimary ? TAG_TONES.action.fg : TAG_TONES.neutral.fg}
                />
                <Switch
                  on={language.isPrimary}
                  label={`Make ${language.languageCode} primary`}
                  testID={`language-primary-${language.languageCode}`}
                  onToggle={() => {
                    makePrimary(language.languageCode);
                  }}
                />
              </Row>
            </SettingRow>
          ))}
          <Faint>
            One language is primary. The character greets {detail.data?.displayName ?? 'them'} in
            that one.
          </Faint>
        </Card>

        <Card gap={10}>
          <CardTitle>Preferred character</CardTitle>
          {(characters.data?.items ?? []).map((character) => {
            const member = castMember(character.slug);
            return (
              <RadioRow
                key={character.id}
                label={member.name}
                trailing={member.ages}
                on={preferred === character.id}
                testID={`preferred-${character.slug}`}
                leading={<Avatar slug={character.slug} size={32} />}
                onPress={() => {
                  setPreferred(character.id);
                  touched();
                }}
              />
            );
          })}
        </Card>
      </ParentScreen>
    </>
  );
}

const styles = StyleSheet.create({
  ageBand: {
    backgroundColor: parentTheme.colors.background,
    borderRadius: parentTheme.radii.control,
    padding: 12,
    gap: 2,
  },
  avatarChoice: {
    flex: 1,
    aspectRatio: 1,
    borderWidth: 2,
    borderRadius: parentTheme.radii.control,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: parentTheme.colors.surface,
  },
});
