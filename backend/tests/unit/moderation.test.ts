/**
 * Moderation: the view, the rules, the policy table, and the boundary.
 */
import { moderate, moderationView, RULE_IDS } from '../../src/moderation';
import { evaluateText, type ModerationPolicy } from '../../src/moderation/policy';
import { RULES } from '../../src/moderation/rules';

function policy(overrides: Partial<ModerationPolicy> = {}): ModerationPolicy {
  return {
    enabled: true,
    defaultAction: 'flag',
    hardBlockRules: [],
    detectContact: true,
    denyList: [],
    ...overrides,
  };
}

function flagsFor(text: string, overrides: Partial<ModerationPolicy> = {}): readonly string[] {
  return evaluateText(moderationView(text), policy(overrides)).flags;
}

describe('the moderation view', () => {
  it('leaves ordinary text recognisable', () => {
    expect(moderationView('  Hello there, how are you?  ')).toBe('Hello there, how are you?');
  });

  it('preserves case', () => {
    // A base58 crypto address is case-sensitive, and lowercasing the view
    // would make it indistinguishable from a long ordinary word.
    expect(moderationView('HeLLo')).toBe('HeLLo');
  });

  it('strips invisible characters used to break substring rules', () => {
    const zeroWidth = `ex${'​'}am${'‍'}ple`;
    expect(moderationView(zeroWidth)).toBe('example');
    expect(moderationView(`a${'﻿'}b${'­'}c`)).toBe('abc');
    // Bidirectional overrides reorder how a string reads without changing it.
    expect(moderationView(`x${'‮'}y`)).toBe('xy');
  });

  it('folds homoglyphs that NFKC leaves alone', () => {
    // Cyrillic "о" and "а" — visually identical, different code points.
    expect(moderationView('gооgle.cоm')).toBe('google.com');
    expect(moderationView('раypal')).toBe('paypal');
  });

  it('applies NFKC, so fullwidth and compatibility forms collapse', () => {
    expect(moderationView('ｅｘａｍｐｌｅ.ｃｏｍ')).toBe('example.com');
  });

  it('undoes written-out separators', () => {
    expect(moderationView('example (dot) com')).toBe('example.com');
    expect(moderationView('example [dot] com')).toBe('example.com');
    expect(moderationView('example dot com')).toBe('example.com');
    expect(moderationView('me (at) example.com')).toBe('me@example.com');
  });

  it('closes spaces around dots', () => {
    expect(moderationView('t . me / joinchat')).toBe('t.me / joinchat');
  });

  it('collapses whitespace', () => {
    expect(moderationView('a   b\n\nc\td')).toBe('a b c d');
  });

  it('is a derived value, not a replacement for the message', () => {
    // The user's own words are what get delivered and retained; mutating text
    // that is later read back as evidence corrupts the evidence.
    const original = 'Hello   (dot)   world';
    moderationView(original);
    expect(original).toBe('Hello   (dot)   world');
  });
});

describe('rules', () => {
  it('flags explicit URLs, bare domains, www prefixes and IP literals', () => {
    expect(flagsFor('check https://example.com/thing')).toContain('url');
    expect(flagsFor('go to example.com')).toContain('url');
    expect(flagsFor('www.example.org')).toContain('url');
    expect(flagsFor('connect to 192.168.1.10')).toContain('url');
    expect(flagsFor('find me at abcd.onion')).toContain('url');
  });

  it('sees through obfuscated domains', () => {
    expect(flagsFor('example (dot) com')).toContain('url');
    expect(flagsFor('example . com')).toContain('url');
    expect(flagsFor(`exa${'​'}mple.com`)).toContain('url');
    expect(flagsFor('gооgle.com')).toContain('url');
  });

  it('does not turn ordinary sentences into URLs', () => {
    // The view joins words across dots, so a generic \.[a-z]{2,} pattern would
    // flag most sentences. The TLD allowlist is what stops that.
    for (const sentence of [
      'ok.thanks',
      'I agree. That works for me.',
      'no way. really?',
      'hello there how are you',
      'end. Next question.',
    ]) {
      expect(flagsFor(sentence)).not.toContain('url');
    }
  });

  it('flags email addresses', () => {
    expect(flagsFor('write to me@example.com')).toContain('email');
    expect(flagsFor('me (at) example (dot) com')).toContain('email');
  });

  it('flags phone numbers but not short digit runs', () => {
    expect(flagsFor('call 07700 900123')).toContain('phone');
    expect(flagsFor('+1 (555) 123-4567')).toContain('phone');
    expect(flagsFor('I am 25 and live in flat 3b')).not.toContain('phone');
    expect(flagsFor('see you at 7')).not.toContain('phone');
  });

  it('flags social handles and platform names', () => {
    expect(flagsFor('add @some.handle')).toContain('social_handle');
    expect(flagsFor('my snapchat is open')).toContain('social_handle');
    expect(flagsFor('are you on telegram')).toContain('social_handle');
  });

  it('flags invite links', () => {
    expect(flagsFor('join discord.gg/abcd')).toContain('invite_link');
    expect(flagsFor('t.me/somechannel')).toContain('invite_link');
    expect(flagsFor('chat.whatsapp.com/xyz')).toContain('invite_link');
  });

  it('flags crypto addresses', () => {
    expect(flagsFor('send to 0x52908400098527886E0F7030069857D2E4169EE7')).toContain(
      'crypto_address',
    );
    expect(flagsFor('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toContain('crypto_address');
    expect(flagsFor('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toContain('crypto_address');
  });

  it('flags off-platform contact solicitation', () => {
    expect(flagsFor('dm me')).toContain('contact_solicitation');
    expect(flagsFor('hmu')).toContain('contact_solicitation');
    expect(flagsFor('add me on discord')).toContain('contact_solicitation');
    expect(flagsFor("let's move to telegram")).toContain('contact_solicitation');
  });

  it('applies a configured deny list, case-insensitively and whole-word', () => {
    expect(flagsFor('this is a badword here', { denyList: ['badword'] })).toContain('deny_list');
    expect(flagsFor('BADWORD', { denyList: ['badword'] })).toContain('deny_list');
    // Not a substring match: "classic" must not fire on "ass".
    expect(flagsFor('a classic problem', { denyList: ['ass'] })).not.toContain('deny_list');
  });

  it('treats a deny-list term as text, never as a pattern', () => {
    // An operator writing a term with regex characters must not accidentally
    // build a pattern that matches everything.
    expect(flagsFor('anything at all', { denyList: ['.*'] })).not.toContain('deny_list');
    expect(flagsFor('nothing to see', { denyList: ['(a|b)+'] })).not.toContain('deny_list');
    // The escaped term still matches itself literally.
    expect(flagsFor('I write c++ daily', { denyList: ['c++'] })).toContain('deny_list');
    expect(flagsFor('I write ccc daily', { denyList: ['c++'] })).not.toContain('deny_list');
  });

  it('turns off every contact rule as a group when configured to', () => {
    const off = { detectContact: false };
    for (const text of ['example.com', 'me@example.com', 'call 07700 900123', 'dm me']) {
      expect(flagsFor(text, off)).toEqual([]);
    }
    // The deny list is not part of that group.
    expect(flagsFor('badword', { ...off, denyList: ['badword'] })).toEqual(['deny_list']);
  });

  it('reports every rule that fired, not just the first', () => {
    const flags = flagsFor('dm me at me@example.com or example.com');
    expect(flags).toEqual(expect.arrayContaining(['email', 'url', 'contact_solicitation']));
  });

  it('never returns what it matched', () => {
    // Flags travel into logs, metric labels and stored rows; the matched
    // fragment is the part of a message most likely to be personal (I8).
    const flags = flagsFor('my number is +1 555 123 4567 and my email is me@example.com');
    for (const flag of flags) {
      expect(RULE_IDS).toContain(flag);
      expect(flag).not.toMatch(/\d/);
      expect(flag).not.toContain('@');
    }
  });

  it('has a declared severity for every rule', () => {
    for (const rule of RULES) {
      expect(['low', 'medium', 'high']).toContain(rule.severity);
    }
    expect(new Set(RULE_IDS).size).toBe(RULE_IDS.length);
  });
});

describe('policy (D20)', () => {
  it('allows a clean message with no flags at all', () => {
    expect(evaluateText(moderationView('how is your day going'), policy())).toEqual({
      action: 'allow',
      flags: [],
      severity: null,
      deliverable: true,
    });
  });

  it('flags and still delivers, by default', () => {
    // The security document's position: classifiers produce signals, not
    // verdicts. A false positive here would be a person told they cannot say
    // something they are allowed to say.
    const result = evaluateText(moderationView('visit example.com'), policy());
    expect(result.action).toBe('flag');
    expect(result.deliverable).toBe(true);
  });

  it('withholds without delivering when configured to', () => {
    const result = evaluateText(
      moderationView('visit example.com'),
      policy({ defaultAction: 'withhold' }),
    );
    expect(result.action).toBe('withhold');
    expect(result.deliverable).toBe(false);
  });

  it('escalates a named rule to a block, leaving the others flagged', () => {
    const hard = policy({ hardBlockRules: ['crypto_address'] });
    expect(evaluateText(moderationView('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'), hard)).toMatchObject({
      action: 'block',
      deliverable: false,
    });
    expect(evaluateText(moderationView('visit example.com'), hard)).toMatchObject({
      action: 'flag',
      deliverable: true,
    });
  });

  it('reports the highest severity among the rules that fired', () => {
    // contact_solicitation is low, email is high.
    expect(evaluateText(moderationView('dm me'), policy()).severity).toBe('low');
    expect(evaluateText(moderationView('dm me at me@example.com'), policy()).severity).toBe('high');
  });

  it('allows everything when moderation is disabled', () => {
    const result = evaluateText(
      moderationView('me@example.com bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'),
      policy({ enabled: false, hardBlockRules: ['email'] }),
    );
    expect(result).toMatchObject({ action: 'allow', flags: [], deliverable: true });
  });

  it('maps every action to the right deliverability', () => {
    const table: Array<[ModerationPolicy['defaultAction'], boolean]> = [
      ['flag', true],
      ['withhold', false],
      ['block', false],
    ];
    for (const [action, deliverable] of table) {
      const result = evaluateText(moderationView('example.com'), policy({ defaultAction: action }));
      expect(result.action).toBe(action);
      expect(result.deliverable).toBe(deliverable);
    }
  });
});

describe('the moderation boundary (§23.5)', () => {
  it('is entered by content type, not by a call on the text', () => {
    const result = moderate({ type: 'text', text: 'visit example.com' }, policy());
    expect(result.action).toBe('flag');
  });

  it('fails closed for a content type it does not handle', () => {
    // Unreachable while MessageContentType is exactly 'text'. It stops being
    // unreachable the day a type is added to that union without a branch here,
    // and on that day this must refuse rather than deliver.
    const future = { type: 'image' as never, text: 'a caption' };
    const result = moderate(future, policy());
    expect(result).toMatchObject({
      action: 'block',
      deliverable: false,
      flags: ['unsupported_content_type'],
    });
  });

  it('fails closed even with moderation switched off', () => {
    // Disabling moderation must not become a way to deliver content nobody
    // knows how to judge.
    const result = moderate({ type: 'voice' as never, text: '' }, policy({ enabled: false }));
    expect(result.deliverable).toBe(false);
  });

  it('never coerces an unknown type to text (§23.6)', () => {
    const result = moderate({ type: 'video' as never, text: 'clean text' }, policy());
    // Not { action: 'allow' } — coercing would mean the sender believes a video
    // was delivered when only a caption was.
    expect(result.action).toBe('block');
  });
});
