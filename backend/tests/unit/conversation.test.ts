/**
 * The per-session conversation tally.
 *
 * The interesting cases are all about *when* a tally is observed rather than
 * what it counts, because that is where the design choice is: a conversation
 * ends once, reported by whichever side won the race (D6), so hanging the
 * observation off the ending would record one side of some conversations and
 * neither side of others.
 */
import { ConversationTally, type ConversationObserver } from '../../src/metrics/conversation';
import { CONVERSED_MESSAGE_THRESHOLD } from '../../src/metrics/registry';

function harness() {
  const spoke: number[] = [];
  const finished: number[] = [];
  let conversed = 0;
  let clock = 0;

  const observer: ConversationObserver = {
    spoke: (seconds) => spoke.push(seconds),
    conversed: () => {
      conversed += 1;
    },
    finished: (messages) => finished.push(messages),
  };

  const tally = new ConversationTally(observer, () => clock);
  return {
    tally,
    spoke,
    finished,
    conversed: () => conversed,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('ConversationTally', () => {
  it('reports the first message as a latency from being matched', () => {
    const h = harness();
    h.tally.matched('s1');
    h.advance(2500);
    h.tally.sent('s1');

    expect(h.spoke).toEqual([2.5]);
  });

  it('reports "spoke" once, however many messages follow', () => {
    const h = harness();
    h.tally.matched('s1');
    for (let i = 0; i < 10; i += 1) h.tally.sent('s1');

    expect(h.spoke).toHaveLength(1);
  });

  it('reports "conversed" exactly on the threshold and not again', () => {
    const h = harness();
    h.tally.matched('s1');
    for (let i = 0; i < CONVERSED_MESSAGE_THRESHOLD * 4; i += 1) h.tally.sent('s1');

    expect(h.conversed()).toBe(1);
  });

  it('does not report "conversed" one message short of the threshold', () => {
    const h = harness();
    h.tally.matched('s1');
    for (let i = 0; i < CONVERSED_MESSAGE_THRESHOLD - 1; i += 1) h.tally.sent('s1');

    expect(h.conversed()).toBe(0);
  });

  /**
   * The bounce, and the single most useful number this file produces.
   *
   * A conversation that is matched and left without either side speaking has to
   * reach the histogram as a zero. Skipping it would leave the distribution
   * describing only the conversations that worked, which is the shape of every
   * metric that flatters the product it measures.
   */
  it('observes a conversation nobody spoke in, as zero', () => {
    const h = harness();
    h.tally.matched('s1');
    h.tally.closed('s1');

    expect(h.finished).toEqual([0]);
    expect(h.spoke).toEqual([]);
  });

  it('flushes the previous conversation when the same session matches again', () => {
    const h = harness();
    h.tally.matched('s1');
    h.tally.sent('s1');
    h.tally.sent('s1');

    // A skip: matched again without anything having said the last one ended.
    h.tally.matched('s1');
    expect(h.finished).toEqual([2]);

    h.tally.sent('s1');
    h.tally.closed('s1');
    expect(h.finished).toEqual([2, 1]);
  });

  it('keeps two sessions apart', () => {
    const h = harness();
    h.tally.matched('a');
    h.tally.matched('b');
    h.tally.sent('a');
    h.tally.sent('a');
    h.tally.sent('b');

    h.tally.closed('a');
    h.tally.closed('b');
    expect(h.finished).toEqual([2, 1]);
  });

  /**
   * A message from a session with no open tally is a resumption, not a bug.
   *
   * Under §28 a socket can attach to a session whose conversation began before
   * this instance ever saw it (D42). Counting that message would put a
   * first-message latency in the histogram measured from a match this instance
   * never observed — a duration since zero, which is to say since the process
   * started.
   */
  it('ignores a message from a session it never saw match', () => {
    const h = harness();
    h.advance(90_000);
    h.tally.sent('resumed');

    expect(h.spoke).toEqual([]);
    expect(h.finished).toEqual([]);
  });

  it('retains nothing after a close', () => {
    const h = harness();
    h.tally.matched('s1');
    h.tally.sent('s1');
    h.tally.closed('s1');

    expect(h.tally.size).toBe(0);

    // A second close is a no-op rather than a second observation. Both the
    // close handler and a re-match can flush, and a session that reaches both
    // must not appear in the histogram twice.
    h.tally.closed('s1');
    expect(h.finished).toEqual([1]);
  });
});
