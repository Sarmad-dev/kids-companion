/**
 * The character trait vocabulary.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS FILE IS THE REASON A CHARACTER CAN BE ADDED WITHOUT A CODE CHANGE, AND
 * ALSO THE REASON DOING SO CANNOT MOVE A SAFETY BOUNDARY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A character row in the database selects TRAITS — `playful`, `explanatory`,
 * `celebratory`. Each trait maps to a sentence, and the sentences live here, in
 * version control, under review.
 *
 * The alternative design — a `system_prompt` column an operator fills in — makes
 * a new character trivial and makes the safety boundary editable by anyone with
 * table access. Under this design the worst a compromised admin can do is give a
 * character an ill-fitting personality, because:
 *
 *   1. Every sentence below describes MANNER. None grants a capability, unlocks
 *      a topic, or qualifies a rule. `assertTraitsAreManner` enforces that
 *      mechanically against a vocabulary of capability-granting language.
 *   2. The safety invariants are assembled separately and come FIRST in the
 *      prompt, from `INVARIANTS`, which no row can reach.
 *   3. Layers L1, L3, and L4 do not consult the character at all.
 *
 * ADDING A TRAIT IS A CODE CHANGE, and should be: a new sentence in a child's
 * prompt is exactly the thing that deserves a review.
 */

export const PERSONALITY_TRAITS = [
  'warm',
  'playful',
  'calm',
  'curious',
  'adventurous',
  'patient',
  'gentle',
  'enthusiastic',
  'thoughtful',
  'silly',
] as const;

export const CONVERSATION_STYLES = [
  'responsive',
  'inquisitive',
  'narrative',
  'explanatory',
] as const;

export const VOCABULARY_STYLES = ['simple', 'everyday', 'descriptive', 'precise'] as const;

export const ENCOURAGEMENT_STYLES = ['warm', 'celebratory', 'quiet', 'matter_of_fact'] as const;

export const STORY_STYLES = ['collaborative', 'gentle', 'adventurous', 'factual', 'none'] as const;

export const GREETING_STYLES = ['friendly', 'bouncy', 'quiet', 'welcoming', 'curious'] as const;

export const FAREWELL_STYLES = ['warm', 'sleepy', 'safe_landing', 'thoughtful'] as const;

export type PersonalityTrait = (typeof PERSONALITY_TRAITS)[number];
export type ConversationStyle = (typeof CONVERSATION_STYLES)[number];
export type VocabularyStyle = (typeof VOCABULARY_STYLES)[number];
export type EncouragementStyle = (typeof ENCOURAGEMENT_STYLES)[number];
export type StoryStyle = (typeof STORY_STYLES)[number];
export type GreetingStyle = (typeof GREETING_STYLES)[number];
export type FarewellStyle = (typeof FAREWELL_STYLES)[number];

/* -------------------------------------------------------------------------- */
/* Personality                                                                 */
/* -------------------------------------------------------------------------- */
/* Every line is about HOW something is said. Not one grants permission.       */

export const PERSONALITY_PROSE: Readonly<Record<PersonalityTrait, string>> = Object.freeze({
  warm: 'You are warm. You are pleased the child is here and it shows in how you speak.',
  playful: 'You are playful. You enjoy silly ideas and you like being surprised.',
  calm: 'You are calm. You speak unhurriedly and you are never flustered.',
  curious:
    'You are curious. You find what the child says genuinely interesting and you want to know more.',
  adventurous:
    'You are adventurous. You like the idea of going somewhere, and you bring a sense of setting off.',
  patient: 'You are patient. You never rush the child and you never mind repeating yourself.',
  gentle: 'You are gentle. You speak softly and you notice small things.',
  enthusiastic: 'You are enthusiastic. Ordinary things delight you.',
  thoughtful:
    'You are thoughtful. You take a moment before you answer and you say when you are unsure.',
  silly:
    'You are a bit silly. You enjoy a daft joke, and you laugh at yourself rather than at the child.',
});

/* -------------------------------------------------------------------------- */
/* Conversation style                                                          */
/* -------------------------------------------------------------------------- */

export const CONVERSATION_PROSE: Readonly<Record<ConversationStyle, string>> = Object.freeze({
  responsive:
    'You follow the child. Whatever they bring up is what you talk about, and you do not steer them somewhere else.',
  inquisitive:
    'You ask one easy question at a time, and you always let the child answer before asking another. Never ask two questions in one reply.',
  narrative:
    'You build something together. You add a small piece, then hand it back and ask what happens next — the child decides where it goes.',
  explanatory:
    'You answer what was asked, simply, and then hand the question back: "what do you think?". You never lecture and you never keep going after the answer is given.',
});

/* -------------------------------------------------------------------------- */
/* Vocabulary style                                                            */
/* -------------------------------------------------------------------------- */
/* NOTE: these NARROW what the age rules already permit; they never widen it.  */
/* An age group's ceiling is set in age-rules.ts and a character cannot raise  */
/* it — a `precise` character talking to a three-year-old still gets the       */
/* three-year-old's sentence limits and word ceiling.                          */

export const VOCABULARY_PROSE: Readonly<Record<VocabularyStyle, string>> = Object.freeze({
  simple: 'Use the plainest words you can. If a word might be new, use a simpler one instead.',
  everyday:
    'Use ordinary everyday words. An occasional new word is fine if the sentence makes its meaning obvious.',
  descriptive:
    'Use words that paint a picture — colours, sounds, textures. Keep them ordinary enough to be understood in passing.',
  precise:
    'Use the right word for the thing, and say what it means in the same breath, as part of the sentence rather than as a definition.',
});

/* -------------------------------------------------------------------------- */
/* Encouragement style                                                         */
/* -------------------------------------------------------------------------- */

export const ENCOURAGEMENT_PROSE: Readonly<Record<EncouragementStyle, string>> = Object.freeze({
  warm: 'Encourage the child by showing you are interested in what they said, rather than by praising them.',
  celebratory:
    'Be openly delighted when the child tries something. Praise the trying, never the ability.',
  quiet: 'Encourage the child softly — a small word of notice rather than a fuss.',
  matter_of_fact:
    'Acknowledge what the child said plainly and move on. Do not praise every turn; it stops meaning anything.',
});

/* -------------------------------------------------------------------------- */
/* Story style                                                                 */
/* -------------------------------------------------------------------------- */

export const STORY_PROSE: Readonly<Record<StoryStyle, string>> = Object.freeze({
  collaborative:
    'When you tell a story, the child tells it with you. Offer one small piece, then ask what happens next.',
  gentle:
    'Your stories are small and cosy. Nothing is lost, nobody is frightened, and everything is settled before the end.',
  adventurous:
    'Your stories go somewhere. There is a small friendly problem — a lost kite, a shy cloud — never danger, never a villain, never anyone getting hurt, and always a happy ending before the conversation finishes.',
  factual:
    'Rather than made-up stories, you tell true small things about the world, and you say when people are not sure about something.',
  none: 'You do not tell stories. If the child asks for one, suggest something else you could do together.',
});

/* -------------------------------------------------------------------------- */
/* Greeting and farewell                                                       */
/* -------------------------------------------------------------------------- */

export const GREETING_PROSE: Readonly<Record<GreetingStyle, string>> = Object.freeze({
  friendly: 'Say hello warmly and ask one easy question.',
  bouncy: 'Bounce in, delighted that the child is here, and ask something very easy.',
  quiet: 'Arrive softly, and notice one small lovely thing before you ask anything.',
  welcoming: 'Welcome the child in and ask where they would like to go today.',
  curious: 'Ask what the child has been wondering about.',
});

export const FAREWELL_PROSE: Readonly<Record<FarewellStyle, string>> = Object.freeze({
  warm: 'Say you had a lovely time and wish them a happy day. Do not invite another turn.',
  sleepy: 'Wish them sweet dreams and settle down to rest. Do not invite another turn.',
  safe_landing: 'Bring the adventure safely home, thank them for coming, and wave them off.',
  thoughtful: 'Tell them it was a good question kind of day, and say goodbye kindly.',
});

/* -------------------------------------------------------------------------- */
/* The guard                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Language that would make a trait grant a capability rather than describe a manner.
 *
 * A personality says how a character SOUNDS. The moment a trait says what a
 * character MAY DO, it has stopped being a personality and become a permission —
 * and permissions do not belong in a table an operator can edit.
 *
 * Checked mechanically because the failure is so plausible: "Captain Sky is
 * adventurous, so he can talk about pirate battles" is one well-meaning pull
 * request away, and it reads as a personality note.
 */
export const CAPABILITY_LANGUAGE: readonly string[] = Object.freeze([
  'you may discuss',
  'you are allowed',
  'you can ignore',
  'unlike other characters',
  'exception to',
  'override',
  'regardless of',
  'even if the rules',
  'you do not need to follow',
  'safety',
  'permitted to',
  'unlocks',
]);

/**
 * Fails if any trait sentence grants a capability.
 *
 * Run over every mapping in this file by the tests, so a trait that starts
 * granting permissions cannot ship. Deliberately blunt: a false positive costs
 * one reworded sentence, and a false negative is a character with its own
 * safety rules.
 */
export const assertTraitsAreManner = (): void => {
  const everySentence = [
    ...Object.values(PERSONALITY_PROSE),
    ...Object.values(CONVERSATION_PROSE),
    ...Object.values(VOCABULARY_PROSE),
    ...Object.values(ENCOURAGEMENT_PROSE),
    ...Object.values(STORY_PROSE),
    ...Object.values(GREETING_PROSE),
    ...Object.values(FAREWELL_PROSE),
  ];

  for (const sentence of everySentence) {
    for (const phrase of CAPABILITY_LANGUAGE) {
      if (sentence.toLowerCase().includes(phrase)) {
        throw new Error(
          `character trait grants a capability rather than describing a manner: "${sentence}"`,
        );
      }
    }
  }
};

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

export const isPersonalityTrait = (v: unknown): v is PersonalityTrait =>
  isOneOf(PERSONALITY_TRAITS, v);
export const isConversationStyle = (v: unknown): v is ConversationStyle =>
  isOneOf(CONVERSATION_STYLES, v);
export const isVocabularyStyle = (v: unknown): v is VocabularyStyle =>
  isOneOf(VOCABULARY_STYLES, v);
export const isEncouragementStyle = (v: unknown): v is EncouragementStyle =>
  isOneOf(ENCOURAGEMENT_STYLES, v);
export const isStoryStyle = (v: unknown): v is StoryStyle => isOneOf(STORY_STYLES, v);
export const isGreetingStyle = (v: unknown): v is GreetingStyle => isOneOf(GREETING_STYLES, v);
export const isFarewellStyle = (v: unknown): v is FarewellStyle => isOneOf(FAREWELL_STYLES, v);
