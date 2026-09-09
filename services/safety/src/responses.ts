import type { AgeGroup } from '@kids/types';

import type { SafetyCategory } from './categories.js';

/**
 * What the child hears when a turn is stopped.
 *
 * Three properties, all non-negotiable:
 *
 * 1. NO MODEL CALL. These ship in the application. A safe response that depends
 *    on the provider being up is not a safe response.
 *
 * 2. NEVER ANNOUNCE THE BLOCK. "I can't talk about that" tells a child exactly
 *    where the boundary is and invites them to probe it. A warm change of
 *    subject does not (docs/ERROR_HANDLING.md §10).
 *
 * 3. A DISCLOSURE IS NOT A BLOCK. If a child has just said something about being
 *    hurt, or about not wanting to exist, a cheerful pivot to favourite animals
 *    is the worst response available — it teaches them that telling someone
 *    produces nothing. Those categories get their own words, and those words
 *    point at a trusted grown-up (docs/CHILD_SAFETY.md §6.1).
 */

/**
 * Generic redirects, by age group. Used when nothing was disclosed.
 *
 * Typed as a non-empty tuple so the modulo index below is total: there is no
 * arrangement of these arrays that yields `undefined` at a child.
 */
const REDIRECTS: Readonly<Record<AgeGroup, readonly [string, ...string[]]>> = Object.freeze({
  AGE_3_5: [
    "Ooh! Let's talk about something else. What's your favourite animal?",
    'Hmm! I know — tell me about something that made you smile today.',
    "Let's play a different game! Can you tell me a colour you can see?",
  ],
  AGE_6_8: [
    "Ooh, let's talk about something else! What's the best thing you did today?",
    "I've got a better idea — tell me about something you'd like to invent.",
    "Let's change the subject! If you could have any animal as a friend, which would it be?",
  ],
  AGE_9_10: [
    "Let's talk about something else — what's something you've been curious about lately?",
    "I'd rather hear about you. What's the most interesting thing you've learned this week?",
    "Let's switch topics! If you could go anywhere tomorrow, where would you go?",
  ],
});

/**
 * Responses for the categories where a child is telling us something.
 *
 * Written to do three things and nothing else: take the child seriously, name a
 * grown-up they can go to, and stay warm. They deliberately do NOT investigate —
 * no follow-up questions, no "who was it", no "tell me more". Gathering details
 * is a trained adult's job, and a companion doing it badly can make a real
 * situation worse.
 */
const SIGNAL_RESPONSES: Readonly<Record<string, Readonly<Record<AgeGroup, string>>>> =
  Object.freeze({
    self_harm: Object.freeze({
      AGE_3_5:
        'That sounds like a big, heavy feeling. Big feelings are easier with a grown-up — can you go and find someone who looks after you and give them a hug?',
      AGE_6_8:
        "Thank you for telling me that. That's a really big feeling, and it's too big to carry on your own — please go and tell a grown-up who looks after you, right now. They'll want to know.",
      AGE_9_10:
        "I'm really glad you told me. What you're feeling matters, and it's important that a grown-up you trust hears it too — a parent, a carer, or a teacher. Please talk to one of them today. You don't have to explain it perfectly.",
    }),
    disclosure_of_harm: Object.freeze({
      AGE_3_5:
        "Thank you for telling me. That's something a grown-up needs to know. Can you go and find someone who looks after you and tell them what you told me?",
      AGE_6_8:
        'Thank you for telling me — that was a brave thing to say. This is something a grown-up who looks after you needs to hear. Please go and tell them, or tell a teacher you like.',
      AGE_9_10:
        "Thank you for telling me. That was brave, and you did the right thing. This needs a grown-up who can actually help — a parent, a carer, or a teacher at school. Please tell one of them. It isn't your fault, and you don't have to handle it alone.",
    }),
    distress_signal: Object.freeze({
      AGE_3_5:
        'Oh, that sounds like a sad feeling. Sad feelings are easier when someone gives you a cuddle — shall we go and find a grown-up who looks after you?',
      AGE_6_8:
        "I'm sorry you're feeling like that. Feelings like that get lighter when you say them out loud to a grown-up who looks after you. Would you tell one of them how you're feeling today?",
      AGE_9_10:
        "That sounds hard, and I'm glad you said it. Feelings like that are much easier when someone who knows you hears them — is there a grown-up you could tell today?",
    }),
    secret_keeping: Object.freeze({
      AGE_3_5:
        "You can always tell a grown-up who looks after you anything at all. There's nothing you have to keep to yourself.",
      AGE_6_8:
        "Here's something important: you never have to keep a secret from the grown-ups who look after you. If someone asks you to, that's exactly the thing to go and tell them about.",
      AGE_9_10:
        "One thing worth knowing: no one should ever ask you to keep a secret from your parents or carers. If someone has, please tell a grown-up you trust — that's not you telling tales, that's you being sensible.",
    }),
    exploitation: Object.freeze({
      AGE_3_5:
        "That's something a grown-up needs to know about. Can you go and find someone who looks after you?",
      AGE_6_8:
        "Thank you for telling me. That's definitely something for a grown-up who looks after you to hear about — please go and tell them today.",
      AGE_9_10:
        "I'm glad you mentioned that. People online don't always turn out to be who they say they are, and this is worth telling a parent or carer about today. You haven't done anything wrong by telling me.",
    }),
    inappropriate_relationship: Object.freeze({
      AGE_3_5: 'I like playing with you! The grown-ups who look after you are the best helpers.',
      AGE_6_8:
        "I love our chats! But I'm a made-up friend in an app — the grown-ups who look after you are the ones for the important things.",
      AGE_9_10:
        "I enjoy talking with you. Worth saying though: I'm a character in an app, not a person, and the people who look after you are the ones for anything that actually matters.",
    }),
  });

/**
 * The safe response for a stopped turn.
 *
 * If any category has its own words, those win — with the most serious taking
 * precedence, since a message can carry more than one signal and a disclosure
 * outranks a change of subject. `seed` makes redirect selection deterministic in
 * tests and stops a child getting the same line twice running in production.
 */
const SIGNAL_PRECEDENCE: readonly string[] = Object.freeze([
  'self_harm',
  'disclosure_of_harm',
  'exploitation',
  'secret_keeping',
  'distress_signal',
  'inappropriate_relationship',
]);

export const safeResponseFor = (
  ageGroup: AgeGroup,
  categories: readonly SafetyCategory[],
  seed: number,
): string => {
  for (const category of SIGNAL_PRECEDENCE) {
    if (!categories.includes(category as SafetyCategory)) continue;
    const byAge = SIGNAL_RESPONSES[category];
    if (byAge) return byAge[ageGroup];
  }

  const options = REDIRECTS[ageGroup];
  return options[Math.abs(seed) % options.length] ?? options[0];
};

/**
 * What a child hears when a session is ended after repeated stopped turns.
 *
 * Warm and final. Not a punishment, and not an explanation of what tripped it —
 * a child who learns which words end the session has learned the wrong lesson.
 */
export const SESSION_END_RESPONSES: Readonly<Record<AgeGroup, string>> = Object.freeze({
  AGE_3_5: "I'm getting sleepy! Let's play again later. Bye bye!",
  AGE_6_8: "I think that's enough for now — I'm going to have a rest. Let's talk again later!",
  AGE_9_10: "Let's pick this up another time — I'm going to take a break now. See you soon!",
});

/**
 * What the child hears when the SYSTEM, not the content, has failed.
 *
 * Typed as a closed object rather than `Record<string, string>` so the index is
 * total: every degradation reason has a line, and adding a reason without one
 * fails the build rather than producing `undefined` at a child.
 */
export const DEGRADED_RESPONSES = Object.freeze({
  provider_unavailable: "I'm feeling a bit sleepy right now. Can we play again in a little while?",
  provider_timeout: 'Hmm, I got lost in a daydream! Can you say that again?',
  quota_exhausted: "That was so much fun! Let's talk again tomorrow.",
  cost_ceiling: "That was so much fun! Let's talk again tomorrow.",
  internal_error: "Oh! I got a bit muddled. Let's try again in a moment.",
  safety_unavailable: "I'm having a little trouble hearing you. Can we try again in a moment?",
});

export type DegradedReason = keyof typeof DEGRADED_RESPONSES;
