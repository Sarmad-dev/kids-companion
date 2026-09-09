import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createMockSubscriptionProvider, signMockWebhook } from './mock-provider.js';
import { WebhookVerificationError } from './ports.js';
import { looksLikeCardNumber, redactPayload, REDACTED } from './redaction.js';

/**
 * Webhook authentication.
 *
 * These tests exist because the failure they guard against is silent. A webhook
 * endpoint that does not verify signatures works perfectly in every manual test
 * — the payments flow completes, the subscription activates, nobody notices —
 * right up until someone posts their own JSON to it and gets a free family
 * plan.
 */

const SECRET = 'test-webhook-secret-of-adequate-length';
const NOW = new Date('2026-04-01T12:00:00.000Z');

const provider = createMockSubscriptionProvider({
  webhookSecret: SECRET,
  toleranceSeconds: 300,
  now: () => NOW,
});

const body = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: 'evt_001',
    type: 'subscription.activated',
    occurred_at: '2026-04-01T11:59:00.000Z',
    data: { reference: 'checkout-1', amount_minor: 49_900, currency: 'PKR' },
    ...overrides,
  });

const signedNow = (raw: string): Record<string, string> => ({
  'x-kc-signature': signMockWebhook(raw, SECRET, Math.floor(NOW.getTime() / 1000)),
});

describe('webhook verification', () => {
  it('accepts a correctly signed event', async () => {
    const raw = body();
    const event = await provider.verifyAndParseWebhook(Buffer.from(raw), signedNow(raw));

    expect(event.externalEventId).toBe('evt_001');
    expect(event.type).toBe('subscription.activated');
    expect(event.reference).toBe('checkout-1');
    expect(event.amount).toEqual({ amountMinor: 49_900, currency: 'PKR' });
  });

  it('refuses an unsigned request', async () => {
    const raw = body();
    await expect(provider.verifyAndParseWebhook(Buffer.from(raw), {})).rejects.toMatchObject({
      name: 'WebhookVerificationError',
      reason: 'missing_signature',
    });
  });

  it('refuses a forged signature', async () => {
    const raw = body();
    const forged = signMockWebhook(raw, 'not-the-real-secret', Math.floor(NOW.getTime() / 1000));

    await expect(
      provider.verifyAndParseWebhook(Buffer.from(raw), { 'x-kc-signature': forged }),
    ).rejects.toMatchObject({ reason: 'bad_signature' });
  });

  it('refuses a body altered after signing', async () => {
    // The attack this stops: capture a real `payment.failed`, change the type
    // to `subscription.renewed`, post it back.
    const original = body();
    const headers = signedNow(original);
    const tampered = body({ type: 'subscription.renewed' });

    await expect(
      provider.verifyAndParseWebhook(Buffer.from(tampered), headers),
    ).rejects.toMatchObject({ reason: 'bad_signature' });
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════
   * A CAPTURED REQUEST IS VALID FOREVER WITHOUT THIS CHECK.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The signature proves the rail sent it. It says nothing about when, so an
   * attacker who observes one `subscription.renewed` can replay it monthly. The
   * timestamp is inside the signed material precisely so it cannot be moved
   * forward without breaking the signature.
   */
  it('refuses a request replayed outside the tolerance window', async () => {
    const raw = body();
    const anHourAgo = Math.floor(NOW.getTime() / 1000) - 3_600;

    await expect(
      provider.verifyAndParseWebhook(Buffer.from(raw), {
        'x-kc-signature': signMockWebhook(raw, SECRET, anHourAgo),
      }),
    ).rejects.toMatchObject({ reason: 'stale_timestamp' });
  });

  it('refuses a timestamp from the future', async () => {
    // Either a badly skewed clock or an attempt to mint a request that stays
    // valid for a week.
    const raw = body();
    const nextWeek = Math.floor(NOW.getTime() / 1000) + 604_800;

    await expect(
      provider.verifyAndParseWebhook(Buffer.from(raw), {
        'x-kc-signature': signMockWebhook(raw, SECRET, nextWeek),
      }),
    ).rejects.toMatchObject({ reason: 'stale_timestamp' });
  });

  it('accepts a redelivery inside the window — rails retry, and that is normal', async () => {
    const raw = body();
    const twoMinutesAgo = Math.floor(NOW.getTime() / 1000) - 120;

    const event = await provider.verifyAndParseWebhook(Buffer.from(raw), {
      'x-kc-signature': signMockWebhook(raw, SECRET, twoMinutesAgo),
    });

    expect(event.externalEventId).toBe('evt_001');
  });

  it('refuses a malformed signature header', async () => {
    const raw = body();
    await expect(
      provider.verifyAndParseWebhook(Buffer.from(raw), { 'x-kc-signature': 'garbage' }),
    ).rejects.toMatchObject({ reason: 'malformed' });
  });

  it('refuses an unknown event type even when correctly signed', async () => {
    // A rail we trust can still send something we do not understand. Guessing
    // at it is how an unmapped event becomes an unintended state change.
    const raw = body({ type: 'subscription.upgraded_to_platinum' });

    await expect(
      provider.verifyAndParseWebhook(Buffer.from(raw), signedNow(raw)),
    ).rejects.toMatchObject({ reason: 'malformed' });
  });

  it('refuses an event with no id, since the id is the idempotency key', async () => {
    const raw = JSON.stringify({ type: 'subscription.renewed', occurred_at: NOW.toISOString() });

    await expect(
      provider.verifyAndParseWebhook(Buffer.from(raw), signedNow(raw)),
    ).rejects.toMatchObject({ reason: 'malformed' });
  });

  it('verifies before parsing', async () => {
    // Unparseable bytes with a bad signature must fail on the SIGNATURE, not on
    // the parse — otherwise the JSON parser is running on unauthenticated input.
    const raw = '{{{not json';
    const error = await provider
      .verifyAndParseWebhook(Buffer.from(raw), { 'x-kc-signature': 't=1,v1=00' })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(WebhookVerificationError);
    expect((error as WebhookVerificationError).reason).toBe('bad_signature');
  });

  it('signs over the exact bytes, so a re-encoded body does not verify', async () => {
    // Re-serialising the body through JSON.parse/stringify changes whitespace
    // and key order. Verifying the re-encoding rather than the original is the
    // quiet way to end up verifying nothing.
    const raw = `{ "id": "evt_002",  "type": "subscription.renewed", "occurred_at": "${NOW.toISOString()}" }`;
    const headers = signedNow(raw);
    const reEncoded = JSON.stringify(JSON.parse(raw));

    expect(reEncoded).not.toBe(raw);
    await expect(
      provider.verifyAndParseWebhook(Buffer.from(reEncoded), headers),
    ).rejects.toMatchObject({ reason: 'bad_signature' });
  });

  it('uses the documented scheme, so a real rail adapter can copy it', () => {
    const timestamp = 1_777_000_000;
    const raw = 'payload';
    const expected = createHmac('sha256', SECRET)
      .update(`${String(timestamp)}.${raw}`)
      .digest('hex');

    expect(signMockWebhook(raw, SECRET, timestamp)).toBe(`t=${String(timestamp)},v1=${expected}`);
  });
});

describe('checkout', () => {
  it('returns somewhere to send the parent and never a status', async () => {
    const session = await provider.createCheckout({
      parentId: 'parent-1' as never,
      plan: {
        code: 'monthly',
        displayName: 'Monthly',
        tier: 'paid',
        price: { amountMinor: 49_900, currency: 'PKR' },
        billingInterval: 'month',
        trialDays: 7,
        graceDays: 7,
      },
      reference: 'checkout-1',
      idempotencyKey: 'key-0000001',
      trialAvailable: true,
    });

    expect(session.rail).toBe('mock');
    expect(session.redirectUrl).toContain('checkout-1');
    // The type has no field for it, which is the actual guarantee.
    expect(session).not.toHaveProperty('status');
  });
});

/* ========================================================================== */
/* Redaction                                                                  */
/* ========================================================================== */

describe('payload redaction', () => {
  it('removes card data by field name', () => {
    const clean = redactPayload({
      card_number: '4111111111111111',
      cvv: '123',
      expiry_month: '04',
      iban: 'PK36SCBL0000001123456702',
      amount_minor: 49_900,
    }) as Record<string, unknown>;

    expect(clean.card_number).toBe(REDACTED);
    expect(clean.cvv).toBe(REDACTED);
    expect(clean.expiry_month).toBe(REDACTED);
    expect(clean.iban).toBe(REDACTED);
    expect(clean.amount_minor).toBe(49_900);
  });

  /**
   * The one that earns its keep.
   *
   * No key list would have predicted `metadata.note`. The Luhn check does not
   * need to.
   */
  it('removes a card number hiding under an innocent key', () => {
    const clean = redactPayload({
      metadata: { note: 'customer said 4111 1111 1111 1111 was declined' },
      reference: '4242424242424242',
    }) as Record<string, unknown>;

    expect(clean.reference).toBe(REDACTED);
  });

  it('keeps ordinary identifiers that are not card-shaped', () => {
    const clean = redactPayload({
      invoice_number: 'INV-2026-0041',
      subscription_id: 'sub_9f2c',
      amount_minor: 79_900,
    }) as Record<string, unknown>;

    expect(clean.invoice_number).toBe('INV-2026-0041');
    expect(clean.subscription_id).toBe('sub_9f2c');
  });

  it('knows a real card number from a long number that is not one', () => {
    expect(looksLikeCardNumber('4111111111111111')).toBe(true);
    expect(looksLikeCardNumber('4111 1111 1111 1111')).toBe(true);
    expect(looksLikeCardNumber('4111111111111112')).toBe(false);
    expect(looksLikeCardNumber('123')).toBe(false);
  });

  it('bounds depth, so a hostile payload cannot overflow the handler', () => {
    let deep: Record<string, unknown> = { end: '4242424242424242' };
    for (let i = 0; i < 200; i += 1) deep = { nested: deep };

    expect(() => redactPayload(deep)).not.toThrow();
  });
});
