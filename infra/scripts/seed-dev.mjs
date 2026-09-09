#!/usr/bin/env node
/**
 * Development-only fixtures.
 *
 *   pnpm db:seed:dev
 *
 * NOT a migration, deliberately. Migrations run in every environment; these
 * records must never exist in staging or production. Keeping them in a script
 * with a hard environment guard makes "seeded a test family into production"
 * something that cannot happen by running the normal deploy.
 *
 * All data here is obviously synthetic — `@example.invalid` addresses, names of
 * the form "Test Child A". Never a real-looking name with a real-looking
 * birthday: plausible fake data eventually gets mistaken for real, or real data
 * gets pasted in beside it and nobody notices (docs/TESTING_STANDARDS.md §6).
 */

import { postgresTls } from '@kids/db';
import pg from 'pg';

const APP_ENV = process.env.APP_ENV ?? 'local';
const ALLOWED = new Set(['local', 'ci']);

if (!ALLOWED.has(APP_ENV)) {
  console.error(
    `Refusing to seed development data with APP_ENV=${APP_ENV}.\n` +
      'These are synthetic test records and must never exist outside local or ci.\n' +
      'No production or staging environment has a legitimate reason to run this.',
  );
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.\n\n  cp .env.example .env   # then: pnpm docker:up\n');
  process.exit(78); // EX_CONFIG
}

const client = new pg.Client({
  connectionString: url,
  ssl: postgresTls({
    mode: process.env.DATABASE_SSL_MODE,
    rootCert: process.env.DATABASE_SSL_ROOT_CERT,
  }),
});
await client.connect();

/** Deterministic UUIDs so re-seeding is idempotent and fixtures are referable. */
const IDS = {
  parentA: '00000000-0000-4000-8000-00000000a001',
  parentB: '00000000-0000-4000-8000-00000000b001',
  childA1: '00000000-0000-4000-8000-00000000a101',
  childA2: '00000000-0000-4000-8000-00000000a102',
  childB1: '00000000-0000-4000-8000-00000000b101',
};

try {
  await client.query('begin');

  // Two families, because a single-family fixture set makes it impossible to
  // notice a cross-tenant leak while clicking around by hand.
  await client.query(
    `insert into parents (id, email, display_name, country_code, locale, status)
     values ($1, 'parent-a@example.invalid', 'Test Parent A', 'PK', 'en', 'active'),
            ($2, 'parent-b@example.invalid', 'Test Parent B', 'PK', 'ur', 'active')
     on conflict (id) do nothing`,
    [IDS.parentA, IDS.parentB],
  );

  // Age bands chosen to cover the extremes: a 3-year-old and a 9-year-old have
  // materially different turn lengths, vocabulary ceilings, and content policy.
  await client.query(
    `insert into children (id, parent_id, display_name, birth_year, birth_month, interests)
     values ($1, $3, 'Test Child A1', 2022, 4, array['animals','trucks']),
            ($2, $3, 'Test Child A2', 2017, 9, array['space','football']),
            ($4, $5, 'Test Child B1', 2019, 1, array['stories'])
     on conflict (id) do nothing`,
    [IDS.childA1, IDS.childA2, IDS.parentA, IDS.childB1, IDS.parentB],
  );

  await client.query(
    `insert into child_languages (child_id, language_code, is_primary, proficiency)
     values ($1, 'en', true,  'learning'),
            ($2, 'en', true,  'conversational'),
            ($2, 'ur', false, 'conversational'),
            ($3, 'ur', true,  'native'),
            ($3, 'en', false, 'learning')
     on conflict do nothing`,
    [IDS.childA1, IDS.childA2, IDS.childB1],
  );

  // A free subscription for A, so entitlement code has something to resolve.
  await client.query(
    `insert into subscriptions (parent_id, plan_id, rail, status, currency, price_minor)
     select $1, p.id, 'mock', 'free', p.currency, p.price_minor
     from subscription_plans p where p.code = 'free'
     on conflict do nothing`,
    [IDS.parentA],
  );

  // A conversation with a couple of messages, so the dashboard has something to
  // render. Content is a placeholder ciphertext — the crypto module lands with
  // the conversation engine, and no real child speech exists to encrypt.
  const conversation = await client.query(
    `insert into conversations (child_id, character_id, language_code, status, message_count, end_reason)
     select $1, c.id, 'en', 'ended', 2, 'child_ended'
     from ai_characters c where c.slug = 'pip-the-fox'
     returning id`,
    [IDS.childA1],
  );

  if (conversation.rows.length > 0) {
    const conversationId = conversation.rows[0].id;
    await client.query(
      `insert into messages (conversation_id, role, sequence, content_ciphertext, content_key_id, content_length)
       values ($1, 'child',     0, decode('00', 'hex'), 'dev', 18),
              ($1, 'companion', 1, decode('00', 'hex'), 'dev', 42)`,
      [conversationId],
    );
  }

  await client.query(
    `insert into learning_progress (child_id, skill_key, exposure_count, success_count)
     values ($1, 'vocabulary.animals', 12, 8),
            ($1, 'conversation.turn_taking', 20, 15)
     on conflict (child_id, skill_key) do nothing`,
    [IDS.childA1],
  );

  await client.query(
    `insert into consent_records
       (parent_id, consent_type, granted, policy_version, policy_text_hash)
     values ($1, 'terms_of_service',      true, '2026-08-01', repeat('a', 64)),
            ($1, 'privacy_policy',        true, '2026-08-01', repeat('b', 64)),
            ($1, 'child_data_processing', true, '2026-08-01', repeat('c', 64)),
            ($1, 'product_analytics',    false, '2026-08-01', repeat('d', 64))`,
    [IDS.parentA],
  );

  await client.query('commit');

  console.log('Development fixtures seeded:');
  console.log('  2 parents (A, B — two families, so cross-tenant leaks are visible by hand)');
  console.log('  3 children, 5 child languages');
  console.log('  1 free subscription, 1 conversation with 2 messages');
  console.log('  2 learning progress rows, 4 consent records');
  console.log(`\n  Parent A: ${IDS.parentA}`);
  console.log(`  Parent B: ${IDS.parentB}`);
} catch (error) {
  await client.query('rollback');
  console.error(`Seeding failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
