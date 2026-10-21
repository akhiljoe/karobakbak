# Prompt for Claude Design — karobakbak frontend

Paste everything below the line into Claude Design. It is written so the output
drops into this codebase with minimal translation: the palette, the type scale
and the icon set are the ones already in `tailwind.config.js`, so a design that
uses them ports directly.

Two things to know before you paste:

* **Section 8 is the important one.** Without it you will get fabricated user
  counts, testimonials and third-party font embeds — the standard playbook for
  this product category, and all three are specifically forbidden here.
* **Do not let it invent copy that makes claims.** Retention periods, age
  policy and the statement about automated partners are load-bearing facts. They are given in
  section 6 and must be used verbatim in substance.

---

## 1. What you are designing

**karobakbak** — an anonymous, text-only random stranger chat website. You press
one button and you are talking to a stranger. There is no signup, no account, no
profile that follows you, and no history.

Design a complete marketing-and-product website for it: a homepage that explains
the product properly, plus supporting pages. It is currently a single screen with
a row of footer links, which is why this brief exists.

**The audience** is someone who has landed on the site and is deciding, in about
four seconds, whether this is worth trying and whether it is safe. The two
questions that lose people are *"is anyone actually there?"* and *"what happens
when I click?"*

**One person operates this**, as a sole proprietor in India. It is not a company.
That should inform the tone: direct, human, unpolished in the way a real person
is unpolished — not corporate, not breathless.

---

## 2. Aesthetic direction — preserve this, do not reinvent it

The existing visual language is good and should be extended rather than
replaced:

* Dark, warm, near-black background. Not blue-black, not grey — **warm**.
* Amber/gold as the single accent. No second accent colour.
* Serif display type for headlines; clean sans for everything else.
* Calm, premium, slightly mysterious, minimal, human, modern.
* Generous negative space that reads as **intentional**, not unfinished.

**Do not** turn it into a generic SaaS landing page. **Do not** make it look
like a dating app. No gradient meshes, no heavy glassmorphism, no floating 3D
blobs, no stock photography, no decorative filler.

---

## 3. Design tokens — use these exact values

These already exist in the codebase. Using anything else means the design has to
be re-coloured before it can ship.

**Background / neutrals (warm "ink" ramp)**

| Token | Hex | Typical use |
|---|---|---|
| ink-950 | `#13100b` | page background |
| ink-900 | `#1c1812` | raised surfaces, cards |
| ink-800 | `#2a241c` | borders, dividers |
| ink-700 | `#3d352a` | stronger borders, rings |
| ink-600 | `#524739` | disabled text only — **fails contrast for body text** |
| ink-500 | `#6b5f4d` | icon tint, very secondary |
| ink-400 | `#8a7d68` | secondary body text (minimum for small text) |
| ink-300 | `#b8ab97` | body text |
| ink-200 | `#d9d1c4` | emphasis text |
| ink-100 | `#ede9e3` | headings |
| ink-50  | `#f7f5f3` | display headlines |

**Accent (amber)**

| Token | Hex | Use |
|---|---|---|
| amber-300 | `#ffc94a` | accented words in headlines, link hover |
| amber-400 | `#ffb420` | primary CTA, icons, focus rings |
| amber-500 | `#f59e0b` | pressed states |

**Secondary accent (sage) — sparing, for "live"/positive signals only**

| Token | Hex |
|---|---|
| sage-400 | `#7fb069` |
| sage-500 | `#5a9251` |

**Type**

* Display: **Fraunces** (serif) — headlines only
* Body/UI: **Plus Jakarta Sans**
* Numerals in live counts: **JetBrains Mono**

Headline scale: 38px mobile → 48px tablet → 64px desktop. Body 16px minimum;
secondary text 14px minimum. **Nothing at 12px** except legal fine print.

---

## 4. Technical constraints — these decide whether the design is buildable

* **React + TypeScript + Tailwind CSS.** Express spacing, colour and type as
  Tailwind utilities using the token names above.
* **Icons: `lucide-react` only.** No custom icon fonts, no SVG icon packs.
* **No external assets of any kind.** No CDN images, no Google Fonts link, no
  remote SVGs. The site runs under a strict Content Security Policy
  (`default-src 'self'`) that blocks every one of them. Illustrations must be
  inline SVG or pure CSS.
* **No new npm dependencies.** No animation libraries, no UI kits, no carousels.
* **Motion:** subtle only, and it must degrade under `prefers-reduced-motion`.
  Slow drifts and fades, nothing that loops attention-grabbingly.
* **Mobile-first.** Design the mobile layout deliberately; do not shrink the
  desktop one. Breakpoints to check: 320, 375, 390, 430, 768, 1024, 1280, 1440.
* **Short viewports matter**, not just narrow ones. Laptops at 1280×700 and
  landscape phones are a real case; the hero must not need scrolling there.

---

## 5. Pages to design

### 5.1 Homepage — the priority

**First viewport, no scrolling required**, on both mobile and a 1280×700
laptop, containing:

1. A compact header: wordmark left, a few links, nothing crowded.
2. Headline: **"Talk to someone you've never met."** — the largest thing on the
   page, with one phrase accented in amber.
3. One supporting line: "Random. Anonymous. Just a conversation."
4. An optional, clearly-optional collapsed control labelled *"Tell strangers
   about you — optional · helps break the ice"*.
5. The primary CTA: **"Start chatting"**. Unmistakably the main action.
6. Reassurance directly under it: "No signup · No profile · No commitment".
   Readable, not fine print.
7. A live activity indicator — **only shown when the number is 100 or more**.
   Design both states: present, and completely absent.

**Below the fold**, scrollable, explaining the product properly:

8. **How it works** — three steps: Start (no signup) → Match (a random
   stranger) → Talk (see where it goes). Compact.
9. **What makes it different** — four to six points, each one sentence. Real
   material: text only by design; no account; nothing to install; you can leave
   any time; conversations delete themselves; some partners are automated, and an
   automated partner never claims to be human.
10. **Safety, briefly** — skip, block and report, with the honest framing that
    these are controls the user has, not a promise of safety.
11. **A short FAQ preview** — four questions, linking to the full FAQ page.
12. A closing CTA.
13. **Footer** — grouped links, not one long row. Suggested grouping:
    *Product* (How it works, FAQ, Safety) · *Company* (About, Contact,
    Support the project) · *Legal* (Terms, Privacy, Rules).

### 5.2 About

The story of why it exists, who runs it, and what it deliberately refuses to
become. Should read like a person wrote it. Include a modest, tasteful
"support the project" element — a single card, **not** a floating button and not
repeated in several places.

### 5.3 Contact

Simple. What to write in about (abuse reports go through the in-product Report
button instead, and say why that is faster), the response commitments — **24
hours to acknowledge, 15 days to resolve** — and a single contact address.
Design a state for when no address is configured yet.

### 5.4 FAQ

A proper page, ~14 questions, grouped into two or three categories. Accordion or
plain stacked sections — your call, but it must be readable without JavaScript
gymnastics.

### 5.5 Safety, Rules, Terms, Privacy

Long-form document pages. Design **one reusable document template**: a title, a
one-line summary, a readable measure (65–75 characters), clear heading
hierarchy, and comfortable spacing. These are pages people skim when they are
worried — legibility beats personality here.

### 5.6 Supporting states

* A styled **404** page.
* A **connection lost / reconnecting** state.
* The **age confirmation dialog** — blocking, cannot be dismissed by clicking
  outside, with "I am 18 or over" and "Leave" as the two actions, and links to
  Terms and Privacy.

---

## 6. Copy facts that must be true

Use these. Do not soften them, and do not invent alternatives.

* Conversations are kept **30 days**, then deleted automatically. If reported,
  **90 days**.
* **Text only.** No photos, no video, no voice — the server rejects anything
  else.
* **No account, no signup**, nothing to log in to.
* **18 or over.** We ask and **we do not verify** — never imply otherwise.
* **Some conversation partners are automated.** They never claim to be human.
  What is said in those conversations goes to the company whose model writes the
  replies; that happens in no other conversation.
* **One cookie**, only so blocking works. No analytics, no trackers, no
  advertising.
* **Not available in the EEA or the UK.**
* Anonymous **to the person you are talking to**. Not entirely anonymous to the
  operator — say so.

---

## 7. Logo and identity

There is no logo yet, only a generic chat-bubble icon. Design one.

* Works at 24px in a header and as a favicon.
* Monochrome-capable; amber on dark as the primary treatment.
* Suggests conversation between two people, or two voices meeting — without
  being a literal speech bubble, which every chat product already uses.
* A wordmark to sit beside it. The name is lowercase: **karobakbak**.
* Deliver as inline SVG.

Also design a social preview / Open Graph card, since a link to the site
currently previews as nothing.

---

## 8. Never include — these are hard rules

Every one of these has a recorded decision behind it. They are not preferences,
and a design containing them cannot ship.

* **No fabricated or inflated user counts.** The real number is shown only above
  100 and is otherwise hidden entirely. Never mock up "12,847 online" as
  decoration.
* **No testimonials, reviews, star ratings, or user avatars.** There are no
  users yet; all of it would be invented.
* **No claims of "100% safe", "completely anonymous", "totally private", or
  "nothing is stored".** All four are false here.
* **Never imply age is verified.**
* **No third-party embeds** — no analytics, no external fonts, no chat widgets,
  no social SDKs, no donation widgets. External *links* are fine; scripts are
  not.
* **Do not design features that do not exist**: video, voice, gender or location
  filters, user profiles, friends, chat history, rooms, feeds, subscriptions,
  translation, or matching preferences.
* **No fake screenshots of real conversations.** An illustrative sample exchange
  is fine if it is visibly an illustration.
* **Do not solve empty space by adding content.** Solve it with typography,
  composition, hierarchy and restraint.

---

## 9. Accessibility

* Contrast: 4.5:1 for body text, 3:1 for large text. `ink-600` on `ink-950` is
  roughly 3:1 — do not use it for anything a person needs to read.
* Visible focus states on every interactive element, designed rather than
  defaulted.
* Touch targets 44×44px minimum.
* Nothing conveyed by colour alone.
* All motion off under `prefers-reduced-motion`.

---

## 10. What to deliver

1. Homepage — mobile (390px) and desktop (1440px).
2. Homepage hero at **1280×700**, proving it fits without scrolling.
3. About, Contact, FAQ.
4. The reusable document template, shown with one long page.
5. Age dialog, 404, reconnecting state.
6. Logo: mark, wordmark, favicon-size, and the social card.
7. A short spec of the components used — buttons, cards, links, section headers
   — with their states (default, hover, active, focus, disabled).

For each screen, note the Tailwind token names used for background, text and
accent, so it can be built without colour-matching by eye.
