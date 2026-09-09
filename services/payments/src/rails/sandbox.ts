import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import type { IsoTimestamp } from '@kids/types';

import { WebhookVerificationError, type Money, type PaymentRail } from '../ports.js';
import { redactPayload } from '../redaction.js';

import {
  RailCapabilityError,
  type PaymentCallback,
  type PaymentFailureCode,
  type PaymentInitiation,
  type PaymentRailAdapter,
  type PaymentResult,
  type PaymentStatus,
  type RailCapabilities,
  type RailVerification,
  type RefundRequest,
  type RefundResult,
} from './types.js';

/**
 * The sandbox rail.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE IMPLEMENTATION, FOUR RAILS, DRIVEN BY EACH RAIL'S CAPABILITIES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This is what runs in local development and CI for JazzCash, Easypaisa,
 * carrier billing, and cards. It is NOT an imitation of any of them — it does
 * not pretend to speak their protocols, because their protocols have not been
 * verified and inventing one would be worse than having none.
 *
 * What it is instead is a rail that behaves the way a payment rail behaves:
 * asynchronous, sometimes slow, sometimes declining, occasionally silent. It
 * enforces the capabilities of whichever rail it is standing in for, so a
 * refund attempted against carrier billing fails here exactly as it would in
 * production — which is the bug worth catching before production.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FAILURES ARE DRIVEN BY THE PAYER HANDLE, THE WAY REAL SANDBOXES WORK.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A sandbox that always succeeds tests one path out of a dozen. The failure
 * paths — declined, insufficient funds, timeout, callback never arrives — are
 * the ones that produce a family charged and not credited, and they are
 * unreachable in a happy-path stub. Here, the last digits of the payer handle
 * choose the outcome (see `SANDBOX_BEHAVIOURS`), so every one of them is a
 * test rather than a hope.
 */

/** What a sandbox payer handle asks the rail to do. */
export const SANDBOX_BEHAVIOURS = {
  /** Anything not listed below. Succeeds on the callback. */
  '0000': 'succeeds after a callback',
  '0001': 'declined',
  '0002': 'insufficient funds',
  '0003': 'the rail times out on initiate',
  '0004': 'authorises but is never captured — needs reconciliation',
  '0005': 'the callback never arrives; queryStatus says it succeeded',
  '0006': 'above the rail limit',
  '0007': 'the rail is unavailable',
} as const;

const behaviourOf = (handle: string | undefined): keyof typeof SANDBOX_BEHAVIOURS => {
  const suffix = (handle ?? '').slice(-4);
  return suffix in SANDBOX_BEHAVIOURS ? (suffix as keyof typeof SANDBOX_BEHAVIOURS) : '0000';
};

export interface SandboxRailOptions {
  readonly rail: PaymentRail;
  readonly capabilities: RailCapabilities;
  readonly verification: RailVerification;
  /** Signs callbacks, so the verification path is exercised rather than skipped. */
  readonly callbackSecret: string;
  readonly toleranceSeconds?: number;
  /** Required — a rail that reads wall time cannot have its timing tested. */
  readonly now: () => Date;
}

const SIGNATURE_HEADER = 'x-kc-rail-signature';

const signaturePayload = (timestamp: number, body: Uint8Array): Buffer =>
  Buffer.concat([Buffer.from(`${String(timestamp)}.`), Buffer.from(body)]);

/** The signature the sandbox rail sends. Exported so tests can forge and replay. */
export const signRailCallback = (
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

const parseSignature = (header: string): { timestamp: number; signature: string } | undefined => {
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

const matches = (expected: string, received: string): boolean => {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** An in-memory record of what the sandbox rail believes about each payment. */
interface SandboxRecord {
  status: PaymentStatus;
  amount: Money;
  reference: string;
  failureCode?: PaymentFailureCode;
  refundedMinor: number;
}

export const createSandboxRail = (options: SandboxRailOptions): PaymentRailAdapter => {
  const { rail, capabilities, verification, now } = options;
  const tolerance = options.toleranceSeconds ?? 300;

  /* The rail's own books. In production this lives at the provider; here it is
   * a Map, which is what makes `queryStatus` a genuine second source of truth
   * rather than a mirror of ours. */
  const ledger = new Map<string, SandboxRecord>();

  const iso = (): IsoTimestamp => now().toISOString() as IsoTimestamp;

  const withinLimits = (amount: Money): PaymentFailureCode | undefined => {
    if (!capabilities.currencies.includes(amount.currency)) return 'not_supported';
    if (
      capabilities.minAmountMinor !== undefined &&
      amount.amountMinor < capabilities.minAmountMinor
    ) {
      return 'not_supported';
    }
    if (
      capabilities.maxAmountMinor !== undefined &&
      amount.amountMinor > capabilities.maxAmountMinor
    ) {
      return 'limit_exceeded';
    }
    return undefined;
  };

  return {
    rail,
    capabilities,
    verification,
    mode: 'sandbox',

    initiate: (request: PaymentInitiation): Promise<PaymentResult> => {
      // Capability and limit checks run BEFORE the behaviour switch, because a
      // rail that cannot take PKR 4,990 rejects it whatever the test handle
      // says — and a plan that is unpayable on a rail is a real product
      // problem worth surfacing in development.
      const limitFailure = withinLimits(request.amount);
      if (limitFailure !== undefined) {
        return Promise.resolve({
          rail,
          status: 'failed' as const,
          failureCode: limitFailure,
          occurredAt: iso(),
        });
      }

      const railReference = `${rail}_sbx_${randomUUID()}`;
      const behaviour = behaviourOf(request.payerHandle);

      const record = (status: PaymentStatus, failureCode?: PaymentFailureCode): PaymentResult => {
        ledger.set(railReference, {
          status,
          amount: request.amount,
          reference: request.reference,
          ...(failureCode === undefined ? {} : { failureCode }),
          refundedMinor: 0,
        });
        return {
          rail,
          status,
          railReference,
          ...(failureCode === undefined ? {} : { failureCode }),
          occurredAt: iso(),
        };
      };

      switch (behaviour) {
        case '0001':
          return Promise.resolve(record('failed', 'declined'));
        case '0002':
          return Promise.resolve(record('failed', 'insufficient_funds'));
        case '0003':
          return Promise.resolve(record('failed', 'rail_timeout'));
        case '0006':
          return Promise.resolve(record('failed', 'limit_exceeded'));
        case '0007':
          return Promise.resolve(record('failed', 'rail_unavailable'));
        case '0004':
          // Authorised and left there. Only reconciliation resolves it.
          return Promise.resolve(record('authorized'));
        case '0005':
          // The rail took the money and will never tell us. `queryStatus` is
          // the only way to find out, which is the entire point of having it.
          ledger.set(railReference, {
            status: 'captured',
            amount: request.amount,
            reference: request.reference,
            refundedMinor: 0,
          });
          return Promise.resolve({
            rail,
            status: 'pending' as const,
            railReference,
            redirectUrl: `https://sandbox.invalid/${rail}/${railReference}`,
            occurredAt: iso(),
          });
        case '0000':
        default:
          return Promise.resolve({
            ...record('pending'),
            redirectUrl: `https://sandbox.invalid/${rail}/${railReference}`,
          });
      }
    },

    queryStatus: (railReference: string): Promise<PaymentResult> => {
      const found = ledger.get(railReference);
      if (!found) {
        // The rail has never heard of it. Not a failure — an unresolved
        // payment, which is a different thing and gets a different response
        // from the reconciler.
        return Promise.resolve({
          rail,
          status: 'unresolved' as const,
          railReference,
          occurredAt: iso(),
        });
      }
      return Promise.resolve({
        rail,
        status: found.status,
        railReference,
        ...(found.failureCode === undefined ? {} : { failureCode: found.failureCode }),
        occurredAt: iso(),
      });
    },

    cancel: (railReference: string): Promise<PaymentResult> => {
      if (!capabilities.cancellation) {
        return Promise.reject(new RailCapabilityError(rail, 'cancellation'));
      }

      const found = ledger.get(railReference);
      if (!found) {
        return Promise.resolve({
          rail,
          status: 'unresolved' as const,
          railReference,
          occurredAt: iso(),
        });
      }
      if (found.status === 'captured') {
        // Past capture the answer is a refund, not a void. Returning success
        // here would let the caller believe money came back when it did not.
        return Promise.reject(new RailCapabilityError(rail, 'cancellation after capture'));
      }

      found.status = 'cancelled';
      return Promise.resolve({
        rail,
        status: 'cancelled' as const,
        railReference,
        occurredAt: iso(),
      });
    },

    refund: (request: RefundRequest): Promise<RefundResult> => {
      if (capabilities.refunds === 'none') {
        return Promise.reject(new RailCapabilityError(rail, 'refunds'));
      }

      const found = ledger.get(request.railReference);
      if (found?.status !== 'captured') {
        return Promise.resolve({
          rail,
          status: 'failed' as const,
          amount: request.amount ?? { amountMinor: 0, currency: 'PKR' },
          failureCode: 'not_supported' as const,
          occurredAt: iso(),
        });
      }

      const requested = request.amount?.amountMinor ?? found.amount.amountMinor;
      const remaining = found.amount.amountMinor - found.refundedMinor;

      if (capabilities.refunds === 'full_only' && requested !== found.amount.amountMinor) {
        return Promise.reject(new RailCapabilityError(rail, 'partial refunds'));
      }
      if (requested > remaining) {
        // Refunding more than was taken is not a rounding error, it is a
        // reconciliation failure, and it must not be quietly clamped.
        return Promise.resolve({
          rail,
          status: 'failed' as const,
          amount: { amountMinor: requested, currency: found.amount.currency },
          failureCode: 'limit_exceeded' as const,
          occurredAt: iso(),
        });
      }

      found.refundedMinor += requested;
      if (found.refundedMinor >= found.amount.amountMinor) found.status = 'refunded';

      return Promise.resolve({
        rail,
        status: 'succeeded' as const,
        railReference: `${request.railReference}_rfnd_${randomUUID().slice(0, 8)}`,
        amount: { amountMinor: requested, currency: found.amount.currency },
        occurredAt: iso(),
      });
    },

    verifyCallback: (
      rawBody: Uint8Array,
      headers: Readonly<Record<string, string | undefined>>,
    ): Promise<PaymentCallback> => {
      try {
        /* Verify before parsing, for the same reason the subscription webhook
         * does: parsing first runs a JSON parser over unauthenticated bytes. */
        const header = headers[SIGNATURE_HEADER] ?? headers[SIGNATURE_HEADER.toLowerCase()];
        if (header === undefined || header === '') {
          throw new WebhookVerificationError('missing_signature');
        }

        const parsed = parseSignature(header);
        if (parsed === undefined) {
          throw new WebhookVerificationError('malformed', 'signature header');
        }

        const expected = createHmac('sha256', options.callbackSecret)
          .update(signaturePayload(parsed.timestamp, rawBody))
          .digest('hex');

        if (!matches(expected, parsed.signature)) {
          throw new WebhookVerificationError('bad_signature');
        }

        const skew = Math.abs(Math.floor(now().getTime() / 1000) - parsed.timestamp);
        if (skew > tolerance) throw new WebhookVerificationError('stale_timestamp');

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

        const reference = asString(body.reference);
        const railReference = asString(body.rail_reference);
        const status = asString(body.status);

        if (reference === undefined || railReference === undefined || status === undefined) {
          throw new WebhookVerificationError(
            'malformed',
            'reference, rail_reference, and status are required',
          );
        }

        const known = ledger.get(railReference);
        const failureCode = asString(body.failure_code) as PaymentFailureCode | undefined;
        const nextStatus = status as PaymentStatus;
        if (known) known.status = nextStatus;

        return Promise.resolve({
          rail,
          externalEventId: asString(body.event_id) ?? railReference,
          reference,
          result: {
            rail,
            status: nextStatus,
            railReference,
            ...(failureCode === undefined ? {} : { failureCode }),
            occurredAt: (asString(body.occurred_at) ?? iso()) as IsoTimestamp,
          },
          payload: redactPayload(body) as Readonly<Record<string, unknown>>,
        });
      } catch (error) {
        // A rejection, not a throw: the interface promises a Promise, and a
        // caller's `.catch()` must actually run.
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
};
