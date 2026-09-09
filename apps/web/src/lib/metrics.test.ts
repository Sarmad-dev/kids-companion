import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { allMetrics, METRICS, metric } from './metrics';

const SRC = fileURLToPath(new URL('..', import.meta.url));

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return entry.name.endsWith('.tsx') || entry.name.endsWith('.ts') ? [full] : [];
  });

describe('the metric registry', () => {
  it('explains every metric, and says what each one is not', () => {
    for (const definition of allMetrics()) {
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.explanation.length).toBeGreaterThan(20);
      expect(definition.notMeasuring.length).toBeGreaterThan(20);
    }
  });

  it('keys itself consistently', () => {
    for (const [key, definition] of Object.entries(METRICS)) {
      expect(definition.key).toBe(key);
      expect(metric(key as keyof typeof METRICS)).toBe(definition);
    }
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * NO METRIC RENDERS WITHOUT ITS EXPLANATION.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `MetricCard` takes a key rather than a label, so the explanation travels
   * with the number by construction. This test closes the remaining gap: a page
   * naming a key that does not exist would be a metric with no entry here, and
   * TypeScript would catch it — but only for as long as the prop stays typed.
   */
  it('holds an entry for every metric key used by a page', () => {
    const used = new Set<string>();

    for (const file of filesUnder(join(SRC, 'app'))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/metricKey="([a-z_]+)"/g)) {
        if (match[1] !== undefined) used.add(match[1]);
      }
    }

    expect(used.size).toBeGreaterThan(0);
    for (const key of used) {
      expect(Object.keys(METRICS)).toContain(key);
    }
  });

  /**
   * The dashboard stays small on purpose.
   *
   * The brief says not to overwhelm parents with metrics, and the pressure runs
   * the other way — parents are the buyers and a dense dashboard looks like
   * value. A ceiling is a crude control, but it forces the conversation to
   * happen rather than letting the list grow one well-intentioned number at a
   * time.
   */
  it('stays short', () => {
    expect(allMetrics().length).toBeLessThanOrEqual(12);
  });

  /**
   * Vocabulary that would turn an observation into a claim about a child.
   *
   * These words carry clinical or comparative weight this product has no basis
   * for: it has no normative sample, no assessment instrument, and no clinician.
   * "Average" is the subtle one — an average of a child's own attempts is fine
   * in prose, but on a card labelled with a child's name it reads as an average
   * compared to other children.
   */
  it('makes no clinical or comparative claim', () => {
    const forbidden = [
      'percentile',
      'iq',
      'diagnos',
      'disorder',
      'delay',
      'deficit',
      'below average',
      'above average',
      'age-appropriate for',
      'should be able to',
      'behind',
      'ahead of',
    ];

    for (const definition of allMetrics()) {
      const text = `${definition.label} ${definition.explanation}`.toLowerCase();
      for (const word of forbidden) {
        expect(text, `${definition.key} says "${word}"`).not.toContain(word);
      }
    }
  });

  /**
   * The caveats have to deny something.
   *
   * A `notMeasuring` reading "this is a useful signal" would satisfy the type
   * and defeat the point. Every one of them must actually push back.
   */
  it('writes caveats that push back', () => {
    const denials = [
      ' not ',
      'rough',
      'only',
      'misses',
      'no ',
      'nothing',
      'many more',
      'the same as',
    ];

    for (const definition of allMetrics()) {
      const text = definition.notMeasuring.toLowerCase();
      expect(
        denials.some((word) => text.includes(word)),
        `${definition.key} has a caveat that does not deny anything`,
      ).toBe(true);
    }
  });
});
