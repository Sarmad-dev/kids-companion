/**
 * Diagnostics behind the numbers in PERFORMANCE_REPORT.md.
 *
 * The load run says WHAT costs what. This says WHY, by counting the two things
 * that actually generate the cost: round trips to the AI provider, and SQL
 * statements per request.
 *
 * Run with:  npx tsx tests/performance/analyse.ts
 */

import { createMockProvider } from '@kids/ai';
import type { AIProvider } from '@kids/ai';

import { createApiHarness, registerAndLogin } from '../helpers/api.js';

/** Wraps a provider and counts every call, by operation. */
const counting = (inner: AIProvider): { provider: AIProvider; calls: Map<string, number> } => {
  const calls = new Map<string, number>();
  const note = (name: string): void => calls.set(name, (calls.get(name) ?? 0) + 1);

  const wrapped = new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      return (...args: unknown[]) => {
        note(property);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });

  return { provider: wrapped, calls };
};

/** The suite prints through stdout directly; `console` is banned repo-wide. */
const write = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

const main = async (): Promise<void> => {
  const { provider, calls } = counting(createMockProvider());

  const harness = await createApiHarness({
    aiProvider: provider,
    env: {
      RATE_LIMIT_GLOBAL_PER_MINUTE: '1000000',
      RATE_LIMIT_CONVERSATION_PER_MINUTE: '1000000',
      RATE_LIMIT_CONVERSATION_START_PER_HOUR: '1000000',
      RATE_LIMIT_VOICE_PER_MINUTE: '1000000',
      AI_PER_CHILD_DAILY_TURN_LIMIT: '1000000',
    },
  });

  const parent = await registerAndLogin(harness, 'analyse');
  const json = {
    authorization: `Bearer ${parent.accessToken}`,
    'content-type': 'application/json',
  };
  const base = await harness.app.listen({ port: 0, host: '127.0.0.1' });

  await harness.db.query(
    `update subscription_plans
        set daily_turn_limit = 1000000, max_conversation_turns = 1000000,
            concurrent_conversation_limit = 1000, daily_minute_limit = 1000000,
            child_profile_limit = 1000, daily_voice_turn_limit = 1000000
      where code = 'monthly'`,
  );

  const childId = (
    (await (
      await fetch(`${base}/v1/children`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          displayName: 'Rumi',
          birthYear: 2018,
          birthMonth: 6,
          languages: [{ languageCode: 'en', isPrimary: true }],
        }),
      })
    ).json()) as { id: string }
  ).id;

  for (const [type, scoped] of [
    ['terms_of_service', undefined],
    ['privacy_policy', undefined],
    ['child_data_processing', childId],
  ] as const) {
    await (
      await fetch(`${base}/v1/consent`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          consentType: type,
          granted: true,
          policyVersion: '2026-08-01',
          policyText: 'We process speech to reply.',
          ...(scoped === undefined ? {} : { childId: scoped }),
        }),
      })
    ).text();
  }

  await harness.db.query(
    `insert into subscriptions
       (parent_id, plan_id, rail, status, current_period_start, current_period_end)
     select $1, id, 'mock', 'active', now(), now() + interval '30 days'
       from subscription_plans where code = 'monthly'`,
    [parent.parentId],
  );
  await harness.db.query('update parental_controls set daily_minute_limit = 240');

  const conversationId = (
    (await (
      await fetch(`${base}/api/conversations/start`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ childId }),
      })
    ).json()) as { id: string }
  ).id;

  /* ---------------------------------------------------------------------- */
  /* 1. How many provider round trips does ONE turn make?                    */
  /* ---------------------------------------------------------------------- */

  calls.clear();
  await (
    await fetch(`${base}/api/conversations/${conversationId}/message`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ text: 'Tell me about elephants' }),
    })
  ).text();

  write('\n=== AI provider calls for ONE conversation turn ===');
  let total = 0;
  for (const [name, count] of [...calls.entries()].sort()) {
    write(`  ${name.padEnd(28)} ${String(count)}`);
    total += count;
  }
  write(`  ${'TOTAL'.padEnd(28)} ${String(total)}`);
  write(
    '  Every one of these is a network round trip against a real vendor,\n' +
      '  and they are sequential, so their latencies ADD.',
  );

  /* ---------------------------------------------------------------------- */
  /* 2. How many SQL statements does each endpoint issue?                    */
  /* ---------------------------------------------------------------------- */

  const measure = async (
    label: string,
    run: () => Promise<unknown>,
  ): Promise<{ label: string; statements: number }> => {
    harness.database.reset();
    await run();
    return { label, statements: harness.database.count() };
  };

  const rows = [
    await measure('GET  /health', async () => (await fetch(`${base}/health`)).text()),
    await measure('GET  /v1/children', async () =>
      (await fetch(`${base}/v1/children`, { headers: json })).text(),
    ),
    await measure('GET  /api/subscriptions/status', async () =>
      (await fetch(`${base}/api/subscriptions/status`, { headers: json })).text(),
    ),
    await measure('GET  /api/parent/dashboard/:id', async () =>
      (await fetch(`${base}/api/parent/dashboard/${childId}`, { headers: json })).text(),
    ),
    await measure('POST /api/conversations/:id/message', async () =>
      (
        await fetch(`${base}/api/conversations/${conversationId}/message`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ text: 'And what about tigers?' }),
        })
      ).text(),
    ),
  ];

  write('\n=== SQL statements per request ===');
  for (const row of rows) {
    write(`  ${row.label.padEnd(38)} ${String(row.statements).padStart(3)}`);
  }

  for (const [label, run] of [
    [
      'the dashboard',
      async () =>
        (await fetch(`${base}/api/parent/dashboard/${childId}`, { headers: json })).text(),
    ],
    [
      'one conversation turn',
      async () =>
        (
          await fetch(`${base}/api/conversations/${conversationId}/message`, {
            method: 'POST',
            headers: json,
            body: JSON.stringify({ text: 'And about whales?' }),
          })
        ).text(),
    ],
  ] as const) {
    write(`\n=== the statements ${label} runs ===`);
    harness.database.reset();
    await run();
    for (const [index, statement] of harness.database.statements().entries()) {
      write(`  ${String(index + 1).padStart(2)}. ${statement}`);
    }
  }

  await harness.close();
};

await main();
