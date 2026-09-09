/**
 * The performance suite.
 *
 * Run with:  pnpm run perf
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS MEASURES — AND THE THREE THINGS IT CANNOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Measured: our own server-side code. Real HTTP over a real loopback socket,
 * real routing, real auth, real Zod serialisation, real SQL, real RLS. That is
 * the part we write and the part we can fix.
 *
 * NOT measured, and no number here should be read as covering them:
 *
 *   1. VENDOR LATENCY. STT, the LLM, and TTS are mocks. Their real latency is
 *      the majority of the voice-loop budget in ARCHITECTURE.md §7.1, and
 *      nothing in this file predicts it. One scenario deliberately INJECTS a
 *      representative provider delay — that is arithmetic about the budget, not
 *      a measurement of a vendor.
 *
 *   2. PRODUCTION POSTGRES. The database is PGlite: Postgres compiled to
 *      WebAssembly, in-process, on ONE connection, with no network hop, no
 *      pool, and a different planner cost model. Its absolute numbers are not
 *      production numbers. What survives the move is the SHAPE — which queries
 *      are heavy relative to each other, and where a request count grows.
 *
 *   3. THE CLIENT. VAD endpointing and mobile upload are two line items in the
 *      budget and both happen on a phone in Pakistan.
 *
 * Everything is closed-loop; see harness.ts for why that makes the tail an
 * under-estimate.
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { createMockProvider } from '@kids/ai';
import { signMockWebhook } from '@kids/payments';
import { silentWav } from '@kids/voice';

import {
  createApiHarness,
  MOCK_WEBHOOK_SECRET,
  registerAndLogin,
  TEST_PASSWORD,
  type ApiHarness,
  type RegisteredParent,
} from '../helpers/api.js';

import {
  CONCURRENCY_LADDER,
  formatSummary,
  runLoad,
  type RequestOutcome,
  type Summary,
} from './harness.js';

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

const okIf = (response: Response, expected: number): RequestOutcome =>
  response.status === expected
    ? { ok: true }
    : { ok: false, detail: `expected ${String(expected)}, got ${String(response.status)}` };

/** Reads and discards the body — an unread body is not a completed request. */
const drain = async (response: Response): Promise<Response> => {
  await response.text();
  return response;
};

const multipartBody = (
  fields: Record<string, string>,
  file: { field: string; filename: string; contentType: string; bytes: Uint8Array },
): { payload: Buffer; contentType: string } => {
  const boundary = '----kidsCompanionPerfBoundary91c';
  const chunks: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }

  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
    ),
    Buffer.from(file.bytes),
    Buffer.from('\r\n'),
    Buffer.from(`--${boundary}--\r\n`),
  );

  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
};

/* -------------------------------------------------------------------------- */
/* Scenario plumbing                                                           */
/* -------------------------------------------------------------------------- */

interface Scenario {
  readonly key: string;
  readonly title: string;
  /** What a reader should take from this scenario, and what they should not. */
  readonly note: string;
  readonly samples: number;
  readonly warmup: number;
  /** Defaults to the full ladder. */
  readonly ladder?: readonly number[];
  /**
   * Runs before each rung of the ladder, outside the measured window.
   *
   * Exists because a conversation is not a load-test fixture you can reuse
   * forever: every turn appends two rows, and a scenario that sends thousands
   * of turns into ONE conversation ends up measuring a transcript no child
   * will ever have. Scenarios that append rotate their fixtures here.
   */
  readonly beforeStep?: () => Promise<void>;
  readonly request: (index: number) => Promise<RequestOutcome>;
}

const results: { scenario: Scenario; runs: Summary[] }[] = [];

/**
 * Shrinks the run for a smoke check (`PERF_SCALE=0.02`).
 *
 * Never used for a reported figure: a scaled run cannot produce an honest p99,
 * and the report says so by carrying the sample count in every table.
 */
const SCALE = Number(process.env.PERF_SCALE ?? '1');
const LADDER = process.env.PERF_LADDER
  ? process.env.PERF_LADDER.split(',').map((value) => Number(value))
  : undefined;

const execute = async (scenario: Scenario): Promise<void> => {
  process.stdout.write(`\n${scenario.title}\n`);
  const runs: Summary[] = [];

  for (const concurrency of LADDER ?? scenario.ladder ?? CONCURRENCY_LADDER) {
    await scenario.beforeStep?.();

    const summary = await runLoad({
      scenario: scenario.key,
      concurrency,
      totalRequests: Math.max(1, Math.round(scenario.samples * SCALE)),
      warmup: Math.max(1, Math.round(scenario.warmup * SCALE)),
      request: scenario.request,
    });
    runs.push(summary);
    process.stdout.write(`${formatSummary(summary)}\n`);
  }

  results.push({ scenario, runs });
};

/* ========================================================================== */
/* Fixtures                                                                    */
/* ========================================================================== */

const POLICY = { policyVersion: '2026-08-01', policyText: 'We process speech to reply.' };

const main = async (): Promise<void> => {
  process.stdout.write('booting the application under test...\n');

  /* A provider with no injected delay. Every millisecond a conversation turn
   * costs in this harness is therefore OURS: safety, context assembly,
   * persistence, serialisation. That is the number worth knowing, because it is
   * the number we can change. */
  const instantProvider = createMockProvider();

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THE LIMITER IS RAISED HERE, AND THAT IS REPORTED, NOT HIDDEN.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * With production limits every scenario below would measure
   * `@fastify/rate-limit` saying no — `RATE_LIMIT_GLOBAL_PER_MINUTE` alone is
   * 600, and several scenarios send more than that. The goal here is the cost
   * of the ENDPOINT, so the limiter is lifted out of the way.
   *
   * The limits themselves are a real capacity ceiling and are reported as one
   * in PERFORMANCE_REPORT.md, next to the throughput each endpoint can
   * actually sustain. Scenario 11 measures the limiter deliberately.
   *
   * One limit is NOT raised because it cannot be: the subscription webhook
   * carries a hard-coded 600/minute in its route config. That scenario is
   * sized to stay under it.
   */
  const harness: ApiHarness = await createApiHarness({
    aiProvider: instantProvider,
    env: {
      RATE_LIMIT_GLOBAL_PER_MINUTE: '1000000',
      RATE_LIMIT_CHECKOUT_PER_HOUR: '1000000',
      RATE_LIMIT_AUTH_PER_15_MIN: '1000000',
      RATE_LIMIT_CONVERSATION_PER_MINUTE: '1000000',
      RATE_LIMIT_CONVERSATION_START_PER_HOUR: '1000000',
      RATE_LIMIT_VOICE_PER_MINUTE: '1000000',
      RATE_LIMIT_UPLOAD_PER_MINUTE: '1000000',
      // The operational ceiling that sits on top of the plan. Real value: 300.
      AI_PER_CHILD_DAILY_TURN_LIMIT: '1000000',
      // The whole run outlives the real 15-minute access token, and a scenario
      // that starts returning 401 half way through measures nothing.
      AUTH_ACCESS_TOKEN_TTL: '4h',
    },
  });
  const base = await harness.app.listen({ port: 0, host: '127.0.0.1' });

  const parent: RegisteredParent = await registerAndLogin(harness, 'perf-main');
  const auth = { authorization: `Bearer ${parent.accessToken}` };
  const json = { ...auth, 'content-type': 'application/json' };

  const createChild = async (name: string): Promise<string> => {
    const response = await fetch(`${base}/v1/children`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        displayName: name,
        birthYear: 2018,
        birthMonth: 6,
        languages: [{ languageCode: 'en', isPrimary: true }],
      }),
    });
    const body = (await response.json()) as { id: string };
    return body.id;
  };

  const consent = async (childId: string): Promise<void> => {
    for (const [type, scoped] of [
      ['terms_of_service', undefined],
      ['privacy_policy', undefined],
      ['child_data_processing', childId],
    ] as const) {
      await drain(
        await fetch(`${base}/v1/consent`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({
            consentType: type,
            granted: true,
            ...POLICY,
            ...(scoped === undefined ? {} : { childId: scoped }),
          }),
        }),
      );
    }
  };

  const startConversation = async (childId: string): Promise<string> => {
    await harness.db.query(
      `update conversations set status = 'ended', ended_at = now(),
              end_reason = coalesce(end_reason, 'parent_ended')
        where child_id = $1 and status = 'active'`,
      [childId],
    );
    const response = await fetch(`${base}/api/conversations/start`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ childId }),
    });
    const body = (await response.json()) as { id: string };
    return body.id;
  };

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THE TURN QUOTA IS LIFTED HERE TOO, AND REPORTED.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * A paid plan allows 40 turns per child per day and 40 turns in one
   * conversation. Those are product limits doing exactly their job — and a
   * scenario that sends 600 messages spends 40 of them measuring the endpoint
   * and 560 measuring the quota refusing.
   *
   * So the plan is widened in this throwaway database only. The real numbers
   * are a capacity fact in their own right and appear in the report: no child
   * can cost more than 40 turns a day however hard anything pushes.
   */
  const liftQuotas = async (): Promise<void> => {
    await harness.db.query(
      `update subscription_plans
          set daily_turn_limit = 1000000,
              max_conversation_turns = 1000000,
              concurrent_conversation_limit = 1000,
              daily_minute_limit = 1000000,
              child_profile_limit = 1000,
              weekly_story_limit = 1000000,
              daily_voice_turn_limit = 1000000
        where code = 'monthly'`,
    );
  };

  /**
   * Parental controls carry their OWN daily minute budget, per child, default 20.
   *
   * That is a second, independent quota system from the plan, and it is the one
   * that bit hardest: a pool of open conversations accrues session minutes fast,
   * so twenty minutes of allowance is gone long before a scenario finishes and
   * every subsequent turn — and every new conversation — is correctly refused.
   *
   * Raised for measurement, and reported as the real limit it is.
   */
  const liftChildControls = async (): Promise<void> => {
    // 240/120 are the maxima the schema permits — `ck_pc_daily_minute_limit`
    // refuses anything larger, and correctly so.
    await harness.db.query(
      'update parental_controls set daily_minute_limit = 240, session_minute_limit = 120',
    );

    /* Raising the ceiling is not enough on its own, because the budget is spent
     * by WALL-CLOCK session time and a pool of conversations accrues it in
     * parallel — ten open sessions burn ten minutes a minute. So finished
     * sessions are moved out of "today" and the usage counters are cleared,
     * which resets the allowance rather than inflating it. */
    await harness.db.query(
      `update conversations
          set started_at = started_at - interval '2 days',
              ended_at = coalesce(ended_at, now()) - interval '2 days'
        where status = 'ended'`,
    );
    await harness.db.query('delete from usage_daily');
  };

  /**
   * Ends everything open for a child, then opens `count` fresh conversations.
   *
   * `startConversation` deliberately closes the previous session first, which is
   * right for a fixture of one and useless for a pool. The plan's concurrent
   * limit is widened alongside the turn quota, so several can be open at once.
   */
  const freshConversationPool = async (child: string, count: number): Promise<string[]> => {
    await harness.db.query(
      `update conversations set status = 'ended', ended_at = now(),
              end_reason = coalesce(end_reason, 'parent_ended')
        where child_id = $1 and status = 'active'`,
      [child],
    );

    const opened: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const response = await fetch(`${base}/api/conversations/start`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ childId: child }),
      });
      const body = (await response.json()) as { id?: string };
      if (body.id !== undefined) opened.push(body.id);
    }
    return opened;
  };

  /** A paid plan, so quota is never the thing being measured. */
  const subscribe = async (parentId: string): Promise<void> => {
    await harness.db.query(
      `insert into subscriptions
         (parent_id, plan_id, rail, status, current_period_start, current_period_end)
       select $1, id, 'mock', 'active', now(), now() + interval '30 days'
         from subscription_plans where code = 'monthly'`,
      [parentId],
    );
  };

  const childId = await createChild('Rumi');
  await consent(childId);
  await liftQuotas();
  await subscribe(parent.parentId);
  const conversationId = await startConversation(childId);
  /** Rotated fresh before every rung — see scenario 5. */
  let turnPool: string[] = [conversationId];
  /** Same, for the voice scenario. */
  let voicePool: string[] = [conversationId];

  /* Eight children with live conversations, for the concurrency scenario. Eight
   * because a family plan is the realistic ceiling on one account, and because
   * the interesting question is what happens when several are talking at once. */
  const family: { childId: string; conversationId: string }[] = [];
  for (let i = 0; i < 8; i += 1) {
    const id = await createChild(`Sibling ${String(i)}`);
    await consent(id);
    family.push({ childId: id, conversationId: await startConversation(id) });
  }
  await liftChildControls();

  /** Refilled fresh before every rung — see scenario 6. */
  const familyPool: string[] = family.map((seat) => seat.conversationId);

  process.stdout.write(`ready at ${base}\n`);
  process.stdout.write(
    `node ${process.version} · ${String(process.platform)} · ${String(
      (await import('node:os')).cpus().length,
    )} logical CPUs\n`,
  );

  /* ======================================================================== */
  /* 1. The floor: what any request costs before touching anything            */
  /* ======================================================================== */

  await execute({
    key: 'health',
    title: '1. Baseline — GET /health (no auth, no database)',
    note: 'The floor. Routing, serialisation, and the socket, and nothing else.',
    samples: 800,
    warmup: 100,
    request: async () => okIf(await drain(await fetch(`${base}/health`)), 200),
  });

  /* ======================================================================== */
  /* 1b. The same handler with the socket taken out of the picture            */
  /* ======================================================================== */

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * SEPARATING OUR LATENCY FROM THE MEASUREMENT APPARATUS.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Scenario 1 shows roughly 15 ms at c=1 and roughly 2.5 ms at c=4 for a
   * handler that does nothing at all. A server cannot get six times faster
   * under more load, so that 15 ms is not the server — it is the client and
   * the operating system, and on Windows a ~15 ms floor is the default timer
   * granularity almost exactly.
   *
   * `inject()` runs the identical Fastify pipeline — routing, hooks, schema
   * serialisation — with no socket, no kernel, and no HTTP client. The gap
   * between this scenario and scenario 1 is therefore the transport and the
   * apparatus, and it has to be subtracted from every other number in this
   * report before any of them mean anything.
   */
  await execute({
    key: 'health_in_process',
    title: '1b. Baseline — the same route via inject() (no socket, no client)',
    note: 'Isolates the Fastify pipeline from the transport. The difference from 1 is apparatus.',
    samples: 800,
    warmup: 100,
    request: async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/health' });
      return response.statusCode === 200
        ? { ok: true }
        : { ok: false, detail: `status ${String(response.statusCode)}` };
    },
  });

  /* ======================================================================== */
  /* 2. API latency: an authenticated read                                    */
  /* ======================================================================== */

  await execute({
    key: 'api_children_list',
    title: '2. API latency — GET /v1/children (authenticated, one query)',
    note: 'Token verification, RLS transaction, one batched query, Zod response serialisation.',
    samples: 800,
    warmup: 100,
    request: async () =>
      okIf(await drain(await fetch(`${base}/v1/children`, { headers: auth })), 200),
  });

  /* ======================================================================== */
  /* 3. Database latency, measured without HTTP in the way                    */
  /* ======================================================================== */

  await execute({
    key: 'db_point_read',
    title: '3a. Database — single-row point read (direct, no HTTP)',
    note: 'PGlite in-process. Absolute value is not a production number; it is a control for 3b.',
    samples: 800,
    warmup: 100,
    request: async () => {
      await harness.db.query('select id, display_name from children where id = $1', [childId]);
      return { ok: true };
    },
  });

  await execute({
    key: 'db_dashboard_aggregate',
    title: '3b. Database — the dashboard aggregate (direct, no HTTP)',
    note: 'The heaviest read in the product. Compare against 3a, not against a production target.',
    samples: 400,
    warmup: 50,
    request: async () => {
      const now = new Date();
      const since = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
      await harness.db.query('select * from app.conversation_metrics($1, $2)', [
        since.toISOString(),
        now.toISOString(),
      ]);
      return { ok: true };
    },
  });

  /* ======================================================================== */
  /* 4. Authentication load                                                   */
  /* ======================================================================== */

  await execute({
    key: 'auth_login',
    title: '4. Authentication — POST /v1/auth/login (Argon2id at production cost)',
    note: 'Argon2id is 19 MiB and 2 iterations by policy. This is CPU, on one thread.',
    samples: 600,
    warmup: 20,
    request: async () =>
      okIf(
        await drain(
          await fetch(`${base}/v1/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: parent.email, password: TEST_PASSWORD }),
          }),
        ),
        200,
      ),
  });

  /* ======================================================================== */
  /* 5. Conversation turn — our orchestration cost                            */
  /* ======================================================================== */

  await execute({
    key: 'ai_turn_overhead',
    title: '5. Conversation turn — POST /api/conversations/:id/message (instant provider)',
    note: 'Provider latency removed, so every millisecond here is ours to fix. Fresh conversations each rung.',
    samples: 600,
    warmup: 40,
    /* 30 conversations for 600 turns is 20 turns each — about a real session,
     * and under the 40-turn plan limit. Sending all 600 into one conversation
     * would measure a transcript no child will ever have. */
    beforeStep: async () => {
      await liftChildControls();
      turnPool = await freshConversationPool(childId, 10);
    },
    request: async (index) => {
      const target = turnPool[index % turnPool.length];
      if (target === undefined) return { ok: false, detail: 'no conversation in pool' };
      return okIf(
        await drain(
          await fetch(`${base}/api/conversations/${target}/message`, {
            method: 'POST',
            headers: json,
            body: JSON.stringify({ text: `Tell me about elephants, number ${String(index)}` }),
          }),
        ),
        200,
      );
    },
  });

  /* ======================================================================== */
  /* 6. Concurrent conversations — different children at once                 */
  /* ======================================================================== */

  await execute({
    key: 'concurrent_conversations',
    title: '6. Concurrent conversations — 8 children, distinct conversations',
    note: 'Different rows, different RLS subjects. Isolates contention from per-row locking.',
    samples: 480,
    warmup: 32,
    /* Three fresh conversations per child, so 480 turns spread over 24 sessions
     * — 20 turns each, the same realistic length scenario 5 uses. */
    beforeStep: async () => {
      await liftChildControls();
      familyPool.length = 0;
      for (const seat of family) {
        for (const opened of await freshConversationPool(seat.childId, 3)) {
          familyPool.push(opened);
        }
      }
    },
    request: async (index) => {
      const seat = familyPool[index % familyPool.length];
      if (seat === undefined) return { ok: false, detail: 'no fixture' };
      return okIf(
        await drain(
          await fetch(`${base}/api/conversations/${seat}/message`, {
            method: 'POST',
            headers: json,
            body: JSON.stringify({ text: `Turn ${String(index)}` }),
          }),
        ),
        200,
      );
    },
  });

  /* ======================================================================== */
  /* 7. Voice turn                                                            */
  /* ======================================================================== */

  const wav = silentWav(2_000);

  await execute({
    key: 'voice_turn',
    title: '7. Voice — POST /api/voice/turns (multipart upload, STT + turn + TTS)',
    note: 'Speech providers are mocks. Measures multipart parsing, validation, storage, persistence.',
    samples: 300,
    warmup: 20,
    beforeStep: async () => {
      await liftChildControls();
      voicePool = await freshConversationPool(childId, 4);
    },
    request: async (index) => {
      const target = voicePool[index % voicePool.length] ?? conversationId;
      const body = multipartBody(
        { conversationId: target },
        { field: 'audio', filename: 'turn.wav', contentType: 'audio/wav', bytes: wav },
      );
      const response = await drain(
        await fetch(`${base}/api/voice/turns`, {
          method: 'POST',
          headers: { ...auth, 'content-type': body.contentType },
          body: body.payload,
        }),
      );
      // 200 on success; anything else is a real failure worth surfacing.
      return okIf(response, 200);
    },
  });

  /* ======================================================================== */
  /* 8. Dashboard                                                             */
  /* ======================================================================== */

  await execute({
    key: 'dashboard',
    title: '8. Dashboard — GET /api/parent/dashboard/:childId',
    note: 'The heaviest authenticated read: activity, levels, milestones, safety counts, controls.',
    samples: 600,
    warmup: 50,
    request: async () =>
      okIf(
        await drain(await fetch(`${base}/api/parent/dashboard/${childId}`, { headers: auth })),
        200,
      ),
  });

  /* ======================================================================== */
  /* 9. Subscription operations                                               */
  /* ======================================================================== */

  await execute({
    key: 'subscription_status',
    title: '9a. Subscription — GET /api/subscriptions/status (computed entitlement)',
    note: 'Entitlement is derived in SQL on every read rather than cached.',
    samples: 600,
    warmup: 50,
    request: async () =>
      okIf(await drain(await fetch(`${base}/api/subscriptions/status`, { headers: auth })), 200),
  });

  await execute({
    key: 'subscription_create',
    title: '9b. Subscription — POST /api/subscriptions/create (a write, unique idempotency key)',
    note: 'Opens a checkout row. A genuine write path under load.',
    samples: 400,
    warmup: 20,
    request: async (index) =>
      okIf(
        await drain(
          await fetch(`${base}/api/subscriptions/create`, {
            method: 'POST',
            headers: json,
            body: JSON.stringify({
              planCode: 'monthly',
              idempotencyKey: `perf-checkout-${String(index)}-${randomUUID().slice(0, 8)}`,
            }),
          }),
        ),
        201,
      ),
  });

  /* ======================================================================== */
  /* 10. Webhook processing                                                   */
  /* ======================================================================== */

  /**
   * The harness freezes the app's clock at boot, and a signed webhook carries a
   * timestamp checked against it with a tolerance window. By the time the run
   * reaches this scenario, minutes of benchmarking have passed and every
   * signature looks stale — a measurement artefact, not a product behaviour, so
   * the app clock is brought back to real time before signing anything.
   */
  harness.setNow(new Date());

  await execute({
    key: 'webhook_processing',
    title: '10. Webhooks — POST /api/subscriptions/webhook/mock (signed, unique event id)',
    note:
      'HMAC verification, idempotency insert, lifecycle, ledger — one transaction. ' +
      'Sized to stay under the route’s hard-coded 600/minute, which is itself the ceiling.',
    // 6 ladder steps x 90 = 540, under the 600/minute this route enforces and
    // cannot be configured out of. Small enough that p99 is flagged unreliable,
    // which is the honest trade rather than measuring the limiter.
    samples: 90,
    warmup: 10,
    request: async (index) => {
      const raw = JSON.stringify({
        id: `perf_evt_${String(index)}_${randomUUID().slice(0, 8)}`,
        type: 'subscription.renewed',
        occurred_at: new Date().toISOString(),
        data: {
          reference: randomUUID(),
          subscription_id: `sub_perf_${String(index)}`,
          amount_minor: 49_900,
          currency: 'PKR',
        },
      });
      const signature = signMockWebhook(raw, MOCK_WEBHOOK_SECRET, Math.floor(Date.now() / 1000));

      const response = await drain(
        await fetch(`${base}/api/subscriptions/webhook/mock`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-kc-signature': signature },
          body: raw,
        }),
      );
      // An unknown reference is still fully processed and acknowledged; what is
      // being measured is verification plus the transaction, not the outcome.
      return response.status === 200 || response.status === 202
        ? { ok: true }
        : { ok: false, detail: `status ${String(response.status)}` };
    },
  });

  await harness.close();

  /* ======================================================================== */
  /* 5b. The same turn, with a provider that behaves like a real one          */
  /* ======================================================================== */

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THIS IS ARITHMETIC ABOUT THE BUDGET, NOT A MEASUREMENT OF A VENDOR.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * ARCHITECTURE.md §7.1 allocates 500 ms (p50) to LLM time-to-first-token.
   * Injecting exactly that shows how our own overhead COMPOSES with a vendor
   * that hits its allocation — which is the question the budget actually
   * poses. It says nothing about whether any real provider hits 500 ms.
   */
  const delayed = await createApiHarness({
    aiProvider: createMockProvider({ behaviour: { latencyMs: 500 } }),
    env: {
      RATE_LIMIT_GLOBAL_PER_MINUTE: '1000000',
      RATE_LIMIT_CONVERSATION_PER_MINUTE: '1000000',
      RATE_LIMIT_CONVERSATION_START_PER_HOUR: '1000000',
      AI_PER_CHILD_DAILY_TURN_LIMIT: '1000000',
      AUTH_ACCESS_TOKEN_TTL: '4h',
    },
  });
  const delayedBase = await delayed.app.listen({ port: 0, host: '127.0.0.1' });
  const delayedParent = await registerAndLogin(delayed, 'perf-delayed');
  const delayedJson = {
    authorization: `Bearer ${delayedParent.accessToken}`,
    'content-type': 'application/json',
  };

  const delayedChild = (
    (await (
      await fetch(`${delayedBase}/v1/children`, {
        method: 'POST',
        headers: delayedJson,
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
    ['child_data_processing', delayedChild],
  ] as const) {
    await drain(
      await fetch(`${delayedBase}/v1/consent`, {
        method: 'POST',
        headers: delayedJson,
        body: JSON.stringify({
          consentType: type,
          granted: true,
          ...POLICY,
          ...(scoped === undefined ? {} : { childId: scoped }),
        }),
      }),
    );
  }

  await delayed.db.query(
    `update subscription_plans
        set daily_turn_limit = 1000000,
            max_conversation_turns = 1000000,
            concurrent_conversation_limit = 1000
      where code = 'monthly'`,
  );

  await delayed.db.query(
    `insert into subscriptions
       (parent_id, plan_id, rail, status, current_period_start, current_period_end)
     select $1, id, 'mock', 'active', now(), now() + interval '30 days'
       from subscription_plans where code = 'monthly'`,
    [delayedParent.parentId],
  );

  const delayedConversation = (
    (await (
      await fetch(`${delayedBase}/api/conversations/start`, {
        method: 'POST',
        headers: delayedJson,
        body: JSON.stringify({ childId: delayedChild }),
      })
    ).json()) as { id: string }
  ).id;

  await execute({
    key: 'ai_turn_with_provider_latency',
    title: '5b. Conversation turn — with 500 ms of injected provider latency',
    note: 'Our overhead plus the budget’s p50 allocation for the model. Not a vendor measurement.',
    // Deliberately fewer: at c=1 every request costs at least half a second.
    samples: 180,
    warmup: 8,
    request: async (index) =>
      okIf(
        await drain(
          await fetch(`${delayedBase}/api/conversations/${delayedConversation}/message`, {
            method: 'POST',
            headers: delayedJson,
            body: JSON.stringify({ text: `Budget probe ${String(index)}` }),
          }),
        ),
        200,
      ),
  });

  await delayed.close();

  /* ======================================================================== */
  /* 11. The Redis stand-in: the in-memory rate limiter                       */
  /* ======================================================================== */

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THERE IS NO REDIS IN THIS APPLICATION.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * `REDIS_URL` exists in the config schema, `/health` reports redis as
   * `skipped`, and no Redis client is installed in any package. Rate limiting
   * runs in `@fastify/rate-limit`'s in-process store.
   *
   * So this scenario measures the thing that is actually there. It is the
   * baseline any future Redis-backed limiter has to be compared against —
   * a network round trip per request has to buy something, and today the
   * limiter costs approximately nothing per request.
   */
  const limited = await createApiHarness({
    env: { RATE_LIMIT_AUTH_PER_15_MIN: '1000000', RATE_LIMIT_GLOBAL_PER_MINUTE: '1000000' },
  });
  const limitedBase = await limited.app.listen({ port: 0, host: '127.0.0.1' });
  const limitedParent = await registerAndLogin(limited, 'perf-limiter');

  await execute({
    key: 'rate_limiter',
    title: '11. Rate limiting — in-memory limiter on the hot path (NO REDIS EXISTS)',
    note: 'Measures the limiter that is actually deployed. See the report for what this is not.',
    samples: 800,
    warmup: 100,
    request: async () =>
      okIf(
        await drain(
          await fetch(`${limitedBase}/v1/children`, {
            headers: { authorization: `Bearer ${limitedParent.accessToken}` },
          }),
        ),
        200,
      ),
  });

  await limited.close();

  /* ======================================================================== */
  /* Output                                                                   */
  /* ======================================================================== */

  const payload = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    cpus: (await import('node:os')).cpus().length,
    totalMemoryGb: Math.round(((await import('node:os')).totalmem() / 1024 ** 3) * 10) / 10,
    scenarios: results.map(({ scenario, runs }) => ({
      key: scenario.key,
      title: scenario.title,
      note: scenario.note,
      runs,
    })),
  };

  const out = process.env.PERF_OUT ?? 'perf-results.json';
  writeFileSync(out, JSON.stringify(payload, null, 2));
  process.stdout.write(`\nwrote ${out}\n`);
};

await main();
