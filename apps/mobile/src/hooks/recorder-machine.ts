import type { FriendlyFailure } from '../api/errors';
import { failureFor } from '../api/errors';

/**
 * The talk-button state machine.
 *
 * The whole child experience is one loop — **character → child speaks → AI
 * responds → character speaks** — and this is the part the child is actually
 * touching. It is a state machine rather than a pile of booleans because the
 * states are genuinely exclusive and the bugs that matter are the impossible
 * combinations: recording while playing, two recordings at once, a reply
 * arriving for a turn the child already cancelled.
 *
 * It lives apart from the component and behind an audio PORT so it can be tested
 * without a simulator, a microphone, or a permission dialog.
 */

export type TalkState =
  /** Nothing happening. The button says "tap to talk". */
  | 'idle'
  /** The OS dialog is up. A child will not understand it; a grown-up is nearby. */
  | 'requesting_permission'
  /** The microphone is open. The button pulses; there is no timer shown. */
  | 'recording'
  /** Audio captured, request in flight. The character is "thinking". */
  | 'thinking'
  /** The character is speaking. Tapping interrupts, which children do constantly. */
  | 'speaking'
  /** Something went wrong. One warm sentence, and usually a way to try again. */
  | 'failed';

export interface TalkContext {
  readonly state: TalkState;
  readonly failure?: FriendlyFailure;
  /** What the character just said, for the caption older children can read. */
  readonly reply?: string;
  /** Milliseconds recorded so far. Drives the pulse, never a countdown. */
  readonly recordedMs: number;
}

export type TalkEvent =
  | { type: 'PRESS' }
  | { type: 'PERMISSION_GRANTED' }
  | { type: 'PERMISSION_DENIED' }
  | { type: 'TICK'; ms: number }
  | { type: 'RECORDING_STOPPED' }
  | { type: 'REPLY'; reply: string; hasAudio: boolean }
  | { type: 'PLAYBACK_FINISHED' }
  | { type: 'FAILED'; failure: FriendlyFailure }
  | { type: 'RESET' };

export const initialTalkContext: TalkContext = { state: 'idle', recordedMs: 0 };

/**
 * The longest a child may hold the button.
 *
 * A hard stop rather than a countdown. A visible timer turns talking into a task
 * with a deadline, and a four-year-old telling a long story does not need to be
 * hurried — but a phone in a pocket recording for nine minutes is a cost and a
 * privacy problem, so the ceiling exists and simply ends the turn warmly.
 */
export const MAX_RECORDING_MS = 30_000;

export const talkReducer = (context: TalkContext, event: TalkEvent): TalkContext => {
  switch (event.type) {
    case 'PRESS':
      // One button, three meanings, and which one depends on the state. This is
      // why it is a machine: a child taps constantly and every tap must land
      // somewhere sensible rather than starting a second recording.
      if (context.state === 'recording') return { ...context, state: 'thinking' };

      // Interrupting is normal and is not an error. Children talk over the
      // character constantly, and the right response is to listen.
      if (context.state === 'idle' || context.state === 'failed' || context.state === 'speaking') {
        return { state: 'requesting_permission', recordedMs: 0 };
      }

      // `requesting_permission` and `thinking` are deliberately inert: tapping
      // during a request must not queue a second one, and a child WILL tap
      // repeatedly while waiting.
      return context;

    case 'PERMISSION_GRANTED':
      return context.state === 'requesting_permission'
        ? { state: 'recording', recordedMs: 0 }
        : context;

    case 'PERMISSION_DENIED':
      return { state: 'failed', failure: failureFor('microphone_blocked'), recordedMs: 0 };

    case 'TICK':
      if (context.state !== 'recording') return context;
      return event.ms >= MAX_RECORDING_MS
        ? { ...context, state: 'thinking', recordedMs: event.ms }
        : { ...context, recordedMs: event.ms };

    case 'RECORDING_STOPPED':
      return context.state === 'recording' ? { ...context, state: 'thinking' } : context;

    case 'REPLY':
      // A reply that arrives after the child moved on is DROPPED. Speaking over
      // a child who has started a new turn is worse than saying nothing.
      if (context.state !== 'thinking') return context;
      return {
        state: event.hasAudio ? 'speaking' : 'idle',
        reply: event.reply,
        recordedMs: 0,
      };

    case 'PLAYBACK_FINISHED':
      return context.state === 'speaking'
        ? {
            state: 'idle',
            ...(context.reply === undefined ? {} : { reply: context.reply }),
            recordedMs: 0,
          }
        : context;

    case 'FAILED':
      return { state: 'failed', failure: event.failure, recordedMs: 0 };

    case 'RESET':
      return initialTalkContext;
  }
};

/** What the button says. Short enough for a pre-reader to recognise by shape. */
export const buttonLabelFor = (state: TalkState): string => {
  switch (state) {
    case 'idle':
    case 'failed':
      return 'Talk to me!';
    case 'requesting_permission':
      return 'One moment…';
    case 'recording':
      return "I'm listening!";
    case 'thinking':
      return 'Thinking…';
    case 'speaking':
      return 'Tap to talk';
  }
};

/** Whether the button should be tappable. Never disabled during `speaking`. */
export const isPressable = (state: TalkState): boolean =>
  state !== 'requesting_permission' && state !== 'thinking';
