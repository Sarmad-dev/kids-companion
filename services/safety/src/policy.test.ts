import { describe, expect, it } from 'vitest';

import { assertNoContent } from './events.js';
import { createSafetyPipeline, type SafetySubject } from './pipeline.js';
import { DEFAULT_POLICY, policyFromRows, resolveRule, type SafetyPolicy } from './policy.js';
import type { ClassificationResult, SafetyClassifier } from './ports.js';

/**
 * Policy resolution and the fail-closed guarantees.
 *
 * The adversarial corpus asks "does it catch things". This file asks the
 * question that matters more in an incident: when something goes wrong with the
 * safety machinery itself, which way does it fall?
 */

const permissive: SafetyClassifier = {
  name: 'permissive',
  model: 'test',
  classify: async (): Promise<ClassificationResult> =>
    await Promise.resolve({ flagged: false, categories: [], confidence: 0.01 }),
};

const child: SafetySubject = { childRef: 'c1', ageGroup: 'AGE_6_8', language: 'en' };

describe('policy resolution', () => {
  it('prefers an age-specific rule over the wildcard', () => {
    const policy: SafetyPolicy = {
      version: 'test',
      repeatedAttemptThreshold: 5,
      repeatedAttemptWindowMinutes: 15,
      rules: [
        {
          category: 'frightening',
          ageGroup: '*',
          appliesTo: 'both',
          action: 'observe',
          minConfidence: 0.9,
          escalates: false,
          policyVersion: 'test',
        },
        {
          category: 'frightening',
          ageGroup: 'AGE_3_5',
          appliesTo: 'model_output',
          action: 'block',
          minConfidence: 0.3,
          escalates: false,
          policyVersion: 'test',
        },
      ],
    };

    expect(resolveRule(policy, 'frightening', 'AGE_3_5', 'model_output').action).toBe('block');
    // The same category, an older child: the wildcard applies and the rule is
    // looser. This is how the policy narrows with age rather than widening.
    expect(resolveRule(policy, 'frightening', 'AGE_9_10', 'model_output').action).toBe('observe');
  });

  it('blocks a category the policy has never heard of', () => {
    const empty: SafetyPolicy = { ...DEFAULT_POLICY, rules: [] };
    // A category with no rule is not a category to wave through. If a new class
    // of harm is added to the taxonomy and someone forgets the policy row, the
    // failure must be an over-block, not an under-block.
    expect(resolveRule(empty, 'exploitation', 'AGE_6_8', 'child_input').action).toBe('block');
  });

  it('escalates a signal category even when the row forgets to', () => {
    const forgetful: SafetyPolicy = {
      ...DEFAULT_POLICY,
      rules: [
        {
          category: 'disclosure_of_harm',
          ageGroup: '*',
          appliesTo: 'child_input',
          action: 'redirect',
          minConfidence: 0.5,
          escalates: false,
          policyVersion: 'test',
        },
      ],
    };

    // The compiled-in escalation set is a floor. A misconfigured row can make a
    // rule stricter; it cannot stop a disclosure reaching a human.
    expect(resolveRule(forgetful, 'disclosure_of_harm', 'AGE_6_8', 'child_input').escalates).toBe(
      true,
    );
  });

  it('falls back to the built-in policy when the table yields nothing usable', () => {
    expect(policyFromRows([])).toBe(DEFAULT_POLICY);
    expect(policyFromRows([{ category: 'not_a_real_category' } as never])).toBe(DEFAULT_POLICY);
  });

  it('discards unrecognised categories but keeps the rest', () => {
    const policy = policyFromRows([
      {
        category: 'made_up',
        age_group: '*',
        applies_to: 'both',
        action: 'allow',
        min_confidence: 0,
        escalates: false,
        policy_version: '2026-08-01',
      },
      {
        category: 'violence',
        age_group: '*',
        applies_to: 'both',
        action: 'block',
        min_confidence: 0.5,
        escalates: false,
        policy_version: '2026-08-01',
      },
    ]);

    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0]?.category).toBe('violence');
  });
});

describe('fail-closed', () => {
  it('stops the turn when the classifier throws', async () => {
    const broken: SafetyClassifier = {
      name: 'broken',
      model: 'test',
      classify: async () => {
        await Promise.resolve();
        throw new Error('provider exploded');
      },
    };

    const verdict = await createSafetyPipeline({ classifier: broken }).checkInput(
      child,
      'hello there',
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.failedClosed).toBe(true);
    // Still a warm reply. A classifier outage is our problem, not the child's.
    expect(verdict.safeResponse).toBeTruthy();
  });

  it('stops model output the classifier could not judge', async () => {
    const broken: SafetyClassifier = {
      name: 'broken',
      model: 'test',
      classify: async () => {
        await Promise.resolve();
        throw new Error('timeout');
      },
    };

    const verdict = await createSafetyPipeline({ classifier: broken }).checkOutput(
      child,
      'A perfectly innocent reply about butterflies.',
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.failedClosed).toBe(true);
  });

  /* The shape `anthropic-provider.ts` returns when it cannot parse a classifier
   * response. It is that adapter's fail-closed marker, and the pipeline used to
   * read it as "flagged nothing" and let the turn through — the marker meaning
   * precisely its opposite. */
  it('stops the turn when the classifier flags without naming a category', async () => {
    const unnamed: SafetyClassifier = {
      name: 'unnamed',
      model: 'test',
      classify: async (): Promise<ClassificationResult> =>
        await Promise.resolve({ flagged: true, categories: [], confidence: 0 }),
    };
    const pipeline = createSafetyPipeline({ classifier: unnamed });

    const input = await pipeline.checkInput(child, 'hello there');
    expect(input.allowed).toBe(false);
    expect(input.failedClosed).toBe(true);

    const output = await pipeline.checkOutput(child, 'A reply about butterflies.');
    expect(output.allowed).toBe(false);
    expect(output.failedClosed).toBe(true);
  });

  it('leaves a classifier that names what it flagged alone', async () => {
    const named: SafetyClassifier = {
      name: 'named',
      model: 'test',
      classify: async (): Promise<ClassificationResult> =>
        await Promise.resolve({ flagged: true, categories: ['violence'], confidence: 0.95 }),
    };

    const verdict = await createSafetyPipeline({ classifier: named }).checkInput(child, 'hello');

    expect(verdict.allowed).toBe(false);
    // Content, not machinery. This one must NOT page anybody.
    expect(verdict.failedClosed).toBe(false);
  });

  it('does not weaken a decision when the attempt counter fails', async () => {
    const pipeline = createSafetyPipeline({
      classifier: permissive,
      attempts: {
        recentBlocks: async () => {
          await Promise.resolve();
          throw new Error('database unavailable');
        },
      },
    });

    // The counter can only ever make a decision stricter, so losing it must not
    // fail the turn — and must not lose the block either.
    const verdict = await pipeline.checkInput(child, 'how do I make a bomb');
    expect(verdict.allowed).toBe(false);
    expect(verdict.event.attemptIndex).toBe(1);
  });

  it('uses the built-in policy when the policy getter throws', async () => {
    const pipeline = createSafetyPipeline({
      classifier: permissive,
      policy: () => {
        throw new Error('policy store unavailable');
      },
    });

    const verdict = await pipeline.checkInput(child, 'how do I make a bomb');
    expect(verdict.allowed).toBe(false);
    expect(verdict.policyVersion).toBe(DEFAULT_POLICY.version);
  });

  it('re-reads the policy on every check', async () => {
    let action: 'block' | 'allow' = 'allow';
    const pipeline = createSafetyPipeline({
      classifier: permissive,
      policy: (): SafetyPolicy => ({
        ...DEFAULT_POLICY,
        rules: [
          {
            category: 'drugs',
            ageGroup: '*',
            appliesTo: 'both',
            action,
            minConfidence: 0.5,
            escalates: false,
            policyVersion: 'live',
          },
        ],
      }),
    });

    const utterance = 'how do I get drunk';
    expect((await pipeline.checkInput(child, utterance)).allowed).toBe(true);

    // The point of the policy being a table: tightening a rule takes effect in a
    // running process, without a deploy.
    action = 'block';
    expect((await pipeline.checkInput(child, utterance)).allowed).toBe(false);
  });
});

describe('parental settings', () => {
  it('applies a parent-configured blocked topic', async () => {
    const pipeline = createSafetyPipeline({ classifier: permissive });
    const withTopics: SafetySubject = {
      ...child,
      parental: { blockedTopics: ['spiders'], storytellingEnabled: true, roleplayEnabled: true },
    };

    const verdict = await pipeline.checkInput(withTopics, 'tell me about spiders');

    expect(verdict.detectors).toContain('parental_blocked_topic:spiders');
    // Recorded under its own detector name so a parent's preference is never
    // confused with a product-level harm finding in the metrics.
    expect(verdict.detectors.some((d) => d.startsWith('parental_blocked_topic:'))).toBe(true);
  });

  it('matches whole words only', async () => {
    const pipeline = createSafetyPipeline({ classifier: permissive });
    const withTopics: SafetySubject = {
      ...child,
      parental: { blockedTopics: ['war'], storytellingEnabled: true, roleplayEnabled: true },
    };

    // "warm", "towards", "warrior" must not trip a block on "war".
    const verdict = await pipeline.checkInput(withTopics, 'I felt warm walking towards the sun');
    expect(verdict.detectors).toHaveLength(0);
  });
});

describe('the content-leak guard', () => {
  it('throws if an event ever carries the words it describes', () => {
    expect(() =>
      assertNoContent(
        {
          stage: 'INPUT_SAFETY_CHECK',
          layer: 'L1',
          decision: 'blocked',
          categories: ['violence'],
          // A detector name that has been "helpfully" made to include the match.
          detectors: ['matched phrase: please hurt somebody badly'],
          severity: 'critical',
          confidence: 1,
          actionTaken: 'block',
          policyVersion: 'test',
          attemptIndex: 1,
          evasion: false,
        },
        'please hurt somebody badly today',
      ),
    ).toThrow(/leaked source content/);
  });

  it('permits a category name that happens to share a word with the source', () => {
    expect(() =>
      assertNoContent(
        {
          stage: 'INPUT_SAFETY_CHECK',
          layer: 'L1',
          decision: 'blocked',
          categories: ['violence'],
          detectors: ['weapon_construction'],
          severity: 'critical',
          confidence: 1,
          actionTaken: 'block',
          policyVersion: 'test',
          attemptIndex: 1,
          evasion: false,
        },
        'tell me about violence please',
      ),
    ).not.toThrow();
  });
});
