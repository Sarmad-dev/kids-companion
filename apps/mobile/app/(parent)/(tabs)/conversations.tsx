import { router } from 'expo-router';
import { ScrollView } from 'react-native';

import type { ChildSummary, ConversationRow } from '../../../src/api/client';
import { ParentHeader } from '../../../src/components/parent/chrome';
import {
  Banner,
  Chip,
  Faint,
  Helper,
  ListRow,
  ParentScreen,
  TAG_TONES,
} from '../../../src/components/parent/index';
import { useResource } from '../../../src/hooks/use-resource';
import { useApp } from '../../../src/state/app-context';

/**
 * Conversations.
 *
 * Date, duration, status. Status is a PLAIN WORD — "Ended by limit", "Lost
 * connection" — never a code and never the server's own enum spelling. A parent
 * reading this list is trying to work out whether a chat went well, and
 * `ended_reason: 'session_limit'` does not answer that question.
 *
 * Chats older than the retention setting are gone, and the footer says so:
 * "we can't recover them" is a promise being kept, and a parent who does not
 * know it was made will read a short list as a bug.
 */
const STATUS_WORDS: Readonly<Record<string, { label: string; tone: keyof typeof TAG_TONES }>> = {
  ended: { label: 'Complete', tone: 'good' },
  active: { label: 'Still open', tone: 'action' },
  flagged: { label: 'Safety moment', tone: 'warn' },
};

const REASON_WORDS: Readonly<Record<string, { label: string; tone: keyof typeof TAG_TONES }>> = {
  session_limit: { label: 'Ended by limit', tone: 'warn' },
  daily_limit: { label: 'Ended by limit', tone: 'warn' },
  timeout: { label: 'Lost connection', tone: 'neutral' },
  child_ended: { label: 'Complete', tone: 'good' },
};

const when = (iso: string): string => {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  /* Wall time on purpose, and the one place it is right: "today" and
   * "yesterday" are relative to the phone the parent is holding, not to a
   * server clock. Nothing here is a decision, a limit or a deadline — it is a
   * label on a row whose real timestamp came from the API, and a Clock injected
   * for determinism would make the label wrong rather than testable. */
  // eslint-disable-next-line no-restricted-syntax
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return `Today, ${time}`;

  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;

  return `${date.toLocaleDateString([], { day: 'numeric', month: 'long' })}, ${time}`;
};

const duration = (startedAt: string, endedAt: string | null): string => {
  if (endedAt === null) return 'in progress';
  const minutes = Math.max(
    1,
    Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60_000),
  );
  return `${String(minutes)} min`;
};

export default function Conversations() {
  const { api, child, setChild } = useApp();

  const children = useResource(
    async () => await api.get<{ items: ChildSummary[] }>('/v1/children'),
    [api],
  );

  const conversations = useResource(
    async () =>
      await api.get<{ items: ConversationRow[] }>(
        `/api/conversations?childId=${child.childId ?? ''}&limit=50`,
      ),
    [api, child.childId],
  );

  return (
    <>
      <ParentHeader title="Conversations" />
      <ParentScreen testID="screen-parent-conversations" gap={8}>
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
              testID={`conv-kid-${kid.id}`}
              onPress={() => {
                setChild({ childId: kid.id, childName: kid.displayName });
              }}
            />
          ))}
        </ScrollView>

        {conversations.failure !== undefined && (
          <Banner tone="danger">{conversations.failure.message}</Banner>
        )}

        {(conversations.data?.items ?? []).length === 0 && !conversations.loading && (
          <Faint>No chats in the window your retention setting keeps.</Faint>
        )}

        {(conversations.data?.items ?? []).map((conversation) => {
          const word = (conversation.endReason === null
            ? undefined
            : REASON_WORDS[conversation.endReason]) ??
            STATUS_WORDS[conversation.status] ?? { label: conversation.status, tone: 'neutral' };
          const tone = TAG_TONES[word.tone];

          return (
            <ListRow
              key={conversation.id}
              label={when(conversation.startedAt)}
              sublabel={`${duration(conversation.startedAt, conversation.endedAt)} · ${String(
                conversation.messageCount,
              )} messages`}
              tag={{ label: word.label, bg: tone.bg, fg: tone.fg }}
              testID={`conversation-${conversation.id}`}
              onPress={() => {
                router.push({
                  pathname: '/(parent)/transcript/[conversationId]',
                  params: { conversationId: conversation.id },
                });
              }}
            />
          );
        })}

        <Helper>
          Chats older than your retention setting are gone — we can&apos;t recover them.
        </Helper>
      </ParentScreen>
    </>
  );
}
