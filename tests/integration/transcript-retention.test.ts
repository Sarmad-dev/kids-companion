import { createMockProvider } from '@kids/ai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authHeader,
  createApiHarness,
  queryAsParent,
  registerAndLogin,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

/**
 * Transcripts being deleted when their time is up.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT WAS THERE BEFORE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `RETENTION_TRANSCRIPT_DAYS`: configured, validated, documented.
 * `parental_controls.transcript_retention_days`: a per-child column with its own
 * CHECK constraint, its own row in the parent dashboard, and a comment noting
 * that whether ninety days is right is an open question.
 *
 * Between them, nothing had ever deleted a message.
 *
 * A parent who found that setting, thought about it, and changed it to thirty
 * days was told something untrue by a product asking them to trust it with
 * their child's conversations. Every test here therefore checks the DATABASE,
 * not a return value: the only thing that matters is whether the words are
 * still there.
 */

const POLICY = { policyVersion: '2026-08-01', policyText: 'We process speech to reply.' };

/** Said by the child, so a test can go looking for it afterwards. */
const SAID = 'my rabbit is called strawberry';

describe('transcript retention', () => {
  let harness: ApiHarness;
  let parent: RegisteredParent;

  const createChild = async (displayName: string): Promise<string> => {
    const child = await harness.app.inject({
      method: 'POST',
      url: '/v1/children',
      headers: authHeader(parent.accessToken),
      payload: {
        displayName,
        birthYear: 2018,
        birthMonth: 6,
        languages: [{ languageCode: 'en', isPrimary: true }],
      },
    });
    const id = child.json<{ id: string }>().id;

    for (const [type, scoped] of [
      ['terms_of_service', undefined],
      ['privacy_policy', undefined],
      ['child_data_processing', id],
    ] as const) {
      await harness.app.inject({
        method: 'POST',
        url: '/v1/consent',
        headers: authHeader(parent.accessToken),
        payload: {
          consentType: type,
          granted: true,
          ...POLICY,
          ...(scoped === undefined ? {} : { childId: scoped }),
        },
      });
    }
    return id;
  };

  /** A finished conversation, aged so retention can act on it. */
  const conversationAged = async (childId: string, daysAgo: number): Promise<string> => {
    const started = await harness.app.inject({
      method: 'POST',
      url: '/api/conversations/start',
      headers: authHeader(parent.accessToken),
      payload: { childId },
    });
    const conversationId = started.json<{ id: string }>().id;

    await harness.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/message`,
      headers: authHeader(parent.accessToken),
      payload: { text: SAID },
    });

    await harness.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/end`,
      headers: authHeader(parent.accessToken),
      payload: {},
    });

    // The clock is the one thing a test cannot live through. Everything else —
    // the SQL, the retention arithmetic, the sweep — then runs for real on it.
    await harness.db.query(
      `update conversations
          set started_at = now() - make_interval(days => $2),
              ended_at   = now() - make_interval(days => $2)
        where id = $1`,
      [conversationId, daysAgo],
    );
    await harness.db.query(
      `update messages set created_at = now() - make_interval(days => $2) where conversation_id = $1`,
      [conversationId, daysAgo],
    );

    return conversationId;
  };

  const setRetention = async (childId: string, days: number) => {
    await harness.db.query(
      'update parental_controls set transcript_retention_days = $2 where child_id = $1',
      [childId, days],
    );
  };

  /** What the database actually still holds. The only assertion that counts. */
  const heldContent = async (conversationId: string): Promise<string[]> => {
    const { rows } = await harness.db.query<{ text: string }>(
      `select convert_from(content_ciphertext, 'UTF8') as text
         from messages where conversation_id = $1 order by sequence`,
      [conversationId],
    );
    return rows.map((row) => row.text);
  };

  beforeAll(async () => {
    harness = await createApiHarness({
      aiProvider: createMockProvider(),
      // The operator ceiling for this suite. Individual children override it
      // downward; one test proves it also caps a parent who asks for more.
      env: { RETENTION_TRANSCRIPT_DAYS: '90' },
    });
    parent = await registerAndLogin(harness, 'retention');
  }, 180_000);

  afterAll(async () => {
    await harness.close();
  });

  /* ======================================================================== */
  /* The control does something                                               */
  /* ======================================================================== */

  describe('a transcript past its retention', () => {
    it('has its words overwritten, not merely flagged', async () => {
      /* ═══════════════════════════════════════════════════════════════════
       * THE ASSERTION THIS FILE EXISTS FOR.
       * ═══════════════════════════════════════════════════════════════════
       *
       * Not "the sweep returned 2". The bytes are read back out of the column
       * afterwards, because a soft delete that leaves the ciphertext in place
       * is exactly the kind of thing that passes a shallower test.
       */
      const childId = await createChild('Rumi');
      await setRetention(childId, 30);
      const conversationId = await conversationAged(childId, 45);

      expect((await heldContent(conversationId)).join(' ')).toContain('strawberry');

      const swept = await harness.app.maintenance.expireTranscripts();
      expect(swept.messages).toBeGreaterThanOrEqual(1);

      const after = await heldContent(conversationId);
      expect(after.join(' ')).not.toContain('strawberry');
      expect(after.every((text) => text === '')).toBe(true);
    });

    it('leaves a transcript that is still within its retention alone', async () => {
      // The other half. A sweep that deletes everything would pass the test
      // above and be catastrophic.
      const childId = await createChild('Zoya');
      await setRetention(childId, 30);
      const conversationId = await conversationAged(childId, 10);

      await harness.app.maintenance.expireTranscripts();

      expect((await heldContent(conversationId)).join(' ')).toContain('strawberry');
    });

    it('records the deletion so it can be proved', async () => {
      /* A deletion nobody can prove happened is not much of a guarantee. The
       * audit row carries a count and nothing else — it must not itself become
       * something that needs deleting. */
      const childId = await createChild('Ayla');
      await setRetention(childId, 7);
      await conversationAged(childId, 30);

      await harness.app.maintenance.expireTranscripts();

      const { rows } = await harness.db.query<{ metadata: unknown; subject_child_id: string }>(
        `select metadata, subject_child_id from audit_logs
          where action = 'privacy.transcript.redacted' and subject_child_id = $1`,
        [childId],
      );

      expect(rows).toHaveLength(1);
      const metadata = rows[0]?.metadata as Record<string, unknown>;
      expect(metadata.messages).toBeGreaterThanOrEqual(1);
      // Counts only. Never a word of what was deleted.
      expect(JSON.stringify(metadata).toLowerCase()).not.toContain('strawberry');
    });
  });

  /* ======================================================================== */
  /* Whose number wins                                                        */
  /* ======================================================================== */

  describe('when the parent and the operator disagree', () => {
    it('honours the parent when they ask for less', async () => {
      /* ═══════════════════════════════════════════════════════════════════
       * THE SHORTER OF THE TWO ALWAYS WINS.
       * ═══════════════════════════════════════════════════════════════════
       *
       * A parent asking for seven days must get seven, even though the operator
       * policy in this suite is ninety. Anything else makes the setting
       * decorative again, which is the whole defect.
       */
      const childId = await createChild('Sana');
      await setRetention(childId, 7);
      const conversationId = await conversationAged(childId, 14);

      await harness.app.maintenance.expireTranscripts();

      expect((await heldContent(conversationId)).join(' ')).not.toContain('strawberry');
    });

    it('caps a parent who asks for more than the operator allows', async () => {
      // The other direction. A parent setting 365 does not get 365 when the
      // operator policy says 90 — the ceiling is a ceiling.
      const { rows } = await harness.db.query<{ days: number }>(
        'select app.effective_transcript_retention_days($1, $2) as days',
        [await createChild('Noor'), 90],
      );
      expect(rows[0]?.days).toBe(90);

      const childId = await createChild('Hina');
      await setRetention(childId, 365);
      const conversationId = await conversationAged(childId, 120);

      await harness.app.maintenance.expireTranscripts();

      expect((await heldContent(conversationId)).join(' ')).not.toContain('strawberry');
    });

    it('deletes as soon as the session is over when a parent asks for nothing', async () => {
      /* Zero is permitted by the column's CHECK and is the strongest setting a
       * parent can choose. It has to actually work, or the most privacy-minded
       * parent in the product is the one being misled. */
      const childId = await createChild('Yusuf');
      await setRetention(childId, 0);
      const conversationId = await conversationAged(childId, 0);

      await harness.app.maintenance.expireTranscripts();

      expect((await heldContent(conversationId)).join(' ')).not.toContain('strawberry');
    });
  });

  /* ======================================================================== */
  /* What must survive                                                        */
  /* ======================================================================== */

  describe('what deletion must not take with it', () => {
    it('keeps the live conversation a child is in the middle of', async () => {
      /* ═══════════════════════════════════════════════════════════════════
       * RETENTION OF ZERO MUST NOT CUT A CHILD OFF MID-SENTENCE.
       * ═══════════════════════════════════════════════════════════════════
       *
       * The engine loads recent history to keep the conversation coherent.
       * Redacting a message the moment it is written would make the character
       * lose the thread while the child was still talking to it.
       */
      const childId = await createChild('Omar');
      await setRetention(childId, 0);

      const started = await harness.app.inject({
        method: 'POST',
        url: '/api/conversations/start',
        headers: authHeader(parent.accessToken),
        payload: { childId },
      });
      const conversationId = started.json<{ id: string }>().id;

      await harness.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/message`,
        headers: authHeader(parent.accessToken),
        payload: { text: SAID },
      });

      // Not ended. The child is still there.
      await harness.app.maintenance.expireTranscripts();

      expect((await heldContent(conversationId)).join(' ')).toContain('strawberry');

      // And the next turn still works, which is the point.
      const next = await harness.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/message`,
        headers: authHeader(parent.accessToken),
        payload: { text: 'and he is very fast' },
      });
      expect(next.statusCode).toBe(200);
    });

    it('does not keep an abandoned conversation for ever', async () => {
      /* The mirror image, and the reason the guard is not simply "status is
       * active". A five-year-old does not end conversations — the app gets
       * closed, the tablet gets taken away. Without this, the way to keep a
       * transcript indefinitely would be to never press stop. */
      const childId = await createChild('Maya');
      await setRetention(childId, 0);

      const started = await harness.app.inject({
        method: 'POST',
        url: '/api/conversations/start',
        headers: authHeader(parent.accessToken),
        payload: { childId },
      });
      const conversationId = started.json<{ id: string }>().id;

      await harness.app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/message`,
        headers: authHeader(parent.accessToken),
        payload: { text: SAID },
      });

      // Still `active`, but from two days ago. Nobody is in this conversation.
      await harness.db.query(
        `update conversations set started_at = now() - interval '2 days' where id = $1`,
        [conversationId],
      );
      await harness.db.query(
        `update messages set created_at = now() - interval '2 days' where conversation_id = $1`,
        [conversationId],
      );

      await harness.app.maintenance.expireTranscripts();

      expect((await heldContent(conversationId)).join(' ')).not.toContain('strawberry');
    });

    it('keeps the safety flags attached to a deleted transcript', async () => {
      /* ═══════════════════════════════════════════════════════════════════
       * A RETENTION SETTING MUST NOT BE A WAY TO ERASE SAFETY HISTORY.
       * ═══════════════════════════════════════════════════════════════════
       *
       * `content_flags.message_id` is ON DELETE CASCADE, so deleting message
       * ROWS would take the flags with them — and a parent shortening retention
       * to seven days would silently wipe the record that anything was ever
       * flagged about their child.
       *
       * Redaction in place is what avoids that. The flag carries categories,
       * severity and a decision, and no content, so it is safe to keep and
       * worth keeping.
       */
      const childId = await createChild('Idris');
      await setRetention(childId, 7);
      const conversationId = await conversationAged(childId, 30);

      const { rows: message } = await harness.db.query<{ id: string }>(
        `select id from messages where conversation_id = $1 and role = 'child' limit 1`,
        [conversationId],
      );

      await harness.db.query(
        `insert into content_flags (child_id, message_id, conversation_id, layer, decision, categories, severity)
         values ($1, $2, $3, 'L4', 'blocked', array['test_category'], 'high')`,
        [childId, message[0]?.id, conversationId],
      );

      await harness.app.maintenance.expireTranscripts();

      expect((await heldContent(conversationId)).join(' ')).not.toContain('strawberry');

      const { rows: flags } = await harness.db.query<{ severity: string; categories: string[] }>(
        'select severity, categories from content_flags where conversation_id = $1',
        [conversationId],
      );
      expect(flags).toHaveLength(1);
      expect(flags[0]?.severity).toBe('high');
    });

    it('keeps the progress a parent has already been shown', async () => {
      // Learning events are counts and durations, not content, and they are
      // what the dashboard reads. Deleting a transcript must not silently reset
      // a child's history to zero.
      const childId = await createChild('Amina');
      await setRetention(childId, 7);
      await conversationAged(childId, 30);

      const before = await harness.app.inject({
        method: 'GET',
        url: `/api/learning/progress?childId=${childId}&period=daily&limit=7`,
        headers: authHeader(parent.accessToken),
      });
      const turnsBefore = before
        .json<{ days: { conversationTurns: number }[] }>()
        .days.reduce((sum, day) => sum + day.conversationTurns, 0);
      expect(turnsBefore).toBeGreaterThanOrEqual(1);

      await harness.app.maintenance.expireTranscripts();

      const after = await harness.app.inject({
        method: 'GET',
        url: `/api/learning/progress?childId=${childId}&period=daily&limit=7`,
        headers: authHeader(parent.accessToken),
      });
      const turnsAfter = after
        .json<{ days: { conversationTurns: number }[] }>()
        .days.reduce((sum, day) => sum + day.conversationTurns, 0);

      expect(turnsAfter).toBe(turnsBefore);
    });
  });

  /* ======================================================================== */
  /* What the parent sees                                                     */
  /* ======================================================================== */

  describe('the transcript a parent opens afterwards', () => {
    it('says the words were deleted rather than showing nothing', async () => {
      /* An empty string on its own reads as a bug. With `redactedAt` beside it,
       * it reads as the retention policy doing exactly what the parent asked
       * for — which is the difference between trust and a support ticket. */
      const childId = await createChild('Bilal');
      await setRetention(childId, 7);
      const conversationId = await conversationAged(childId, 30);

      await harness.app.maintenance.expireTranscripts();

      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/conversations/${conversationId}`,
        headers: authHeader(parent.accessToken),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        messages: { text: string; status: string; redactedAt: string | null }[];
      }>();

      expect(body.messages.length).toBeGreaterThanOrEqual(1);
      for (const message of body.messages) {
        expect(message.text).toBe('');
        expect(message.redactedAt).not.toBeNull();
      }
      expect(JSON.stringify(body)).not.toContain('strawberry');
    });
  });

  /* ======================================================================== */
  /* Reach                                                                    */
  /* ======================================================================== */

  it('is not something a parent can run against another family', async () => {
    /* The sweep is a system operation with no route. This asserts the door it
     * would come through does not exist for a parent: `authenticated` holds no
     * UPDATE grant on messages, so redaction is unreachable from a session
     * however the query is shaped. */
    const childId = await createChild('Rida');
    const conversationId = await conversationAged(childId, 1);

    /* First prove the parent CAN reach this table at all, so the refusal below
     * is a missing privilege and not a broken query or a session that never
     * worked — which is how a test like this passes for the wrong reason. */
    const readable = await queryAsParent<{ n: number }>(
      harness,
      parent.parentId,
      'select count(*)::int as n from messages where conversation_id = $1',
      [conversationId],
    );
    expect(readable[0]?.n).toBeGreaterThanOrEqual(1);

    const refusal = await queryAsParent(
      harness,
      parent.parentId,
      `update messages set content_ciphertext = ''::bytea where conversation_id = $1`,
      [conversationId],
    ).then(
      () => 'allowed' as const,
      (error: unknown) => String(error),
    );

    expect(refusal).not.toBe('allowed');
    // Named explicitly: a permission refusal, not a syntax error.
    expect(String(refusal).toLowerCase()).toContain('permission denied');

    // And the words are still there, because nothing succeeded.
    expect((await heldContent(conversationId)).join(' ')).toContain('strawberry');
  });

  /* ======================================================================== */
  /* What the parent is told                                                  */
  /* ======================================================================== */

  describe('the number a parent is shown', () => {
    /** Controls are read through the dashboard — there is no GET for them alone. */
    const controls = async (childId: string) => {
      const response = await harness.app.inject({
        method: 'GET',
        url: `/api/parent/dashboard/${childId}`,
        headers: authHeader(parent.accessToken),
      });
      expect(response.statusCode).toBe(200);
      return response.json<{
        controls: {
          transcriptRetentionDays: number;
          transcriptRetention: {
            effectiveDays: number;
            heldMessages: number;
            deletedMessages: number;
            oldestHeldAt: string | null;
          };
        };
      }>().controls;
    };

    it('is the one that applies, not the one they asked for', async () => {
      /* ═══════════════════════════════════════════════════════════════════
       * BEING QUIETLY OVERRULED IS ITS OWN KIND OF DISHONESTY.
       * ═══════════════════════════════════════════════════════════════════
       *
       * A parent asking for 365 where the operator policy is 90 gets 90. Being
       * shown 365 back while the sweep uses 90 is the same defect as the
       * setting doing nothing — the screen says one thing and the database does
       * another.
       */
      const childId = await createChild('Farah');
      await setRetention(childId, 365);

      const body = await controls(childId);
      expect(body.transcriptRetentionDays).toBe(365);
      expect(body.transcriptRetention.effectiveDays).toBe(90);
    });

    it('shows a shorter request unchanged', async () => {
      // The ceiling is a cap, never a floor.
      const childId = await createChild('Kamran');
      await setRetention(childId, 7);

      expect((await controls(childId)).transcriptRetention.effectiveDays).toBe(7);
    });

    it('counts what is still held, and what has gone', async () => {
      /* How a parent checks the promise was kept, without the answer being
       * another copy of what they asked us to delete. */
      const childId = await createChild('Laila');
      await setRetention(childId, 7);
      await conversationAged(childId, 30);

      const before = await controls(childId);
      expect(before.transcriptRetention.heldMessages).toBeGreaterThanOrEqual(1);
      expect(before.transcriptRetention.deletedMessages).toBe(0);
      expect(before.transcriptRetention.oldestHeldAt).not.toBeNull();

      await harness.app.maintenance.expireTranscripts();

      const after = await controls(childId);
      expect(after.transcriptRetention.heldMessages).toBe(0);
      expect(after.transcriptRetention.deletedMessages).toBeGreaterThanOrEqual(1);
      expect(after.transcriptRetention.oldestHeldAt).toBeNull();
    });
  });
});
