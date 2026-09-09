import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import type { ConversationDetail } from '../../../src/api/client';
import { ParentHeader } from '../../../src/components/parent/chrome';
import {
  Banner,
  Card,
  Faint,
  Note,
  ParentScreen,
  Row,
  SectionTitle,
} from '../../../src/components/parent/index';
import { useResource } from '../../../src/hooks/use-resource';
import { useApp } from '../../../src/state/app-context';
import { castMember } from '../../../src/theme/child-theme';
import { fonts } from '../../../src/theme/fonts';
import { parentTheme } from '../../../src/theme/parent-theme';

/**
 * The transcript reader.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A READER, NOT A CHAT UI
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No bubbles, no tails, no input box, no typing indicator. The parent is
 * READING something that already happened, and a chat interface invites them to
 * feel present in a conversation they were not part of — and, worse, invites
 * them to look for a way to reply to their own child's four-year-old self.
 *
 * A message the retention sweep has redacted comes back as an empty string with
 * a `redactedAt`, and is shown as what it is: deleted, on the schedule the
 * parent themselves set. Rendering it as an empty line would look like a bug in
 * the app rather than a promise being kept.
 */
export default function Transcript() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { api, child } = useApp();

  const conversation = useResource(
    async () => await api.get<ConversationDetail>(`/api/conversations/${conversationId}`),
    [api, conversationId],
  );

  const data = conversation.data;
  const character = castMember(data?.character.slug);

  const minutes =
    data?.endedAt == null
      ? undefined
      : Math.max(
          1,
          Math.round(
            (new Date(data.endedAt).getTime() - new Date(data.startedAt).getTime()) / 60_000,
          ),
        );

  return (
    <>
      <ParentHeader
        title="Transcript"
        onBack={() => {
          router.back();
        }}
      />
      <ParentScreen testID="screen-transcript" gap={10}>
        {conversation.failure !== undefined && (
          <Banner tone="danger">{conversation.failure.message}</Banner>
        )}

        {data !== undefined && (
          <Card>
            <Row align="center" style={{ justifyContent: 'space-between' }}>
              <SectionTitle>{new Date(data.startedAt).toLocaleString()}</SectionTitle>
              <Faint>
                {minutes === undefined ? 'in progress' : `${String(minutes)} min`} · with{' '}
                {character.short}
              </Faint>
            </Row>
          </Card>
        )}

        {(data?.messages ?? []).map((message) => {
          const fromChild = message.role === 'child';
          const redacted = message.redactedAt !== null;
          return (
            <View
              key={message.id}
              style={[styles.message, fromChild ? styles.fromChild : styles.fromCompanion]}
            >
              <Text
                style={[
                  styles.speaker,
                  { color: fromChild ? parentTheme.colors.action : '#6b4a8f' },
                ]}
              >
                {fromChild ? (child.childName ?? 'Your child') : character.short}
              </Text>
              {redacted ? (
                <Faint>Deleted on your retention schedule. We cannot recover it.</Faint>
              ) : (
                <Text style={styles.text}>{message.text}</Text>
              )}
            </View>
          );
        })}

        <Note>
          Kept for as long as your retention setting says, then deleted. Voice recordings were
          deleted within hours of the chat.
        </Note>
      </ParentScreen>
    </>
  );
}

const styles = StyleSheet.create({
  message: {
    gap: 4,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: parentTheme.radii.control,
    borderWidth: 1,
  },
  fromChild: {
    backgroundColor: parentTheme.colors.surface,
    borderColor: parentTheme.colors.border,
  },
  /* The character's lines are washed violet so a parent can skim who said what
   * without reading a single name. */
  fromCompanion: { backgroundColor: '#f8f4fd', borderColor: '#e3d6f5' },
  speaker: {
    fontFamily: fonts.parent.semibold,
    fontSize: 11,
    letterSpacing: 0.44,
    textTransform: 'uppercase',
  },
  text: {
    fontFamily: fonts.parent.regular,
    fontSize: 14.5,
    lineHeight: 14.5 * 1.55,
    color: parentTheme.colors.ink,
  },
});
