import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  isWebhookEventType,
  WebhookVerificationError,
  type CheckoutRequest,
  type CheckoutSession,
  type SubscriptionProvider,
  type VerifiedWebhookEvent,
} from './ports.js';
import { lastFour, redactPayload } from './redaction.js';

/**
 * The mock rail.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS NOT A STUB. IT IMPLEMENTS THE SIGNATURE SCHEME PROPERLY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A mock that returns `{ verified: true }` would make every webhook test pass
 * and prove nothing — the tests would exercise our reconciler against an oracle
 * that never says no. So this rail does what a real one does: HMAC-SHA-256 over
 * `timestamp.body`, a signed timestamp with a tolerance window, and a
 * constant-time comparison. The scheme is Stripe's, because it is the one the
 * Stripe adapter will have to implement and there is no value in the test rail
 * being easier than the real one.
 *
 * That is what lets the suite assert the things that actually matter: a forged
 * signature is rejected, a captured request replayed an hour later is rejected,
 * and a body altered by one byte is rejected.
 *
 * Selected only when `PAYMENTS_PROVIDER=mock`, and configuration refuses that
 * combination in any deployed environment.
 */

export interface MockProviderOptions {
  readonly webhookSecret: string;
  /** How old a signed timestamp may be. Stripe's default is 5 minutes. */
  readonly toleranceSeconds?: number;
  /**
   * Required, not defaulted.
   *
   * A rail that falls back to wall time would accept a signature the rest of
   * the system considers stale, and the replay window — the entire point of the
   * timestamp — would be untestable.
   */
  readonly now: () => Date;
  /** Where a parent would be sent. Local only; there is no hosted page. */
  readonly checkoutBaseUrl?: string;
}

const SIGNATURE_HEADER = 'x-kc-signature';

const signaturePayload = (timestamp: number, body: Uint8Array): Buffer =>
  Buffer.concat([Buffer.from(`${String(timestamp)}.`), Buffer.from(body)]);

/** The signature a rail would send. Exported so tests can forge and replay properly. */
export const signMockWebhook = (
  body: Uint8Array | string,
  secret: string,
  timestampSeconds: number,
): string => {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const digest = createHmac('sha256', secret)
    .update(signaturePayload(timestampSeconds, bytes))
    .digest('hex');
  return `t=${String(timestampSeconds)},v1=${digest}`;
};

const parseSignatureHeader = (
  header: string,
): { timestamp: number; signature: string } | undefined => {
  let timestamp: number | undefined;
  let signature: string | undefined;

  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && value !== undefined) timestamp = Number(value);
    if (key === 'v1' && value !== undefined) signature = value;
  }

  if (timestamp === undefined || !Number.isFinite(timestamp) || signature === undefined) {
    return undefined;
  }
  return { timestamp, signature };
};

/** Constant-time. A `===` here leaks the signature one byte at a time. */
const signaturesMatch = (expected: string, received: string): boolean => {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/**
 * Verification and parsing, synchronously.
 *
 * Nothing here is asynchronous — it is an HMAC and a JSON parse — so this is a
 * sync function that throws, and the port method below adapts it to the
 * Promise the interface requires. Written the other way round, a `throw` inside
 * a non-async arrow escapes the promise entirely and a caller's `.catch()`
 * never runs.
 */
export const verifyMockWebhook = (
  rawBody: Uint8Array,
  headers: Readonly<Record<string, string | undefined>>,
  options: { secret: string; toleranceSeconds: number; now: Date },
): VerifiedWebhookEvent => {
  /* ---------------------------------------------------------------------- */
  /* 1. Verify BEFORE parsing                                                */
  /* ---------------------------------------------------------------------- */
  /* The order is the whole point. Parsing first means running a JSON parser,
   * and then our own field handling, over bytes from an unauthenticated
   * source — and it is how "we verify signatures" turns into a parser exposed
   * to the internet. */

  const header = headers[SIGNATURE_HEADER] ?? headers[SIGNATURE_HEADER.toLowerCase()];
  if (header === undefined || header === '') {
    throw new WebhookVerificationError('missing_signature');
  }

  const parsed = parseSignatureHeader(header);
  if (parsed === undefined) throw new WebhookVerificationError('malformed', 'signature header');

  const expected = createHmac('sha256', options.secret)
    .update(signaturePayload(parsed.timestamp, rawBody))
    .digest('hex');

  if (!signaturesMatch(expected, parsed.signature)) {
    throw new WebhookVerificationError('bad_signature');
  }

  /* ---------------------------------------------------------------------- */
  /* 2. The replay window                                                    */
  /* ---------------------------------------------------------------------- */
  /* The timestamp is INSIDE the signed material, so an attacker replaying a
   * captured request cannot move it forward without invalidating the
   * signature. Without this check a valid request captured once is valid
   * forever, and the signature only proves it was genuine at some point in
   * history.
   *
   * Checked in both directions: a timestamp far in the FUTURE is either a badly
   * skewed clock or someone minting a request that stays valid for a week. */
  const skewSeconds = Math.abs(Math.floor(options.now.getTime() / 1000) - parsed.timestamp);
  if (skewSeconds > options.toleranceSeconds) {
    throw new WebhookVerificationError('stale_timestamp');
  }

  /* ---------------------------------------------------------------------- */
  /* 3. Now it is safe to parse                                              */
  /* ---------------------------------------------------------------------- */
  let body: Record<string, unknown>;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(rawBody).toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new Error('not an object');
    }
    body = decoded as Record<string, unknown>;
  } catch {
    throw new WebhookVerificationError('malformed', 'body is not a JSON object');
  }

  const type = asString(body.type);
  const externalEventId = asString(body.id);
  const occurredAt = asString(body.occurred_at);

  if (externalEventId === undefined || occurredAt === undefined || type === undefined) {
    throw new WebhookVerificationError('malformed', 'id, type, and occurred_at are required');
  }
  if (!isWebhookEventType(type)) {
    throw new WebhookVerificationError('malformed', `unknown event type: ${type}`);
  }
  if (Number.isNaN(new Date(occurredAt).getTime())) {
    throw new WebhookVerificationError('malformed', 'occurred_at is not a timestamp');
  }

  const data = (typeof body.data === 'object' && body.data !== null ? body.data : {}) as Record<
    string,
    unknown
  >;

  const amountMinor = data.amount_minor;
  const method = (
    typeof data.payment_method === 'object' && data.payment_method !== null
      ? data.payment_method
      : {}
  ) as Record<string, unknown>;

  const brand = asString(method.brand);
  const last4 = lastFour(asString(method.last4));

  return {
    rail: 'mock',
    externalEventId,
    type,
    occurredAt: occurredAt as VerifiedWebhookEvent['occurredAt'],
    reference: asString(data.reference),
    externalSubscriptionId: asString(data.subscription_id),
    amount:
      typeof amountMinor === 'number' && Number.isFinite(amountMinor)
        ? {
            amountMinor: Math.round(amountMinor),
            currency: asString(data.currency) ?? 'PKR',
          }
        : undefined,
    failureCode: asString(data.failure_code),
    periodEnd: asString(data.period_end) as VerifiedWebhookEvent['periodEnd'],
    paymentMethod: brand === undefined && last4 === undefined ? undefined : { brand, last4 },
    // Redacted before it can reach a persistence layer, not at the point of
    // writing. A payload that has been through this function is safe to store,
    // log, or forward; one that has not, is not.
    payload: redactPayload(body) as Readonly<Record<string, unknown>>,
  };
};

export const createMockSubscriptionProvider = (
  options: MockProviderOptions,
): SubscriptionProvider => {
  const tolerance = options.toleranceSeconds ?? 300;
  const { now } = options;
  const baseUrl = options.checkoutBaseUrl ?? 'https://mock-checkout.invalid';

  return {
    rail: 'mock',

    createCheckout: (request: CheckoutRequest): Promise<CheckoutSession> => {
      // No money moves here, and none would on a real rail either — a checkout
      // session is a URL. The price travels to the rail from the plan the
      // caller resolved from the database; this adapter never invents one.
      const externalId = `mock_cs_${randomUUID()}`;
      const expiresAt = new Date(now().getTime() + 30 * 60_000).toISOString();

      return Promise.resolve({
        rail: 'mock' as const,
        externalId,
        redirectUrl: `${baseUrl}/session/${externalId}?ref=${encodeURIComponent(request.reference)}`,
        expiresAt: expiresAt as CheckoutSession['expiresAt'],
      });
    },

    cancel: (): Promise<void> => Promise.resolve(),
    resume: (): Promise<void> => Promise.resolve(),

    verifyAndParseWebhook: (
      rawBody: Uint8Array,
      headers: Readonly<Record<string, string | undefined>>,
    ): Promise<VerifiedWebhookEvent> => {
      try {
        return Promise.resolve(
          verifyMockWebhook(rawBody, headers, {
            secret: options.webhookSecret,
            toleranceSeconds: tolerance,
            now: now(),
          }),
        );
      } catch (error) {
        // A rejection, not a throw. The interface promises a Promise.
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
};
