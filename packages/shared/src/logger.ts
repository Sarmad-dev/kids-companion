import { pino, type Logger, type LoggerOptions } from 'pino';

import { REDACTED_PATHS, REDACTION_PLACEHOLDER } from './redaction.js';

/**
 * The logger factory. See docs/LOGGING.md.
 *
 * Every logger in the workspace comes from here. `no-console` is a lint error so
 * nothing can bypass it, and redaction is configured on the instance rather than
 * applied at call sites — a call site can forget, a serialiser cannot.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LoggerConfig {
  readonly level: LogLevel;
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly appEnv: string;
  /** Human-readable output for local development. Redaction applies either way. */
  readonly pretty?: boolean;
  /**
   * Where log lines are written. Defaults to stdout.
   *
   * Injectable so tests can assert on what the logger *actually emits* rather
   * than on how it is configured — a redaction guarantee verified by reading the
   * config is not verified at all.
   */
  readonly destination?: { write: (line: string) => void };
}

export const createLogger = (config: LoggerConfig): Logger => {
  const options: LoggerOptions = {
    level: config.level,
    base: {
      service: config.serviceName,
      version: config.serviceVersion,
      env: config.appEnv,
    },
    // ISO timestamps, because correlating a log line with a parent's support
    // email should not require converting epoch milliseconds by hand.
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...REDACTED_PATHS],
      censor: REDACTION_PLACEHOLDER,
    },
    formatters: {
      // Emit `"level": "info"` rather than `"level": 30`.
      level: (label) => ({ level: label }),
    },
  };

  if (config.destination) {
    return pino(options, config.destination);
  }

  if (config.pretty) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }

  return pino(options);
};

export type { Logger };
