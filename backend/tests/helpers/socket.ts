/**
 * A real server on a real port, and a real WebSocket client, for the socket
 * integration tests.
 *
 * Nothing here fakes the transport: the point of these tests is the code that
 * only runs when there is an actual handshake, an actual frame size limit and
 * an actual close code.
 */
import { WebSocket } from 'ws';

import { createNullLogger } from '../../src/logger';
import { createRedisClients, type RedisClients } from '../../src/redis/client';
import { createChatServer, type ChatServer } from '../../src/server';
import { NullRetentionSink } from '../../src/storage/sink';
import { createMetrics, type Metrics } from '../../src/metrics/registry';
import type { AnyServerEnvelope, ServerEventType } from '../../src/protocol/types';
import { createTestContext, type TestContext } from './redis';
import type { Env } from '../../src/config';

export interface TestServer {
  ctx: TestContext;
  server: ChatServer;
  clients: RedisClients;
  metrics: Metrics;
  /** Every backup report the server accepted, in order. */
  backupReports: boolean[];
  url: string;
  stop(): Promise<void>;
}

/**
 * Start a server bound to an ephemeral port, against a test Redis keyspace.
 * `port: 0` matters — parallel suites must not fight over a fixed one.
 */
export async function startTestServer(overrides: Env = {}): Promise<TestServer> {
  const ctx = await createTestContext({ BACKEND_PORT: '0', BACKEND_HOST: '127.0.0.1', ...overrides });
  const logger = createNullLogger();
  const clients = await createRedisClients(ctx.config, logger);
  await clients.waitUntilReady();
  const metrics = createMetrics(ctx.config, { processMetrics: false });

  const backupReports: boolean[] = [];

  const server = createChatServer({
    onBackupReported: (ok) => backupReports.push(ok),
    config: ctx.config,
    logger,
    store: ctx.store,
    clients,
    // The socket suite is about the transport; the retention path has its own
    // suite against a real database.
    retention: new NullRetentionSink(),
    metrics,
  });
  const port = await server.listen();

  return {
    ctx,
    server,
    clients,
    metrics,
    backupReports,
    url: `ws://127.0.0.1:${port}${ctx.config.http.wsPath}`,
    async stop(): Promise<void> {
      await server.stop();
      await clients.close();
      await ctx.close();
    },
  };
}

/** A connected client that records every frame it received. */
export class TestClient {
  readonly frames: AnyServerEnvelope[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  /** Set-Cookie values from the handshake response. */
  readonly setCookies: string[] = [];
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (data) => {
      this.frames.push(JSON.parse(data.toString()) as AnyServerEnvelope);
    });
    socket.on('close', (code, reason) => {
      this.closes.push({ code, reason: reason.toString() });
    });
    socket.on('upgrade', (res) => {
      const header = res.headers['set-cookie'];
      if (Array.isArray(header)) this.setCookies.push(...header);
      else if (typeof header === 'string') this.setCookies.push(header);
    });
    // A test client that throws on a socket error would fail the test with the
    // wrong message; the close code is what these tests assert on.
    socket.on('error', () => undefined);
  }

  static async connect(
    url: string,
    options: {
      headers?: Record<string, string>;
      maxPayload?: number;
      /** Subprotocols to offer, as a browser would. */
      protocols?: string[];
    } = {},
  ): Promise<TestClient> {
    const socket =
      options.protocols === undefined
        ? new WebSocket(url, {
            headers: options.headers,
            maxPayload: options.maxPayload ?? 10 * 1024 * 1024,
          })
        : new WebSocket(url, options.protocols, {
            headers: options.headers,
            maxPayload: options.maxPayload ?? 10 * 1024 * 1024,
          });
    const client = new TestClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', (err) => reject(err));
    });
    return client;
  }

  /** Connect expecting a refusal, and return the HTTP status the server sent. */
  static async expectRefusal(
    url: string,
    options: { headers?: Record<string, string>; protocols?: string[] } = {},
  ): Promise<{ status: number; body: string }> {
    const socket =
      options.protocols === undefined
        ? new WebSocket(url, { headers: options.headers })
        : new WebSocket(url, options.protocols, { headers: options.headers });
    return new Promise((resolve, reject) => {
      let status = 0;
      socket.on('unexpected-response', (_req, res) => {
        status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          socket.terminate();
          resolve({ status, body: Buffer.concat(chunks).toString() });
        });
      });
      socket.on('open', () => {
        socket.close();
        reject(new Error('expected the upgrade to be refused'));
      });
      socket.on('error', (err) => {
        if (status === 0) reject(err);
      });
    });
  }

  send(frame: unknown): void {
    this.socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  /** Send a command in the ordinary envelope shape. */
  command(type: string, payload: Record<string, unknown> = {}, id?: string): void {
    const envelope: Record<string, unknown> = { type, version: 1, payload };
    if (id !== undefined) envelope.id = id;
    this.send(envelope);
  }

  sendBinary(bytes: Buffer): void {
    this.socket.send(bytes, { binary: true });
  }

  /** Wait for the next frame of a type, or throw with what did arrive. */
  async next(type: ServerEventType, timeoutMs = 2000): Promise<AnyServerEnvelope> {
    const seen = this.frames.filter((frame) => frame.type === type).length;
    return this.waitFor(() => {
      const matches = this.frames.filter((frame) => frame.type === type);
      return matches.length > seen ? matches[matches.length - 1] : undefined;
    }, `frame ${type}`, timeoutMs);
  }

  /** Wait for a frame of a type, counting ones already received. */
  async waitForFrame(type: ServerEventType, timeoutMs = 2000): Promise<AnyServerEnvelope> {
    return this.waitFor(
      () => this.frames.find((frame) => frame.type === type),
      `frame ${type}`,
      timeoutMs,
    );
  }

  async waitForClose(timeoutMs = 2000): Promise<{ code: number; reason: string }> {
    return this.waitFor(() => this.closes[0], 'close', timeoutMs);
  }

  close(): void {
    this.socket.close();
  }

  terminate(): void {
    this.socket.terminate();
  }

  private async waitFor<T>(
    probe: () => T | undefined,
    what: string,
    timeoutMs: number,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = probe();
      if (value !== undefined) return value;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${what}; received: ${this.frames.map((f) => f.type).join(', ') || 'nothing'}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** Payload of a received frame, narrowed by the caller. */
export function payloadOf<T = Record<string, unknown>>(frame: AnyServerEnvelope): T {
  return frame.payload as T;
}
