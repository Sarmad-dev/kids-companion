import { envSchema, type ValidatedEnv } from './env.js';

/**
 * The one place `process.env` is read.
 *
 * Validation happens once, at boot, and fails hard. A service that starts with a
 * broken configuration and fails on the first child's request is strictly worse
 * than one that never starts — the failure is later, less obvious, and lands on
 * a user instead of a deploy pipeline.
 */

export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      [
        'Invalid environment configuration:',
        ...issues.map((i) => `  - ${i}`),
        '',
        'See docs/ENVIRONMENT.md. To start from the template:  cp .env.example .env',
      ].join('\n'),
    );
    this.issues = issues;
  }
}

export type Config = Readonly<ValidatedEnv>;

/**
 * Parse and validate an environment record.
 *
 * Takes the source as a parameter rather than reading `process.env` directly so
 * it is testable without mutating global state — which is what makes the
 * cross-field rules in `env.ts` cheap to cover.
 */
export const parseConfig = (source: Record<string, string | undefined>): Config => {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new ConfigurationError(issues);
  }

  return Object.freeze(result.data);
};

let cached: Config | undefined;

/**
 * Load configuration from `process.env`, memoised.
 *
 * Memoised because configuration is immutable for a process lifetime, and because
 * re-validating on every access would make the failure mode "some requests fail"
 * rather than "the process does not start".
 */
export const loadConfig = (): Config => {
  cached ??= parseConfig(process.env);
  return cached;
};

/** Test-only. Clears the memoised config so a different environment can be loaded. */
export const resetConfigForTesting = (): void => {
  cached = undefined;
};
