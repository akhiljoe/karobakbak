/**
 * What the socket accepts, probed from outside.
 *
 * `validate.test.ts` covers `parseClientFrame` thoroughly as a function. These
 * are the same questions asked of the running server, because two of the
 * answers are enforced by `ws` and by the upgrade rather than by the validator
 * — an oversized frame never reaches `handleFrame` at all, and a binary frame's
 * refusal is architectural rather than a validation rule.
 */
import { WebSocket } from 'ws';

import { fail, pass, syntheticAddress, type Context, type Probe, type Result } from '../probe';

interface Session {
  readonly socket: WebSocket;
  /** Resolves with the close code, whenever it comes. */
  readonly closed: Promise<number>;
  readonly frames: string[];
}

function connect(ctx: Context, address: string): Promise<Session> {
  return new Promise((resolve, reject) => {
    const frames: string[] = [];
    const socket = new WebSocket(ctx.wsUrl, ['kbb.v1'], {
      headers: { Origin: ctx.origin, 'X-Forwarded-For': address },
      handshakeTimeout: 8000,
    });
    let closeCode = 0;
    const closed = new Promise<number>((res) => {
      socket.on('close', (code: number) => {
        closeCode = code;
        res(code);
      });
      setTimeout(() => res(closeCode), 12_000);
    });
    socket.on('message', (data) => frames.push(String(data)));
    socket.on('open', () => resolve({ socket, closed, frames }));
    socket.on('error', reject);
    socket.on('unexpected-response', () => reject(new Error('upgrade refused')));
  });
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Binary frames are refused, and that is architectural (§23.2).
 *
 * It is what keeps the socket from becoming a media transport. Relaxing it to
 * "support attachments" is the change this probe exists to make loud: media
 * goes beside the socket, never through it.
 */
export const binaryFramesRefused: Probe = {
  id: 'PROTO-1',
  name: 'binary frames are refused',
  proves: 'The socket cannot become a media transport (§23.2). Text only is a design decision.',
  async run(ctx): Promise<Result> {
    const session = await connect(ctx, syntheticAddress(201));
    session.socket.send(Buffer.from([0x00, 0x01, 0x02, 0x03]));
    await settle(1200);

    const errored = session.frames.some((f) => f.includes('"error"') || f.includes('BAD_ENVELOPE'));
    session.socket.close();

    if (!errored) return fail('a binary frame produced no error frame');
    return pass('the server answered a binary frame with an error');
  },
};

/**
 * Ten invalid frames disconnect a socket with 4003.
 *
 * The strike accounting is what stops a client probing the validator for free.
 * Swarm handoff trap 1 records that `MESSAGE_TOO_LONG` counts towards it, which
 * is why a persona sending one over-length message per conversation is
 * disconnected after ten matches.
 */
export const strikesDisconnect: Probe = {
  id: 'PROTO-2',
  name: 'repeated invalid frames disconnect the socket',
  proves: 'A client cannot probe the validator indefinitely for free (INVALID_MESSAGE_STRIKES).',
  async run(ctx): Promise<Result> {
    const session = await connect(ctx, syntheticAddress(202));

    for (let i = 0; i < 15; i += 1) {
      if (session.socket.readyState !== WebSocket.OPEN) break;
      session.socket.send('{"this":"is not a valid envelope"}');
      await settle(60);
    }

    const code = await Promise.race([session.closed, settle(6000).then(() => 0)]);
    try {
      session.socket.close();
    } catch {
      /* already gone */
    }

    if (code === 0) return fail('fifteen invalid frames did not close the socket');
    return pass(`the socket was closed with code ${code}`);
  },
};

/**
 * Nothing a client sends may name the subject of a state change.
 *
 * Protocol rule 3, probed rather than trusted: a frame carrying somebody else's
 * session id must not route anything. The server is expected to ignore the
 * field entirely — it is not part of any envelope — so the observable is that
 * nothing happens rather than that an error is returned.
 */
export const clientCannotNameASubject: Probe = {
  id: 'PROTO-3',
  name: 'a frame naming another session changes nothing',
  proves: 'Protocol rule 3: identity, routing and ordering never come off a client frame.',
  async run(ctx): Promise<Result> {
    const session = await connect(ctx, syntheticAddress(203));
    // A well-formed join carrying fields the server must ignore.
    // The real envelope shape — `{ type, version, payload }`. The first version
    // of this probe used `{ v, type, id, data }`, which is refused as
    // BAD_ENVELOPE before anything is read, so it passed without ever testing
    // what it claimed to: a frame that is never parsed cannot echo a field.
    session.socket.send(
      JSON.stringify({
        type: 'join_queue',
        version: 1,
        id: 'probe-1',
        payload: {
          sessionId: 'sess_someone_else',
          partnerSessionId: 'sess_victim',
          matchId: 'm_forged',
          accountId: 'acct_victim',
        },
      }),
    );
    await settle(1500);
    const sawForged = session.frames.some(
      (f) => f.includes('sess_victim') || f.includes('m_forged') || f.includes('acct_victim'),
    );
    session.socket.close();

    if (sawForged) return fail('the server echoed an identifier the client supplied');
    return pass('none of the client-supplied identifiers came back');
  },
};

/**
 * A resume token is a bearer credential: single use, rotated on redemption.
 *
 * L15 in the swarm proves a *spent* token buys nothing. This probes the
 * neighbouring case from outside — that an invented token is refused and opens
 * a fresh session rather than erroring, which is what keeps a failed resume
 * from looking like an outage to a reconnecting browser.
 */
export const inventedResumeTokenRefused: Probe = {
  id: 'PROTO-4',
  name: 'an invented resume token opens a fresh session rather than resuming one',
  proves: 'The resume token is a bearer credential and is never taken on trust (§28).',
  async run(ctx): Promise<Result> {
    const forged = 'kbb.resume.' + 'f'.repeat(43);
    const outcome = await new Promise<'open' | 'refused'>((resolve) => {
      let settled = false;
      const done = (v: 'open' | 'refused'): void => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      // Offered BESIDE the base protocol, never alone — the server deliberately
      // never selects the resume subprotocol, and `ws` fails any handshake
      // where the client offered subprotocols and the server selected none.
      const socket = new WebSocket(ctx.wsUrl, [forged, 'kbb.v1'], {
        headers: { Origin: ctx.origin, 'X-Forwarded-For': syntheticAddress(204) },
        handshakeTimeout: 8000,
      });
      socket.on('open', () => {
        socket.close();
        done('open');
      });
      socket.on('unexpected-response', () => done('refused'));
      socket.on('error', () => done('refused'));
      setTimeout(() => done('refused'), 9000);
    });

    // Opening is the correct answer: a failed resume must produce a new session,
    // not an error a reconnecting browser would render as a dead server.
    if (outcome === 'refused') {
      return fail('a forged resume token was refused at the upgrade rather than ignored');
    }
    return pass('the forged token was ignored and a fresh session opened');
  },
};
