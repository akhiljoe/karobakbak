import { newIdentityPair, newNickname } from '../../src/ws/identity';

describe('session-scoped nicknames', () => {
  it('uses the nickname each session already has, for both sides', () => {
    // The whole point of the scope: two matches in one session must show the
    // same name, which they can only do if the pairing takes what it is given.
    const { you, partner } = newIdentityPair(undefined, {
      you: 'Gentle Otter',
      partner: 'Copper Panda',
    });
    expect(you.nickname).toBe('Gentle Otter');
    expect(partner.nickname).toBe('Copper Panda');
  });

  it('redraws the arriving side when both sessions hold the same name', () => {
    // `you` is the session that just matched; `partner` was already waiting and
    // has been using that name with other people, so it is the one that stands.
    for (let i = 0; i < 200; i += 1) {
      const { you, partner } = newIdentityPair(undefined, {
        you: 'Gentle Otter',
        partner: 'Gentle Otter',
      });
      expect(partner.nickname).toBe('Gentle Otter');
      expect(you.nickname).not.toBe('Gentle Otter');
    }
  });

  it('redraws both words, so the result never reads as a variant of the other', () => {
    // "Gentle Otter" answered by "Gentle Panda" implies a relationship between
    // two strangers that does not exist.
    for (let i = 0; i < 200; i += 1) {
      const { you } = newIdentityPair(undefined, {
        you: 'Gentle Otter',
        partner: 'Gentle Otter',
      });
      const [adjective, noun] = you.nickname.split(' ');
      expect(adjective).not.toBe('Gentle');
      expect(noun).not.toBe('Otter');
    }
  });

  it('draws a fresh name for a session that has none', () => {
    // A hash that expired between the match and the read. Degraded, not wrong:
    // the conversation still has two usable labels.
    const { you, partner } = newIdentityPair(undefined, { you: null, partner: 'Copper Panda' });
    expect(you.nickname).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(you.nickname).not.toBe('Copper Panda');
    expect(partner.nickname).toBe('Copper Panda');
  });

  it('keeps the colour per match even when the nickname is fixed', () => {
    // The colour deliberately did not follow the nickname into session scope:
    // nickname plus colour is a markedly more distinctive handle than either.
    const colours = new Set(
      Array.from(
        { length: 200 },
        () => newIdentityPair(undefined, { you: 'Gentle Otter', partner: 'Copper Panda' }).you.colour,
      ),
    );
    expect(colours.size).toBeGreaterThan(1);
  });

  it('draws a two-word name that is not a function of anything', () => {
    const names = new Set(Array.from({ length: 200 }, () => newNickname()));
    expect(names.size).toBeGreaterThan(50);
    for (const name of names) expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });
});

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
    expect(Object.keys(you).sort()).toEqual(['colour', 'nickname', 'profile']);
    expect(you.nickname).not.toMatch(/\d/);
    // Nothing declared means null, not an object of nulls: "told us nothing"
    // has one representation downstream.
    expect(you.profile).toBeNull();
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
