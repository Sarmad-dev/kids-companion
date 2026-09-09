import { describe, expect, it } from 'vitest';

import { createFakeAudioPort } from './audio-port';
import {
  buttonLabelFor,
  initialTalkContext,
  isPressable,
  MAX_RECORDING_MS,
  talkReducer,
  type TalkContext,
  type TalkEvent,
} from './recorder-machine';

/**
 * The talk button.
 *
 * The whole child experience is one loop and this is the part a child actually
 * touches, so the bugs that matter are the impossible combinations: recording
 * while playing, two recordings at once, a reply arriving for a turn the child
 * already abandoned. Every one of those is a state transition, and every one is
 * asserted below.
 */

const run = (events: TalkEvent[], from: TalkContext = initialTalkContext): TalkContext =>
  events.reduce(talkReducer, from);

describe('the happy path', () => {
  it('walks the whole loop', () => {
    // character → child speaks → AI responds → character speaks
    let context = run([{ type: 'PRESS' }]);
    expect(context.state).toBe('requesting_permission');

    context = run([{ type: 'PERMISSION_GRANTED' }], context);
    expect(context.state).toBe('recording');

    context = run([{ type: 'PRESS' }], context);
    expect(context.state).toBe('thinking');

    context = run([{ type: 'REPLY', reply: 'Lovely!', hasAudio: true }], context);
    expect(context).toMatchObject({ state: 'speaking', reply: 'Lovely!' });

    context = run([{ type: 'PLAYBACK_FINISHED' }], context);
    expect(context.state).toBe('idle');
  });

  it('returns to idle when there is no audio to play', () => {
    const context = run([
      { type: 'PRESS' },
      { type: 'PERMISSION_GRANTED' },
      { type: 'PRESS' },
      { type: 'REPLY', reply: 'Text only', hasAudio: false },
    ]);
    // TTS failing degrades the experience; it does not break the turn.
    expect(context).toMatchObject({ state: 'idle', reply: 'Text only' });
  });
});

describe('the impossible states', () => {
  it('ignores taps while a permission request is open', () => {
    // A child WILL tap repeatedly while waiting, and a second request must not
    // queue behind the first.
    const context = run([{ type: 'PRESS' }, { type: 'PRESS' }, { type: 'PRESS' }]);
    expect(context.state).toBe('requesting_permission');
  });

  it('ignores taps while thinking', () => {
    const context = run([
      { type: 'PRESS' },
      { type: 'PERMISSION_GRANTED' },
      { type: 'PRESS' },
      { type: 'PRESS' },
      { type: 'PRESS' },
    ]);
    expect(context.state).toBe('thinking');
  });

  it('lets a child interrupt the character', () => {
    // Children talk over the character constantly, and the right response is to
    // listen rather than to treat it as an error.
    const speaking = run([
      { type: 'PRESS' },
      { type: 'PERMISSION_GRANTED' },
      { type: 'PRESS' },
      { type: 'REPLY', reply: 'Once upon a time…', hasAudio: true },
    ]);
    expect(speaking.state).toBe('speaking');

    expect(run([{ type: 'PRESS' }], speaking).state).toBe('requesting_permission');
  });

  it('drops a reply that arrives after the child moved on', () => {
    // Speaking over a child who has started a new turn is worse than silence.
    const recording = run([
      { type: 'PRESS' },
      { type: 'PERMISSION_GRANTED' },
      { type: 'PRESS' },
      { type: 'REPLY', reply: 'first', hasAudio: true },
      { type: 'PRESS' },
      { type: 'PERMISSION_GRANTED' },
    ]);
    expect(recording.state).toBe('recording');

    const late = run([{ type: 'REPLY', reply: 'stale', hasAudio: true }], recording);
    expect(late.state).toBe('recording');
    expect(late.reply).not.toBe('stale');
  });

  it('ignores playback finishing when nothing was playing', () => {
    expect(run([{ type: 'PLAYBACK_FINISHED' }]).state).toBe('idle');
  });

  it('ignores a tick when not recording', () => {
    const context = run([{ type: 'TICK', ms: 5_000 }]);
    expect(context).toEqual(initialTalkContext);
  });
});

describe('limits and failures', () => {
  it('stops recording at the ceiling', () => {
    const context = run([
      { type: 'PRESS' },
      { type: 'PERMISSION_GRANTED' },
      { type: 'TICK', ms: MAX_RECORDING_MS },
    ]);
    // A hard stop, not a countdown. A visible timer turns talking into a task
    // with a deadline.
    expect(context.state).toBe('thinking');
  });

  it('keeps recording below the ceiling', () => {
    const context = run([
      { type: 'PRESS' },
      { type: 'PERMISSION_GRANTED' },
      { type: 'TICK', ms: MAX_RECORDING_MS - 1 },
    ]);
    expect(context.state).toBe('recording');
    expect(context.recordedMs).toBe(MAX_RECORDING_MS - 1);
  });

  it('explains a denied microphone without blaming the child', () => {
    const context = run([{ type: 'PRESS' }, { type: 'PERMISSION_DENIED' }]);
    expect(context.state).toBe('failed');
    expect(context.failure?.kind).toBe('microphone_blocked');
    expect(context.failure?.message.toLowerCase()).toContain('grown-up');
  });

  it('lets a child try again after a failure', () => {
    const failed = run([{ type: 'PRESS' }, { type: 'PERMISSION_DENIED' }]);
    expect(run([{ type: 'PRESS' }], failed).state).toBe('requesting_permission');
  });

  it('resets cleanly', () => {
    const failed = run([{ type: 'PRESS' }, { type: 'PERMISSION_DENIED' }]);
    expect(run([{ type: 'RESET' }], failed)).toEqual(initialTalkContext);
  });
});

describe('what the button says', () => {
  it('is short enough for a pre-reader to recognise by shape', () => {
    for (const state of ['idle', 'recording', 'thinking', 'speaking', 'failed'] as const) {
      expect(buttonLabelFor(state).length).toBeLessThanOrEqual(14);
    }
  });

  it('is never disabled while the character is speaking', () => {
    // Interrupting is the single most common thing a child does.
    expect(isPressable('speaking')).toBe(true);
    expect(isPressable('idle')).toBe(true);
    expect(isPressable('thinking')).toBe(false);
    expect(isPressable('requesting_permission')).toBe(false);
  });
});

describe('the audio port', () => {
  it('records and hands back a file', async () => {
    const port = createFakeAudioPort();
    expect(await port.requestPermission()).toBe('granted');
    await port.startRecording();
    expect(await port.stopRecording()).toMatchObject({ mimeType: 'audio/mp4' });
  });

  it('returns nothing when it was never recording', async () => {
    const port = createFakeAudioPort();
    expect(await port.stopRecording()).toBeUndefined();
  });

  it('reports a denied permission', async () => {
    const port = createFakeAudioPort({ permission: 'denied' });
    expect(await port.requestPermission()).toBe('denied');
  });

  it('tracks what was discarded', async () => {
    // The property the conversation screen relies on: a child's voice is deleted
    // from the device on EVERY path, including the failures.
    const port = createFakeAudioPort();
    await port.discard('file:///tmp/turn.m4a');
    expect(port.discarded).toEqual(['file:///tmp/turn.m4a']);
  });
});
