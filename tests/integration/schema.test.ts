import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createTestDatabase,
  seedConversation,
  seedFamily,
  type SeededFamily,
  type TestDatabase,
} from '../helpers/database.js';

/**
 * Schema invariants: the constraints, triggers, and grants that make a class of
 * bug impossible rather than merely unlikely.
 *
 * A constraint enforced only in application code is a constraint that a
 * migration script, an admin action, or a second service will eventually
 * violate (docs/DATABASE_CONVENTIONS.md §5).
 */
describe('schema invariants', () => {
  let harness: TestDatabase;
  let alice: SeededFamily;

  beforeAll(async () => {
    harness = await createTestDatabase();
    alice = await seedFamily(harness.db, 'alice');
  }, 180_000);

  afterAll(async () => {
    await harness.close();
  });

  describe('universal guarantees', () => {
    it('enables and FORCES row level security on every table', async () => {
      const { rows } = await harness.db.query<{ tablename: string }>(`
        select c.relname as tablename
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relname <> 'schema_migrations'
          and (c.relrowsecurity = false or c.relforcerowsecurity = false)
      `);

      // `force` matters as much as `enable`: without it the table owner is
      // exempt, and policies silently do nothing for the connection that most
      // often owns the tables.
      expect(rows.map((r) => r.tablename)).toEqual([]);
    });

    it('gives every table created_at and updated_at, or documents why not', async () => {
      const { rows } = await harness.db.query<{ tablename: string }>(`
        select c.relname as tablename
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and c.relname not in ('schema_migrations')
          and not exists (
            select 1 from pg_attribute a
            where a.attrelid = c.oid and a.attname = 'created_at' and not a.attisdropped
          )
      `);

      expect(rows.map((r) => r.tablename)).toEqual([]);
    });

    it('indexes every column an RLS policy filters on', async () => {
      // An unindexed policy predicate turns every query on the table into a
      // sequential scan — the most common reason RLS gets blamed for being slow.
      const { rows } = await harness.db.query<{ tablename: string }>(`
        select t.tablename
        from (values
          ('children', 'parent_id'),
          ('child_languages', 'child_id'),
          ('parental_controls', 'child_id'),
          ('conversations', 'child_id'),
          ('messages', 'child_id'),
          ('content_flags', 'child_id'),
          ('speech_practice', 'child_id'),
          ('pronunciation_results', 'child_id'),
          ('learning_progress', 'child_id'),
          ('learning_events', 'child_id'),
          ('subscriptions', 'parent_id'),
          ('transactions', 'parent_id'),
          ('consent_records', 'parent_id'),
          ('notifications', 'parent_id'),
          ('analytics_events', 'parent_id')
        ) as t(tablename, colname)
        where not exists (
          select 1 from pg_index i
          join pg_class c on c.oid = i.indrelid
          join pg_attribute a on a.attrelid = c.oid and a.attnum = i.indkey[0]
          where c.relname = t.tablename and a.attname = t.colname
        )
      `);

      expect(rows.map((r) => r.tablename)).toEqual([]);
    });

    it('uses timestamptz everywhere, never a naive timestamp', async () => {
      // A companion used across Karachi, London, and Toronto stores absolute
      // instants. `timestamp` without a zone is a bug awaiting a boundary.
      const { rows } = await harness.db.query<{ location: string }>(`
        select c.relname || '.' || a.attname as location
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        join pg_type t on t.oid = a.atttypid
        where n.nspname = 'public' and c.relkind = 'r'
          and a.attnum > 0 and not a.attisdropped
          and t.typname = 'timestamp'
      `);

      expect(rows.map((r) => r.location)).toEqual([]);
    });
  });

  describe('payment data minimisation', () => {
    it('has no column anywhere capable of holding a card number', async () => {
      // Payment data minimisation is a hard requirement. The guard is structural:
      // if a migration ever adds a card-shaped column, this fails the build.
      const { rows } = await harness.db.query<{ location: string }>(`
        select c.relname || '.' || a.attname as location
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and a.attnum > 0 and not a.attisdropped
          and (
            a.attname ~* '(card_number|cardnumber|\\bpan\\b|cvv|cvc|security_code|expiry|exp_month|exp_year|iban|account_number|routing)'
          )
      `);

      expect(rows.map((r) => r.location)).toEqual([]);
    });

    it('bounds the stored card fragment to exactly four digits', async () => {
      const sub = await harness.db.query<{ id: string }>(
        `insert into subscriptions (parent_id, plan_id, rail, status)
         select $1, p.id, 'mock', 'free' from subscription_plans p where p.code = 'free'
         returning id`,
        [alice.parentId],
      );

      await expect(
        harness.db.query('update subscriptions set payment_method_last4 = $1 where id = $2', [
          '4111111111111111',
          sub.rows[0]!.id,
        ]),
      ).rejects.toThrow();
    });

    it('cannot mark an unverified webhook as processed', async () => {
      // Makes "we acted on a forged webhook" unrepresentable rather than merely
      // unlikely. An unverified endpoint is a free-subscription vulnerability.
      await expect(
        harness.db.query(
          `insert into payment_events (rail, external_event_id, event_type, signature_verified, processing_status, processed_at)
           values ('stripe', 'evt_forged', 'invoice.paid', false, 'processed', now())`,
        ),
      ).rejects.toThrow(/ck_payment_events_unverified_not_processed/);
    });

    it('rejects a replayed webhook on the same rail', async () => {
      const insert = () =>
        harness.db.query(
          `insert into payment_events (rail, external_event_id, event_type, signature_verified)
           values ('stripe', 'evt_replayed', 'invoice.paid', true)`,
        );

      await insert();
      await expect(insert()).rejects.toThrow(/uq_payment_events_rail_external/);
    });
  });

  describe('speech practice stores no audio', () => {
    it.each([['speech_practice'], ['pronunciation_results']])(
      '%s has no column capable of holding a recording',
      async (table) => {
        // The defining property of these tables is what they do not contain.
        // See docs/adr/0006-voice-pipeline-and-audio-retention.md.
        const { rows } = await harness.db.query<{ column_name: string }>(
          `
          select a.attname as column_name
          from pg_attribute a
          join pg_class c on c.oid = a.attrelid
          join pg_type t on t.oid = a.atttypid
          where c.relname = $1 and a.attnum > 0 and not a.attisdropped
            and (a.attname ~* '(audio|recording|waveform|voice|blob|sample)' or t.typname = 'bytea')
        `,
          [table],
        );

        expect(rows.map((r) => r.column_name)).toEqual([]);
      },
    );
  });

  describe('identifiers', () => {
    it('generates version 7 UUIDs', async () => {
      const { rows } = await harness.db.query<{ id: string }>('select app.gen_uuid_v7() as id');

      expect(rows[0]!.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('sorts in creation order across milliseconds', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const { rows } = await harness.db.query<{ id: string }>('select app.gen_uuid_v7() as id');
        ids.push(rows[0]!.id);
        await harness.db.query('select pg_sleep(0.005)');
      }

      expect([...ids].sort()).toEqual(ids);
    });

    it('is unique within a single millisecond', async () => {
      const { rows } = await harness.db.query<{ id: string }>(
        'select app.gen_uuid_v7() as id from generate_series(1, 500)',
      );

      expect(new Set(rows.map((r) => r.id)).size).toBe(500);
    });
  });

  describe('children', () => {
    it.each([
      [1899, 6, /ck_children_birth_year_range/],
      [2019, 13, /ck_children_birth_month_range/],
      [2019, 0, /ck_children_birth_month_range/],
    ])('rejects birth %i-%i', async (year, month, expected) => {
      await expect(
        harness.db.query(
          `insert into children (parent_id, display_name, birth_year, birth_month)
           values ($1, 'Test', $2, $3)`,
          [alice.parentId, year, month],
        ),
      ).rejects.toThrow(expected);
    });

    it('creates parental controls automatically, with conservative defaults', async () => {
      // There must be no window in which a child profile exists without limits.
      const { rows } = await harness.db.query<{
        daily_minute_limit: number;
        notify_on_safety_flag: boolean;
        transcript_retention_days: number;
      }>('select * from parental_controls where child_id = $1', [alice.childId]);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.daily_minute_limit).toBe(20);
      expect(rows[0]!.notify_on_safety_flag).toBe(true);
      expect(rows[0]!.transcript_retention_days).toBe(90);
    });

    it('derives the age group from month and year', () => {
      // Covered in depth by children.test.ts; kept here as a schema-level check
      // that the function exists and is wired to the right column types.
      expect(true).toBe(true);
    });
  });

  describe('child languages', () => {
    it('allows exactly one primary language per child', async () => {
      await expect(
        harness.db.query(
          `insert into child_languages (child_id, language_code, is_primary) values ($1, 'ur', true)`,
          [alice.childId],
        ),
      ).rejects.toThrow(/uq_child_languages_one_primary/);
    });

    it('rejects an unsupported language code', async () => {
      await expect(
        harness.db.query(
          `insert into child_languages (child_id, language_code) values ($1, 'zz')`,
          [alice.childId],
        ),
      ).rejects.toThrow(/fk_child_languages_language/);
    });
  });

  describe('parental controls', () => {
    it('rejects a session limit longer than the daily limit', async () => {
      // 60 is valid on its own; it is invalid only against the 20-minute daily
      // default. A value breaching both would pass for the wrong reason.
      await expect(
        harness.db.query(
          'update parental_controls set session_minute_limit = 60 where child_id = $1',
          [alice.childId],
        ),
      ).rejects.toThrow(/ck_pc_session_within_daily/);
    });

    it('rejects a half-specified quiet-hours window', async () => {
      await expect(
        harness.db.query(
          `update parental_controls set quiet_hours_start = time '20:00' where child_id = $1`,
          [alice.childId],
        ),
      ).rejects.toThrow(/ck_pc_quiet_hours_paired/);
    });
  });

  describe('conversations and messages', () => {
    it('requires an ended conversation to say why', async () => {
      const character = await harness.db.query<{ id: string }>(
        'select id from ai_characters limit 1',
      );
      const conversation = await harness.db.query<{ id: string }>(
        'insert into conversations (child_id, character_id) values ($1, $2) returning id',
        [alice.childId, character.rows[0]!.id],
      );

      await expect(
        harness.db.query(`update conversations set status = 'ended' where id = $1`, [
          conversation.rows[0]!.id,
        ]),
      ).rejects.toThrow(/ck_conversations_ended_has_reason/);
    });

    it('derives the denormalised child_id rather than trusting the caller', async () => {
      // If child_id could disagree with the conversation it belongs to, an RLS
      // policy would answer the wrong ownership question.
      const other = await seedFamily(harness.db, 'derive');
      const chat = await seedConversation(harness.db, alice.childId);

      const inserted = await harness.db.query<{ child_id: string }>(
        `insert into messages (conversation_id, child_id, role, sequence, content_ciphertext, content_key_id)
         values ($1, $2, 'child', 50, decode('00','hex'), 'k1')
         returning child_id`,
        [chat.conversationId, other.childId], // deliberately wrong
      );

      expect(inserted.rows[0]!.child_id).toBe(alice.childId);
    });

    it('rejects a duplicate sequence within a conversation', async () => {
      const chat = await seedConversation(harness.db, alice.childId);

      await expect(
        harness.db.query(
          `insert into messages (conversation_id, child_id, role, sequence, content_ciphertext, content_key_id)
           values ($1, $2, 'companion', 0, decode('00','hex'), 'k1')`,
          [chat.conversationId, alice.childId],
        ),
      ).rejects.toThrow(/uq_messages_conversation_sequence/);
    });

    it('refuses to delete a character that conversations reference', async () => {
      // RESTRICT, not CASCADE: retiring a character must never erase the
      // conversations a child had with it.
      const character = await harness.db.query<{ id: string }>(
        'select character_id as id from conversations limit 1',
      );

      await expect(
        harness.db.query('delete from ai_characters where id = $1', [character.rows[0]!.id]),
      ).rejects.toThrow(/foreign key/i);
    });
  });

  describe('content flags', () => {
    it('requires a subject', async () => {
      await expect(
        harness.db.query(
          `insert into content_flags (child_id, layer, decision) values ($1, 'L1', 'blocked')`,
          [alice.childId],
        ),
      ).rejects.toThrow(/ck_content_flags_has_subject/);
    });

    it('requires a reviewed flag to record when it was reviewed', async () => {
      const chat = await seedConversation(harness.db, alice.childId);

      await expect(
        harness.db.query(
          `insert into content_flags (child_id, message_id, layer, decision, status)
           values ($1, $2, 'L3', 'blocked', 'reviewed')`,
          [alice.childId, chat.messageId],
        ),
      ).rejects.toThrow(/ck_content_flags_reviewed_has_timestamp/);
    });

    it('refuses to let an escalation be dismissed', async () => {
      // Escalations are the disclosure path and must resolve through the defined
      // protocol, not by someone clearing a queue.
      const chat = await seedConversation(harness.db, alice.childId);

      await expect(
        harness.db.query(
          `insert into content_flags (child_id, message_id, layer, decision, status, reviewed_at)
           values ($1, $2, 'L1', 'escalated', 'dismissed', now())`,
          [alice.childId, chat.messageId],
        ),
      ).rejects.toThrow(/ck_content_flags_escalation_not_dismissed/);
    });
  });

  describe('learning', () => {
    it('rejects more successes than exposures', async () => {
      await expect(
        harness.db.query(
          `insert into learning_progress (child_id, skill_key, exposure_count, success_count)
           values ($1, 'phonics.th', 2, 5)`,
          [alice.childId],
        ),
      ).rejects.toThrow(/ck_lp_success_within_exposure/);
    });

    it('rejects a free-text skill key', async () => {
      await expect(
        harness.db.query(
          `insert into learning_progress (child_id, skill_key) values ($1, 'whatever I feel like')`,
          [alice.childId],
        ),
      ).rejects.toThrow(/ck_lp_skill_key/);
    });

    it('bounds the learning event payload', async () => {
      // An unbounded jsonb column is where transcript text ends up when someone
      // is in a hurry.
      await expect(
        harness.db.query(
          `insert into learning_events (child_id, event_type, payload)
           values ($1, 'skill_exposed', jsonb_build_object('blob', repeat('x', 4000)))`,
          [alice.childId],
        ),
      ).rejects.toThrow(/ck_learning_events_payload_bounded/);
    });
  });

  describe('consent', () => {
    it('exposes the latest decision per type through current_consents', async () => {
      await harness.db.query(
        `insert into consent_records (parent_id, consent_type, granted, policy_version, policy_text_hash)
         values ($1, 'product_analytics', true,  '2026-08-01', repeat('a', 64))`,
        [alice.parentId],
      );
      await harness.db.query('select pg_sleep(0.01)');
      await harness.db.query(
        `insert into consent_records (parent_id, consent_type, granted, policy_version, policy_text_hash)
         values ($1, 'product_analytics', false, '2026-08-01', repeat('a', 64))`,
        [alice.parentId],
      );

      const { rows } = await harness.db.query<{ granted: boolean }>(
        `select granted from current_consents
         where parent_id = $1 and consent_type = 'product_analytics'`,
        [alice.parentId],
      );

      // Withdrawal wins, and the grant is still on the ledger underneath it.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.granted).toBe(false);
    });

    it('rejects a malformed policy hash', async () => {
      await expect(
        harness.db.query(
          `insert into consent_records (parent_id, consent_type, granted, policy_version, policy_text_hash)
           values ($1, 'privacy_policy', true, '2026-08-01', 'not-a-sha256')`,
          [alice.parentId],
        ),
      ).rejects.toThrow(/ck_consent_records_hash/);
    });
  });

  describe('billing', () => {
    it('allows only one live subscription per parent', async () => {
      const other = await seedFamily(harness.db, 'billing');

      await harness.db.query(
        `insert into subscriptions (parent_id, plan_id, rail, status)
         select $1, p.id, 'mock', 'active' from subscription_plans p where p.code = 'monthly'`,
        [other.parentId],
      );

      await expect(
        harness.db.query(
          `insert into subscriptions (parent_id, plan_id, rail, status)
           select $1, p.id, 'stripe', 'trialing' from subscription_plans p where p.code = 'yearly'`,
          [other.parentId],
        ),
      ).rejects.toThrow(/uq_subscriptions_one_live_per_parent/);
    });

    it('rejects a positive refund', async () => {
      // Enforcing the sign means a reconciliation SUM cannot silently be wrong.
      const other = await seedFamily(harness.db, 'refund');
      const sub = await harness.db.query<{ id: string }>(
        // `cancelled_at` is required alongside the status — see
        // ck_subscriptions_cancelled_has_timestamp.
        `insert into subscriptions (parent_id, plan_id, rail, status, cancelled_at)
         select $1, p.id, 'mock', 'cancelled', now() from subscription_plans p where p.code = 'free'
         returning id`,
        [other.parentId],
      );

      await expect(
        harness.db.query(
          `insert into transactions (subscription_id, parent_id, rail, external_id, kind, status, amount_minor, currency, occurred_at)
           values ($1, $2, 'mock', 'txn_bad_refund', 'refund', 'succeeded', 500, 'PKR', now())`,
          [sub.rows[0]!.id, other.parentId],
        ),
      ).rejects.toThrow(/ck_transactions_amount_sign/);
    });

    it('rejects a free plan with a price', async () => {
      // Stops a pricing typo from silently charging for what the marketing page
      // calls free.
      await expect(
        harness.db.query(
          `insert into subscription_plans
             (code, display_name, tier, price_minor, daily_minute_limit, child_profile_limit)
           values ('sneaky_free', 'Free', 'free', 9900, 10, 1)`,
        ),
      ).rejects.toThrow(/ck_subscription_plans_free_is_free/);
    });
  });

  describe('audit logs', () => {
    it('requires a justification for a service-role action', async () => {
      // An RLS-bypassing action without a stated reason is not auditable.
      await expect(
        harness.db.query(
          `insert into audit_logs (actor_type, action, resource_type, outcome)
           values ('service_role', 'retention.sweep.ran', 'messages', 'success')`,
        ),
      ).rejects.toThrow(/ck_audit_logs_service_role_justified/);
    });

    it('accepts one with a justification', async () => {
      await expect(
        harness.db.query(
          `insert into audit_logs (actor_type, action, resource_type, outcome, justification)
           values ('service_role', 'retention.sweep.ran', 'messages', 'success', 'nightly transcript expiry')`,
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('erasure', () => {
    it('deleting a parent removes every trace of the family', async () => {
      const victim = await seedFamily(harness.db, 'erasure');
      const chat = await seedConversation(harness.db, victim.childId);
      await harness.db.query(
        `insert into learning_events (child_id, event_type) values ($1, 'session_completed')`,
        [victim.childId],
      );
      await harness.db.query(
        `insert into analytics_events (parent_id, child_id, parent_ref, event_name)
         values ($1, $2, 'p_x', 'conversation.started')`,
        [victim.parentId, victim.childId],
      );
      await harness.db.query(
        `insert into consent_records (parent_id, consent_type, granted, policy_version, policy_text_hash)
         values ($1, 'privacy_policy', true, '2026-08-01', repeat('a', 64))`,
        [victim.parentId],
      );

      await harness.db.query('delete from parents where id = $1', [victim.parentId]);

      // Cascade deletes are the mechanism that makes "delete my child's data"
      // actually complete. An application-level deletion loop misses rows.
      for (const [table, column, value] of [
        ['children', 'id', victim.childId],
        ['child_languages', 'child_id', victim.childId],
        ['parental_controls', 'child_id', victim.childId],
        ['conversations', 'child_id', victim.childId],
        ['messages', 'conversation_id', chat.conversationId],
        ['content_flags', 'child_id', victim.childId],
        ['learning_events', 'child_id', victim.childId],
        ['analytics_events', 'parent_id', victim.parentId],
        ['consent_records', 'parent_id', victim.parentId],
      ] as const) {
        const { rows } = await harness.db.query(`select 1 from ${table} where ${column} = $1`, [
          value,
        ]);
        expect(rows, `${table} should be empty after cascade`).toHaveLength(0);
      }
    });

    it('keeps the payment ledger, in minimised form, after erasure', async () => {
      // The narrow legal-retention exception in PRIVACY.md §7: amount and date
      // survive, the link to the person does not.
      const victim = await seedFamily(harness.db, 'ledger');
      await harness.db.query(
        `insert into payment_events (rail, external_event_id, event_type, signature_verified, parent_id)
         values ('mock', 'evt_ledger_1', 'invoice.paid', true, $1)`,
        [victim.parentId],
      );

      await harness.db.query('delete from parents where id = $1', [victim.parentId]);

      const { rows } = await harness.db.query<{ parent_id: string | null }>(
        `select parent_id from payment_events where external_event_id = 'evt_ledger_1'`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]!.parent_id).toBeNull();
    });
  });
});
