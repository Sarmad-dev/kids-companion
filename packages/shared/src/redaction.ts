/**
 * Redaction. See docs/LOGGING.md §4.
 *
 * A log aggregator is a database with weaker access control, longer retention,
 * and wider read access than the primary store. Transcript text, raw audio, and
 * child identifiers must never reach one — at any level, in any environment,
 * including local development.
 *
 * This is enforced by construction rather than by discipline: the paths below are
 * stripped by the logger's serialisers, so passing a forbidden field is a no-op
 * instead of a leak.
 */

/**
 * Field names that must never appear in a log line.
 *
 * Path-based redaction alone is not sufficient — it misses a field named
 * something nobody anticipated. Domain objects therefore define allowlist
 * serialisers as well; this is the backstop, not the whole defence.
 */
export const REDACTED_PATHS: readonly string[] = [
  // Child speech and model output — the highest-risk category (S3).
  'transcript',
  '*.transcript',
  'utterance',
  '*.utterance',
  'text',
  '*.text',
  'audio',
  '*.audio',
  'audioUrl',
  '*.audioUrl',

  // Child and parent identity (S2/S1).
  'childName',
  '*.childName',
  'displayName',
  '*.displayName',
  'email',
  '*.email',
  'birthYear',
  '*.birthYear',
  'birthMonth',
  '*.birthMonth',

  // Credentials.
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'apiKey',
  '*.apiKey',
  'secret',
  '*.secret',
  // A webhook URL is a bearer credential in path form — the Slack incoming
  // variety is enough on its own to post into somebody's channel. The alert
  // transport never logs one, and this is the second line of that defence.
  'webhookUrl',
  '*.webhookUrl',
  'authorization',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export const REDACTION_PLACEHOLDER = '[REDACTED]';

/**
 * A salted, rotating pseudonymous reference.
 *
 * Enough to correlate one child's requests within a debugging window; not enough
 * to identify a child from logs alone, or to build a profile across months.
 * Rotating the salt bounds how long a log corpus stays linkable.
 *
 * Not a security control — an attacker holding both the salt and a candidate ID
 * can confirm a match. It is a minimisation control, which is the actual goal.
 */
export const pseudonymize = (prefix: string, id: string, salt: string): string => {
  let hash = 0x811c9dc5;
  const input = `${salt}:${id}`;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}_${hash.toString(16).padStart(8, '0')}`;
};

/**
 * Strip forbidden keys from an arbitrary object before it reaches a log.
 *
 * Used for error `context`, which is developer-authored and therefore the most
 * likely place for a sensitive field to be added without thinking.
 */
export const redactObject = (
  value: Readonly<Record<string, unknown>>,
  maxDepth = 4,
): Record<string, unknown> => {
  const forbidden = new Set(
    REDACTED_PATHS.filter((p) => !p.includes('*') && !p.includes('.')).map((p) => p.toLowerCase()),
  );

  const walk = (input: unknown, depth: number): unknown => {
    if (depth > maxDepth) return '[TRUNCATED]';
    if (input === null || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map((item) => walk(item, depth + 1));

    const output: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
      output[key] = forbidden.has(key.toLowerCase()) ? REDACTION_PLACEHOLDER : walk(val, depth + 1);
    }
    return output;
  };

  return walk(value, 0) as Record<string, unknown>;
};
