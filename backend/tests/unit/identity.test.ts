import { newIdentityPair } from '../../src/ws/identity';

describe('per-match identities', () => {
  it('gives the two participants different nicknames and different colours', () => {
    // Guaranteed by construction rather than by luck: sharing either one would
    // make the conversation ambiguous exactly when reading it back matters.
    for (let i = 0; i < 500; i += 1) {
      const { you, partner } = newIdentityPair();
      expect(you.nickname).not.toBe(partner.nickname);
      expect(you.colour).not.toBe(partner.colour);
    }
  });

  it('produces a two-word nickname and a hex colour', () => {
    const { you, partner } = newIdentityPair();
    for (const identity of [you, partner]) {
      expect(identity.nickname).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(identity.colour).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it('carries no session id, match id or counter', () => {
    const { you } = newIdentityPair();
    // Anything derived from an identifier would be stable across matches, and
    // anything stable across matches is a correlation handle (§24.3).
    expect(Object.keys(you).sort()).toEqual(['colour', 'nickname']);
    expect(you.nickname).not.toMatch(/\d/);
  });

  it('is not a stable function of anything — repeated calls differ', () => {
    const pairs = new Set(
      Array.from({ length: 200 }, () => {
        const { you } = newIdentityPair();
        return `${you.nickname}|${you.colour}`;
      }),
    );
    // 32 x 32 nicknames and 8 colours: 200 draws collapsing to a handful would
    // mean the generator is keyed on something.
    expect(pairs.size).toBeGreaterThan(100);
  });
});
