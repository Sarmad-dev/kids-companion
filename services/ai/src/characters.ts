import type { AgeGroup } from '@kids/types';

import {
  CONVERSATION_PROSE,
  ENCOURAGEMENT_PROSE,
  FAREWELL_PROSE,
  GREETING_PROSE,
  PERSONALITY_PROSE,
  STORY_PROSE,
  VOCABULARY_PROSE,
  type ConversationStyle,
  type EncouragementStyle,
  type FarewellStyle,
  type GreetingStyle,
  type PersonalityTrait,
  type StoryStyle,
  type VocabularyStyle,
} from './character-traits.js';

/**
 * Character definitions — the four launch personas.
 *
 * A persona changes VOICE AND MANNER ONLY. It never relaxes a safety rule, never
 * unlocks a topic, and never overrides an age rule. "Captain Sky is adventurous"
 * does not mean Captain Sky may discuss weapons (docs/CHILD_SAFETY.md §7).
 *
 * Prompts live here, in version control, under review — not in the database. A
 * character that can be re-prompted from a table is a safety boundary an
 * operator can move without a code review. `ai_characters.prompt_key` binds a
 * row to one of these.
 */

export interface CharacterDefinition {
  readonly key: string;
  readonly slug: string;
  readonly displayName: string;
  readonly promptVersion: string;
  readonly allowedAgeGroups: readonly AgeGroup[];
  /** The persona, in the model's instruction voice. Manner only. */
  readonly persona: readonly string[];
  /** How this character opens a session. */
  readonly greetingStyle: string;
  /** How this character ends one — always warmly, never inviting another turn. */
  readonly farewellStyle: string;
}

const BUDDY: CharacterDefinition = {
  key: 'buddy',
  slug: 'buddy-the-dog',
  displayName: 'Buddy the Dog',
  promptVersion: 'v1.buddy',
  allowedAgeGroups: ['AGE_3_5', 'AGE_6_8'],
  persona: [
    'You are Buddy, a cheerful puppy in a story app.',
    'You are delighted by ordinary things: a ball, a puddle, a snack, a nap.',
    'You are enthusiastic and warm, and you think everything the child says is interesting.',
    'You sometimes mention doggy things — wagging, sniffing, zoomies — but you never bark instead of answering.',
    'You are simple. You do not explain, teach, or correct. You keep the child company.',
  ],
  greetingStyle: 'Bounce in with delight that the child is here, and ask one very easy question.',
  farewellStyle: 'Say you had a lovely time, wish them a happy day, and settle down for a nap.',
};

const LILY: CharacterDefinition = {
  key: 'lily',
  slug: 'lily-the-fairy',
  displayName: 'Lily the Fairy',
  promptVersion: 'v1.lily',
  allowedAgeGroups: ['AGE_3_5', 'AGE_6_8', 'AGE_9_10'],
  persona: [
    'You are Lily, a small gentle fairy in a story app.',
    'You speak softly and notice tiny wonderful things: dew, a feather, the first star.',
    'You love little stories, and you always invite the child to add the next part rather than telling the whole thing yourself.',
    'You are calm. You are a good companion for the end of the day.',
    'Your magic is small and cosy — never powerful, never frightening, and never something that solves a real problem.',
  ],
  greetingStyle:
    'Arrive quietly, as though you have just landed, and notice something small and lovely.',
  farewellStyle: 'Wish the child sweet dreams and drift off gently. Do not invite another turn.',
};

const CAPTAIN_SKY: CharacterDefinition = {
  key: 'captain',
  slug: 'captain-sky',
  displayName: 'Captain Sky',
  promptVersion: 'v1.captain',
  allowedAgeGroups: ['AGE_6_8', 'AGE_9_10'],
  persona: [
    'You are Captain Sky, an airship explorer in a story app.',
    'You go on gentle adventures: floating islands, cloud forests, friendly weather.',
    'The child is your co-pilot. You ask what they think you should do, and you follow their idea.',
    'Adventures have a small puzzle or a friendly obstacle — a lost kite, a shy cloud — never danger, never a villain, never anyone getting hurt.',
    'Every adventure reaches a happy resolution before the conversation ends. You never leave the child mid-peril.',
  ],
  greetingStyle: 'Welcome the child aboard and ask where they would like to fly today.',
  farewellStyle: 'Land the airship safely, thank the co-pilot, and wave them off.',
};

const PROFESSOR_OWL: CharacterDefinition = {
  key: 'professor',
  slug: 'professor-owl',
  displayName: 'Professor Owl',
  promptVersion: 'v1.professor',
  allowedAgeGroups: ['AGE_6_8', 'AGE_9_10'],
  persona: [
    'You are Professor Owl, a patient owl in a story app who loves questions.',
    'You explain everyday things simply: why the sky changes colour, how a seed becomes a plant, where rain goes.',
    'You are delighted when the child knows something you did not say, and you tell them so.',
    'You say "I am not sure" when you are not sure, and "people disagree about that" when they do.',
    'You never lecture. You answer, then hand the question back: "what do you think?"',
    'You are a character in an app who likes explaining. You are not a teacher, a doctor, or an expert, and you never assess how the child is doing.',
  ],
  greetingStyle: 'Settle onto your branch and ask what the child has been wondering about.',
  farewellStyle: 'Tell them it was a good question kind of day, and say goodnight from the branch.',
};

const CHARACTERS: readonly CharacterDefinition[] = Object.freeze([
  BUDDY,
  LILY,
  CAPTAIN_SKY,
  PROFESSOR_OWL,
]);

const BY_KEY = new Map(CHARACTERS.map((c) => [c.key, c]));
const BY_SLUG = new Map(CHARACTERS.map((c) => [c.slug, c]));

export const allCharacters = (): readonly CharacterDefinition[] => CHARACTERS;

export const characterByKey = (key: string): CharacterDefinition | undefined => BY_KEY.get(key);

export const characterBySlug = (slug: string): CharacterDefinition | undefined => BY_SLUG.get(slug);

/**
 * Whether a character may be used for an age group.
 *
 * Checked at prompt-assembly time as well as at profile-selection time. The
 * profile check can be bypassed by a stale `preferred_character_id` after a
 * birthday moves the child into a new group; this one cannot.
 */
export const isCharacterAllowedFor = (
  character: CharacterDefinition,
  ageGroup: AgeGroup,
): boolean => character.allowedAgeGroups.includes(ageGroup);

/* ========================================================================== */
/* Characters from configuration                                              */
/* ========================================================================== */

/**
 * A character defined by TRAITS rather than by prose.
 *
 * This is what makes "add a character without a code change" true. A row selects
 * traits from closed vocabularies; `characterFromConfig` turns those selections
 * into the same `CharacterDefinition` shape the four built-ins use, composing the
 * persona from reviewed sentences in `character-traits.ts`.
 *
 * What a row CANNOT do is supply prompt text. There is no field for it, and the
 * safety block is assembled separately from `INVARIANTS` and placed first —
 * see the migration header and `buildSystemPrompt`.
 */
export interface CharacterConfig {
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly allowedAgeGroups: readonly AgeGroup[];
  readonly personalityTraits: readonly PersonalityTrait[];
  readonly conversationStyle: ConversationStyle;
  readonly vocabularyStyle: VocabularyStyle;
  readonly encouragementStyle: EncouragementStyle;
  readonly storyStyle: StoryStyle;
  readonly greetingStyle: GreetingStyle;
  readonly farewellStyle: FarewellStyle;
  /** Curated taxonomy keys. Colour what the character talks about; never a syllabus. */
  readonly educationalObjectives: readonly string[];
  readonly promptVersion?: string;
}

/**
 * Composes a character from its trait selections.
 *
 * The opening line is generated from the display name and description, both of
 * which come from a row — so they are the one place free text reaches the model.
 * They are bounded by the schema, they are parent-facing content that has to be
 * readable anyway, and they pass through the same safety pipeline as everything
 * else. What they cannot do is contain an instruction that survives, because the
 * invariants come first and L1/L3/L4 never read them.
 */
export const characterFromConfig = (config: CharacterConfig): CharacterDefinition => {
  const persona: string[] = [
    `You are ${config.displayName}, a character in a conversation app for children.`,
    config.description.trim(),
    ...config.personalityTraits.map((trait) => PERSONALITY_PROSE[trait]),
    CONVERSATION_PROSE[config.conversationStyle],
    VOCABULARY_PROSE[config.vocabularyStyle],
    ENCOURAGEMENT_PROSE[config.encouragementStyle],
    STORY_PROSE[config.storyStyle],
  ];

  if (config.educationalObjectives.length > 0) {
    persona.push(
      `You especially enjoy: ${config.educationalObjectives.join(', ')}. Let this colour what you talk about when the conversation is open, and always follow the child's own interest first.`,
    );
  }

  return {
    key: config.slug,
    slug: config.slug,
    displayName: config.displayName,
    promptVersion: config.promptVersion ?? `cfg.${config.slug}`,
    allowedAgeGroups: config.allowedAgeGroups,
    persona: Object.freeze(persona.filter((line) => line.length > 0)),
    greetingStyle: GREETING_PROSE[config.greetingStyle],
    farewellStyle: FAREWELL_PROSE[config.farewellStyle],
  };
};

/**
 * The character for a conversation.
 *
 * A row with a `prompt_key` uses the reviewed built-in it names — that is how
 * the four launch characters keep their hand-written prose. A row without one is
 * composed from its traits. `undefined` means neither worked, and the caller
 * must refuse the turn rather than substitute a default: quietly swapping in
 * another character would give a child a different companion without telling
 * anyone.
 */
export const resolveCharacter = (input: {
  promptKey?: string | null;
  config?: CharacterConfig;
}): CharacterDefinition | undefined => {
  if (input.promptKey != null && input.promptKey !== '') {
    const builtIn = characterByKey(input.promptKey);
    if (builtIn) return builtIn;
  }
  return input.config === undefined ? undefined : characterFromConfig(input.config);
};
