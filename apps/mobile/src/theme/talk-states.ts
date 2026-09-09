import type { TalkState } from '../hooks/recorder-machine';

import { characterColour, childTheme } from './child-theme';

/**
 * How the talk button looks in each of its states.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FACE, FILL AND LABEL ALWAYS CHANGE TOGETHER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That is the whole rule, and it is the reason Reduce Motion costs nothing:
 * every state is legible from three independent channels, so removing the
 * breath removes decoration rather than information. It is also why the
 * disabled state keeps its label — a greyed control with no words is a puzzle,
 * and a child who cannot read it just sees a button that stopped working.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RECORDING IS GREEN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Not red. Red means stop, everywhere else in a child's life, and teaching a
 * four-year-old to press a red button in order to speak is teaching them the
 * wrong thing about every other red button they will meet.
 *
 * The `failed` state is deliberately IDENTICAL to idle. The speech bubble
 * apologises; the button never scolds, never turns red, and never implies the
 * child broke something.
 */

export interface TalkVisual {
  readonly face: string;
  readonly label: string;
  readonly fill: string;
  readonly breathing: boolean;
  readonly tappable: boolean;
}

export const talkVisual = (
  state: TalkState,
  slug: string | undefined,
  online: boolean,
): TalkVisual => {
  const own = characterColour(slug);

  // Offline outranks everything. There is nothing to talk INTO, and a button
  // that looks ready but does nothing is worse than one that says it is resting.
  if (!online) {
    return {
      face: '🎤',
      label: 'Talk to me!',
      fill: childTheme.colors.disabled,
      breathing: false,
      tappable: false,
    };
  }

  switch (state) {
    case 'idle':
    case 'failed':
      return { face: '🎤', label: 'Talk to me!', fill: own, breathing: false, tappable: true };
    case 'requesting_permission':
      // Untappable while the OS dialog is up: tapping again would queue a second
      // request, and a child WILL tap repeatedly at a box they cannot read.
      return { face: '🎤', label: 'One moment…', fill: own, breathing: false, tappable: false };
    case 'recording':
      return {
        face: '👂',
        label: "I'm listening!",
        fill: childTheme.colors.listening,
        breathing: true,
        tappable: true,
      };
    case 'thinking':
      // Grey and untappable; the rig carries the wait.
      return {
        face: '💭',
        label: 'Thinking…',
        fill: childTheme.colors.thinking,
        breathing: false,
        tappable: false,
      };
    case 'speaking':
      // Tappable mid-answer. Interrupting is normal, is not an error, and the
      // right response to a child talking over the character is to listen.
      return { face: '🎤', label: 'Tap to talk', fill: own, breathing: false, tappable: true };
  }
};

/** The prompt pill shows before anyone has spoken; the bubble shows after. */
export const showsPrompt = (state: TalkState): boolean =>
  state === 'idle' || state === 'requesting_permission';
