import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ChildDetail } from '../../../src/api/client';
import { Avatar } from '../../../src/components/child/Avatar';
import { ParentHeader } from '../../../src/components/parent/chrome';
import {
  Banner,
  Card,
  DangerOutlineButton,
  Faint,
  Helper,
  ParentScreen,
  SecondaryButton,
  Tag,
  TAG_TONES,
  Wrap,
} from '../../../src/components/parent/index';
import { useResource } from '../../../src/hooks/use-resource';
import { useApp } from '../../../src/state/app-context';
import { castMember } from '../../../src/theme/child-theme';
import { fonts } from '../../../src/theme/fonts';
import { parentTheme } from '../../../src/theme/parent-theme';

/**
 * Children.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PAUSE, ARCHIVE AND DELETE ARE THREE DIFFERENT THINGS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pause is reversible and immediate, so it is a switch on the controls screen.
 * Archive keeps the profile but stops all activity, so it is a button here.
 * Delete is irreversible, so it is a button that leads to a screen with a typed
 * confirmation on it — never an action that happens from this list.
 *
 * The distinction is stated in the footer rather than left to be discovered,
 * because "archive" and "delete" are words people reasonably assume mean the
 * same thing.
 */
/** The server's enum, in the words a parent uses. */
const AGE_LABEL: Readonly<Record<string, string>> = {
  AGE_3_5: '3–5',
  AGE_6_8: '6–8',
  AGE_9_10: '9–10',
};

export default function Children() {
  const { api, setChild } = useApp();
  const [busy, setBusy] = useState<string | undefined>();

  const children = useResource(
    async () => await api.get<{ items: ChildDetail[] }>('/v1/children?includeArchived=true'),
    [api],
  );

  const toggleArchive = async (kid: ChildDetail) => {
    setBusy(kid.id);
    const route = kid.status === 'archived' ? 'restore' : 'archive';
    await api.post(`/v1/children/${kid.id}/${route}`);
    setBusy(undefined);
    children.reload();
  };

  return (
    <>
      <ParentHeader title="Children" />
      <ParentScreen testID="screen-parent-children" gap={10}>
        {children.failure !== undefined && (
          <Banner tone="danger">{children.failure.message}</Banner>
        )}

        {(children.data?.items ?? []).map((kid) => {
          const archived = kid.status === 'archived';
          const tone = archived
            ? TAG_TONES.neutral
            : kid.status === 'active'
              ? TAG_TONES.good
              : TAG_TONES.warn;
          const languages = kid.languages.map((language) => language.languageCode.toUpperCase());
          const character = castMember(kid.avatarKey ?? undefined);

          return (
            <Card key={kid.id} gap={12} testID={`child-row-${kid.id}`}>
              <View style={styles.head}>
                <Avatar slug={kid.avatarKey ?? undefined} size={44} />
                <View style={styles.headText}>
                  <Text style={styles.name}>{kid.displayName}</Text>
                  <Faint>
                    {AGE_LABEL[kid.ageGroup] ?? kid.ageGroup} · {languages.join(', ')} ·{' '}
                    {character.short}
                  </Faint>
                </View>
                <Tag
                  label={archived ? 'Archived' : kid.status === 'active' ? 'Active' : 'Paused'}
                  bg={tone.bg}
                  fg={tone.fg}
                />
              </View>

              <Wrap>
                <SecondaryButton
                  label="Edit"
                  testID={`edit-${kid.id}`}
                  onPress={() => {
                    setChild({ childId: kid.id, childName: kid.displayName });
                    router.push({
                      pathname: '/(parent)/child/[childId]/profile',
                      params: { childId: kid.id },
                    });
                  }}
                />
                <SecondaryButton
                  label="Preferences"
                  testID={`prefs-${kid.id}`}
                  onPress={() => {
                    setChild({ childId: kid.id, childName: kid.displayName });
                    router.push({
                      pathname: '/(parent)/child/[childId]/preferences',
                      params: { childId: kid.id },
                    });
                  }}
                />
                <SecondaryButton
                  label={archived ? 'Unarchive' : 'Archive'}
                  disabled={busy === kid.id}
                  testID={`archive-${kid.id}`}
                  onPress={() => {
                    void toggleArchive(kid);
                  }}
                />
                <DangerOutlineButton
                  label="Delete"
                  testID={`delete-${kid.id}`}
                  onPress={() => {
                    setChild({ childId: kid.id, childName: kid.displayName });
                    router.push({
                      pathname: '/(parent)/child/[childId]/delete',
                      params: { childId: kid.id, childName: kid.displayName },
                    });
                  }}
                />
              </Wrap>
            </Card>
          );
        })}

        <SecondaryButton
          label="+ Add a child"
          style={styles.add}
          testID="add-child"
          onPress={() => {
            router.push('/(parent)/add-child');
          }}
        />

        <Helper>
          Archiving keeps a profile but stops all activity. Deleting removes everything, for good.
        </Helper>
      </ParentScreen>
    </>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headText: { flex: 1, gap: 1 },
  name: {
    fontFamily: fonts.parent.bold,
    fontSize: 16,
    color: parentTheme.colors.ink,
  },
  add: { borderStyle: 'dashed', borderColor: parentTheme.colors.borderStrong, minHeight: 48 },
});
