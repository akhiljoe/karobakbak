/**
 * Each page's title, description and canonical address, for search engines.
 *
 * `index.html` carries one set for the whole site, and that is all the
 * link-preview crawlers (WhatsApp, Facebook, X) ever see, because they do not
 * run script. Search engines do run it, and to them a site where every page is
 * called "karobakbak" is one page with eight addresses. So the route sets its
 * own title, description and canonical here, on every navigation.
 *
 * One table, keyed by path, so the sitemap test can hold `public/sitemap.xml`
 * to exactly the pages listed as indexable here — a page added to one and not
 * the other fails a test instead of quietly going unindexed.
 */

export const SITE_ORIGIN = 'https://karobakbak.com';

export interface PageMeta {
  readonly title: string;
  readonly description: string;
  /** Listed in the sitemap and open to indexing. False for a 404. */
  readonly indexable: boolean;
}

const SUFFIX = ' — karobakbak';

export const PAGE_META: Readonly<Record<string, PageMeta>> = {
  '/': {
    title: 'karobakbak — Anonymous random chat with strangers',
    description:
      "Talk to someone you've never met. Free, anonymous random chat. No sign-up, no app.",
    indexable: true,
  },
  '/about': {
    title: `About${SUFFIX}`,
    description:
      'What karobakbak is: a random chat for talking to strangers, built to be anonymous and simple.',
    indexable: true,
  },
  '/how-it-works': {
    title: `How it works${SUFFIX}`,
    description:
      'How random matching works on karobakbak, what is kept and for how long, and how skip, block and report work.',
    indexable: true,
  },
  '/faq': {
    title: `FAQ${SUFFIX}`,
    description:
      'Answers to the questions people ask about karobakbak: anonymity, accounts, friends, safety and more.',
    indexable: true,
  },
  '/safety': {
    title: `Safety${SUFFIX}`,
    description:
      'Skip, block and report on karobakbak, and practical advice for talking to strangers safely.',
    indexable: true,
  },
  '/rules': {
    title: `Rules${SUFFIX}`,
    description: 'The rules for chatting on karobakbak: short enough to read, clear enough to enforce.',
    indexable: true,
  },
  '/contact': {
    title: `Contact${SUFFIX}`,
    description: 'How to reach karobakbak, and what happens when you do.',
    indexable: true,
  },
  '/terms': {
    title: `Terms of Service${SUFFIX}`,
    description: 'The agreement between you and karobakbak.',
    indexable: true,
  },
  '/privacy': {
    title: `Privacy Policy${SUFFIX}`,
    description: 'What karobakbak collects, how long it is kept, and who can see it.',
    indexable: true,
  },
  '/premium': {
    title: `Premium${SUFFIX}`,
    description: 'Matching preferences on karobakbak.',
    indexable: false,
  },
  '/support': {
    title: `Support karobakbak${SUFFIX}`,
    description: 'Help keep karobakbak running.',
    indexable: false,
  },
};

const NOT_FOUND: PageMeta = {
  title: `Page not found${SUFFIX}`,
  description: 'There is no page at this address.',
  indexable: false,
};

/** The meta for a path; anything unknown is the 404's. */
export function pageMeta(path: string): PageMeta {
  return PAGE_META[path] ?? NOT_FOUND;
}

/** Every path that belongs in the sitemap, in table order. */
export function indexablePaths(): string[] {
  return Object.entries(PAGE_META)
    .filter(([, meta]) => meta.indexable)
    .map(([path]) => path);
}

function setMeta(attribute: 'name' | 'property', key: string, content: string): void {
  let tag = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (tag === null) {
    tag = document.createElement('meta');
    tag.setAttribute(attribute, key);
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', content);
}

/**
 * Write a page's meta into the document.
 *
 * A page that is not indexable gets `noindex` rather than simply being left
 * out of the sitemap: an unknown path still answers 200 with the app (nginx
 * serves `index.html` for everything), and without the tag every typo is a
 * soft-404 a crawler may index.
 */
export function applyPageMeta(path: string): void {
  const meta = pageMeta(path);
  document.title = meta.title;
  setMeta('name', 'description', meta.description);
  setMeta('property', 'og:title', meta.title);
  setMeta('property', 'og:description', meta.description);

  const url = `${SITE_ORIGIN}${path === '/' ? '/' : path}`;
  setMeta('property', 'og:url', url);
  let canonical = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (canonical === null) {
    canonical = document.createElement('link');
    canonical.rel = 'canonical';
    document.head.appendChild(canonical);
  }
  canonical.href = url;

  const robots = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (meta.indexable) robots?.remove();
  else setMeta('name', 'robots', 'noindex');
}
