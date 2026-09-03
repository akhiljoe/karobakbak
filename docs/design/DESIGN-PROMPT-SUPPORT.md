# Prompt for Claude Design — the "support this" UI

Paste everything below the line into Claude Design.

The brief is narrow on purpose. The previous version of this element read like a
donation widget lifted from a template, which is exactly what it must not be —
so most of this prompt is about what it should *feel* like rather than what it
should contain.

---

## What you are designing

One element, for a website called **karobakbak** — an anonymous, text-only
random stranger chat. You press a button and you are talking to somebody you
have never met. No signup, no account, no profile.

The element asks people to voluntarily support the project.

## The situation it sits in — this is the whole brief

The site is run by **one person**. It is completely free. There is no
advertising anywhere on it, nothing is paywalled, and nothing is being withheld
from people who do not pay. There is no upsell behind this and no benefit
attached to it — no badge, no perks, no thanks-page, nothing changes for
somebody who gives.

So this is not a conversion element. It is closer to a note at the bottom of
something somebody made, mentioning that it costs money to run.

**The failure to avoid:** it currently looks like a donation widget dropped in
from a template — a coloured card with a coffee cup and a button, the kind of
thing people have learned to skip past without reading. Anything that pattern-
matches to "advertisement" or "sponsored" has failed, however well it is drawn.

**The tone to hit:** understated, honest, slightly self-aware. It should read as
a person mentioning something, not a product asking for money. It should be
possible to ignore without feeling avoided, and it should not perform gratitude
in advance.

Do not use guilt, urgency, scarcity, progress bars, goals, donor counts, tiers,
or "buy me a coffee" cup iconography unless you have a genuinely better reason
than convention.

## Where it appears

Design **two** treatments of the same idea:

1. **On the About page.** The page has just explained that one person runs this
   and that reports are read by that person. The element sits after that, in a
   readable prose column about 65–75 characters wide. This is the primary
   treatment and it can afford a sentence or two of context.

2. **As a single line in a navigation menu**, alongside links like Rules,
   Contact, Terms and Privacy. One line of text, no card, no icon unless it
   genuinely helps. It must not shout louder than the links beside it.

Both link out to an external page. There is no in-page payment flow to design —
no amount picker, no card fields, no currency selector.

## Design tokens — use these exact values

The site already uses these. Anything else has to be re-coloured before it can
ship.

**Background and neutrals — a warm "ink" ramp**

| Token | Hex | Use |
|---|---|---|
| ink-950 | `#13100b` | page background |
| ink-900 | `#1c1812` | raised surfaces |
| ink-800 | `#2a241c` | borders |
| ink-700 | `#3d352a` | stronger borders |
| ink-500 | `#6b5f4d` | icon tint |
| ink-400 | `#8a7d68` | secondary text — the minimum for anything readable |
| ink-300 | `#b8ab97` | body text |
| ink-100 | `#ede9e3` | headings |

**Accent** — amber-400 `#ffb420`, amber-300 `#ffc94a`.

Amber is heavily reserved on this site: the primary "Start chatting" button owns
it. **This element should probably not use amber at all**, or should use it far
more quietly than a call to action does — if it competes with the button, it is
wrong. Consider whether it needs an accent colour at all.

**Type** — Fraunces (serif) for display, Plus Jakarta Sans for everything else.
Body text 14px minimum, 16px preferred.

## Technical constraints

* **React + Tailwind.** Express everything as Tailwind utilities using the token
  names above.
* **Icons: `lucide-react` only.**
* **No external assets whatsoever.** No CDN images, no remote SVG, no embedded
  donation widget or script. The site runs under a Content Security Policy of
  `default-src 'self'` which blocks all of them at runtime. This must be a plain
  link — the privacy policy states the site makes no third-party requests from
  the browser, and an embedded widget would make that sentence false.
* **No new dependencies.**
* Dark background only — the site has no light mode.
* Must work at 320px wide.
* Touch target at least 44px; visible focus state; contrast at least 4.5:1 for
  body text.

## Never include

* Any suggestion that paying unlocks something, improves matching, or removes
  anything. It does not.
* Fabricated numbers — supporters, amount raised, goals, "join 400 others".
* Testimonials or names of supporters.
* Countdown timers, limited-time framing, or any urgency device.
* Anything that could be mistaken for a paid advertisement or sponsored slot.
* Guilt framing — "we can't do this without you", "keep us alive".

## What to deliver

1. The About-page treatment, at 390px and 1440px.
2. The single-line menu treatment, at 390px and 1440px.
3. Hover, focus and active states for both.
4. Two or three copy options for the About treatment — a sentence or two each —
   with a note on which you would choose and why.
5. The Tailwind token names used for background, border, text and any accent.

If you conclude the strongest version of this is a single line of text with no
container at all, that is a legitimate answer. Say so and show it.
