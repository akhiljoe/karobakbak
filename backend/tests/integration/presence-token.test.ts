/**
 * Both sides of a match get a presence token, over real sockets.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE
 * ---------------------------------------------------------------------------
 * The token shipped reaching only half of every conversation, and which half
 * depended on who had been waiting.
 *
 * The two people are told about a match by two different pieces of code. The
 * side already in the queue is told by a frame `lifecycle` builds and
 * publishes, which carried the token from the first commit. The side that
 * pressed Start is told by a frame `server.ts` builds from the returned
 * outcome — and that one dropped it. So one person could ask to reconnect and
 * the other could not, from the same conversation, and nothing anywhere failed.
 *
 * Neither unit tests nor the route-level integration test could see it: both
 * pieces were individually correct, and the fault was that they disagreed about
 * what a `matched` frame contains. It takes two real sockets to notice, which
 * is what this does.
 *
 * The assertion is deliberately symmetric. Testing one side would have passed
 * against the broken build half the time, depending on which client the test
 * happened to look at.
 */
import { startTestServer, TestClient, payloadOf, type TestServer } from '../helpers/socket';
import type { MatchedPayload } from '../../src/protocol/types';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.stop();
});

/** Alice waits, Bob searches — so the two frames are built by different code. */
async function pair(): Promise<{ waited: MatchedPayload; searched: MatchedPayload }> {
  const alice = await TestClient.connect(server.url);
  const bob = await TestClient.connect(server.url);
  await alice.waitForFrame('connected');
  await bob.waitForFrame('connected');

  alice.command('join_queue');
  await alice.waitForFrame('queue_status');
  bob.command('join_queue');

  const searched = payloadOf<MatchedPayload>(await bob.waitForFrame('matched'));
  const waited = payloadOf<MatchedPayload>(await alice.waitForFrame('matched'));

  alice.close();
  bob.close();
  return { waited, searched };
}

describe('the matched frame', () => {
  it('carries the presence field to both sides, not just the one that waited', async () => {
    const { waited, searched } = await pair();

    /*
      Asserted as "the field is there", not "a token is there", because this
      harness starts a server with no auth configured and therefore no presence
      service — so nothing is minted and both sides are correctly null.

      That still catches the bug exactly. Before the fix the searcher's frame
      did not carry the key at all, so it read `undefined` while the waiter's
      read `null`: two different answers to the same question, from one
      conversation, decided by which side had been waiting.
    */
    expect(Object.hasOwn(waited, 'partnerPresence')).toBe(true);
    expect(Object.hasOwn(searched, 'partnerPresence')).toBe(true);
  });

  it('answers the same way on both sides', async () => {
    // Symmetric on purpose. Checking one side would pass against the broken
    // build half the time, depending on which client the test looked at.
    const { waited, searched } = await pair();
    expect(searched.partnerPresence ?? null).toEqual(waited.partnerPresence ?? null);
  });
});
