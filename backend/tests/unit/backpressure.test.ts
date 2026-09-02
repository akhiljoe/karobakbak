/**
 * L5 — the slow consumer, and the close that stops it being unbounded memory.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS WORTH A TEST OF ITS OWN
 * ---------------------------------------------------------------------------
 * A client that stops reading its socket does not error and does not close. It
 * simply stops draining, and every frame the server writes accumulates in that
 * connection's send buffer. A suspended tab and a dead mobile radio both look
 * exactly like this, and so does a client written to do it on purpose — which
 * is the cheapest denial of service available against a chat server, because
 * the attacker's cost is nothing at all.
 *
 * `SocketConnection.send` checks `bufferedAmount` against
 * `MAX_BUFFERED_BYTES` and closes with 1013 (`TRY_AGAIN_LATER`). That check was
 * the only defence and had **no test**, which is the combination worth caring
 * about: it is one comparison, it is easy to remove while tidying, and nothing
 * would fail.
 *
 * The decision is tested directly rather than by manufacturing real
 * backpressure. Getting a `ws` client to genuinely stop draining means pausing
 * the underlying stream and flooding it from the other side, which tests the
 * operating system's buffer sizes as much as this code, and is slow and
 * flaky besides. What matters is the rule: past the limit, close and refuse.
 */
import { loadConfig, type Config, type Env } from '../../src/config';
import { createNullLogger } from '../../src/logger';
import { SocketConnection } from '../../src/ws/connection';
import { CLOSE_CODES } from '../../src/protocol/types';

function config(overrides: Env = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    INSTANCE_ID: 'i_test',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ...overrides,
  });
}

/**
 * A socket that reports whatever `bufferedAmount` the test wants.
 *
 * Only the surface `SocketConnection` touches: the event registration it does
 * at construction, the readyState it checks before writing, the buffer it
 * checks before writing, and the two writes.
 */
function fakeSocket(bufferedAmount = 0) {
  const sent: string[] = [];
  const closes: Array<{ code: number; reason: string }> = [];
  return {
    OPEN: 1,
    readyState: 1,
    bufferedAmount,
    sent,
    closes,
    on(): void {
      /* the connection registers message/pong/close/error; none is driven here */
    },
    send(frame: string): void {
      sent.push(frame);
    },
    close(code: number, reason: string): void {
      closes.push({ code, reason: String(reason) });
    },
    terminate(): void {
      closes.push({ code: 1006, reason: 'terminated' });
    },
  };
}

function connectionWith(socket: ReturnType<typeof fakeSocket>, cfg = config()): SocketConnection {
  return new SocketConnection({
    socket: socket as never,
    sessionId: 'sess_test',
    ipHash: 'iphash',
    clientHash: 'clienthash',
    country: null,
    config: cfg,
    logger: createNullLogger(),
    onCommand: () => Promise.resolve(),
    onClose: () => Promise.resolve(),
  });
}

describe('a socket that has stopped draining', () => {
  it('writes normally while the buffer is inside the limit', () => {
    const socket = fakeSocket(1024);
    const connection = connectionWith(socket, config({ MAX_BUFFERED_BYTES: '65536' }));

    expect(connection.send('{"hello":true}')).toBe(true);
    expect(socket.sent).toHaveLength(1);
    expect(socket.closes).toHaveLength(0);
  });

  /**
   * The defence itself. Past the limit the frame is **not** written — writing
   * it would be adding to the buffer this is reacting to — and the socket is
   * closed with 1013, which is the code that tells a well-behaved client to
   * come back rather than that it did something wrong.
   */
  it('closes with 1013 rather than adding to a buffer it cannot drain', () => {
    const socket = fakeSocket(200_000);
    const connection = connectionWith(socket, config({ MAX_BUFFERED_BYTES: '65536' }));

    expect(connection.send('{"hello":true}')).toBe(false);
    expect(socket.sent).toHaveLength(0);
    expect(socket.closes).toHaveLength(1);
    expect(socket.closes[0]?.code).toBe(CLOSE_CODES.TRY_AGAIN_LATER);
  });

  /**
   * `send` returns false rather than throwing, and that is load-bearing.
   *
   * Its callers are usually transitions that have **already been committed to
   * Redis** — a match was made, a message was routed — and a throw there would
   * unwind an operation the rest of the system now believes happened. The
   * failure of one socket must not become the failure of the transition that
   * was writing to it.
   */
  it('reports the refusal rather than throwing, so a committed transition is not unwound', () => {
    const socket = fakeSocket(10_000_000);
    const connection = connectionWith(socket, config({ MAX_BUFFERED_BYTES: '65536' }));

    expect(() => connection.send('{"a":1}')).not.toThrow();
    expect(connection.send('{"b":2}')).toBe(false);
  });

  /**
   * And a closed socket refuses quietly, without a second close.
   *
   * Every teardown path in this system is idempotent on purpose (rule 4), and
   * this is the smallest instance of it: a write to a socket that is already
   * gone is ordinary, not exceptional.
   */
  it('refuses a write to a socket that is no longer open, without closing it again', () => {
    const socket = fakeSocket(0);
    socket.readyState = 3; // CLOSED
    const connection = connectionWith(socket);

    expect(connection.send('{"late":true}')).toBe(false);
    expect(socket.sent).toHaveLength(0);
    expect(socket.closes).toHaveLength(0);
  });

  /**
   * The limit is configuration, not a constant, and the test reads it from the
   * same place the code does — so raising `MAX_BUFFERED_BYTES` for a
   * deployment with slower clients does not silently stop this being tested.
   */
  it('takes its threshold from MAX_BUFFERED_BYTES', () => {
    const generous = config({ MAX_BUFFERED_BYTES: '1000000' });
    const socket = fakeSocket(200_000);

    // The same buffer that was fatal above is fine here.
    expect(connectionWith(socket, generous).send('{"ok":true}')).toBe(true);
    expect(socket.closes).toHaveLength(0);
  });
});
