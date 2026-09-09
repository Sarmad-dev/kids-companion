import { defineConfig } from 'vitest/config';

/**
 * Workspace test runner. The three projects map 1:1 to the tiers in
 * docs/TESTING_STANDARDS.md:
 *
 *   unit        — pure, in-memory, no network, no container. Must stay fast.
 *   integration — the real app, real plugins, real serialisation. Driven through
 *                 `inject()`; Phase 1 adds the Postgres/Redis-backed suites.
 *   e2e         — a real server process over a real socket.
 *
 * Browser end-to-end tests for the dashboard live in Playwright
 * (`pnpm test:e2e:web`), kept separate so the default test command never depends
 * on downloaded browser binaries.
 *
 * No tier ever calls a live vendor. Every provider defaults to `mock`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            '{packages,services,apps}/**/*.test.ts',
            '{packages,services,apps}/**/*.test.tsx',
            // The operational scripts. They are the least-exercised code in the
            // repository and the most consequential when wrong — the backup
            // verifier decides whether a dump is trusted.
            'infra/scripts/**/*.test.mjs',
          ],
          exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
          environment: 'node',
          testTimeout: 5_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: [
            'tests/integration/**/*.test.ts',
            'tests/contract/**/*.test.ts',
            '{apps,services}/**/*.integration.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.config.*',
        '**/*.d.ts',
        'apps/mobile/**',
        'apps/web/**',
        'tests/**',
        'infra/**',
      ],
      // Global floor. Safety-critical modules carry their own, higher gates —
      // see docs/TESTING_STANDARDS.md#4-coverage-policy.
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 65,
        statements: 70,
      },
    },
  },
});
