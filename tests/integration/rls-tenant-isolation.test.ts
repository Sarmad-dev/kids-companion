import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestDatabase,
  seedBilling,
  seedConversation,
  seedFamily,
  type SeededConversation,
  type SeededFamily,
  type TestDatabase,
} from '../helpers/database.js';

/**
 * Tenant isolation, proven AT THE DATABASE.
 *
 * These are the most important tests in the repository. The application layer is
 * the primary authorization boundary; RLS is the backstop that catches the day
 * someone forgets an ownership check. A backstop that has never been exercised
 * is a guess — so every one of these runs with the application layer entirely
 * absent, against the policies alone, as the `authenticated` role Supabase uses.
 *
 * The worst realistic failure in this product is one family reading another
 * family's child's conversations. That is what these assert cannot happen.
 */
describe('RLS tenant isolation', () => {
  let harness: TestDatabase;
  let alice: SeededFamily;
  let bob: SeededFamily;
  let aliceChat: SeededConversation;

  beforeAll(async () => {
    harness = await createTestDatabase();
    alice = await seedFamily(harness.db, 'alice');
    bob = await seedFamily(harness.db, 'bob');
    aliceChat = await seedConversation(harness.db, alice.childId);
    await seedBilling(harness.db, alice.parentId, 'alice');

    // Child-branch data for Alice only, so "Bob sees nothing" is meaningful.
    const practice = await harness.db.query<{ id: string }>(
      `insert into speech_practice (child_id, exercise_key) values ($1, 'phonics.th') returning id`,
      [alice.childId],
    );
    await harness.db.query(
      `insert into pronunciation_results (speech_practice_id, child_id, target_text, sequence, overall_score)
       values ($1, $2, 'the cat sat', 0, 0.8)`,
      [practice.rows[0]!.id, alice.childId],
    );
    await harness.db.query(
      `insert into learning_progress (child_id, skill_key, exposure_count, success_count)
       values ($1, 'vocabulary.animals', 5, 3)`,
      [alice.childId],
    );
    await harness.db.query(
      `insert into learning_events (child_id, event_type, skill_key)
       values ($1, 'skill_exposed', 'vocabulary.animals')`,
      [alice.childId],
    );
    await harness.db.query(
      `insert into consent_records (parent_id, consent_type, granted, policy_version, policy_text_hash)
       values ($1, 'privacy_policy', true, '2026-08-01', repeat('a', 64))`,
      [alice.parentId],
    );
    await harness.db.query(
      `insert into notifications (parent_id, child_id, kind, title, body)
       values ($1, $2, 'safety_flag', 'A conversation was flagged', 'Open the dashboard to review.')`,
      [alice.parentId, alice.childId],
    );
    await harness.db.query(
      `insert into analytics_events (parent_id, child_id, parent_ref, child_ref, event_name)
       values ($1, $2, 'p_alice', 'c_alice', 'conversation.turn.completed')`,
      [alice.parentId, alice.childId],
    );
  }, 180_000);

  afterAll(async () => {
    await harness.close();
  });

  /* ------------------------------------------------------------------------ */
  /* The core requirement, table by table                                     */
  /* ------------------------------------------------------------------------ */

  describe("a parent cannot read another parent's rows", () => {
    it.each([
      ['children', 'parent_id', () => alice.parentId],
      ['child_languages', 'child_id', () => alice.childId],
      ['parental_controls', 'child_id', () => alice.childId],
      ['conversations', 'child_id', () => alice.childId],
      ['messages', 'child_id', () => alice.childId],
      ['content_flags', 'child_id', () => alice.childId],
      ['speech_practice', 'child_id', () => alice.childId],
      ['pronunciation_results', 'child_id', () => alice.childId],
      ['learning_progress', 'child_id', () => alice.childId],
      ['learning_events', 'child_id', () => alice.childId],
      ['subscriptions', 'parent_id', () => alice.parentId],
      ['transactions', 'parent_id', () => alice.parentId],
      ['consent_records', 'parent_id', () => alice.parentId],
      ['notifications', 'parent_id', () => alice.parentId],
      ['analytics_events', 'parent_id', () => alice.parentId],
    ])("%s: Bob sees none of Alice's rows", async (table, column, ownerId) => {
      const rows = await harness.asParent(
        bob.parentId,
        async () =>
          (await harness.db.query(`select 1 from ${table} where ${column} = $1`, [ownerId()])).rows,
      );

      expect(rows).toHaveLength(0);
    });

    it.each([
      ['children', 'parent_id', () => alice.parentId],
      ['child_languages', 'child_id', () => alice.childId],
      ['parental_controls', 'child_id', () => alice.childId],
      ['conversations', 'child_id', () => alice.childId],
      ['messages', 'child_id', () => alice.childId],
      ['content_flags', 'child_id', () => alice.childId],
      ['speech_practice', 'child_id', () => alice.childId],
      ['pronunciation_results', 'child_id', () => alice.childId],
      ['learning_progress', 'child_id', () => alice.childId],
      ['learning_events', 'child_id', () => alice.childId],
      ['subscriptions', 'parent_id', () => alice.parentId],
      ['transactions', 'parent_id', () => alice.parentId],
      ['consent_records', 'parent_id', () => alice.parentId],
      ['notifications', 'parent_id', () => alice.parentId],
      ['analytics_events', 'parent_id', () => alice.parentId],
    ])('%s: Alice reads her own rows', async (table, column, ownerId) => {
      // The mirror of the assertion above. Without it, a policy that denies
      // everyone would pass the isolation test while breaking the product.
      const rows = await harness.asParent(
        alice.parentId,
        async () =>
          (await harness.db.query(`select 1 from ${table} where ${column} = $1`, [ownerId()])).rows,
      );

      expect(rows.length).toBeGreaterThan(0);
    });
  });

  describe('a parent can only access their own account', () => {
    it('reads only their own parent row', async () => {
      const rows = await harness.asParent(
        alice.parentId,
        async () => (await harness.db.query<{ id: string }>('select id from parents')).rows,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(alice.parentId);
    });

    it("cannot update another parent's row", async () => {
      await harness.asParent(bob.parentId, async () => {
        await harness.db.query('update parents set display_name = $1 where id = $2', [
          'Hijacked',
          alice.parentId,
        ]);
      });

      const check = await harness.db.query<{ display_name: string }>(
        'select display_name from parents where id = $1',
        [alice.parentId],
      );
      expect(check.rows[0]!.display_name).toBe('Test Parent ALICE');
    });
  });

  describe("a parent cannot access another parent's child", () => {
    it("cannot update Alice's child", async () => {
      await harness.asParent(bob.parentId, async () => {
        await harness.db.query('update children set display_name = $1 where id = $2', [
          'Hijacked',
          alice.childId,
        ]);
      });

      const check = await harness.db.query<{ display_name: string }>(
        'select display_name from children where id = $1',
        [alice.childId],
      );
      expect(check.rows[0]!.display_name).toBe('Test Child ALICE');
    });

    it("cannot delete Alice's child", async () => {
      await harness.asParent(bob.parentId, async () => {
        await harness.db.query('delete from children where id = $1', [alice.childId]);
      });

      const check = await harness.db.query('select id from children where id = $1', [
        alice.childId,
      ]);
      expect(check.rows).toHaveLength(1);
    });

    it("cannot plant a child into another parent's account", async () => {
      // Without `with check` on insert, this is a cross-tenant WRITE — arguably
      // worse than a read, because it puts data in a family's account.
      await expect(
        harness.asParent(bob.parentId, async () => {
          await harness.db.query(
            `insert into children (parent_id, display_name, birth_year, birth_month)
             values ($1, 'Planted', 2019, 6)`,
            [alice.parentId],
          );
        }),
      ).rejects.toThrow(/row-level security/i);
    });

    it("cannot attach a language to Alice's child", async () => {
      await expect(
        harness.asParent(bob.parentId, async () => {
          await harness.db.query(
            `insert into child_languages (child_id, language_code) values ($1, 'ur')`,
            [alice.childId],
          );
        }),
      ).rejects.toThrow(/row-level security/i);
    });

    it("cannot start a conversation for Alice's child", async () => {
      const character = await harness.db.query<{ id: string }>(
        `select id from ai_characters limit 1`,
      );

      await expect(
        harness.asParent(bob.parentId, async () => {
          await harness.db.query(
            'insert into conversations (child_id, character_id) values ($1, $2)',
            [alice.childId, character.rows[0]!.id],
          );
        }),
      ).rejects.toThrow(/row-level security/i);
    });

    it("cannot write a message into Alice's conversation", async () => {
      await expect(
        harness.asParent(bob.parentId, async () => {
          await harness.db.query(
            `insert into messages (conversation_id, child_id, role, sequence, content_ciphertext, content_key_id)
             values ($1, $2, 'child', 99, decode('00','hex'), 'k1')`,
            [aliceChat.conversationId, alice.childId],
          );
        }),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  describe('a soft-deleted child is invisible even to its owner', () => {
    it("disappears from the parent's view once deleted_at is set", async () => {
      const temp = await seedFamily(harness.db, 'softdel');
      await harness.db.query('update children set deleted_at = now() where id = $1', [
        temp.childId,
      ]);

      const rows = await harness.asParent(
        temp.parentId,
        async () =>
          (await harness.db.query('select id from children where id = $1', [temp.childId])).rows,
      );

      // The 30-day grace window is a deletion in progress, not a hidden row that
      // still serves reads.
      expect(rows).toHaveLength(0);
    });

    it("takes the child's conversations with it", async () => {
      const temp = await seedFamily(harness.db, 'softdel2');
      await seedConversation(harness.db, temp.childId);
      await harness.db.query('update children set deleted_at = now() where id = $1', [
        temp.childId,
      ]);

      const rows = await harness.asParent(
        temp.parentId,
        async () =>
          (
            await harness.db.query('select id from conversations where child_id = $1', [
              temp.childId,
            ])
          ).rows,
      );

      // app.owns_child() filters deleted children, so everything hanging off a
      // deleted child becomes unreachable in one place rather than table by table.
      expect(rows).toHaveLength(0);
    });
  });

  /* ------------------------------------------------------------------------ */
  /* Write restrictions                                                        */
  /* ------------------------------------------------------------------------ */

  describe('records a parent may read but must not alter', () => {
    it('cannot rewrite conversation history', async () => {
      await harness.asParent(alice.parentId, async () => {
        await harness.db
          .query('update messages set content_length = 999 where id = $1', [aliceChat.messageId])
          .catch(() => undefined);
      });

      const check = await harness.db.query<{ content_length: number }>(
        'select content_length from messages where id = $1',
        [aliceChat.messageId],
      );
      expect(check.rows[0]!.content_length).toBe(12);
    });

    it('cannot delete a safety flag', async () => {
      // A safety record a parent can erase is not a safety record.
      await harness.asParent(alice.parentId, async () => {
        await harness.db
          .query('delete from content_flags where id = $1', [aliceChat.flagId])
          .catch(() => undefined);
      });

      const check = await harness.db.query('select id from content_flags where id = $1', [
        aliceChat.flagId,
      ]);
      expect(check.rows).toHaveLength(1);
    });

    it('cannot grant themselves a subscription', async () => {
      // Subscription state comes from verified webhooks, never from a request by
      // the party who benefits from it.
      await expect(
        harness.asParent(alice.parentId, async () => {
          await harness.db.query(
            `insert into subscriptions (parent_id, plan_id, rail, status)
             select $1, p.id, 'mock', 'active' from subscription_plans p where p.code = 'family_annual'`,
            [alice.parentId],
          );
        }),
      ).rejects.toThrow();
    });

    it('cannot forge a notification', async () => {
      // A parent able to forge a "safety flag" notification could forge
      // reassurance too.
      await expect(
        harness.asParent(alice.parentId, async () => {
          await harness.db.query(
            `insert into notifications (parent_id, kind, title, body)
             values ($1, 'safety_flag', 'Fake', 'Fake')`,
            [alice.parentId],
          );
        }),
      ).rejects.toThrow();
    });

    it('cannot rewrite their own consent history', async () => {
      // Overwriting a consent row destroys exactly the evidence it exists to
      // provide. Blocked twice over: no UPDATE grant, so it fails at the
      // privilege check, and the append-only trigger behind that.
      await expect(
        harness.asParent(alice.parentId, async () => {
          await harness.db.query(
            `update consent_records set granted = false where parent_id = $1`,
            [alice.parentId],
          );
        }),
      ).rejects.toThrow(/permission denied|append-only/i);
    });

    it('cannot delete learning events', async () => {
      await expect(
        harness.asParent(alice.parentId, async () => {
          await harness.db.query('delete from learning_events where child_id = $1', [
            alice.childId,
          ]);
        }),
      ).rejects.toThrow(/permission denied|append-only/i);
    });

    it.each([['consent_records'], ['learning_events'], ['analytics_events']])(
      '%s rejects an UPDATE even from a privileged writer',
      async (table) => {
        // Run as the owner, where privileges are not the barrier — this proves
        // the append-only trigger itself, not just the missing grant.
        await expect(harness.db.query(`update ${table} set created_at = now()`)).rejects.toThrow(
          /append-only/i,
        );
      },
    );
  });

  /* ------------------------------------------------------------------------ */
  /* Tables no parent may touch                                               */
  /* ------------------------------------------------------------------------ */

  describe('operational tables are unreachable from an authenticated session', () => {
    it('denies payment_events to the authenticated role entirely', async () => {
      // No grant at all: the read fails at the privilege check, before a policy
      // is consulted. The raw webhook ledger is operational, not user-facing.
      await expect(
        harness.asParent(alice.parentId, async () => {
          await harness.db.query('select 1 from payment_events');
        }),
      ).rejects.toThrow(/permission denied/i);
    });

    it('returns no audit_logs rows to a parent', async () => {
      // audit_logs IS granted to , because admins read it. A
      // parent is stopped by policy instead — they must not be able to read the
      // record of their own actions.
      const rows = await harness.asParent(
        alice.parentId,
        async () => (await harness.db.query('select 1 from audit_logs')).rows,
      );

      expect(rows).toHaveLength(0);
    });

    it('cannot alter an audit record', async () => {
      await harness.db.query(
        `insert into audit_logs (actor_id, actor_type, action, resource_type, outcome)
         values ($1, 'parent', 'child.profile.created', 'child', 'success')`,
        [alice.parentId],
      );

      await expect(harness.db.query(`update audit_logs set outcome = 'denied'`)).rejects.toThrow(
        /append-only/i,
      );
      await expect(harness.db.query('delete from audit_logs')).rejects.toThrow(/append-only/i);
    });
  });

  /* ------------------------------------------------------------------------ */
  /* Deny by default                                                          */
  /* ------------------------------------------------------------------------ */

  describe('no identity means no rows', () => {
    it.each([
      ['parents'],
      ['children'],
      ['child_languages'],
      ['parental_controls'],
      ['conversations'],
      ['messages'],
      ['content_flags'],
      ['speech_practice'],
      ['pronunciation_results'],
      ['learning_progress'],
      ['learning_events'],
      ['subscriptions'],
      ['transactions'],
      ['consent_records'],
      ['notifications'],
      ['analytics_events'],
    ])('an unauthenticated session sees nothing in %s', async (table) => {
      // `app.current_parent_id()` returns NULL with no identity, and every policy
      // compares a column against it — `column = NULL` is never true.
      const rows = await harness.asAnonymous(
        async () => (await harness.db.query(`select 1 from ${table}`)).rows,
      );

      expect(rows).toHaveLength(0);
    });

    it.each([
      ['not json at all'],
      ['{"sub": "not-a-uuid"}'],
      ['{"sub": null}'],
      ['{}'],
      ['{"sub": ""}'],
    ])('treats the claim %s as no identity, never as a bypass', async (claims) => {
      const rows = await harness.withRawClaims(
        claims,
        async () => (await harness.db.query('select 1 from children')).rows,
      );

      expect(rows).toHaveLength(0);
    });
  });

  /* ------------------------------------------------------------------------ */
  /* Reference data                                                           */
  /* ------------------------------------------------------------------------ */

  describe('global reference data', () => {
    it.each([['ai_characters'], ['subscription_plans'], ['supported_languages']])(
      '%s is readable without owning anything — it holds no personal data',
      async (table) => {
        const rows = await harness.asAnonymous(
          async () => (await harness.db.query(`select 1 from ${table}`)).rows,
        );

        expect(rows.length).toBeGreaterThan(0);
      },
    );

    it('hides retired characters', async () => {
      await harness.db.query(
        `update ai_characters set status = 'retired' where slug = 'captain-zia'`,
      );

      const rows = await harness.asParent(
        alice.parentId,
        async () =>
          (await harness.db.query(`select slug from ai_characters where slug = 'captain-zia'`))
            .rows,
      );

      await harness.db.query(
        `update ai_characters set status = 'active' where slug = 'captain-zia'`,
      );
      expect(rows).toHaveLength(0);
    });

    it.each([['ai_characters'], ['subscription_plans'], ['supported_languages']])(
      '%s is not writable by a parent',
      async (table) => {
        // The DML grant exists so an ADMIN can curate the catalogue. A parent is
        // stopped by policy, which deletes nothing rather than raising — so the
        // assertion is that the data is still there.
        const count = async () => (await harness.db.query(`select 1 from ${table}`)).rows.length;

        const before = await count();

        await harness.asParent(alice.parentId, async () => {
          await harness.db.query(`delete from ${table}`).catch(() => undefined);
        });

        const after = await count();
        expect(after).toBe(before);
        expect(after).toBeGreaterThan(0);
      },
    );
  });
});
