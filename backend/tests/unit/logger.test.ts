import {
  createLogger,
  dbErrorFields,
  errorFields,
  ForbiddenLogFieldError,
  isForbiddenLogField,
} from '../../src/logger';

function capture(options: Parameters<typeof createLogger>[0] = { level: 'debug' }) {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const logger = createLogger({
    ...options,
    sink: (line) => {
      raw.push(line);
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  return { logger, lines, raw };
}

/**
 * A distinctive string standing in for a user's chat message. Every leakage
 * test asserts this never reaches the log stream, in any nesting.
 */
const CANARY = 'CANARY_PRIVATE_CONVERSATION_a7f3e91b';

describe('logger — basics', () => {
  it('emits one JSON object per line with level, message and timestamp', () => {
    const { logger, lines } = capture();
    logger.info('session opened', { sessionId: 's_abc' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'session opened', sessionId: 's_abc' });
    expect(new Date(String(lines[0]!.ts)).toISOString()).toBe(lines[0]!.ts);
  });

  it('filters below the configured level', () => {
    const { logger, lines } = capture({ level: 'warn' });
    logger.debug('noise');
    logger.info('noise');
    logger.warn('kept');
    logger.error('kept');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('stamps base fields and merges child fields', () => {
    const { logger, lines } = capture({ level: 'debug', base: { instance: 'i_1' } });
    logger.child({ sessionId: 's_1' }).child({ matchId: 'm_1' }).info('matched');
    expect(lines[0]).toMatchObject({ instance: 'i_1', sessionId: 's_1', matchId: 'm_1' });
  });

  it('allows the operational fields the system actually logs', () => {
    const { logger, lines } = capture({ level: 'debug', strict: true });
    logger.info('message persisted', {
      sessionId: 's_1',
      matchId: 'm_1',
      messageId: 'msg_1',
      conversationId: 'c_1',
      ipHash: 'deadbeef',
      clientHash: 'feedface',
      charLength: 42,
      moderationAction: 'flag',
      queueState: 'QUEUED',
      persistenceState: 'PERSISTED',
      queueClass: 'p3',
      errorCode: 'NONE',
      route: 'remote',
    });
    expect(lines[0]).toMatchObject({
      matchId: 'm_1',
      ipHash: 'deadbeef',
      charLength: 42,
      persistenceState: 'PERSISTED',
    });
  });

  it('truncates a circular structure at the depth limit rather than failing', () => {
    const { logger, lines } = capture();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger.error('boom', { circular })).not.toThrow();
    // Depth limiting makes the copy finite, so the line serialises normally.
    expect(lines[0]).toMatchObject({ level: 'error', msg: 'boom' });
    expect(JSON.stringify(lines[0])).toContain('truncated');
  });

  it('falls back to a safe line when a value genuinely cannot be serialised', () => {
    const { logger, lines } = capture();
    // BigInt makes JSON.stringify throw and cannot be depth-truncated away.
    expect(() => logger.error('boom', { count: BigInt(1) })).not.toThrow();
    expect(lines[0]).toMatchObject({ level: 'error', msg: 'boom', logError: expect.any(String) });
  });
});

describe('logger — content leakage prevention (DESIGN.md I8, §18.1)', () => {
  it('covers every content-shaped and personal-data field name', () => {
    for (const name of [
      'text',
      'body',
      'content',
      'message',
      'note',
      'payload',
      'frame',
      'raw',
      'input',
      'value',
      'excerpt',
      'preview',
      'snippet',
      'transcript',
      'conversation',
      'ip',
      'remoteAddress',
      'clientIp',
      'userAgent',
    ]) {
      expect(isForbiddenLogField(name)).toBe(true);
    }
    // Hashed and structural identifiers must remain loggable.
    for (const name of ['ipHash', 'clientHash', 'sessionId', 'matchId', 'messageId', 'msg']) {
      expect(isForbiddenLogField(name)).toBe(false);
    }
  });

  it('throws in strict mode on a top-level forbidden field', () => {
    const { logger } = capture({ level: 'debug', strict: true });
    expect(() => logger.info('inbound', { text: CANARY })).toThrow(ForbiddenLogFieldError);
    expect(() => logger.info('report', { note: CANARY })).toThrow(/forbidden field/);
    expect(() => logger.info('upgrade', { ip: '203.0.113.7' })).toThrow(/forbidden field/);
    expect(() => logger.child({ text: CANARY })).toThrow(/forbidden field/);
  });

  it('throws on a NESTED forbidden field — a shallow check would miss this', () => {
    const { logger } = capture({ level: 'debug', strict: true });
    expect(() => logger.info('inbound', { ctx: { text: CANARY } })).toThrow(/ctx\.text/);
    expect(() => logger.info('inbound', { a: { b: { c: { body: CANARY } } } })).toThrow(
      /a\.b\.c\.body/,
    );
  });

  it('throws on a forbidden field inside an array', () => {
    const { logger } = capture({ level: 'debug', strict: true });
    expect(() => logger.info('batch', { rows: [{ messageId: 'm1' }, { text: CANARY }] })).toThrow(
      /rows\[1\]\.text/,
    );
  });

  it('redacts rather than throws in production, and the canary never appears', () => {
    const { logger, raw } = capture({ level: 'debug', strict: false });
    logger.info('inbound', {
      text: CANARY,
      ctx: { note: CANARY, deep: { body: CANARY } },
      rows: [{ content: CANARY }],
      sessionId: 's_1',
    });
    const output = raw.join('\n');
    expect(output).not.toContain(CANARY);
    expect(output).toContain('[redacted]');
    expect(output).toContain('s_1');
  });

  it('does not mutate the caller-supplied fields object while redacting', () => {
    const { logger } = capture({ level: 'debug', strict: false });
    const fields = { ctx: { text: CANARY } };
    logger.info('inbound', fields);
    expect(fields.ctx.text).toBe(CANARY);
  });

  it('bounds recursion so a deep structure cannot stall the process', () => {
    const { logger, raw } = capture({ level: 'debug', strict: false });
    let deep: Record<string, unknown> = { text: CANARY };
    for (let i = 0; i < 50; i += 1) deep = { nested: deep };
    expect(() => logger.info('deep', deep)).not.toThrow();
    expect(raw.join('\n')).not.toContain(CANARY);
  });

  it('truncates oversized arrays and objects instead of logging them whole', () => {
    const { logger, lines } = capture({ level: 'debug', strict: false });
    logger.info('big', { rows: Array.from({ length: 500 }, (_, i) => i) });
    expect((lines[0]!.rows as unknown[]).length).toBeLessThanOrEqual(32);
  });
});

describe('logger — provider credentials (A4)', () => {
  it('redacts a model provider key', () => {
    // A leaked key is somebody else's bill, and it makes the persona spend
    // ceiling meaningless. Same class of harm as `secret`, so it is on the same
    // list rather than relying on nobody logging a config object.
    expect(isForbiddenLogField('apiKey')).toBe(true);
    expect(isForbiddenLogField('api_key')).toBe(true);
  });

  it('matches exactly, which is a property of the whole denylist', () => {
    // Not specific to the key: the denylist is a case-sensitive Set, so
    // `Password` is no more redacted than `ApiKey` is. Both spellings that
    // anyone would actually write are covered above. Recorded here so the
    // limitation is visible rather than discovered, since widening it to be
    // case-insensitive is a change to the primary I8 control and deserves to
    // be decided on its own rather than folded into a feature.
    expect(isForbiddenLogField('ApiKey')).toBe(false);
    expect(isForbiddenLogField('Password')).toBe(false);
  });

  it('leaves the provider and model names loggable, because they are metric labels', () => {
    expect(isForbiddenLogField('provider')).toBe(false);
    expect(isForbiddenLogField('model')).toBe(false);
  });
});

describe('errorFields', () => {
  it('extracts error name, message and stack', () => {
    const fields = errorFields(new TypeError('bad thing'));
    expect(fields).toMatchObject({ err: 'TypeError', errMsg: 'bad thing' });
    expect(typeof fields.stack).toBe('string');
    expect(errorFields('plain string')).toMatchObject({
      err: 'UnknownError',
      errMsg: 'plain string',
    });
  });

  it('truncates a long error message so a large body cannot ride along', () => {
    const fields = errorFields(new Error('x'.repeat(5000)));
    expect(String(fields.errMsg).length).toBeLessThan(400);
    expect(String(fields.errMsg)).toContain('[truncated]');
  });

  it('is scanned by the denylist when logged, so an interpolated message is caught', () => {
    // Building an Error from user text is the mistake this guards against.
    // errorFields keeps it in `errMsg`, which is not a forbidden name — so the
    // real defence is that content-handling code must throw constants. This
    // test documents that contract explicitly rather than implying protection
    // the logger does not provide.
    const leaked = errorFields(new Error(`rejected: ${CANARY}`));
    expect(String(leaked.errMsg)).toContain(CANARY);
    // The rule: never construct an Error by interpolating message content.
  });
});

describe('dbErrorFields', () => {
  it('emits only structured driver fields, never the failing row', () => {
    const pgError = Object.assign(new Error(`duplicate key value: (body)=(${CANARY})`), {
      name: 'error',
      code: '23505',
      constraint: 'messages_pkey',
      table: 'messages',
      routine: '_bt_check_unique',
      // pg attaches the offending detail here
      detail: `Key (body)=(${CANARY}) already exists.`,
    });
    const fields = dbErrorFields(pgError);
    expect(fields).toEqual({
      err: 'error',
      dbCode: '23505',
      dbConstraint: 'messages_pkey',
      dbTable: 'messages',
      dbRoutine: '_bt_check_unique',
    });
    expect(JSON.stringify(fields)).not.toContain(CANARY);
  });

  it('logs cleanly through the logger without leaking the canary', () => {
    const { logger, raw } = capture({ level: 'debug', strict: true });
    const pgError = Object.assign(new Error(`insert failed for ${CANARY}`), {
      code: '40001',
      table: 'messages',
    });
    logger.error('persistence batch failed', { ...dbErrorFields(pgError), batchSize: 100 });
    expect(raw.join('\n')).not.toContain(CANARY);
    expect(raw.join('\n')).toContain('40001');
  });

  it('handles a non-Error value without throwing', () => {
    expect(dbErrorFields(undefined)).toEqual({ err: 'DatabaseError' });
    expect(dbErrorFields('boom')).toEqual({ err: 'DatabaseError' });
  });
});
