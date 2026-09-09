import { ConfigurationError, loadConfig } from '@kids/config';
import { createPgDatabase } from '@kids/db';
import closeWithGrace from 'close-with-grace';

import { buildApp } from './app.js';

/**
 * Process entry point.
 *
 * Configuration is validated before anything else starts. A service that boots
 * with a broken configuration and fails on the first child's request is strictly
 * worse than one that never starts — the failure is later, less obvious, and
 * lands on a user instead of a deploy pipeline.
 */
const main = async (): Promise<void> => {
  const config = loadConfig();

  if (config.DATABASE_URL === undefined) {
    throw new ConfigurationError(['DATABASE_URL: is required to start the API']);
  }

  const db = createPgDatabase({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    ssl: config.DATABASE_SSL_MODE === 'require',
    ...(config.DATABASE_SSL_ROOT_CERT === undefined
      ? {}
      : { sslRootCert: config.DATABASE_SSL_ROOT_CERT }),
    statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT_MS,
  });

  const app = await buildApp({ config, db });

  closeWithGrace({ delay: 10_000 }, async ({ err, signal }) => {
    if (err) {
      app.log.fatal({ err }, 'shutting down after an unhandled error');
    } else {
      app.log.info({ signal }, 'shutting down');
    }
    // In-flight turns finish before the process exits, so a child mid-sentence
    // is not cut off by a routine deploy.
    await app.close();
    await db.close();
  });

  await app.listen({ host: config.API_HOST, port: config.API_PORT });
};

try {
  await main();
} catch (error) {
  if (error instanceof ConfigurationError) {
    // Configuration errors are for a human reading a terminal or a deploy log,
    // before the logger exists. This is the one place stderr is correct.
    process.stderr.write(`${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(`Failed to start: ${String(error)}\n`);
  process.exit(1);
}
