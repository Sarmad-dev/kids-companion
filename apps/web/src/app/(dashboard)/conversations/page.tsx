import { Card, EmptyState, ErrorState, PageHeader, Pill } from '../../../components/ui';
import { getChildren, getConversations } from '../../../lib/api';
import { count, longDate } from '../../../lib/format';

export const dynamic = 'force-dynamic';

/**
 * Conversations.
 *
 * A list, not a surveillance feed. A parent can see that a chat happened, how
 * long it was, and whether anything was flagged — and can open one to read it,
 * which is their right over their own child's account.
 *
 * What is NOT here is a live view or a notification per message. A child who
 * believes every word is watched stops talking, and a companion nobody talks to
 * protects nobody (docs/CHILD_SAFETY.md §8).
 */
export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const children = await getChildren();

  if (children.state !== 'ok') {
    return (
      <>
        <PageHeader title="Conversations" />
        <ErrorState
          message={children.state === 'error' ? children.message : 'Please sign in again.'}
        />
      </>
    );
  }

  const items = children.data.items;
  if (items.length === 0) {
    return (
      <>
        <PageHeader title="Conversations" />
        <EmptyState title="No children yet" description="Add a child profile to see chats." />
      </>
    );
  }

  const requested = typeof params.childId === 'string' ? params.childId : undefined;
  const child = items.find((c) => c.id === requested) ?? items[0]!;
  const conversations = await getConversations(child.id);

  if (conversations.state !== 'ok') {
    return (
      <>
        <PageHeader title="Conversations" />
        <ErrorState
          message={
            conversations.state === 'error' ? conversations.message : 'Please sign in again.'
          }
        />
      </>
    );
  }

  const list = conversations.data.items;

  return (
    <>
      <PageHeader
        title={`${child.displayName}’s chats`}
        description="You can open any chat and read it. We show you that one happened; we do not notify you on every message."
      />

      {list.length === 0 ? (
        <EmptyState
          title="No chats yet"
          description={`When ${child.displayName} talks to their character, the chats appear here.`}
        />
      ) : (
        <Card>
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Recent conversations</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Character</th>
                  <th scope="col">Length</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {list.map((conversation) => (
                  <tr key={conversation.id}>
                    <th scope="row" style={{ fontWeight: 500 }}>
                      {longDate(conversation.startedAt)}
                    </th>
                    <td>{conversation.character.displayName}</td>
                    <td>{count(conversation.turnsUsed, 'turn')}</td>
                    <td>
                      {conversation.status === 'flagged' ? (
                        <Pill tone="flagged">Reviewed by our safety system</Pill>
                      ) : conversation.status === 'active' ? (
                        <Pill tone="active">In progress</Pill>
                      ) : (
                        <Pill>Finished</Pill>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="stat-caveat">
            “Reviewed by our safety system” means the app steered away from a topic during that
            chat. It is not a judgement about your child — children ask about everything.
          </p>
        </Card>
      )}
    </>
  );
}
