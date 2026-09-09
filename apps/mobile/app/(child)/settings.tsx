import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ChildDetail, ParentalControls } from '../../src/api/client';
import { Aside, QuietButton, Screen, Spacer, Title } from '../../src/components/child/index';
import { useResource } from '../../src/hooks/use-resource';
import { useApp } from '../../src/state/app-context';
import { childTheme } from '../../src/theme/child-theme';
import { fonts } from '../../src/theme/fonts';

/** What each language is called in its own script, as the design has it. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = { en: 'English', ur: 'اردو' };

/**
 * Change things.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DELIBERATELY TINY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Only things a child may safely touch: a different friend, a different player,
 * and — if a parent has allowed a second language — which words they hear. Time
 * limits, content filters, schedules, retention and every other control live in
 * the parent app behind a grown-up's sign-in, because a setting a child can
 * change is not a parental control.
 *
 * NOTHING HERE CAN WEAKEN A PARENTAL CONTROL. Switching character is bounded by
 * the character allow-list the server enforces; switching child lands on the
 * child list, which is itself gated. There is no path from this screen to a
 * longer session.
 */
const RowButton = ({
  icon,
  iconBackground,
  label,
  onPress,
  testID,
}: {
  icon: string;
  iconBackground: string;
  label: string;
  onPress: () => void;
  testID?: string;
}) => (
  <Pressable
    testID={testID}
    accessibilityRole="button"
    accessibilityLabel={label}
    onPress={onPress}
  >
    {({ pressed }) => (
      <View style={[styles.row, childTheme.shadows.card, pressed && styles.pressed]}>
        <View style={[styles.disc, { backgroundColor: iconBackground }]}>
          <Text style={styles.discIcon}>{icon}</Text>
        </View>
        <Text style={styles.rowLabel}>{label}</Text>
      </View>
    )}
  </Pressable>
);

export default function Settings() {
  const { api, child, clearChild } = useApp();
  const [saving, setSaving] = useState(false);

  const detail = useResource(
    async () => await api.get<ChildDetail>(`/v1/children/${child.childId ?? ''}`),
    [api, child.childId],
  );

  /**
   * Whether the language control appears at all.
   *
   * Only when the parent has given this child more than one language AND has
   * not locked the conversation to one of them. A lock is a parental control,
   * so a child must not be able to see a switch that would contradict it — the
   * server would refuse the change anyway, and a control that visibly does
   * nothing is worse than one that is not there.
   */
  const controls = useResource(
    async () => await api.get<ParentalControls>(`/api/parent/controls/${child.childId ?? ''}`),
    [api, child.childId],
  );

  const languages = detail.data?.languages ?? [];
  const locked = (controls.data?.languageLock ?? null) !== null;
  const showLanguages = languages.length > 1 && !locked;
  const primary = languages.find((language) => language.isPrimary)?.languageCode;

  const choose = async (code: string) => {
    if (saving || child.childId === undefined || code === primary) return;
    setSaving(true);
    const next = languages.map((language) => ({
      languageCode: language.languageCode,
      isPrimary: language.languageCode === code,
      proficiency: language.proficiency,
    }));
    const updated = await api.put<ChildDetail>(`/v1/children/${child.childId}/languages`, {
      languages: next,
    });
    setSaving(false);
    if (updated.ok && updated.data !== undefined) detail.set(updated.data);
  };

  return (
    <Screen scroll testID="screen-settings" padding={24}>
      <Title>Change things</Title>

      <View style={styles.rows}>
        <RowButton
          icon="🔄"
          iconBackground={childTheme.colors.tileStars}
          label="Different friend"
          testID="change-character"
          onPress={() => {
            router.push('/(child)/character-select');
          }}
        />
        <RowButton
          icon="🙂"
          iconBackground="#e3f2ea"
          label="Different player"
          testID="change-child"
          onPress={() => {
            clearChild();
            router.replace('/(child)/child-select');
          }}
        />

        {showLanguages && (
          <View style={[styles.row, childTheme.shadows.card, styles.languageRow]}>
            <View style={[styles.disc, { backgroundColor: '#eaf4ff' }]}>
              <Text style={styles.discIcon}>🗣️</Text>
            </View>
            <View style={styles.languageBody}>
              <Text style={styles.rowLabel}>My words</Text>
              <View style={styles.languageChoices}>
                {languages.map((language) => {
                  const on = language.languageCode === primary;
                  return (
                    <Pressable
                      key={language.languageCode}
                      testID={`language-${language.languageCode}`}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on, disabled: saving }}
                      accessibilityLabel={
                        LANGUAGE_NAMES[language.languageCode] ?? language.languageCode
                      }
                      disabled={saving}
                      style={[styles.languageChip, on ? styles.languageOn : styles.languageOff]}
                      onPress={() => {
                        void choose(language.languageCode);
                      }}
                    >
                      <Text style={on ? styles.languageTextOn : styles.languageTextOff}>
                        {LANGUAGE_NAMES[language.languageCode] ?? language.languageCode}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          </View>
        )}
      </View>

      <View style={styles.note}>
        <Aside>Grown-ups can change everything else in the parent app.</Aside>
      </View>

      <QuietButton
        label="For grown-ups"
        face="🔒"
        style={styles.grownups}
        onPress={() => {
          router.push('/(parent)/gate');
        }}
        testID="settings-grownups"
      />

      <Spacer />
      <QuietButton
        label="Go home"
        face="🏠"
        fullWidth={false}
        soft
        onPress={() => {
          router.replace('/(child)/home');
        }}
        testID="home-button"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  rows: { gap: 14, marginTop: 22 },
  row: {
    minHeight: childTheme.touch.primary,
    backgroundColor: childTheme.colors.surface,
    borderRadius: childTheme.radii.card,
    flexDirection: 'row',
    alignItems: 'center',
    gap: childTheme.spacing.md,
    paddingHorizontal: childTheme.spacing.lg - 4,
    paddingVertical: 12,
  },
  pressed: { opacity: 0.9 },
  disc: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  discIcon: { fontSize: 26 },
  rowLabel: {
    fontFamily: fonts.child.bold,
    fontSize: childTheme.text.body,
    color: childTheme.colors.ink,
  },
  languageRow: { alignItems: 'flex-start' },
  languageBody: { flex: 1, gap: childTheme.spacing.sm },
  languageChoices: { flexDirection: 'row', gap: childTheme.spacing.sm },
  languageChip: {
    flex: 1,
    minHeight: 44,
    borderRadius: childTheme.radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  languageOn: { backgroundColor: childTheme.colors.captain },
  languageOff: { backgroundColor: '#eaf4ff' },
  languageTextOn: { fontFamily: fonts.child.bold, fontSize: 16, color: '#ffffff' },
  languageTextOff: { fontFamily: fonts.child.bold, fontSize: 16, color: '#1a4fa0' },
  note: { marginTop: childTheme.spacing.lg - 4 },
  grownups: { marginTop: childTheme.spacing.lg - 4 },
});
