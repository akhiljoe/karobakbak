/**
 * k6 WebSocket load test.
 *
 *   k6 run load-test/websocket.js
 *   k6 run -e VUS=200 -e DURATION=2m load-test/websocket.js
 *   k6 run -e WS_URL=ws://localhost:8081/ws load-test/websocket.js
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MEASURES, AND WHAT IT CANNOT
 * ---------------------------------------------------------------------------
 * Every virtual user is a whole conversation: connect, queue, get matched, send
 * a few messages, skip, repeat. Users are paired *with each other*, which is
 * the only way to load-test a product where a session is worthless without a
 * partner — and it means the numbers are only meaningful with an even, and
 * reasonably large, number of VUs.
 *
 * Matchmaking latency is deliberately **not** given a hard threshold. It is
 * dominated by how many other people happen to be waiting, not by how fast the
 * server is, so a threshold on it would fail for reasons that have nothing to
 * do with the code. What is thresholded is what the server actually controls:
 * whether connections are accepted, whether messages are acknowledged, and how
 * long an acknowledgement takes.
 *
 * ---------------------------------------------------------------------------
 * THE PER-IP CEILING, WHICH IS THE REAL LIMIT ON THIS FILE
 * ---------------------------------------------------------------------------
 * Every VU shares the load generator's single IP, and the abuse controls are
 * per IP: `CONN_RATE_LIMIT` connection attempts per `CONN_RATE_WINDOW_SECONDS`,
 * and `MAX_CONNECTIONS_PER_IP` concurrent sockets. A load generator is exactly
 * the traffic shape those controls exist to refuse, so the defaults here stay
 * inside them — `VUS × (DURATION / iteration)` must not exceed the connection
 * budget, or the run measures the limiter rather than the server.
 *
 * The fix is never to weaken the shipped defaults. For a real capacity run,
 * raise the ceiling on the target stack for the duration of the test:
 *
 *   CONN_RATE_LIMIT=100000 MAX_CONNECTIONS_PER_IP=100000 docker compose up -d
 *   k6 run -e VUS=200 -e DURATION=2m load-test/websocket.js
 *
 * A throttled upgrade is therefore counted as its own thing, not as a connect
 * failure: the server refusing it is correct behaviour. But a run that spends
 * most of its connections being throttled has measured nothing, so that has a
 * threshold of its own.
 */
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { randomString } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const WS_URL = __ENV.WS_URL || 'ws://localhost:8081/ws';
// The profile the shipped per-IP limits permit from one host. Raise both the
// limits and these together; raising these alone measures the limiter.
const VUS = Number(__ENV.VUS || 20);
const DURATION = __ENV.DURATION || '20s';
const MESSAGES_PER_CHAT = Number(__ENV.MESSAGES_PER_CHAT || 5);

const matched = new Counter('kbb_matched');
const messagesSent = new Counter('kbb_messages_sent');
const messagesReceived = new Counter('kbb_messages_received');
const ackLatency = new Trend('kbb_ack_latency_ms', true);
const matchLatency = new Trend('kbb_match_latency_ms', true);
const connectFailures = new Rate('kbb_connect_failures');
/**
 * Upgrades refused by a per-IP abuse control (HTTP 429). Separate from
 * `kbb_connect_failures` because the server is working: it is refusing a single
 * address that asked for too many sockets too quickly, which is its job.
 */
const upgradeThrottled = new Rate('kbb_upgrade_throttled');
const protocolErrors = new Counter('kbb_protocol_errors');
/**
 * Errors that are the *correct* answer under load, counted separately so they
 * stay visible without failing the run.
 *
 * `RATE_LIMITED` is what a test pushing past the configured limits should get.
 * `NOT_MATCHED` is the §10.8 race: a message sent in the instant the partner
 * skipped arrives after the match record is gone. A deleted match can never
 * deliver (I6), so refusing it is the server working, not failing.
 */
const expectedRefusals = new Counter('kbb_expected_refusals');

export const options = {
  vus: VUS,
  duration: DURATION,
  thresholds: {
    // What the server controls.
    kbb_connect_failures: ['rate<0.01'],
    // Not a server fault, but a run mostly spent being throttled has measured
    // the limiter instead of the system. Fails loudly so the profile gets
    // resized rather than the result being read as a capacity number.
    kbb_upgrade_throttled: ['rate<0.10'],
    // An ack is one Redis round trip plus a socket write. If this degrades,
    // something on the hot path has started doing work it should not.
    kbb_ack_latency_ms: ['p(95)<250'],
    kbb_protocol_errors: ['count<1'],
    // A run that connected cleanly and never paired proves nothing at all.
    kbb_matched: ['count>0'],
  },
};

export default function run() {
  const start = Date.now();
  let queuedAt = 0;
  let matchId = null;
  let sent = 0;
  const pending = new Map();

  const response = ws.connect(WS_URL, {}, (socket) => {
    socket.on('open', () => {
      // Nothing is sent until `connected` arrives: the limits and the feature
      // set come from that frame.
    });

    socket.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch {
        protocolErrors.add(1);
        return;
      }

      switch (frame.type) {
        case 'connected':
          queuedAt = Date.now();
          socket.send(JSON.stringify({ type: 'join_queue', version: 1, payload: {} }));
          break;

        case 'matched': {
          matched.add(1);
          matchLatency.add(Date.now() - queuedAt);
          matchId = frame.payload.matchId;
          sendNext(socket);
          break;
        }

        case 'message_ack': {
          const at = pending.get(frame.payload.clientMsgId);
          if (at !== undefined) {
            ackLatency.add(Date.now() - at);
            pending.delete(frame.payload.clientMsgId);
          }
          if (sent < MESSAGES_PER_CHAT) {
            sendNext(socket);
          } else {
            // Skip to the next stranger, which is the loop a real user runs.
            matchId = null;
            sent = 0;
            queuedAt = Date.now();
            socket.send(JSON.stringify({ type: 'skip', version: 1, payload: {} }));
          }
          break;
        }

        case 'message':
          messagesReceived.add(1);
          break;

        case 'partner_skipped':
        case 'partner_disconnected':
          // The partner left first. Get back in the queue rather than idling,
          // so the load stays where it was aimed.
          matchId = null;
          sent = 0;
          queuedAt = Date.now();
          socket.send(JSON.stringify({ type: 'join_queue', version: 1, payload: {} }));
          break;

        case 'error':
          if (frame.payload.code === 'RATE_LIMITED') {
            expectedRefusals.add(1);
          } else if (frame.payload.code === 'NOT_MATCHED') {
            // The partner skipped while this message was in flight. Get back
            // in the queue rather than waiting for an ack that will not come.
            expectedRefusals.add(1);
            matchId = null;
            sent = 0;
            pending.clear();
            queuedAt = Date.now();
            socket.send(JSON.stringify({ type: 'join_queue', version: 1, payload: {} }));
          } else {
            protocolErrors.add(1);
            console.error(`unexpected protocol error: ${frame.payload.code}`);
          }
          break;

        case 'queue_status':
        case 'presence':
        case 'partner_typing':
        case 'pong':
        case 'report_ack':
          break;

        case 'server_shutdown':
          socket.close();
          break;

        default:
          // An unknown frame is not an error: a newer server may send one.
          break;
      }
    });

    socket.on('error', () => {
      connectFailures.add(1);
    });

    // Keep the socket alive for the run, then leave the way a browser tab does.
    socket.setTimeout(() => socket.close(), 25_000);
  });

  // 101 is success; 429 is an abuse control doing its job; anything else is a
  // genuine failure to connect.
  const status = response ? response.status : 0;
  const throttled = status === 429;
  upgradeThrottled.add(throttled);
  connectFailures.add(!throttled && status !== 101);
  if (throttled) expectedRefusals.add(1);
  check(response, {
    'upgrade accepted, or refused by a per-IP limit': () => status === 101 || throttled,
  });

  function sendNext(socket) {
    if (!matchId) return;
    const id = `c_${randomString(12)}`;
    pending.set(id, Date.now());
    sent += 1;
    messagesSent.add(1);
    socket.send(
      JSON.stringify({
        type: 'message',
        version: 1,
        id,
        payload: { text: `load test message ${sent} ${randomString(16)}` },
      }),
    );
  }

  // Pace the reconnect loop so a VU is a user rather than a connection storm —
  // the connection-attempt limiter would refuse it, correctly, and the test
  // would be measuring the limiter.
  sleep(1 + Math.random());
  void start;
}
