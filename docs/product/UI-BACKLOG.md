# UI backlog — a brief for whoever improves this next

This document exists to be handed to a designer or a model and get useful work
back instead of a generic landing page. It is written for a reader who has not
seen the codebase.

Read section 2 before proposing anything. Most of the obvious suggestions for a
product like this are already ruled out, and the reasons are not aesthetic.

---

## 1. What the product is

**karobakbak** — anonymous, real-time, **text-only** random stranger chat. Two
strangers are paired at random over WebSockets, either can skip or block, and
conversations are retained for a defined period so abuse can be investigated,
then deleted automatically.

* No accounts. No signup. No password. Nothing to log in to.
* Text only. No images, no voice, no video, and none of them are coming soon.
* Some conversation partners are AI personas. They never claim to be human.
* One person operates it, as a sole proprietor in India.
* Not launched yet. The blocker is a domain, not code.

**Aesthetic to preserve:** dark, warm, premium, calm, slightly mysterious,
human, minimal, modern. Near-black warm background, amber/gold accent, Fraunces
serif for display type, Plus Jakarta Sans for body, JetBrains Mono for numbers.

It must not become a generic SaaS landing page and it must not look like a
dating app.

---

## 2. Hard constraints — do not propose these

Each of these has a recorded decision behind it. They are not preferences.

| Do not propose | Why |
|---|---|
| **Fake or inflated online counts** | The wire format sends `approximate: true` as a literal so the UI is structurally unable to present counts as exact. Fabricated social proof is recorded as "a trust bug that is impossible to walk back". The counter is **hidden entirely below 100 online** rather than padded. |
| **Testimonials, reviews, star ratings, user avatars** | There are no users yet. Every one of these would be fabricated. |
| **"100% safe", "completely anonymous", "totally private", "nothing is stored"** | All four are false. Conversations are retained (30 days, 90 if reported). The product is anonymous *to your chat partner*, not to the operator. |
| **Any claim that age is verified** | The age gate asks and does not check. It says so on its own face. Copy implying verification is the single most consequential false claim this UI could make. |
| **Third-party embeds — analytics, fonts, chat widgets, donation widgets, social SDKs** | The Privacy Policy states the site makes "no requests to any third party from your browser — not even external fonts". A single embed makes that sentence false. External links are fine; scripts are not. |
| **Video, voice, filters by gender/location, profiles, friends, chat history, rooms, feeds, subscriptions** | Not built, and deliberately not on the landing page. Several are gated behind a child-safety determination that has not happened. |
| **A free-text "intro" or interest-tag field** | Sounds like a UI change; is not. The profile is a typed wire field (`{name, country, age, gender}`), the frontend protocol file is generated from the backend, and any new field needs moderation, retention and console support. |
| **Removing the retention sentence from the footer** | It is there because the landing screen once implied the opposite, and that was logged as a defect. |
| **Gradients everywhere, heavy glassmorphism, stock photography, decorative filler** | Stated direction. The page should read as intentionally minimal, not unfinished. |

Two softer rules:

* **Do not solve emptiness by adding content.** Solve it with typography,
  composition, hierarchy, spacing and restraint.
* **Every factual claim in the UI is checked against the code.** If a proposal
  states a number, a duration, or a guarantee, it has to be true — there are
  tests that fail the build when copy and config drift apart.

---

## 3. What already exists

So nobody spends effort rebuilding it.

**Landing screen**
* Headline "Talk to someone you've never met." — 38px mobile → 64px desktop,
  with "never met" accented in amber italic.
* Sub-line "Random. Anonymous. Just a conversation."
* Collapsed optional profile control ("Optional · helps break the ice").
* Primary CTA, full-width on mobile, amber, with a soft glow on hover.
* Reassurance line: "No signup · No profile · No commitment".
* Live count — **only above 100**, otherwise absent.
* "How it works": three compact steps joined by a hairline.
* Four ambient drifting dots, well away from the centre column.
* Footer: safety/retention line, then About · FAQ · Safety · Buy me a coffee ·
  Contact (each link hidden when its URL is unconfigured).

**Other surfaces**
* Age gate — now opens when somebody presses Start, not on arrival. Blocking,
  non-dismissible, links Terms and Privacy.
* About / FAQ / Safety pages as overlays, content held as data and unit-tested.
* Chat shell, message list, composer, typing indicator, block/report/skip.
* Settings, filters, safety sheets.

**Technical facts worth knowing**
* Tailwind. Custom `ink` / `amber` / `sage` palettes; no other colours defined.
* `prefers-reduced-motion` is handled globally in `index.css` — it kills every
  animation, so new motion needs no extra guard.
* `safe-pt` / `safe-pb` helpers exist for notches.
* No router. Static pages are overlays, so they have **no URLs and cannot be
  indexed or linked**. `nginx.conf` already has the SPA fallback if that is
  wanted later.
* Ads are frontend-only and disabled; `AdSlot` renders `null`.

---

## 3a. Fixed since this document was written

Two of these were bugs rather than polish, and neither was visible without
opening a browser.

* **Build args the Dockerfile never declared.** `docker-compose.yml` passed
  `VITE_CONTACT_EMAIL` and `VITE_SUPPORT_URL`, and `frontend/Dockerfile` did not
  declare an `ARG` for either — so Docker dropped both silently and the Contact
  and donation links were missing from the bundle through a full rebuild. There
  is no warning for an undeclared build arg. Fixed, and both links are confirmed
  present in the DOM.
* **The landing screen overflowed by 82px at 1536×695**, a common laptop height.
  Measured, not guessed. The single largest contributor was a wrapper div
  holding a 24px top margin open for `AdSlot`, which renders `null` while ads
  are disabled — `empty:hidden` now collapses it. The rest came from a new
  `short` height breakpoint (`max-height: 760px`) that tightens vertical rhythm
  on laptops and landscape phones and leaves tall screens alone.

  **Not fully verified.** The breakpoint ships in the built CSS and the classes
  are on the elements, but the automation could not resize the browser window
  below the threshold, so it has not been seen firing. Worth eyeballing on a
  short viewport before trusting it.
* **Terms and Privacy are pages now** (`frontend/src/content/legal.ts`) rather
  than outbound links to a domain that does not exist, so the documents ship
  with the bundle. The age gate links them instead of saying they are
  unpublished. A Rules page was added. Six pages total.
* **Footer contrast and size.** Links were `text-xs` on `ink-600` against
  `ink-950` — roughly 3:1, below the AA floor for body text, and too small to
  read on a desktop monitor. Now `text-sm` on `ink-400` with larger tap targets.

Still open in the same area: the footer runs 163–185px tall with eight links and
wraps to two or three lines on narrow screens. That is a large share of a short
viewport spent on navigation, and whether to group or trim it is unresolved.

## 4. The backlog

Grouped by what they are for. Nothing here is decided.

### 4.1 Composition and hierarchy

1. **Verify the one-screen mobile claim.** The layout is designed to fit
   375×667 but has not been measured in a real browser. Worst case is a filled
   profile card plus a visible live count at 320px wide.
2. **The `ended` state reuses the landing layout.** "That one is over." with a
   full how-it-works block underneath is probably wrong for somebody who has
   just finished a conversation — they know how it works. Consider a leaner
   variant.
3. **Desktop at 1440px+ is still centre-weighted and narrow.** Worth deciding
   whether that is intentional restraint or wasted canvas.
4. **The four ambient dots are decorative and currently the only "life" on the
   page.** Either commit to them properly or remove them.

### 4.2 Trust and comprehension

5. **Show what a conversation actually looks like** — a small, static, clearly
   illustrative sample exchange. Answers "what am I getting into" better than
   any copy. Must be visibly an illustration, not a real transcript.
6. **Make the AI-persona disclosure visible on the landing page**, not only in
   About and the policies. It is unusual, honest, and probably a differentiator
   rather than a liability.
7. **Say what happens on Skip and Block before the first conversation.** The
   controls are excellent and completely invisible until you are already in a
   chat.
8. **A "why is this free" line.** With a coffee link now present, the absence of
   an explanation is conspicuous.

### 4.3 The chat surface itself

*Least designed part of the product, and where users actually spend their time.*

9. **The waiting/searching state.** Currently minimal. It is the highest-anxiety
   moment in the product and the most likely point of abandonment.
10. **First-conversation onboarding** — one-time, dismissible, pointing out
    skip/block/report. Not a tour.
11. **The moment a partner leaves.** Currently a system message. Could carry the
    next action more strongly.
12. **Empty-composer state** — a gentle prompt for the first message, since
    "what do I even say" is the second barrier after "is anyone there".

### 4.4 Identity and polish

13. **There is no logo** beyond a lucide `MessageCircle` icon. A real mark would
    do more for "proper website" than any layout change.
14. **No favicon, no OG image, no social preview.** A link to the site currently
    previews as nothing, which matters the first time anybody shares it.
15. **No 404 or error page** styled like the product.
16. **The `<title>` and meta description** have not been reviewed.

### 4.5 Structural

17. **Give static pages real URLs.** Currently overlays — no deep links, no SEO,
    no way to link somebody directly to Safety. This is the largest single
    "proper website" gap.
18. **Publish Terms and Privacy as in-app pages.** They exist as drafts in
    `docs/policies/` but interleave user-facing text with internal review notes,
    so they cannot be shipped verbatim. Needs an editorial pass, not a code one.
19. **Loading and reconnect states** deserve a look as a set rather than
    individually.

### 4.6 Accessibility

20. **Audit contrast across the whole palette.** `ink-600` on `ink-950` was
    being used for footer links at ~3:1 and has been fixed; other uses of
    `ink-500`/`ink-600` for text have not been checked.
21. **Focus states have not been reviewed** as a system.
22. **Touch targets** below 44px exist in the footer and headers.
23. **Screen-reader pass** on the chat surface — live regions for incoming
    messages, in particular.

---

## 5. Open questions for the operator

* Should the live count use `online` (people connected, currently displayed) or
  `conversations` (active pairs)? They differ by roughly 4×, and the ≥100
  threshold would need to move with it.
* Should the statement that some partners are automated (today in About and
  the policies) also appear on the landing page? An automated partner never
  claims to be human, but the chat itself does not label which partner is one.
* Does the product want a personality/voice in its copy, or should it stay
  neutral? The headline has some; the rest does not.
* Is SEO a goal? If yes, item 17 is the first thing to do and it changes the
  frontend architecture.

---

## 6. How to give feedback on a proposal

A good proposal for this codebase says which files it touches, which of the
section 2 constraints it is near, and what factual claim (if any) it introduces.
A proposal that adds a sentence to the UI is proposing a commitment the operator
has to keep.
