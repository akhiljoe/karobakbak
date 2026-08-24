import { describe, expect, it } from 'vitest';

import {
  AGE_GATE_VERSION,
  acknowledgeAge,
  clearAgeAcknowledgement,
  hasAcknowledgedAge,
} from './agegate';
import { hasLegalLinks, loadClientConfig } from './config';

/** An in-memory `Storage`, so nothing here depends on a browser. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

/** Storage that throws on every access, as a blocked or private-mode browser does. */
function hostileStorage(): Storage {
  const boom = (): never => {
    throw new Error('storage is not available');
  };
  return {
    get length(): number {
      return boom();
    },
    clear: boom,
    getItem: boom,
    key: boom,
    removeItem: boom,
    setItem: boom,
  };
}

describe('the age acknowledgement', () => {
  it('is not held before anybody has been asked', () => {
    expect(hasAcknowledgedAge(fakeStorage())).toBe(false);
  });

  it('survives a round trip', () => {
    const storage = fakeStorage();
    acknowledgeAge(storage);
    expect(hasAcknowledgedAge(storage)).toBe(true);
  });

  it('can be withdrawn', () => {
    const storage = fakeStorage();
    acknowledgeAge(storage);
    clearAgeAcknowledgement(storage);
    expect(hasAcknowledgedAge(storage)).toBe(false);
  });

  /**
   * The whole reason the record is versioned rather than dated.
   *
   * Re-asking on a schedule is theatre — the same person presses the same
   * button. Re-asking when the *wording* changed tracks what was actually
   * agreed to, and it is the only re-ask that means anything.
   */
  it('is not carried over to different wording', () => {
    const storage = fakeStorage();
    acknowledgeAge(storage);
    expect(hasAcknowledgedAge(storage)).toBe(true);

    storage.setItem(
      'karobakbak.agegate.v1',
      JSON.stringify({ version: AGE_GATE_VERSION + 1 }),
    );
    expect(hasAcknowledgedAge(storage)).toBe(false);
  });

  /**
   * A record from a *newer* build than this one — a rolled-back deployment, a
   * tab open across a release — agreed to wording this build cannot show. It is
   * therefore not an acknowledgement of what is on the screen now, which is why
   * the comparison is equality rather than `>=`.
   */
  it('is not carried backwards from a newer build either', () => {
    const storage = fakeStorage({
      'karobakbak.agegate.v1': JSON.stringify({ version: AGE_GATE_VERSION + 5 }),
    });
    expect(hasAcknowledgedAge(storage)).toBe(false);
  });

  it('treats a malformed record as never having been asked', () => {
    for (const raw of ['not json', 'null', '[]', '{}', '{"version":"1"}']) {
      const storage = fakeStorage({ 'karobakbak.agegate.v1': raw });
      expect(hasAcknowledgedAge(storage)).toBe(false);
    }
  });

  /**
   * Fails towards showing the gate.
   *
   * A private window or blocked site data means the acknowledgement cannot be
   * remembered. Asking again costs a returning user one interruption; silently
   * skipping it would remove the only control that exists.
   */
  it('shows the gate when storage cannot be read at all', () => {
    expect(hasAcknowledgedAge(hostileStorage())).toBe(false);
    expect(hasAcknowledgedAge(undefined)).toBe(false);
  });

  it('does not throw when the acknowledgement cannot be written', () => {
    acknowledgeAge(hostileStorage());
    clearAgeAcknowledgement(hostileStorage());
    // Nothing is stored, so the person is asked again next time — which is the
    // documented behaviour, not a failure.
    expect(hasAcknowledgedAge(hostileStorage())).toBe(false);
  });
});

describe('the legal links the gate depends on', () => {
  it('are absent by default, because they are per deployment', () => {
    const config = loadClientConfig({});
    expect(config.legal.termsUrl).toBe('');
    expect(config.legal.privacyUrl).toBe('');
    expect(hasLegalLinks(config)).toBe(false);
  });

  it('are read from the environment', () => {
    const config = loadClientConfig({
      VITE_TERMS_URL: 'https://example.test/terms',
      VITE_PRIVACY_URL: 'https://example.test/privacy',
    });
    expect(hasLegalLinks(config)).toBe(true);
  });

  /**
   * Both or neither. One link present and the other missing leaves the gate
   * citing a document that cannot be opened, which is worse than a gate that
   * admits the links are missing.
   */
  it('are not satisfied by only one of the two', () => {
    expect(hasLegalLinks(loadClientConfig({ VITE_TERMS_URL: 'https://example.test/terms' }))).toBe(
      false,
    );
    expect(
      hasLegalLinks(loadClientConfig({ VITE_PRIVACY_URL: 'https://example.test/privacy' })),
    ).toBe(false);
  });
});
