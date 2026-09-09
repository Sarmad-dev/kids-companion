import { describe, expect, it } from 'vitest';

import { parseReply } from './redis-client.js';

/**
 * RESP parsing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BUG THIS FILE IS LOOKING FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A reply arriving split across TCP packets. It works perfectly in every test
 * that writes a whole reply at once, and then one day a reply lands in two
 * pieces and the parser either throws or — far worse — consumes half of one
 * reply and matches the remainder to the NEXT command.
 *
 * For a rate limiter that means counts attributed to the wrong caller: an
 * attacker's attempts charged to somebody else's key, and a parent locked out
 * by traffic that was never theirs.
 */

const buf = (text: string): Buffer => Buffer.from(text, 'utf8');

describe('parsing one reply', () => {
  it('reads an integer, which is what INCR and PTTL return', () => {
    expect(parseReply(buf(':42\r\n'))).toEqual({ value: 42, next: 5 });
  });

  it('reads a simple string, which is what AUTH returns', () => {
    expect(parseReply(buf('+OK\r\n'))).toEqual({ value: 'OK', next: 5 });
  });

  it('reads a bulk string', () => {
    expect(parseReply(buf('$5\r\nhello\r\n'))).toEqual({ value: 'hello', next: 11 });
  });

  it('reads a null bulk string as null, not as the text "nil"', () => {
    expect(parseReply(buf('$-1\r\n'))).toEqual({ value: null, next: 5 });
  });

  it('reads an array, including a nested one', () => {
    const parsed = parseReply(buf('*2\r\n:1\r\n*1\r\n+deep\r\n'));

    expect(parsed?.value).toEqual([1, ['deep']]);
  });

  it('surfaces an error reply as a value rather than throwing', () => {
    /* A rate-limit command that gets `-NOAUTH` should degrade the limiter to
     * local counting, not throw somewhere unexpected in a request. */
    const parsed = parseReply(buf('-NOAUTH Authentication required.\r\n'));

    expect(parsed?.value).toBeInstanceOf(Error);
    expect(String(parsed?.value)).toContain('NOAUTH');
  });
});

describe('when the bytes have not all arrived', () => {
  it('asks for more rather than guessing, on a truncated line', () => {
    expect(parseReply(buf(':42'))).toBeUndefined();
  });

  it('asks for more when a bulk string is short', () => {
    // The length header arrived; the payload did not.
    expect(parseReply(buf('$5\r\nhel'))).toBeUndefined();
  });

  it('asks for more when an array is incomplete', () => {
    expect(parseReply(buf('*2\r\n:1\r\n'))).toBeUndefined();
  });

  it('parses correctly once the rest arrives', () => {
    /* The property that matters: the same bytes, delivered in two pieces,
     * produce the same answer as one piece. */
    const whole = buf('$5\r\nhello\r\n');

    expect(parseReply(whole.subarray(0, 6))).toBeUndefined();
    expect(parseReply(whole)).toEqual({ value: 'hello', next: 11 });
  });
});

describe('when several replies share a buffer', () => {
  it('consumes exactly one and reports where the next begins', () => {
    /* ═══════════════════════════════════════════════════════════════════════
     * OFF BY ONE HERE MIS-ATTRIBUTES EVERY LATER COUNT.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Replies are matched to commands FIFO. If `next` is wrong the parser
     * silently re-reads or skips bytes, and from then on every INCR result
     * belongs to a different caller than the one being counted.
     */
    const pipeline = buf(':1\r\n:900000\r\n');

    const first = parseReply(pipeline);
    expect(first).toEqual({ value: 1, next: 4 });

    const second = parseReply(pipeline, first!.next);
    expect(second?.value).toBe(900_000);
    expect(second?.next).toBe(pipeline.length);
  });

  it('handles a mixed pipeline of every type', () => {
    const pipeline = buf(':1\r\n+OK\r\n$3\r\nabc\r\n');
    const values: unknown[] = [];

    let cursor = 0;
    for (;;) {
      const parsed = parseReply(pipeline, cursor);
      if (!parsed) break;
      values.push(parsed.value);
      cursor = parsed.next;
      if (cursor >= pipeline.length) break;
    }

    expect(values).toEqual([1, 'OK', 'abc']);
  });
});

describe('when the stream is not RESP at all', () => {
  it('reports an error rather than guessing past it', () => {
    /* Something that is not Redis on the other end, or a stream that has lost
     * sync. Skipping the byte and carrying on would mis-attribute everything
     * after it; an error makes the client tear down and reconnect. */
    const parsed = parseReply(buf('garbage\r\n'));

    expect(parsed?.value).toBeInstanceOf(Error);
  });
});
