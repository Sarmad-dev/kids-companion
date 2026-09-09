/**
 * The five story seeds.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A CLOSED SET, AND WHY IT HAS TO BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A seed becomes the opening message of a story conversation, which means it
 * becomes text the model reads. Free text from a child's device is the one
 * thing this product must never put in that position — not because a
 * four-year-old would attack the prompt, but because a text field on a child's
 * screen is a text field anyone holding the phone can type into, and there is
 * no way to make that safe. Five fixed sentences, chosen by picture, cannot be
 * anything other than what they are.
 *
 * The pictures are also the point for the child: seeds are offered as images
 * with a word, and "You choose!" lets a child hand the idea back to the
 * character rather than requiring them to have one.
 */

export interface StorySeed {
  readonly key: string;
  readonly icon: string;
  readonly label: string;
  /** What is actually sent as the child's first message. */
  readonly opening: string;
}

export const STORY_SEEDS: readonly StorySeed[] = [
  {
    key: 'dog',
    icon: '🐕',
    label: 'A brave little dog',
    opening: "Let's make a story about a brave little dog.",
  },
  {
    key: 'moon',
    icon: '🌙',
    label: 'A trip to the moon',
    opening: "Let's make a story about a trip to the moon.",
  },
  {
    key: 'balloon',
    icon: '🎈',
    label: 'A lost balloon',
    opening: "Let's make a story about a lost balloon.",
  },
  {
    key: 'tree',
    icon: '🌳',
    label: 'A magic tree',
    opening: "Let's make a story about a magic tree.",
  },
  {
    key: 'you',
    icon: '✨',
    label: 'You choose!',
    opening: "Let's make a story. You choose what it's about!",
  },
];

export const storySeedFor = (key: string | undefined): StorySeed | undefined =>
  STORY_SEEDS.find((seed) => seed.key === key);
