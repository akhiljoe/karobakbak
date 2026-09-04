# Prompt for Claude Design — one page at a time

**How to use this:** paste everything below the line, then paste the page's
the page's entry from `frontend/src/content/` underneath it, saying which page it is.
One page per conversation — the brief is deliberately narrow so the design
answers *this* page rather than averaging across eight.

---

## What you are designing

One page of **karobakbak** — an anonymous, text-only random stranger chat.
Press one button, talk to a stranger. No signup, no account, no profile, no
history. Mobile-first; most visitors are on a phone.

The chat itself already exists and is not what you are designing. These are the
pages around it: the ones somebody opens *before* deciding to press the button,
or *after* something has gone wrong and they want to know where they stand.

The copy is written and is provided below. **Do not rewrite it.** You are
deciding how it is presented — structure, hierarchy, rhythm, what becomes a
list, what becomes a card, what earns emphasis, where the page breathes. If a
sentence genuinely cannot be laid out as written, say so rather than editing it.

## Two kinds of page, and they want opposite things

**Read-straight pages: Terms, Privacy.**
Somebody opens these worried, or looking for one specific fact, often on a
phone, sometimes to send to someone else. They want a single readable column, a
clear heading hierarchy, generous line height, and a measure of 65–75
characters. No cards, no columns, no illustration, nothing clever. Legibility
and scannability are the entire design. A table of contents at the top is
welcome if the page is long.

**Expressive pages: About, How it works, Safety, Rules, Premium, FAQ, Contact.**
These can be laid out inventively — numbered steps, cards, an accordion,
pull-quotes, a diagram, a small illustrative device. Use structure to make the
content quicker to understand, never to decorate it. The test for any element:
does this help somebody grasp the page faster, or does it just fill space?

Say which of the two you have been given and design accordingly.

## The shell it drops into

Every page already renders inside a fixed shell. Design the **content area**;
do not redesign these.

* **Header** — sticky, `ink-950/85` with a blur, 56px tall. On the left: a
  hamburger, then the logo and wordmark, then inline nav links from `md` up. On
  the right: a "Start chatting" button.
* **Footer** — a row of small links: Rules, Contact, Buy me a coffee, Terms,
  Privacy.
* **Content area** — currently `max-w-2xl`, centred, with a page title, a
  one-line summary under it, then the sections. You may propose a different
  width or a different treatment of the title block for an expressive page.

## Design tokens — use these exact values

The product is **dark**. A light version was tried and rejected; do not propose
one.

**Neutrals — a warm "ink" ramp, not grey**

| Token | Hex | Typical use |
|---|---|---|
| ink-950 | `#13100b` | page background |
| ink-900 | `#1c1812` | raised surfaces, cards |
| ink-800 | `#2a241c` | borders, dividers |
| ink-700 | `#3d352a` | stronger borders, rings |
| ink-600 | `#524739` | disabled text only — fails contrast for body |
| ink-500 | `#6b5f4d` | icon tint, very secondary |
| ink-400 | `#8a7d68` | secondary body text — the floor for anything readable |
| ink-300 | `#b8ab97` | body text |
| ink-200 | `#d9d1c4` | emphasis |
| ink-100 | `#ede9e3` | headings |
| ink-50 | `#f7f5f3` | display headlines |

**Accent — amber.** `amber-300 #ffc94a`, `amber-400 #ffb420`, `amber-500 #f59e0b`.

Amber is **reserved**. The primary "Start chatting" button owns it. On these
pages use it sparingly — an accented word, an icon, a border on hover. A page
that uses as much amber as the chat button competes with the product's only
call to action.

**Secondary — sage**, for positive or "live" signals only:
`sage-400 #7fb069`, `sage-500 #5a9251`. Currently under-used; a little more of
it would help these pages feel less monochrome.

**Warm light palette — `coffee` and `cream`** exist for one page only (the
support/donation page) and must not be used elsewhere.

**Type.** Fraunces (serif) for display and headings. Plus Jakarta Sans for body
and UI. JetBrains Mono for numbers and labels. Body text 16px, secondary 14px.
Nothing at 12px except legal fine print.

## Technical constraints — these decide whether it can be built

* **React + TypeScript + Tailwind.** Express everything as Tailwind utilities
  using the token names above.
* **Icons: `lucide-react` only.** No icon fonts, no SVG packs.
* **No external assets of any kind.** No CDN images, no Google Fonts link, no
  remote SVG. A strict Content Security Policy (`default-src 'self'`) blocks
  every one of them at runtime, and the Privacy page states the site makes no
  third-party requests from the browser. Illustration must be inline SVG or CSS.
* **No new dependencies.** No animation library, no UI kit, no carousel.
* **Motion is subtle and must degrade** under `prefers-reduced-motion`, which is
  handled globally. Avoid anything that depends on scroll position. These
  animations already exist as Tailwind utilities and should be reused rather
  than replaced: `animate-fade-in`, `animate-msg-in`, `animate-pop-in`,
  `animate-float`, `animate-float-slow`, `animate-pulse-ring`,
  `animate-shimmer`.
* **Two extra breakpoints exist and are about height, not width:** `short`
  (`max-height: 760px`) and `tiny` (`max-height: 700px`). They matter on the
  homepage; on a scrolling page you will rarely need them.
* **Shadows:** `shadow-soft`, `shadow-lift`, `shadow-glow` (amber ring).
  `rounded-4.5` is a 1.125rem radius used for the larger cards.
* **Mobile-first.** Check 320, 375, 390, 430, 768, 1024, 1440.
* **These pages scroll**, unlike the homepage. That is fine and expected.

## Never include

Each of these has a recorded decision behind it.

* **Fabricated numbers.** No user counts, no "members since", no growth stats.
  There are no users yet. The live count elsewhere in the product is hidden
  below 100 rather than padded.
* **Testimonials, reviews, ratings, avatars, named quotes.** All would be
  invented.
* **"100% safe", "completely anonymous", "totally private", "nothing is
  stored".** All four are false here. Conversations are kept 30 days, 90 if
  reported, and the product is anonymous *to your chat partner*, not to the
  operator.
* **Any implication that age, gender or country is verified.** Nothing is.
* **Features that do not exist:** voice, video, friends, chat history,
  reconnecting to a past partner, games, image sharing, translation.
* **Third-party embeds** — analytics, fonts, chat widgets, social SDKs.
* **Decorative filler.** Empty space is solved with typography and composition,
  not with content.

## What to deliver

1. The page at **390px** and at **1440px**.
2. Any interactive state the layout implies — an open and closed accordion, a
   hover, a focus ring.
3. A short spec of any new component the page introduces: its states, and the
   token names used for background, border, text and accent.
4. One line on anything in the copy you could not lay out as written.

Design only the page you were given. If it needs something the shell does not
have, describe it rather than redesigning the header or footer.

---

## Notes for whoever integrates the result

Not part of the prompt — do not paste this section.

* Pages currently live as **data**, not components: `frontend/src/content/*.ts`
  exports `{ id, title, summary, sections: [{ heading, body: string[] }] }`, and
  `SitePage` renders all of them identically. That is what makes the copy
  testable — `pages.test.ts` asserts against the data without rendering.
* A bespoke layout per page breaks that shape. Two options when the designs
  arrive: keep the data and let `SitePage` branch on `page.id`, or promote that
  page to its own component and lose the copy tests for it. The first is
  preferable; the second is sometimes unavoidable.
* `SitePage` already accepts a `children` slot, used today by Contact
  (`ContactCard`), About (`SupportCard`) and How it works
  (`SampleConversation`). Cheap extras should go there before anything is
  restructured.
* Every page in `frontend/src/content/` still needs checking against the
  product before it ships. Two of them already carried claims that had stopped
  being true.
