import { FakeConnection, silentLogger } from '../helpers/fakes';
import { ConnectionRegistry } from '../../src/ws/registry';

function registry() {
  return new ConnectionRegistry(silentLogger());
}

describe('ConnectionRegistry', () => {
  it('finds a locally attached socket and reports nothing for a remote one', () => {
    const reg = registry();
    const connection = new FakeConnection('s_local');
    reg.add(connection);

    expect(reg.get('s_local')).toBe(connection);
    // A session on another instance is simply absent — the registry answers
    // "is this socket here", not "where is this socket".
    expect(reg.get('s_remote')).toBeUndefined();
    expect(reg.has('s_remote')).toBe(false);
  });

  it('reports its size and its members', () => {
    const reg = registry();
    reg.add(new FakeConnection('s_1'));
    reg.add(new FakeConnection('s_2'));
    expect(reg.size).toBe(2);
    expect(reg.sessionIds().sort()).toEqual(['s_1', 's_2']);
    expect(reg.all()).toHaveLength(2);
  });

  it('hands out a copy, so iterating cannot be disturbed by a concurrent close', () => {
    const reg = registry();
    reg.add(new FakeConnection('s_1'));
    const ids = reg.sessionIds();
    reg.remove('s_1');
    expect(ids).toEqual(['s_1']);
    expect(reg.size).toBe(0);
  });

  it('closes the old socket when a session id somehow repeats', () => {
    const reg = registry();
    const first = new FakeConnection('s_dup');
    const second = new FakeConnection('s_dup');
    reg.add(first);
    reg.add(second);

    // Session ids are server-generated and used once, so this is a bug rather
    // than a race. The old socket is closed rather than orphaned with no way
    // to reach it.
    expect(first.closes).toEqual([{ code: 1011, reason: 'duplicate session' }]);
    expect(reg.get('s_dup')).toBe(second);
  });

  it('tolerates re-adding the same connection', () => {
    const reg = registry();
    const connection = new FakeConnection('s_1');
    reg.add(connection);
    reg.add(connection);
    expect(connection.closes).toEqual([]);
    expect(reg.size).toBe(1);
  });

  it('removes idempotently', () => {
    const reg = registry();
    reg.add(new FakeConnection('s_1'));
    expect(reg.remove('s_1')).toBe(true);
    expect(reg.remove('s_1')).toBe(false);
  });

  it('refuses to evict the session that replaced the one being removed', () => {
    const reg = registry();
    const stale = new FakeConnection('s_reused');
    reg.add(stale);
    const current = new FakeConnection('s_reused');
    reg.add(current);

    // A late close handler for the previous connection must not take down the
    // one that replaced it.
    expect(reg.remove('s_reused', stale)).toBe(false);
    expect(reg.get('s_reused')).toBe(current);
    expect(reg.remove('s_reused', current)).toBe(true);
  });

  it('clears everything, for shutdown', () => {
    const reg = registry();
    reg.add(new FakeConnection('s_1'));
    reg.add(new FakeConnection('s_2'));
    reg.clear();
    expect(reg.size).toBe(0);
  });
});
