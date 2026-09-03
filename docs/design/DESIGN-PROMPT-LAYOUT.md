# Prompt — where each piece of the UI should live

Paste everything below the line into an LLM. It is an information-architecture
question, not a visual design one: every element listed already exists and is
built. What is being asked is **placement**, and the answer should be a table of
element → surface with reasoning, not new features.

---

## The product

**karobakbak** — anonymous, text-only random stranger chat. Press one button,
talk to a stranger. No signup to chat. Mobile-first; most use is on a phone.

The core loop is: land → press Start → get matched → talk → skip → matched
again. Everything else is secondary to that loop and must not obstruct it.

## The surfaces available

1. **Landing page** (`/`) — currently a **single screen that does not scroll**,
   with no footer. This is a hard constraint: the primary button must be
   reachable without scrolling on a 375×667 phone. Space here is finite and
   every addition costs something visible.
2. **Header** — present on every page. Contains the logo (links home), an inline
   nav on desktop, and a menu button (☰) at all sizes.
3. **The ☰ menu** — a panel. On mobile it holds everything; on desktop it holds
   only what the inline nav does not.
4. **Age gate** — a blocking dialog shown when Start is pressed, not on arrival.
   Cannot be dismissed by clicking away.
5. **Chat screen** — shown while searching and while talking. Separate from the
   landing page.
6. **Document pages** — these scroll and have a footer.
7. **Settings sheet**, **Filters modal**, **Safety sheet** — overlays reachable
   from the header or the chat screen.

## Every element that exists, and where it currently is

**Landing page**
- Logo mark
- Wordmark "karobakbak"
- Headline: "Talk to someone you've never met."
- Sub-line: "Random. Anonymous. Just a conversation."
- Primary button: "Start chatting"
- Reassurance: "No signup · No profile · No commitment"
- Three-step strip: Start → Match → Talk (hidden on short screens)
- Live count — **only rendered when 100+ people are online**, absent otherwise
- An ad slot, currently disabled and rendering nothing

**Header inline nav (desktop):** How it works · Premium · Safety · FAQ · About

**☰ menu:** Rules · Contact · Buy me a coffee · Terms · Privacy

**Age gate:** heading, one checkbox combining age confirmation + agreement to
Terms/Privacy/Rules + a behaviour undertaking, "Start chatting", "Leave"

**Chat screen:** skip, block, report, message composer, typing indicator,
auto-search toggle

**Settings sheet:** profile fields (name, age, gender, country — all optional),
"alert me when I match", auto-search, conversation starters

**Pages that exist:** How it works, About, FAQ, Safety, Rules, Contact, Terms,
Privacy, Premium, Support

**Cards inside pages:** a support/"buy me a coffee" card on About; a contact
card with the email address and response commitments on Contact

## Things that currently have no clear home

Decide where each of these belongs, or that it should not exist:

1. **Sign in.** Only relevant to people with a paid subscription — chatting
   never needs an account. Currently it appears only in the header of the
   Premium page.
2. **Advertising.** Disabled today and may be enabled later. If it returns, where
   does it go without wrecking the single-screen landing page?
3. **The live count.** Currently on the landing page and hidden below 100 people.
   Is the landing page the right surface, or does it belong on the searching
   screen where the question "is anyone here" is actually being asked?
4. **The three-step strip.** It duplicates the How it works page. Is it earning
   its space on a finite screen?

## Known duplication — resolve or justify

- **Auto-search** appears in both the Settings sheet and the chat screen.
- **Profile fields** are in Settings only, having been removed from the landing
  page for being a duplicate.
- **Terms and Privacy** appear in the age gate checkbox and in the ☰ menu. Note
  that they are *required* to be reachable without passing the gate, so the menu
  copy cannot simply be removed.

## Constraints that cannot be traded away

- The landing page must not scroll on a phone, and the Start button must be
  visible without scrolling.
- Terms and Privacy must be reachable **without** passing the age gate.
- The live count must never be shown below 100, and must never be fabricated.
- No third-party embeds anywhere — no analytics, no widgets, no external fonts.
- Nothing may be added that claims a feature the product does not have. There is
  no voice, video, friends list, chat history, or matching by gender.
- Safety controls (skip, block, report) must stay obvious and must not move
  behind a menu.

## What to produce

1. A table: **element → surface → why**, covering every element listed above.
2. A specific recommendation for each of the four homeless items.
3. A resolution for each duplication — keep both, or pick one, with reasoning.
4. The landing page's contents in final order, top to bottom, with a note on
   what is dropped when the screen is short.
5. The header's contents at desktop and at mobile, stating what goes inline and
   what goes in the ☰ menu.
6. Anything currently placed that should be removed entirely.

Do not propose new features, new pages, or visual restyling. If an element seems
to be missing, say so rather than designing it.
