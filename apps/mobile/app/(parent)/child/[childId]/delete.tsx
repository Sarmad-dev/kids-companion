import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { ParentHeader } from '../../../../src/components/parent/chrome';
import {
  Banner,
  Body,
  Card,
  DangerButton,
  Field,
  GroupLabel,
  LinkButton,
  LossLine,
  ParentScreen,
  SectionTitle,
} from '../../../../src/components/parent/index';
import { useApp } from '../../../../src/state/app-context';
import { parentTheme } from '../../../../src/theme/parent-theme';

/**
 * Deleting a child's profile.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GESTURE AND THE CONSEQUENCE ARE SEPARATED ON PURPOSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The red button is INERT until the child's name has been typed, character for
 * character. That is not friction for its own sake: a parent tapping through a
 * list on a phone in one hand can reach a destructive button by accident, and
 * this one cannot be undone by us or by them. Typing a name is a thing a hand
 * cannot do accidentally.
 *
 * The screen also NAMES what goes, in a list, before the field. "Are you sure?"
 * asks a question nobody can answer without knowing the answer to this one.
 */
export default function DeleteChild() {
  const { childId, childName } = useLocalSearchParams<{ childId: string; childName?: string }>();
  const { api, clearChild } = useApp();
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const name = childName ?? '';
  const matches = typed.trim() === name && name !== '';

  const remove = async () => {
    if (!matches) return;
    setDeleting(true);
    const result = await api.delete(`/v1/children/${childId}`);
    setDeleting(false);

    if (!result.ok) {
      setError('We could not delete that profile. Nothing has been removed — try again.');
      return;
    }
    clearChild();
    router.replace('/(parent)/(tabs)/children');
  };

  return (
    <>
      <ParentHeader
        title="Delete a profile"
        onBack={() => {
          router.back();
        }}
      />
      <ParentScreen testID="screen-child-delete" gap={14}>
        {error !== undefined && <Banner tone="danger">{error}</Banner>}

        <Card tone="danger" gap={8} style={{ backgroundColor: parentTheme.colors.dangerWash }}>
          <SectionTitle>Delete {name}&apos;s profile</SectionTitle>
          <Body>This cannot be undone, and we cannot restore it for you afterwards.</Body>
        </Card>

        <Card gap={8}>
          <GroupLabel>What goes</GroupLabel>
          <LossLine>Their profile, name, birth month and year</LossLine>
          <LossLine>Every transcript we still hold</LossLine>
          <LossLine>Their words, badges and practice history</LossLine>
          <LossLine>Their preferences and character choice</LossLine>
          <LossLine>Their safety-moment counts</LossLine>
        </Card>

        <Field
          label={`Type ${name} to confirm`}
          value={typed}
          onChangeText={setTyped}
          autoCapitalize="words"
          placeholder={name}
          testID="delete-confirm-name"
        />

        <DangerButton
          label="Delete this profile for good"
          enabled={matches && !deleting}
          onPress={() => {
            void remove();
          }}
          testID="delete-child-submit"
        />
        <LinkButton
          label="Keep the profile"
          onPress={() => {
            router.back();
          }}
          testID="delete-child-cancel"
        />
      </ParentScreen>
    </>
  );
}
