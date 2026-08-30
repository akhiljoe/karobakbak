/**
 * What the navigation shows, and what brings it back.
 *
 * Premium and the support page are hidden while `PAYMENTS_ENABLED` is false, and
 * the requirement is not "hidden" — it is **hidden and reversible**. Nothing was
 * deleted, so the thing worth testing is the half that is easy to get wrong: the
 * flag turning both back on, and the footer link swinging back from the external
 * page to the internal one.
 *
 * `vi.resetModules()` before each import is what makes that testable. Both
 * `features.ts` and `config.ts` are read at module scope, so a mock applied
 * after the module has been evaluated once changes nothing — the second case
 * would silently assert the first case's constants.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SUPPORT_URL = 'https://buymeacoffee.com/karobakbak';

async function navWith(options: {
  payments: boolean;
  supportUrl?: string;
}): Promise<typeof import('./SiteNav')> {
  vi.resetModules();
  vi.doMock('../features', () => ({
    PAYMENTS_ENABLED: options.payments,
    ACCOUNTS_ENABLED: false,
    FILTERS_ENABLED: false,
  }));
  vi.doMock('../config', () => ({
    clientConfig: { supportUrl: options.supportUrl ?? SUPPORT_URL },
  }));
  return import('./SiteNav');
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('../features');
  vi.doUnmock('../config');
});

describe('while payments are off', () => {
  it('hides Premium from the header', async () => {
    const { navPaths } = await navWith({ payments: false });
    expect([...navPaths()]).not.toContain('/premium');
    // The rest of the header is untouched.
    expect([...navPaths()]).toEqual(['/about', '/how-it-works', '/safety', '/faq']);
  });

  it('points "Buy me a coffee" off the site, in the same position', async () => {
    const { secondaryNav } = await navWith({ payments: false });
    const items = secondaryNav();
    expect(items.map((item) => item.label)).toEqual([
      'Rules',
      'Contact',
      'Buy me a coffee',
      'Terms',
      'Privacy',
    ]);
    const coffee = items.find((item) => item.label === 'Buy me a coffee');
    expect(coffee?.to).toBe(SUPPORT_URL);
    expect(coffee?.external).toBe(true);
  });

  it('drops the link entirely rather than pointing it nowhere', async () => {
    // `clientConfig.supportUrl` documents this: empty hides it. A "buy me a
    // coffee" that goes nowhere is worse than no link at all.
    const { secondaryNav } = await navWith({ payments: false, supportUrl: '' });
    expect(secondaryNav().map((item) => item.label)).not.toContain('Buy me a coffee');
  });
});

describe('when payments are switched on', () => {
  it('brings Premium back to the header', async () => {
    const { navPaths } = await navWith({ payments: true });
    expect([...navPaths()]).toContain('/premium');
    expect([...navPaths()]).toEqual(['/about', '/how-it-works', '/safety', '/premium', '/faq']);
  });

  it('sends "Buy me a coffee" back to the internal page', async () => {
    const { secondaryNav } = await navWith({ payments: true });
    const coffee = secondaryNav().find((item) => item.label === 'Buy me a coffee');
    expect(coffee?.to).toBe('/support');
    expect(coffee?.external).toBeUndefined();
  });

  it('keeps the coffee link even with no external URL configured', async () => {
    // The internal page does not depend on the external one existing.
    const { secondaryNav } = await navWith({ payments: true, supportUrl: '' });
    expect(secondaryNav().map((item) => item.label)).toContain('Buy me a coffee');
  });
});
