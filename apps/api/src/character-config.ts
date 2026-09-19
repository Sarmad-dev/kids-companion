import {
  isConversationStyle,
  isEncouragementStyle,
  isFarewellStyle,
  isGreetingStyle,
  isPersonalityTrait,
  isStoryStyle,
  isVocabularyStyle,
  type CharacterConfig,
} from '@kids/ai';
import type { AgeGroup } from '@kids/types';

/**
 * A character row, as every route that resolves a persona selects it.
 *
 * Snake-cased because it is a row, not a domain object: the mapping into
 * `CharacterConfig` is the whole job of this module, and doing it in two places
 * is how one of them ends up a trait behind.
 */
export interface CharacterTraitRow {
  slug: string;
  display_name: string;
  description: string;
  allowed_age_groups: AgeGroup[];
  personality_traits: string[];
  conversation_style: string;
  vocabulary_style: string;
  encouragement_style: string;
  story_style: string;
  greeting_style: string;
  farewell_style: string;
  educational_objectives: string[];
}

/**
 * Turns a character row into a config, when its traits are valid.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS SHARED RATHER THAN WRITTEN WHERE IT IS NEEDED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `20260817230000_character_configuration.sql` made a character something an
 * operator can add with an INSERT: a row with `prompt_key = NULL` composes its
 * persona from trait selections instead of naming a reviewed built-in. That is
 * only true for a code path that actually READS the traits. The text route did;
 * the voice route did not, and resolved a character by `prompt_key` alone — so
 * a configured character could be chosen on the select screen, could start a
 * conversation, and then failed on the first spoken turn with "uses a character
 * that is no longer available". On a voice-first app that is the whole product.
 *
 * One function, imported by both, is what makes "the two routes agree about who
 * a character is" a fact rather than a habit.
 *
 * Returns `undefined` for a row whose traits do not typecheck — a character
 * with a nonsense personality is refused rather than given a default one,
 * because a default would be a different companion arriving unannounced.
 */
export const characterConfigFrom = (row: CharacterTraitRow): CharacterConfig | undefined => {
  const personality = row.personality_traits.filter(isPersonalityTrait);
  if (
    personality.length === 0 ||
    !isConversationStyle(row.conversation_style) ||
    !isVocabularyStyle(row.vocabulary_style) ||
    !isEncouragementStyle(row.encouragement_style) ||
    !isStoryStyle(row.story_style) ||
    !isGreetingStyle(row.greeting_style) ||
    !isFarewellStyle(row.farewell_style)
  ) {
    return undefined;
  }

  return {
    slug: row.slug,
    displayName: row.display_name,
    description: row.description,
    allowedAgeGroups: row.allowed_age_groups,
    personalityTraits: personality,
    conversationStyle: row.conversation_style,
    vocabularyStyle: row.vocabulary_style,
    encouragementStyle: row.encouragement_style,
    storyStyle: row.story_style,
    greetingStyle: row.greeting_style,
    farewellStyle: row.farewell_style,
    educationalObjectives: row.educational_objectives,
  };
};
