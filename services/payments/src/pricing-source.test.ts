import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Prices live in the database. Nowhere else.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS TEST SCANS THE SOURCE FOR PRICE LITERALS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A price hard-coded in application code is not merely untidy. It is a second
 * source of truth that disagrees with the first the moment either changes, and
 * the disagreement surfaces as a parent charged one amount and shown another —
 * which is a refund, a support conversation, and in some jurisdictions a
 * regulatory problem.
 *
 * The rule is enforced structurally elsewhere: `PlanPolicy` is built from a
 * database row and has no defaults, and the mock rail is handed a price rather
 * than choosing one. This test is the backstop for the case structure cannot
 * catch — someone writing `if (plan === 'monthly') return 49900` in a hurry.
 *
 * Migrations and tests are exempt. The migration IS the price list, and a test
 * asserting on a real price is doing its job.
 */

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

const SCANNED = [
  'apps/api/src',
  'apps/web/src',
  'apps/mobile/src',
  'services/payments/src',
  'packages/config/src',
];

const SKIP_FILE = /\.test\.tsx?$|\.generated\.ts$/;

const walk = (dir: string): string[] => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    if (!/\.tsx?$/.test(entry.name) || SKIP_FILE.test(entry.name)) return [];
    return [full];
  });
};

const sourceFiles = (): string[] => SCANNED.flatMap((dir) => walk(join(REPO, dir)));

describe('pricing', () => {
  it('finds source to scan, so this test is testing something', () => {
    expect(sourceFiles().length).toBeGreaterThan(30);
  });

  /**
   * The five real prices, in minor units, as seeded by the migration.
   *
   * Written with separators and without, because `49_900` and `49900` are the
   * same number to a reader and different strings to a grep.
   */
  it('never writes a plan price into application code', () => {
    const prices = [14_900, 49_900, 79_900, 499_000];
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const price of prices) {
        const plain = String(price);
        const separated = plain.replace(/\B(?=(\d{3})+(?!\d))/g, '_');
        if (source.includes(plain) || source.includes(separated)) {
          offenders.push(`${file.slice(REPO.length)} contains ${plain}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * And no plan-shaped conditional that could grow into one.
   *
   * `plan === 'monthly'` in a pricing context is how a price literal gets
   * introduced: the branch appears first, the number follows. Plan CODES are
   * legitimate in a great deal of code — the catch is a branch on a code inside
   * a file that also mentions money.
   */
  it('never branches on a plan code to decide an amount', () => {
    const offenders: string[] = [];
    // Paid codes only. `tier === 'free'` is a structural distinction — a free
    // plan needs no checkout — and decides nothing about an amount.
    const branch = /(?:===|!==)\s*['"](?:weekly|monthly|yearly|family)['"]/;
    const money = /amountMinor|priceMinor|price_minor|amount_minor/;

    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      if (!money.test(source)) continue;

      for (const [index, line] of source.split('\n').entries()) {
        if (branch.test(line)) {
          offenders.push(`${file.slice(REPO.length)}:${String(index + 1)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * Trial and grace lengths are policy, and policy is data too.
   *
   * A hard-coded seven-day grace window is the same bug as a hard-coded price,
   * with a slower failure mode: it is only wrong for the plans whose window
   * differs, and only noticed when one of those plans lapses.
   */
  it('never hard-codes a trial or grace window outside the state machine', () => {
    const offenders: string[] = [];
    const suspicious = /(?:trialDays|graceDays|trial_days|grace_days)\s*[:=]\s*\d+/;
    // Scoped to files that are about subscriptions. "Grace period" also names
    // how long a DELETED ACCOUNT stays recoverable, which is a different
    // concept that happens to share the word.
    const subscriptionShaped = /subscription_plans|PlanPolicy|billingInterval|planCode/;

    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      if (!subscriptionShaped.test(source)) continue;

      for (const [index, line] of source.split('\n').entries()) {
        if (suspicious.test(line)) {
          offenders.push(`${file.slice(REPO.length)}:${String(index + 1)} — ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
