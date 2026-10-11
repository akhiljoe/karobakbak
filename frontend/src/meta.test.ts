import { describe, expect, it } from 'vitest';

// `?raw` and `?inline` rather than `node:fs`: this package compiles without
// Node's types, the same reason `content/pages.test.ts` gives.
import indexHtml from '../index.html?raw';
import robotsTxt from '../public/robots.txt?raw';
import sitemapXml from '../public/sitemap.xml?raw';
import ogImage from '../public/og-image.png?inline';

import { STATIC_PAGES } from './content/pages';
import { PAGE_META, SITE_ORIGIN, indexablePaths, pageMeta } from './meta';

describe('page meta', () => {
  it('covers every static page, so none is left titled "karobakbak"', () => {
    for (const page of STATIC_PAGES) {
      expect(PAGE_META[`/${page.id}`], page.id).toBeDefined();
    }
  });

  it('gives every page its own title and description', () => {
    const titles = Object.values(PAGE_META).map((m) => m.title);
    const descriptions = Object.values(PAGE_META).map((m) => m.description);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it('keeps titles and descriptions within what search results show', () => {
    for (const [path, meta] of Object.entries(PAGE_META)) {
      expect(meta.title.length, path).toBeLessThanOrEqual(60);
      expect(meta.description.length, path).toBeLessThanOrEqual(160);
    }
  });

  it('answers an unknown path with a non-indexable 404', () => {
    expect(pageMeta('/saftey')).toMatchObject({ indexable: false });
    expect(pageMeta('/saftey').title).toMatch(/not found/i);
  });
});

describe('sitemap.xml and robots.txt', () => {
  it('lists exactly the indexable pages', () => {
    const locs = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(indexablePaths().map((path) => `${SITE_ORIGIN}${path}`));
  });

  it('points crawlers at the sitemap and away from the API', () => {
    const robots = robotsTxt;
    expect(robots).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
    expect(robots).toMatch(/^Disallow: \/auth\/$/m);
    expect(robots).toMatch(/^Disallow: \/api\/$/m);
  });
});

describe('index.html', () => {
  const html = indexHtml;

  it('carries a complete link-preview card with an absolute image URL', () => {
    for (const tag of ['og:title', 'og:description', 'og:url', 'og:image', 'og:type']) {
      expect(html, tag).toContain(`property="${tag}"`);
    }
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain(`content="${SITE_ORIGIN}/og-image.png"`);
  });

  it("matches the homepage's title, so a cold load and a navigation agree", () => {
    expect(html).toContain(`<title>${PAGE_META['/']!.title}</title>`);
  });

  it('has the preview image it names, at the size it declares', () => {
    // The PNG header stores width and height as big-endian words at 16 and 20.
    const bytes = atob(ogImage.slice(ogImage.indexOf(',') + 1));
    const word = (at: number): number =>
      ((bytes.charCodeAt(at) << 24) | (bytes.charCodeAt(at + 1) << 16) | (bytes.charCodeAt(at + 2) << 8) | bytes.charCodeAt(at + 3)) >>> 0;
    expect(ogImage.startsWith('data:image/png')).toBe(true);
    expect(word(16)).toBe(1200);
    expect(word(20)).toBe(630);
  });
});
