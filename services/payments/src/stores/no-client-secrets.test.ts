import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * No store secret reaches the mobile application.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A KEY IN AN APP BUNDLE IS A KEY AN ATTACKER HAS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An app bundle is not a secure location. It is a zip file on a device the
 * attacker owns, and extracting strings from one is a five-minute job — which is
 * exactly why both Apple's and Google's purchase-verification APIs are
 * server-to-server in the first place.
 *
 * The division this test enforces:
 *
 *   the app   receives a purchase token from the store SDK and posts it to us,
 *   the server holds the credentials that ask the store whether it is real.
 *
 * Nothing about that is enforced by a type, because the mobile app is a separate
 * build with its own configuration — so it is enforced here, by reading the
 * source. The failure it guards against is quiet: a developer adds a store key
 * to the app's environment "to test something", it ships, and nobody notices
 * until somebody else notices.
 */

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const MOBILE = join(REPO, 'apps/mobile');

/**
 * Names a store credential travels under.
 *
 * The configuration variable names, and the words their values would be stored
 * against. Matched case-insensitively.
 */
const FORBIDDEN_IN_CLIENT = [
  'APPLE_IAP_ISSUER_ID',
  'APPLE_IAP_KEY_ID',
  'APPLE_IAP_PRIVATE_KEY',
  'APPLE_IAP_SHARED_SECRET',
  'GOOGLE_PLAY_SERVICE_ACCOUNT',
  'STORE_BILLING_MOCK_SECRET',
  'PAYMENTS_SANDBOX_CALLBACK_SECRET',
  'JAZZCASH_INTEGRITY_SALT',
  'JAZZCASH_PASSWORD',
  'EASYPAISA_HASH_KEY',
  'CARD_SECRET_KEY',
  'CARD_WEBHOOK_SECRET',
  'CARRIER_BILLING_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'sharedSecret',
  'serviceAccountJson',
  'privateKey',
];

const walk = (dir: string): string[] => {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === '.expo' || entry.name === 'dist') {
      return [];
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.(tsx?|json|js)$/.test(entry.name) ? [full] : [];
  });
};

describe('the mobile application', () => {
  it('exists, so this test is testing something', () => {
    expect(existsSync(MOBILE)).toBe(true);
    expect(walk(MOBILE).length).toBeGreaterThan(5);
  });

  it('holds no store or payment credential of any kind', () => {
    const offenders: string[] = [];

    for (const file of walk(MOBILE)) {
      const source = readFileSync(file, 'utf8');
      for (const secret of FORBIDDEN_IN_CLIENT) {
        if (source.toLowerCase().includes(secret.toLowerCase())) {
          offenders.push(`${file.slice(REPO.length)} mentions ${secret}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * And nothing that looks like a credential, whatever it is called.
   *
   * The list above catches the names we know. This catches the shape: a long
   * high-entropy literal in a mobile source file is a key somebody pasted, and
   * it is worth failing on even when nobody predicted its variable name.
   */
  it('carries no long secret-shaped literal', () => {
    const offenders: string[] = [];
    // Base64 or hex, 40+ characters, assigned to something.
    const secretShaped = /['"][A-Za-z0-9+/=_-]{40,}['"]/;

    for (const file of walk(MOBILE)) {
      // Lockfiles and generated manifests are full of hashes by design.
      if (file.endsWith('package-lock.json') || file.endsWith('app.json')) continue;

      const source = readFileSync(file, 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        if (secretShaped.test(line) && !line.trimStart().startsWith('//')) {
          offenders.push(`${file.slice(REPO.length)}:${String(index + 1)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The client cannot even name a subscription status field.
   *
   * `POST /api/store/verify` accepts a store and a token. If the mobile app were
   * building a request with `entitled` or `isActive` in it, that would be the
   * shape of a client trying to declare its own subscription — which the API
   * would reject, but the attempt is worth catching in the app that makes it.
   */
  it('never sends a subscription status to the API', () => {
    const offenders: string[] = [];
    const claiming = /(entitled|isActive|isSubscribed|subscriptionActive)\s*:\s*(true|false)/;

    for (const file of walk(MOBILE)) {
      const source = readFileSync(file, 'utf8');
      if (!/store|purchase|subscri/i.test(source)) continue;

      for (const [index, line] of source.split('\n').entries()) {
        if (claiming.test(line)) offenders.push(`${file.slice(REPO.length)}:${String(index + 1)}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
