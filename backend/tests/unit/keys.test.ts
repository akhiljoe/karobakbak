import { createKeys, UnsafeKeyComponentError } from '../../src/redis/keys';
import { SCRIPTS } from '../../src/redis/scripts';
import { newInstanceId } from '../../src/util/ids';

const keys = createKeys('chat');

describe('key namespace', () => {
  it('builds every documented key from the prefix', () => {
    expect(keys.session('s_1')).toBe('chat:session:s_1');
    expect(keys.sessions()).toBe('chat:sessions');
    expect(keys.queue('default')).toBe('chat:queue:default');
    expect(keys.segments()).toBe('chat:segments');
    expect(keys.match('m_1')).toBe('chat:match:m_1');
    expect(keys.matches()).toBe('chat:matches');
    expect(keys.userMatch('s_1')).toBe('chat:user_match:s_1');
    expect(keys.dedupe('m_1')).toBe('chat:dedupe:m_1');
    expect(keys.rateLimit('message', 's_1')).toBe('chat:rl:message:s_1');
    expect(keys.connRate('abc')).toBe('chat:rl:conn:abc');
    expect(keys.connSessions('abc')).toBe('chat:conn:abc');
    expect(keys.blocks('abc')).toBe('chat:blocks:abc');
    expect(keys.ban('abc')).toBe('chat:ban:abc');
    expect(keys.instance('i_1')).toBe('chat:instance:i_1');
    expect(keys.instances()).toBe('chat:instances');
    expect(keys.janitorLock()).toBe('chat:janitor:lock');
    expect(keys.sessionChannel('s_1')).toBe('chat:ev:session:s_1');
  });

  it('honours a non-default prefix everywhere', () => {
    const other = createKeys('kbb_test');
    expect(other.session('s_1')).toBe('kbb_test:session:s_1');
    expect(other.queue('default')).toBe('kbb_test:queue:default');
    expect(other.sessionChannel('s_1')).toBe('kbb_test:ev:session:s_1');
  });

  it('refuses a component that would escape its namespace', () => {
    // A ':' silently moves the key into a different logical namespace, and a
    // '*' widens any later SCAN MATCH. Neither can reach here today; the guard
    // is what keeps that true.
    expect(() => keys.session('s_1:evil')).toThrow(UnsafeKeyComponentError);
    expect(() => keys.session('s_*')).toThrow(UnsafeKeyComponentError);
    expect(() => keys.session('')).toThrow(UnsafeKeyComponentError);
    expect(() => keys.session('s 1')).toThrow(UnsafeKeyComponentError);
    expect(() => keys.blocks('a'.repeat(129))).toThrow(UnsafeKeyComponentError);
    expect(() => keys.ban('abc:evil')).toThrow(UnsafeKeyComponentError);
    expect(() => createKeys('bad:prefix')).toThrow(UnsafeKeyComponentError);
  });

  it('keeps bans and blocks in separate namespaces', () => {
    // They are answers to different questions — "will these two be matched"
    // against "does this connection happen at all" — and they are written and
    // revoked by different actors. A shared namespace would let a moderator
    // revoking a ban delete a user's own block, or let a user's block refuse an
    // upgrade. The prefixes are what keep the two apart, so assert they differ
    // for the same subject rather than trusting the spelling.
    expect(keys.ban('same')).not.toBe(keys.blocks('same'));
    expect(keys.ban('same').startsWith('chat:ban:')).toBe(true);
    expect(keys.blocks('same').startsWith('chat:blocks:')).toBe(true);
  });

  it('never puts the offending value in the error message', () => {
    // The guard exists for the day a component comes from user input, which is
    // the last thing that should be echoed into an error or a log line.
    const canary = 'CANARY:VALUE';
    try {
      keys.session(canary);
      throw new Error('expected a rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeKeyComponentError);
      expect((err as Error).message).not.toContain('CANARY');
    }
  });

  it('round-trips a session channel and rejects a foreign one', () => {
    expect(keys.sessionIdFromChannel('chat:ev:session:s_abc')).toBe('s_abc');
    expect(keys.sessionIdFromChannel('chat:ev:session:')).toBeNull();
    expect(keys.sessionIdFromChannel('other:ev:session:s_abc')).toBeNull();
    expect(keys.sessionIdFromChannel('chat:sessions')).toBeNull();
    expect(keys.sessionIdFromChannel('chat:ev:session:has:colon')).toBeNull();
  });

  it('accepts a generated instance id, hostname dots and all', () => {
    // newInstanceId feeds chat:instance:{iid} directly, so anything it can
    // produce has to be a legal key component.
    expect(() => keys.instance(newInstanceId())).not.toThrow();
    expect(() => keys.instance(newInstanceId('host.example.com:8080'))).not.toThrow();
    expect(newInstanceId('host.example.com')).toBe('host-example-com');
    expect(newInstanceId('   ')).toMatch(/^i_/);
  });
});

/**
 * The Lua scripts rebuild key names from the prefix they are handed, because a
 * candidate's session key is not knowable before the script reads the queue.
 * That second layout has to match `keys.ts` exactly — if it drifts, the scripts
 * quietly read and write keys nobody else can see, and the janitor never finds
 * them.
 */
describe('Lua key layout matches keys.ts', () => {
  const layouts: Array<[string, string]> = [
    ["kSession(sid)   return P .. ':session:' .. sid", keys.session('SID')],
    ["kSessions()     return P .. ':sessions'", keys.sessions()],
    ["kQueue(seg)     return P .. ':queue:' .. seg", keys.queue('SEG')],
    ["kMatch(mid)     return P .. ':match:' .. mid", keys.match('MID')],
    ["kMatches()      return P .. ':matches'", keys.matches()],
    ["kUserMatch(sid) return P .. ':user_match:' .. sid", keys.userMatch('SID')],
    ["kDedupe(mid)    return P .. ':dedupe:' .. mid", keys.dedupe('MID')],
    ["kBlocks(b)      return P .. ':blocks:' .. b", keys.blocks('B')],
    ["kInstance(iid)  return P .. ':instance:' .. iid", keys.instance('IID')],
    ["kConn(ip)       return P .. ':conn:' .. ip", keys.connSessions('IP')],
  ];

  it.each(layouts)('%s', (luaLine, tsKey) => {
    // Every script carries the same prelude, so checking one is checking all.
    expect(SCRIPTS.tryMatch.source).toContain(luaLine);
    // Derive the infix the Lua builds and assert the TS key uses it too.
    const infix = luaLine.match(/':([a-z_]+):?'/)?.[1];
    expect(infix).toBeDefined();
    expect(tsKey.startsWith(`chat:${infix}`)).toBe(true);
  });
});
