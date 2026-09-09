import { describe, expect, it } from 'vitest';

import { INVARIANTS, rulesFor } from './age-rules.js';
import { allCharacters, characterByKey, isCharacterAllowedFor } from './characters.js';
import {
  assertInvariantsPresent,
  buildSystemPrompt,
  NAME_PLACEHOLDER,
  substituteName,
  type PromptInputs,
} from './prompts.js';

const base = (overrides: Partial<PromptInputs> = {}): PromptInputs => ({
  character: characterByKey('lily')!,
  ageGroup: 'AGE_6_8',
  language: 'en',
  learningObjectives: [],
  blockedTopics: [],
  contentRestrictions: [],
  correctionStyle: 'gentle',
  ...overrides,
});

describe('system prompt assembly', () => {
  it('includes every safety invariant', () => {
    const prompt = buildSystemPrompt(base());

    for (const invariant of INVARIANTS) {
      expect(prompt).toContain(invariant);
    }
  });

  it.each(allCharacters().map((c) => [c.key] as const))('%s carries every invariant', (key) => {
    // A persona changes voice and manner only. No character may ship without
    // the full rule set (docs/CHILD_SAFETY.md §7).
    const character = characterByKey(key)!;
    const prompt = buildSystemPrompt(base({ character, ageGroup: character.allowedAgeGroups[0]! }));

    expect(() => {
      assertInvariantsPresent(prompt);
    }).not.toThrow();
  });

  it('puts the safety rules before the persona', () => {
    // Later instructions tend to be weighted more heavily. The thing we least
    // want overridden is the safety block, so the persona goes last.
    const prompt = buildSystemPrompt(base());

    expect(prompt.indexOf('Rules you must never break')).toBeLessThan(
      prompt.indexOf('Who you are'),
    );
  });

  it('rejects a character not permitted for the age group', () => {
    // Captain Sky is AGE_6_8 and up. A stale preferred_character_id can survive
    // a birthday, so this is checked at prompt time as well as at selection.
    expect(() =>
      buildSystemPrompt(base({ character: characterByKey('captain')!, ageGroup: 'AGE_3_5' })),
    ).toThrow(/not permitted for age group/);
  });

  describe('age adaptation', () => {
    it.each([
      ['AGE_3_5', 2],
      ['AGE_6_8', 4],
      ['AGE_9_10', 6],
    ] as const)('states the %s sentence ceiling of %i', (ageGroup, sentences) => {
      const prompt = buildSystemPrompt(base({ character: characterByKey('lily')!, ageGroup }));

      expect(prompt).toContain(`more than ${String(sentences)} sentences`);
    });

    it('forbids conflict for the youngest group only', () => {
      const youngest = buildSystemPrompt(base({ ageGroup: 'AGE_3_5' }));
      const oldest = buildSystemPrompt(base({ ageGroup: 'AGE_9_10' }));

      expect(youngest).toContain('Never introduce conflict');
      expect(oldest).not.toContain('Never introduce conflict');
    });

    it('never widens what is permitted as age rises', () => {
      // Age groups NARROW. Nothing prohibited at three becomes allowed at ten.
      for (const ageGroup of ['AGE_3_5', 'AGE_6_8', 'AGE_9_10'] as const) {
        const prompt = buildSystemPrompt(base({ ageGroup }));
        for (const invariant of INVARIANTS) {
          expect(prompt).toContain(invariant);
        }
      }
    });

    it('scales the output token budget with age', () => {
      expect(rulesFor('AGE_3_5').maxOutputTokens).toBeLessThan(
        rulesFor('AGE_9_10').maxOutputTokens,
      );
    });
  });

  describe('parental controls reach the prompt', () => {
    it('includes blocked topics', () => {
      const prompt = buildSystemPrompt(base({ blockedTopics: ['spiders', 'thunderstorms'] }));

      expect(prompt).toContain('spiders');
      expect(prompt).toContain('thunderstorms');
    });

    it('tells the model not to reveal that a topic was blocked', () => {
      const prompt = buildSystemPrompt(base({ blockedTopics: ['spiders'] }));

      expect(prompt).toContain('never say that a subject was blocked');
    });

    it('includes learning objectives without turning them into a quiz', () => {
      const prompt = buildSystemPrompt(base({ learningObjectives: ['animals', 'space'] }));

      expect(prompt).toContain('animals, space');
      expect(prompt).toContain('Never quiz the child');
    });

    it('includes additional content restrictions', () => {
      const prompt = buildSystemPrompt(base({ contentRestrictions: ['Do not tell stories.'] }));

      expect(prompt).toContain('Do not tell stories.');
    });

    it('omits the optional sections when there is nothing to say', () => {
      const prompt = buildSystemPrompt(base());

      expect(prompt).not.toContain('Additional subjects to avoid');
      expect(prompt).not.toContain('Things this child enjoys');
    });
  });

  describe('language', () => {
    it('names the language in full', () => {
      expect(buildSystemPrompt(base({ language: 'ur' }))).toContain('Urdu');
      expect(buildSystemPrompt(base({ language: 'ar' }))).toContain('Arabic');
    });

    it("forbids assessing the child's language ability", () => {
      // Adjacent to diagnosis, and the boundary a language-learning product
      // would most easily drift across.
      expect(buildSystemPrompt(base())).toContain('never assess their language ability');
    });
  });

  describe('correction style', () => {
    it.each([
      ['none', 'Never correct'],
      ['gentle', 'without drawing attention'],
      ['active', 'gently offer the right word once'],
    ] as const)('%s produces its guidance', (style, expected) => {
      expect(buildSystemPrompt(base({ correctionStyle: style }))).toContain(expected);
    });
  });
});

describe('assertInvariantsPresent', () => {
  it('accepts a properly assembled prompt', () => {
    expect(() => {
      assertInvariantsPresent(buildSystemPrompt(base()));
    }).not.toThrow();
  });

  it('rejects a prompt that lost an invariant', () => {
    // A refactor that drops a rule would otherwise ship silently and show up
    // only as a slow rise in the block rate.
    const damaged = buildSystemPrompt(base()).replace(INVARIANTS[0]!, '');

    expect(() => {
      assertInvariantsPresent(damaged);
    }).toThrow(/missing 1 safety invariant/);
  });
});

describe("the child's name", () => {
  it('is never in the prompt — only a placeholder', () => {
    // The mechanism that makes "never send unnecessary private child data" true
    // rather than aspirational: the name is substituted locally, afterwards.
    const prompt = buildSystemPrompt(base());

    expect(prompt).toContain(NAME_PLACEHOLDER);
    expect(prompt).toContain("You do not know the child's name");
  });

  it('substitutes locally after generation', () => {
    expect(substituteName('Hi {{name}}, how are you?', 'Ayesha')).toBe('Hi Ayesha, how are you?');
  });

  it('substitutes every occurrence', () => {
    expect(substituteName('{{name}} and {{name}}', 'Sam')).toBe('Sam and Sam');
  });

  it('leaves a reply without the placeholder untouched', () => {
    // Models forget the placeholder often enough that this must not break.
    expect(substituteName('That sounds fun!', 'Ayesha')).toBe('That sounds fun!');
  });
});

describe('character catalogue', () => {
  it('has exactly the four launch characters', () => {
    expect(
      allCharacters()
        .map((c) => c.slug)
        .sort(),
    ).toEqual(['buddy-the-dog', 'captain-sky', 'lily-the-fairy', 'professor-owl']);
  });

  it('keeps Buddy away from the oldest group and Captain Sky from the youngest', () => {
    expect(isCharacterAllowedFor(characterByKey('buddy')!, 'AGE_9_10')).toBe(false);
    expect(isCharacterAllowedFor(characterByKey('captain')!, 'AGE_3_5')).toBe(false);
    expect(isCharacterAllowedFor(characterByKey('professor')!, 'AGE_3_5')).toBe(false);
  });

  it('gives every character at least one age group and a pinned prompt version', () => {
    for (const character of allCharacters()) {
      expect(character.allowedAgeGroups.length).toBeGreaterThan(0);
      expect(character.promptVersion).toMatch(/^v\d+\./);
    }
  });

  it('never lets a persona mention a rule it could relax', () => {
    // "You are adventurous" must not become licence to discuss weapons.
    for (const character of allCharacters()) {
      const persona = character.persona.join(' ').toLowerCase();
      expect(persona).not.toContain('you may ignore');
      expect(persona).not.toContain('except');
    }
  });
});

/* ========================================================================== */
/* Story mode                                                                 */
/* ========================================================================== */

describe('story mode', () => {
  it('is absent unless it is asked for', () => {
    // The default must be a chat. A client that has never heard of stories, or
    // a route that forgets to pass the flag, gets exactly the prompt it did
    // before this existed.
    expect(buildSystemPrompt(base())).not.toContain('Making a story together');
  });

  it('asks the character to build the story WITH the child', () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * NOT A MONOLOGUE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The obvious reading of "tell me a story" would contradict the reply
     * length limits and would turn a conversation app into a playback device —
     * the child stops talking, which is the one thing the product exists to
     * make them do.
     */
    const prompt = buildSystemPrompt(base({ storyMode: true }));

    expect(prompt).toContain('Making a story together');
    expect(prompt).toContain('Never tell the whole story at once');
    expect(prompt.toLowerCase()).toContain('what happens next');
  });

  it('does not relax a single safety rule', () => {
    // A story frame is the most natural way for prohibited content to arrive
    // and the most tempting place to treat it as make-believe and harmless.
    const prompt = buildSystemPrompt(base({ storyMode: true }));

    expect(() => {
      assertInvariantsPresent(prompt);
    }).not.toThrow();
    for (const invariant of INVARIANTS) {
      expect(prompt).toContain(invariant);
    }
  });

  it('keeps the story frame below the safety rules and below the restrictions', () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * ORDERING IS THE POINT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * A later instruction tends to carry more weight. "Do not tell stories" is
     * a parental control, so the story frame must never sit above it and read
     * as something that supersedes it.
     */
    const prompt = buildSystemPrompt(
      base({ storyMode: true, contentRestrictions: ['Do not tell stories.'] }),
    );

    expect(prompt.indexOf('Rules you must never break')).toBeLessThan(
      prompt.indexOf('Making a story together'),
    );
    expect(prompt.indexOf('Do not tell stories.')).toBeLessThan(
      prompt.indexOf('Making a story together'),
    );
    // And still below the persona, which stays last.
    expect(prompt.indexOf('Making a story together')).toBeLessThan(prompt.indexOf('Who you are'));
  });

  it('still obeys the age group reply length', () => {
    // "Tell a story" must not become a licence to write six paragraphs to a
    // three-year-old. The length rule is stated once and applies to every mode.
    const rules = rulesFor('AGE_3_5');
    const prompt = buildSystemPrompt(base({ ageGroup: 'AGE_3_5', storyMode: true }));

    expect(prompt).toContain(`Never write more than ${String(rules.maxSentences)} sentences`);
  });
});
