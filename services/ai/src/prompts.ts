import type { AgeGroup, SupportedLanguage } from '@kids/types';

import {
  INVARIANTS,
  REDIRECTION_GUIDANCE,
  rulesFor,
  SENSITIVE_TOPIC_GUIDANCE,
  STORY_GUIDANCE,
} from './age-rules.js';
import { isCharacterAllowedFor, type CharacterDefinition } from './characters.js';

/**
 * System prompt assembly.
 *
 * Ordering is deliberate. The safety invariants come FIRST and the persona
 * comes last, because an instruction later in a prompt tends to be weighted more
 * heavily by the model — and the thing we least want overridden is the safety
 * block. Putting the persona first would let "you are an adventurous explorer"
 * colour how the model reads "never depict violence".
 *
 * The prompt is a behavioural instruction, NOT a security boundary. It is layer
 * L2 of five, and the enforcement lives in L1, L3, and L4 — which do not depend
 * on the model choosing to comply (docs/CHILD_SAFETY.md §3).
 */

export interface PromptInputs {
  readonly character: CharacterDefinition;
  readonly ageGroup: AgeGroup;
  readonly language: SupportedLanguage;
  /** Curated topic keys from the child's preferences. Never free text. */
  readonly learningObjectives: readonly string[];
  /** Parent-configured blocked topics, on top of the universal prohibitions. */
  readonly blockedTopics: readonly string[];
  /** Additional parental restrictions, e.g. storytelling disabled. */
  readonly contentRestrictions: readonly string[];
  readonly correctionStyle: 'none' | 'gentle' | 'active';
  /**
   * Whether this session is a story.
   *
   * A template flag, not parent-supplied data — which is why it is passed to the
   * baseline prompt too. See `buildProviderContext`.
   */
  readonly storyMode?: boolean;
}

const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: 'English',
  ur: 'Urdu',
  ar: 'Arabic',
  hi: 'Hindi',
  es: 'Spanish',
  fr: 'French',
  zh: 'Mandarin Chinese',
  pa: 'Punjabi',
  sd: 'Sindhi',
  ps: 'Pashto',
};

const CORRECTION_GUIDANCE: Readonly<Record<PromptInputs['correctionStyle'], string>> = {
  none: "Never correct the child's grammar, pronunciation, or word choice. Simply understand them and reply.",
  gentle:
    'Do not correct the child directly. If they use a word wrongly, use it correctly yourself in your reply, without drawing attention to it.',
  active:
    'You may gently offer the right word once, warmly and in passing, then carry on with what the child was saying. Never repeat a correction, and never make it the subject of the reply.',
};

/**
 * The placeholder the model is told to use in place of the child's name.
 *
 * The application substitutes the real name after generation, so the name never
 * reaches the provider (see `buildProviderContext`). This is the mechanism that
 * makes "never send unnecessary private child data" true rather than aspirational
 * — and it costs a little naturalness when the model forgets to use it, which is
 * why the substitution step tolerates its absence.
 */
export const NAME_PLACEHOLDER = '{{name}}';

export const buildSystemPrompt = (inputs: PromptInputs): string => {
  if (!isCharacterAllowedFor(inputs.character, inputs.ageGroup)) {
    throw new Error(
      `character ${inputs.character.key} is not permitted for age group ${inputs.ageGroup}`,
    );
  }

  const rules = rulesFor(inputs.ageGroup);
  const languageName = LANGUAGE_NAMES[inputs.language] ?? inputs.language;
  const section = (title: string, lines: readonly string[]): string =>
    `## ${title}\n${lines.map((l) => `- ${l}`).join('\n')}`;

  const parts: string[] = [
    'You are a character in a conversation app for children. A child is talking to you now.',
    '',
    // FIRST, and non-negotiable.
    section('Rules you must never break', INVARIANTS),
    '',
    section('Hard topics', [SENSITIVE_TOPIC_GUIDANCE]),
    '',
    section('If you must refuse something', [REDIRECTION_GUIDANCE]),
    '',
    section(`How to talk to a child in the ${inputs.ageGroup} group`, [
      ...rules.behaviour,
      rules.vocabularyNote,
      `Never write more than ${String(rules.maxSentences)} sentences, and keep sentences under about ${String(rules.maxWordsPerSentence)} words.`,
      ...rules.additionalProhibitions,
    ]),
    '',
    section('Language', [
      `Reply only in ${languageName}. If the child mixes in another language, understand them, but reply in ${languageName}.`,
      'Never comment on how well the child speaks, and never assess their language ability.',
    ]),
    '',
    section('Addressing the child', [
      `You do not know the child's name. When you want to address them by name, write exactly ${NAME_PLACEHOLDER} and the app will put their name there.`,
      `Use ${NAME_PLACEHOLDER} sparingly — at most once per reply, and only when it feels natural.`,
    ]),
    '',
    section('Correcting the child', [CORRECTION_GUIDANCE[inputs.correctionStyle]]),
  ];

  if (inputs.learningObjectives.length > 0) {
    parts.push(
      '',
      section('Things this child enjoys', [
        `The child's grown-up has said they like: ${inputs.learningObjectives.join(', ')}.`,
        "Let these colour what you talk about when the conversation is open. Never quiz the child on them, never announce them, and always follow the child's own interest first.",
      ]),
    );
  }

  if (inputs.blockedTopics.length > 0) {
    parts.push(
      '',
      section('Additional subjects to avoid', [
        `This child's grown-up has asked you not to talk about: ${inputs.blockedTopics.join(', ')}.`,
        'Treat these exactly like the rules above: change the subject warmly, and never say that a subject was blocked or that a grown-up asked you to avoid it.',
      ]),
    );
  }

  if (inputs.contentRestrictions.length > 0) {
    parts.push('', section('Additional restrictions', inputs.contentRestrictions));
  }

  /* AFTER the restrictions, deliberately. A later instruction tends to carry
   * more weight, and "do not tell stories" is a parental control — it must not
   * be readable as something the story frame below supersedes. The route
   * refuses to start a story at all when that control is off, so the two can
   * never both be present; the ordering is the belt to that braces. */
  if (inputs.storyMode === true) {
    parts.push('', section('Making a story together', STORY_GUIDANCE));
  }

  parts.push(
    '',
    section('Who you are', [
      ...inputs.character.persona,
      `When a conversation begins: ${inputs.character.greetingStyle}`,
      `When a conversation ends: ${inputs.character.farewellStyle}`,
      'Your personality changes how you sound. It never changes any rule above.',
    ]),
  );

  return parts.join('\n');
};

/**
 * Fails a prompt that has lost a safety invariant.
 *
 * Called on every assembled prompt, not only in tests. A refactor that
 * accidentally drops an invariant would otherwise ship silently and be visible
 * only as a slow rise in the block rate — which is exactly the kind of
 * regression nobody attributes to the right cause.
 */
export const assertInvariantsPresent = (prompt: string): void => {
  const missing = INVARIANTS.filter((invariant) => !prompt.includes(invariant));
  if (missing.length > 0) {
    throw new Error(
      `assembled prompt is missing ${String(missing.length)} safety invariant(s); refusing to send`,
    );
  }
};

/** Substitutes the child's name locally, after the provider has replied. */
export const substituteName = (text: string, childName: string): string =>
  text.replaceAll(NAME_PLACEHOLDER, childName);
