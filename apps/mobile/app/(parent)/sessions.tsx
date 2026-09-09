import { router } from 'expo-router';
import { useState } from 'react';

import type { ParentSession } from '../../src/api/client';
import { ParentHeader } from '../../src/components/parent/chrome';
import {
  Banner,
  Card,
  CardTitle,
  DangerOutlineButton,
  Faint,
  Helper,
  Note,
  ParentScreen,
  Row,
  Tag,
  TAG_TONES,
} from '../../src/components/parent/index';
import { useResource } from '../../src/hooks/use-resource';
import { useApp } from '../../src/state/app-context';

/**
 * Where you are signed in.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO DEVICE NAME AND NO PLACE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Most "where you are signed in" screens show a device model and a city, which
 * means the product stores a user agent and resolves an IP to a location for
 * every session. We do not: `/v1/parents/me/sessions` returns a session id, an
 * expiry, and whether it is this one, because that is all the session store
 * keeps.
 *
 * That is a genuine trade and it is made deliberately. The screen is less
 * informative than it could be, and in exchange there is no table mapping this
 * family to the places they have been — which, for an account attached to
 * children, is the more valuable thing to not have. The note says so, rather
 * than leaving a parent to assume the feature is unfinished.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SIGNING OUT EVERYWHERE INCLUDES THE PHONE THE CHILD PLAYS ON
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Said out loud, before the button. The child app holds the parent's own token
 * — that is the whole authentication model — so this signs the child out too,
 * and they will meet a screen asking them to find a grown-up. A parent who
 * discovers that afterwards will reasonably think something broke.
 */
export default function Sessions() {
  const { api, signOut } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const sessions = useResource(
    async () => await api.get<{ items: ParentSession[] }>('/v1/parents/me/sessions'),
    [api],
  );

  const revokeAll = async () => {
    setBusy(true);
    setError(undefined);
    const result = await api.post('/v1/parents/me/sessions/revoke-all');
    setBusy(false);

    if (!result.ok) {
      setError('We could not sign those devices out. Nothing has changed.');
      return;
    }
    // Including this one. Anything else would be a lie in the button's label.
    await signOut();
    router.replace('/(parent)/sign-in');
  };

  const live = (sessions.data?.items ?? []).filter((session) => session.revokedAt === null);

  return (
    <>
      <ParentHeader
        title="Where you are signed in"
        onBack={() => {
          router.back();
        }}
      />
      <ParentScreen testID="screen-sessions" gap={10}>
        {error !== undefined && <Banner tone="danger">{error}</Banner>}
        {sessions.failure !== undefined && (
          <Banner tone="danger">{sessions.failure.message}</Banner>
        )}

        {live.map((session) => (
          <Card key={session.id} testID={`session-${session.id}`}>
            <Row align="center">
              <Row gap={0} align="stretch" style={{ flex: 1, flexDirection: 'column' }}>
                <CardTitle>{session.current ? 'This phone' : 'Another device'}</CardTitle>
                <Faint>Signed in until {new Date(session.expiresAt).toLocaleDateString()}</Faint>
              </Row>
              {session.current && (
                <Tag label="In use now" bg={TAG_TONES.good.bg} fg={TAG_TONES.good.fg} />
              )}
            </Row>
          </Card>
        ))}

        {live.length === 0 && !sessions.loading && <Faint>No sessions are active.</Faint>}

        <Note>
          We don&apos;t record the make of your phone or where you were when you signed in, so there
          is nothing more to show here than this.
        </Note>

        <DangerOutlineButton
          label={busy ? 'Signing out…' : 'Sign out everywhere'}
          testID="revoke-all"
          onPress={() => {
            void revokeAll();
          }}
        />
        <Helper>
          This includes the phone your child plays on. They&apos;ll be asked to find a grown-up.
        </Helper>
      </ParentScreen>
    </>
  );
}
