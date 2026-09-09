import { describe, expect, it } from 'vitest';

import { assertNoCardData, CARD_ASSUMED_CAPABILITIES, createCardRail } from './card.js';
import {
  CARRIER_BILLING_ASSUMED_CAPABILITIES,
  createCarrierBillingRail,
} from './carrier-billing.js';
import { createEasypaisaRail, EASYPAISA_ASSUMED_CAPABILITIES } from './easypaisa.js';
import { createJazzCashRail, JAZZCASH_ASSUMED_CAPABILITIES } from './jazzcash.js';
import { createRailRegistry, describeRegistry } from './registry.js';
import { signRailCallback } from './sandbox.js';
import {
  isFullyVerified,
  isRetryableFailure,
  outstandingChecks,
  RailCapabilityError,
  RailNotVerifiedError,
  type PaymentInitiation,
  type PaymentRailAdapter,
} from './types.js';

/**
 * Payment rails.
 *
 * The thing under test here is mostly *refusal*: that an unverified rail will
 * not pretend to work, that a rail without refunds will not pretend to refund,
 * and that an application with no rails at all keeps running. Those are the
 * behaviours that cost money or take the product down when they are wrong, and
 * every one of them is invisible on a happy path.
 */

const NOW = new Date('2026-06-01T12:00:00.000Z');
const SECRET = 'sandbox-rail-signing-key-for-tests';

const sandboxConfig = { mode: 'sandbox' as const, sandboxCallbackSecret: SECRET, now: () => NOW };

const jazzcash = createJazzCashRail({
  merchantId: 'test-merchant',
  password: 'test-password',
  integritySalt: 'test-salt',
  ...sandboxConfig,
});

const carrier = createCarrierBillingRail({
  aggregator: 'test-aggregator',
  merchantId: 'test-merchant',
  apiKey: 'test-key',
  callbackSecret: 'test-callback',
  ...sandboxConfig,
});

const card = createCardRail({
  processor: 'test-processor',
  secretKey: 'test-key',
  webhookSecret: 'test-webhook',
  ...sandboxConfig,
});

const initiation = (overrides: Partial<PaymentInitiation> = {}): PaymentInitiation => ({
  reference: 'payment-1',
  amount: { amountMinor: 49_900, currency: 'PKR' },
  idempotencyKey: 'idem-00000001',
  description: 'Monthly plan',
  ...overrides,
});

/* ========================================================================== */
/* Verification                                                               */
/* ========================================================================== */

describe('verification', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * NO RAIL CLAIMS TO BE READY.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Not one endpoint, field name, or signature recipe for any of these four
   * providers has been read from its own documentation. This test is what stops
   * that changing quietly: flipping a checklist item to `true` is a deliberate
   * act by someone who checked, and until then every rail reports itself
   * unverified.
   */
  it('reports every rail as unverified, because none has been checked', () => {
    for (const rail of [jazzcash, carrier, card]) {
      expect(isFullyVerified(rail.verification), rail.rail).toBe(false);
      expect(outstandingChecks(rail.verification).length).toBeGreaterThan(0);
    }
  });

  it('names what is outstanding, so the work is bounded rather than vague', () => {
    const outstanding = outstandingChecks(jazzcash.verification);

    expect(outstanding).toContain('endpoints');
    expect(outstanding).toContain('signatureScheme');
    expect(outstanding).toContain('amountUnits');
    expect(outstanding).toContain('sandboxTested');
  });

  it('says where the answers come from', () => {
    expect(jazzcash.verification.source).toContain('JazzCash');
    expect(carrier.verification.source).toContain('aggregator');
  });

  /**
   * A live adapter that returned a plausible success would be the single most
   * dangerous thing in this package: a subscription nobody paid for, discovered
   * during reconciliation weeks later.
   */
  it('refuses every operation in live mode rather than guessing', async () => {
    const live = createJazzCashRail({
      merchantId: 'm',
      password: 'p',
      integritySalt: 's',
      mode: 'live',
      sandboxCallbackSecret: SECRET,
      now: () => NOW,
    });

    await expect(live.initiate(initiation())).rejects.toBeInstanceOf(RailNotVerifiedError);
    await expect(live.queryStatus('ref')).rejects.toBeInstanceOf(RailNotVerifiedError);
    await expect(
      live.refund({ railReference: 'ref', idempotencyKey: 'k-0000001', reason: 'test' }),
    ).rejects.toBeInstanceOf(RailNotVerifiedError);
    await expect(live.verifyCallback(new Uint8Array(), {})).rejects.toBeInstanceOf(
      RailNotVerifiedError,
    );
  });

  it('does not silently fall back to sandbox when live is unavailable', async () => {
    const live = createEasypaisaRail({
      storeId: 's',
      hashKey: 'h',
      mode: 'live',
      sandboxCallbackSecret: SECRET,
      now: () => NOW,
    });

    expect(live.mode).toBe('live');
    await expect(live.initiate(initiation())).rejects.toThrow(/not implemented/);
  });
});

/* ========================================================================== */
/* Capabilities                                                               */
/* ========================================================================== */

describe('capabilities', () => {
  it('assumes the least, so nothing is promised that cannot be delivered', () => {
    // Pessimistic until verified: an unoffered refund that turns out to be
    // possible is a feature; a promised one that is not is a support crisis.
    for (const capabilities of [
      JAZZCASH_ASSUMED_CAPABILITIES,
      EASYPAISA_ASSUMED_CAPABILITIES,
      CARRIER_BILLING_ASSUMED_CAPABILITIES,
    ]) {
      expect(capabilities.refunds).toBe('none');
      expect(capabilities.recurring).toBe('none');
      expect(capabilities.currencies).toEqual(['PKR']);
    }
  });

  it('leaves transaction ceilings unknown rather than assuming there are none', () => {
    // `undefined` is not "no limit". Wallets and carrier billing both impose
    // ceilings, and a yearly plan may simply be unpayable on some rails.
    expect(JAZZCASH_ASSUMED_CAPABILITIES.maxAmountMinor).toBeUndefined();
    expect(CARRIER_BILLING_ASSUMED_CAPABILITIES.maxAmountMinor).toBeUndefined();
  });

  it('gives cards the capabilities cards have had for decades', () => {
    expect(CARD_ASSUMED_CAPABILITIES.refunds).toBe('full_and_partial');
    expect(CARD_ASSUMED_CAPABILITIES.recurring).toBe('native');
    expect(CARD_ASSUMED_CAPABILITIES.cancellation).toBe(true);
  });

  it('refuses a refund on a rail that cannot make one', async () => {
    // Carrier billing generally cannot return money. Failing here, in
    // development, is the entire reason capabilities are declared.
    await expect(
      carrier.refund({ railReference: 'ref', idempotencyKey: 'k-0000001', reason: 'test' }),
    ).rejects.toBeInstanceOf(RailCapabilityError);
  });

  it('refuses a cancellation on a rail that cannot void', async () => {
    await expect(jazzcash.cancel('ref')).rejects.toBeInstanceOf(RailCapabilityError);
  });
});

/* ========================================================================== */
/* The sandbox                                                                */
/* ========================================================================== */

describe('the sandbox rail', () => {
  it('takes a payment and waits for the rail, rather than assuming success', async () => {
    const result = await jazzcash.initiate(initiation());

    // `pending`, not `captured`. A payment is not successful because we asked.
    expect(result.status).toBe('pending');
    expect(result.railReference).toBeDefined();
    expect(result.redirectUrl).toBeDefined();
  });

  it.each([
    ['0001', 'declined'],
    ['0002', 'insufficient_funds'],
    ['0006', 'limit_exceeded'],
    ['0007', 'rail_unavailable'],
  ] as const)('drives %s to a %s failure', async (suffix, expected) => {
    const result = await jazzcash.initiate(initiation({ payerHandle: `0300000${suffix}` }));

    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe(expected);
  });

  it('separates a rail being down from a payment being declined', () => {
    // Retrying a declined card annoys a customer; retrying a network failure is
    // exactly right. Conflating them produces a dunning policy that is wrong in
    // both directions.
    expect(isRetryableFailure('declined')).toBe(false);
    expect(isRetryableFailure('insufficient_funds')).toBe(false);
    expect(isRetryableFailure('rail_unavailable')).toBe(true);
    expect(isRetryableFailure('rail_timeout')).toBe(true);
  });

  /**
   * `unknown` is deliberately NOT retryable.
   *
   * An unrecognised rail code might mean "try again" or might mean "you have
   * already been charged". Retrying on that guess risks charging a family
   * twice, so it goes to reconciliation, which asks.
   */
  it('does not retry a failure it does not understand', () => {
    expect(isRetryableFailure('unknown')).toBe(false);
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THE CALLBACK THAT NEVER ARRIVES.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The customer has been charged. We were never told. No amount of care on the
   * request path detects this — only asking the rail does, which is why
   * `queryStatus` exists and why reconciliation is not optional.
   */
  it('can be asked what really happened when no callback came', async () => {
    const started = await jazzcash.initiate(initiation({ payerHandle: '03000000005' }));
    expect(started.status).toBe('pending');

    const truth = await jazzcash.queryStatus(started.railReference!);
    expect(truth.status).toBe('captured');
  });

  it('reports a payment it has never heard of as unresolved, not failed', async () => {
    // "We do not know" and "it failed" are different, and treating the first as
    // the second is how a paying customer is told they were declined.
    const result = await jazzcash.queryStatus('jazzcash_sbx_nonexistent');

    expect(result.status).toBe('unresolved');
  });

  it('refuses a payment in a currency the rail does not settle', async () => {
    const result = await jazzcash.initiate(
      initiation({ amount: { amountMinor: 1_000, currency: 'USD' } }),
    );

    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('not_supported');
  });

  it('verifies callback signatures rather than trusting the body', async () => {
    const started = await card.initiate(initiation());
    const body = JSON.stringify({
      event_id: 'evt_1',
      reference: 'payment-1',
      rail_reference: started.railReference,
      status: 'captured',
      occurred_at: NOW.toISOString(),
    });

    const good = await card.verifyCallback(Buffer.from(body), {
      'x-kc-rail-signature': signRailCallback(body, SECRET, Math.floor(NOW.getTime() / 1000)),
    });
    expect(good.result.status).toBe('captured');

    await expect(
      card.verifyCallback(Buffer.from(body), {
        'x-kc-rail-signature': signRailCallback(body, 'wrong', Math.floor(NOW.getTime() / 1000)),
      }),
    ).rejects.toMatchObject({ reason: 'bad_signature' });

    await expect(card.verifyCallback(Buffer.from(body), {})).rejects.toMatchObject({
      reason: 'missing_signature',
    });
  });

  it('refuses a callback replayed outside the tolerance window', async () => {
    const body = JSON.stringify({
      reference: 'payment-1',
      rail_reference: 'card_sbx_x',
      status: 'captured',
    });
    const anHourAgo = Math.floor(NOW.getTime() / 1000) - 3_600;

    await expect(
      card.verifyCallback(Buffer.from(body), {
        'x-kc-rail-signature': signRailCallback(body, SECRET, anHourAgo),
      }),
    ).rejects.toMatchObject({ reason: 'stale_timestamp' });
  });

  it('refunds a card payment, in full and in part', async () => {
    const started = await card.initiate(initiation());
    const body = JSON.stringify({
      reference: 'payment-1',
      rail_reference: started.railReference,
      status: 'captured',
    });
    await card.verifyCallback(Buffer.from(body), {
      'x-kc-rail-signature': signRailCallback(body, SECRET, Math.floor(NOW.getTime() / 1000)),
    });

    const partial = await card.refund({
      railReference: started.railReference!,
      amount: { amountMinor: 10_000, currency: 'PKR' },
      idempotencyKey: 'refund-0000001',
      reason: 'goodwill',
    });
    expect(partial.status).toBe('succeeded');
    expect(partial.amount.amountMinor).toBe(10_000);

    // More than remains is a reconciliation failure, not a rounding error, and
    // must not be quietly clamped.
    const over = await card.refund({
      railReference: started.railReference!,
      amount: { amountMinor: 99_000, currency: 'PKR' },
      idempotencyKey: 'refund-0000002',
      reason: 'too much',
    });
    expect(over.status).toBe('failed');
  });
});

/* ========================================================================== */
/* Card data                                                                  */
/* ========================================================================== */

describe('card data', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * THERE IS NO PARAMETER FOR A CARD NUMBER, AND A CHECK IN CASE.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The processor collects card details on the customer's device. This guard is
   * a defence against our own future code — the day someone wires a form field
   * through "just to debug" — and it fails loudly rather than redacting
   * quietly, because the caller is the bug.
   */
  it('refuses an initiation carrying something card-shaped', () => {
    expect(() => assertNoCardData(initiation({ payerHandle: '4111111111111111' }))).toThrow(
      /card-shaped/,
    );
    expect(() => assertNoCardData(initiation({ instrumentToken: '4242 4242 4242 4242' }))).toThrow(
      /card-shaped/,
    );
  });

  it('allows ordinary handles and tokens', () => {
    expect(() => assertNoCardData(initiation({ payerHandle: '03001234567' }))).not.toThrow();
    expect(() => assertNoCardData(initiation({ instrumentToken: 'tok_9f2c4a' }))).not.toThrow();
  });

  it('is wired into the card rail, not merely exported', async () => {
    await expect(card.initiate(initiation({ payerHandle: '4111111111111111' }))).rejects.toThrow(
      /card-shaped/,
    );
  });
});

/* ========================================================================== */
/* The registry                                                               */
/* ========================================================================== */

describe('the registry', () => {
  /**
   * ═══════════════════════════════════════════════════════════════════════
   * ZERO RAILS IS THE DEFAULT STATE OF THIS PRODUCT.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Payments are off in local development, off in CI, and off in any deployment
   * where the rail question is unanswered. A children's app must not be taken
   * down by an unfinished payment integration.
   */
  it('is empty when nothing is enabled, and says so without throwing', () => {
    const registry = createRailRegistry({ enabled: [] });

    expect(registry.anyAvailable()).toBe(false);
    expect(registry.available()).toEqual([]);
    expect(registry.get('jazzcash')).toBeUndefined();
    expect(describeRegistry(registry)).toEqual([]);
  });

  it('skips a rail that is enabled but not configured', () => {
    // A switched-on rail with no credentials is left out rather than built
    // half-formed. It appears the moment the credentials arrive, with no code
    // change and no restart logic.
    const registry = createRailRegistry({ enabled: ['jazzcash', 'easypaisa'] });

    expect(registry.anyAvailable()).toBe(false);
  });

  it('builds only the rails that are switched on', () => {
    const registry = createRailRegistry({
      enabled: ['jazzcash'],
      jazzcash: {
        merchantId: 'm',
        password: 'p',
        integritySalt: 's',
        ...sandboxConfig,
      },
      easypaisa: { storeId: 's', hashKey: 'h', ...sandboxConfig },
    });

    expect(registry.get('jazzcash')).toBeDefined();
    // Configured but not enabled. Configuration alone must not switch a rail on.
    expect(registry.get('easypaisa')).toBeUndefined();
  });

  it('reports which enabled rails are running unverified', () => {
    const registry = createRailRegistry({
      enabled: ['jazzcash'],
      jazzcash: { merchantId: 'm', password: 'p', integritySalt: 's', ...sandboxConfig },
    });

    expect(registry.unverified().map((rail: PaymentRailAdapter) => rail.rail)).toEqual([
      'jazzcash',
    ]);

    const described = describeRegistry(registry);
    expect(described[0]).toMatchObject({ rail: 'jazzcash', mode: 'sandbox', verified: false });
    expect(described[0]?.outstanding.length).toBeGreaterThan(0);
  });
});
