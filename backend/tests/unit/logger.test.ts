import { createLogger, errorFields } from '../../src/logger';

function capture(options: Parameters<typeof createLogger>[0] = { level: 'debug' }) {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    ...options,
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

describe('logger', () => {
  it('emits one JSON object per line with level, message and timestamp', () => {
    const { logger, lines } = capture();
    logger.info('session opened', { sessionId: 's_abc' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'session opened', sessionId: 's_abc' });
    expect(typeof lines[0]!.ts).toBe('string');
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

  it('throws in strict mode when a field could carry chat content', () => {
    const { logger } = capture({ level: 'debug', strict: true });
    expect(() => logger.info('inbound', { text: 'private message' })).toThrow(/forbidden field/);
    expect(() => logger.info('inbound', { payload: { text: 'private' } })).toThrow(/forbidden field/);
    expect(() => logger.info('upgrade', { ip: '203.0.113.7' })).toThrow(/forbidden field/);
    expect(() => logger.child({ text: 'nope' })).toThrow(/forbidden field/);
  });

  it('redacts rather than throws when not strict, and never emits the value', () => {
    const { logger, lines } = capture({ level: 'debug', strict: false });
    logger.info('inbound', { text: 'private message', sessionId: 's_1' });
    expect(lines[0]).toMatchObject({ text: '[redacted]', sessionId: 's_1' });
    expect(JSON.stringify(lines[0])).not.toContain('private message');
  });

  it('allows the operational fields the system actually logs', () => {
    const { logger, lines } = capture({ level: 'debug', strict: true });
    logger.info('match created', {
      sessionId: 's_1',
      matchId: 'm_1',
      ipHash: 'deadbeef',
      bytes: 128,
      route: 'remote',
    });
    expect(lines[0]).toMatchObject({ matchId: 'm_1', ipHash: 'deadbeef', route: 'remote' });
  });

  it('survives non-serialisable fields instead of crashing the process', () => {
    const { logger, lines } = capture();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger.error('boom', { circular })).not.toThrow();
    expect(lines[0]).toMatchObject({ level: 'error', msg: 'boom', logError: expect.any(String) });
  });

  it('extracts error name, message and stack into fields', () => {
    const fields = errorFields(new TypeError('bad thing'));
    expect(fields).toMatchObject({ err: 'TypeError', errMsg: 'bad thing' });
    expect(typeof fields.stack).toBe('string');

    expect(errorFields('plain string')).toEqual({ err: 'UnknownError', errMsg: 'plain string' });
  });
});
