/**
 * What a burst of logins does to everything else.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MEASUREMENT THAT TURNS A BOTTLENECK INTO A CONSEQUENCE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The load run shows authentication pinned near ten requests a second with
 * event-loop lag tracking its latency almost exactly. That is a diagnosis, not
 * an impact: on its own it only says logins are slow.
 *
 * This asks the question a parent would notice. While people are signing in,
 * what happens to a request that has nothing to do with signing in?
 *
 * Argon2id runs on the one thread that also serves every other route, so the
 * answer is not "nothing". Quantifying it is what justifies isolating the
 * hashing work rather than weakening it — the parameters are an OWASP floor and
 * lowering them is not on the table.
 *
 * Run with:  npx tsx tests/performance/interference.ts
 */

import { createApiHarness, registerAndLogin, TEST_PASSWORD } from '../helpers/api.js';

import { percentileOf } from './harness.js';

const summarise = (label: string, samples: number[]): void => {
  const sorted = [...samples].sort((a, b) => a - b);
  const show = (value: number): string => value.toFixed(1).padStart(8);
  process.stdout.write(
    `  ${label.padEnd(34)} n=${String(sorted.length).padStart(4)}  ` +
      `p50=${show(percentileOf(sorted, 50))}ms  ` +
      `p95=${show(percentileOf(sorted, 95))}ms  ` +
      `p99=${show(percentileOf(sorted, 99))}ms\n`,
  );
};

const main = async (): Promise<void> => {
  const harness = await createApiHarness({
    env: {
      RATE_LIMIT_GLOBAL_PER_MINUTE: '1000000',
      RATE_LIMIT_AUTH_PER_15_MIN: '1000000',
      AUTH_ACCESS_TOKEN_TTL: '4h',
    },
  });
  const base = await harness.app.listen({ port: 0, host: '127.0.0.1' });
  const parent = await registerAndLogin(harness, 'interference');
  const auth = { authorization: `Bearer ${parent.accessToken}` };

  const readOnce = async (): Promise<number> => {
    const started = performance.now();
    const response = await fetch(`${base}/v1/children`, { headers: auth });
    await response.text();
    return performance.now() - started;
  };

  const loginOnce = async (): Promise<void> => {
    const response = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: parent.email, password: TEST_PASSWORD }),
    });
    await response.text();
  };

  // Warm-up, discarded.
  for (let i = 0; i < 40; i += 1) await readOnce();

  /* ---- Quiet: the same read with nothing else happening ---- */
  const quiet: number[] = [];
  for (let i = 0; i < 300; i += 1) quiet.push(await readOnce());

  /* ---- Under login load: four concurrent sign-ins, continuously ---- */
  let loading = true;
  const loginLoad = Promise.all(
    Array.from({ length: 4 }, async () => {
      while (loading) await loginOnce();
    }),
  );

  // Let the login load establish itself before sampling.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const busy: number[] = [];
  for (let i = 0; i < 300; i += 1) busy.push(await readOnce());

  loading = false;
  await loginLoad;

  process.stdout.write('\nGET /v1/children — one reader, unchanged, in both cases\n');
  summarise('quiet system', quiet);
  summarise('while 4 logins run continuously', busy);

  const quietSorted = [...quiet].sort((a, b) => a - b);
  const busySorted = [...busy].sort((a, b) => a - b);
  const ratio = percentileOf(busySorted, 95) / percentileOf(quietSorted, 95);
  process.stdout.write(`\n  p95 multiplied by ${ratio.toFixed(1)}x under login load.\n`);

  await harness.close();
};

await main();
