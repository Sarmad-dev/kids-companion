import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * End-to-end: a real server process, over a real socket.
 *
 * This is deliberately distinct from the integration suite, which drives the app
 * in-process via `inject()`. Booting the actual entry point is what proves
 * `server.ts` works — config loading, port binding, graceful shutdown — none of
 * which `inject()` exercises.
 *
 * No vendor is ever called: every provider defaults to `mock` under APP_ENV=ci.
 */

const PORT = 8_099;
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;

/**
 * The API now requires a database to start, so this suite needs a real Postgres
 * — it boots the actual entry point, which is the whole point of it.
 *
 * Skipped rather than failed when `DATABASE_URL` is absent: the precondition is
 * genuinely unmet, and a red suite that means "you have not started Docker"
 * teaches people to ignore red suites. CI provides the service; locally,
 * `pnpm docker:up && pnpm db:migrate` does.
 *
 * The schema and RLS policies are covered without any of this by the integration
 * suite, which runs PostgreSQL in-process.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = DATABASE_URL === undefined ? describe.skip : describe;

if (DATABASE_URL === undefined) {
  // Written to stderr rather than through the logger: this is a message to the
  // person running the suite, before any application exists to log through.
  process.stderr.write(
    '\n  e2e: skipped — DATABASE_URL is not set.\n' +
      '  Run `pnpm docker:up && pnpm db:migrate` to exercise the real server process.\n\n',
  );
}

let server: ChildProcess;

const waitForReady = async (timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet — keep waiting rather than failing on the first refusal.
    }
    await sleep(250);
  }

  throw new Error(`Server did not become ready within ${String(timeoutMs)}ms`);
};

const API_DIR = fileURLToPath(new URL('../../apps/api/', import.meta.url));

beforeAll(async () => {
  if (DATABASE_URL === undefined) return;

  // `process.execPath` rather than the string 'node': the test must run the same
  // runtime that started it, and must not depend on PATH resolution.
  server = spawn(process.execPath, ['dist/server.js'], {
    cwd: API_DIR,
    env: {
      ...process.env,
      APP_ENV: 'ci',
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      API_PORT: String(PORT),
      API_HOST: '127.0.0.1',
      SERVICE_VERSION: 'e2e-test',
      DATABASE_URL,
    },
    stdio: 'pipe',
  });

  await waitForReady();
}, 60_000);

afterAll(async () => {
  if (DATABASE_URL === undefined) return;

  server.kill('SIGTERM');
  await sleep(500);
  if (!server.killed) server.kill('SIGKILL');
});

describeE2E('API end-to-end', () => {
  it('serves liveness over a real socket', async () => {
    const response = await fetch(`${BASE_URL}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', version: 'e2e-test' });
  });

  it('serves readiness', async () => {
    const response = await fetch(`${BASE_URL}/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ready' });
  });

  it('returns the standard error body for an unknown route', async () => {
    const response = await fetch(`${BASE_URL}/nope`);
    const body = (await response.json()) as { error: { code: string; requestId: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(body.error.requestId).toBeTruthy();
  });

  it('sets security headers on a real response', async () => {
    const response = await fetch(`${BASE_URL}/health`);

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('propagates a client request id end to end', async () => {
    const response = await fetch(`${BASE_URL}/health`, {
      headers: { 'x-request-id': 'e2e-correlation-1' },
    });

    expect(response.headers.get('x-request-id')).toBe('e2e-correlation-1');
  });
});
