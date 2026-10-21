# Brand assets, and prompts for generating new ones

Three things live here: the mark as it exists today, the facts any generated
asset has to respect, and prompts you can paste into an image model.

---

## The mark as it stands

| File | What it is | Use it for |
|---|---|---|
| `logo-mark.svg` | The mark alone, transparent background | Anywhere the background is already dark |
| `logo-mark-plate.svg` | The mark on its rounded dark plate | Favicons, app icons, light backgrounds, anywhere small |
| `logo-lockup.svg` | Mark plus wordmark | Headers, covers, anything that needs the name |

The mark is drawn in three places and they must agree:
`frontend/src/components/Logo.tsx` (everything in the UI),
`frontend/public/favicon.svg` (the tab, slightly inset so the strokes clear the
plate's corners), and the SVGs here. **Change one, change all three.**

### What the mark is, and what it deliberately is not

Two arcs facing each other with a point between them. Two voices meeting.

It is **not a speech bubble**, and that is the whole design decision. Every chat
product is already a speech bubble; a generic mark is worth less than no mark.

The arcs are asymmetric on purpose, and in two ways: the answering arc is both
**shorter** and at half opacity. Two identical arcs read as decoration, or worse
as a loading spinner. One leading and one answering reads as a conversation.

The size difference is the half that survives greyscale — opacity alone very
nearly disappears there, and with it the whole "two voices" reading. If you
regenerate the mark, that is the property to keep.

`new-logo.png` is the source the current geometry was rebuilt from. The SVGs
here are hand-built arcs rather than a raster trace, so they stay clean at every
size; the PNG is kept as the reference they were measured against.

The plate is not decoration either. The strokes are thin, and at 16px an
unplated mark disappears into whatever colour the browser tab happens to be.

---

## The facts a generated asset must respect

### Palette

Copy these hex values into any prompt rather than describing the colours, which
models interpret loosely.

| Role | Hex | Notes |
|---|---|---|
| Background | `#13100b` | Near-black, warm. Not neutral grey, not blue-black. |
| Surface | `#1c1812` | Cards and panels. |
| Border | `#2a241c` | |
| Primary text | `#f7f5f3` | Warm off-white, never pure `#ffffff`. |
| Body text | `#b8ab97` | |
| Accent | `#ffb420` | The lead arc, buttons, the one bright thing. |
| Accent light | `#ffc94a` | The answering arc. |
| Sage | `#7fb069` | Presence dot only. Sparingly. |

The whole palette is warm. A cool grey or a blue-tinted black is the single
easiest way to make a generated asset look like it belongs to a different
product.

### Type

- Display: **Fraunces**, weight 600, tight tracking. Serif.
- Body: **Plus Jakarta Sans**.
- Mono: **JetBrains Mono**, used for labels and numbers.

The name is **lowercase everywhere**, including at the start of a sentence:
`karobakbak`, never `Karobakbak` or `KaroBakBak`. It is a word, not a proper
noun being announced.

### Tone

Warm, plain, unhurried, and honest about limits. The product is anonymous
text-only chat with strangers. It is not neon, not cyberpunk, not "connect with
the world", and there are no photographs of smiling people.

---

## Prompt — logo

Use this if you want alternatives to the current mark. Paste `logo-mark.svg`
alongside it as a reference image where the tool accepts one.

```text
Design a minimal vector logo mark for "karobakbak", an anonymous text-only
chat service that pairs two strangers at random for one conversation.

Concept: two voices meeting. Two arcs facing each other with a single small
point between them — the thing passing between them. The two arcs must be
asymmetric in two ways: one taller, solid and confident; the other visibly
shorter and quieter at about half opacity, so the pair reads as one voice
leading and one answering rather than as a symmetrical ornament. The size
difference matters more than the opacity, because it is the half that survives
greyscale.

Hard constraints:
- NOT a speech bubble, NOT a chat balloon, NOT two overlapping bubbles. Every
  competitor is already that.
- NOT a circular ring or arc pair that reads as a loading spinner.
- No gradients, no 3D, no bevels, no drop shadows, no glow.
- Flat vector, rounded stroke caps, even stroke weight.
- Must survive at 16x16 pixels: no detail that disappears when small.
- Two colours only: #ffb420 for the leading element, #ffc94a at 50% opacity for
  the answering one. Background #13100b.
- Square canvas, generous padding, mark centred.

Style: geometric, calm, warm. Closer to a well-made typographic ligature than to
a tech startup icon. Flat, no texture.
```

### If you want the wordmark too

Append:

```text
Also produce a horizontal lockup: the mark on the left, the word "karobakbak"
to its right in a serif face similar to Fraunces at weight 600, tight letter
spacing, colour #f7f5f3. The word is always entirely lowercase.
```

---

## Prompt — cover image

For the social card, the Buy Me a Coffee header, or a repository banner. Set the
aspect ratio in the tool rather than in the prompt — 1200×630 for a social card,
1500×500 for a wide banner.

```text
A wide, minimal, atmospheric cover image for "karobakbak", an anonymous
text-only chat service where two strangers are paired at random.

Composition: a very dark warm background, near-black at #13100b, with two soft
out-of-focus circular glows — one warm amber #ffb420, one muted sage #7fb069 —
drifting toward each other from opposite sides but never touching. Large areas
of empty dark space. The glows are diffuse and low-opacity, like light through
frosted glass, not lens flares and not neon.

Mood: quiet, warm, late evening, a little lonely but not bleak. Two people about
to speak.

Hard constraints:
- No text, no letters, no logos, no watermarks.
- No people, no faces, no hands, no silhouettes.
- No speech bubbles, no chat interfaces, no phone or laptop mockups, no UI.
- No cyberpunk, no neon grid, no circuitry, no network-of-nodes graphic.
- No blue. The palette is warm: amber, cream, deep brown-black.
- Flat and photographic-soft, not illustrated, not 3D rendered.
- Leave the centre and lower third uncluttered so a wordmark can be placed over
  it later.
```

### Why "no text" is in the prompt

Image models set type badly and inconsistently, and the name is lowercase in a
specific serif. Generate the background, then place `logo-lockup.svg` over it —
you get a correct wordmark and a reusable background.

---

## The Buy Me a Coffee button

`frontend/public/buymeacoffee-button.svg` is the vendor's own rendered button,
fetched once and served from our origin. Re-fetch it if the branding changes:

```bash
curl -sL -o frontend/public/buymeacoffee-button.svg --get   --data-urlencode "text=Buy me a coffee"   --data-urlencode "emoji=coffee"   --data-urlencode "slug=<your-slug>"   --data-urlencode "button_colour=FFDD00"   --data-urlencode "font_colour=000000"   --data-urlencode "font_family=Cookie"   --data-urlencode "outline_colour=000000"   --data-urlencode "coffee_colour=ffffff"   "https://img.buymeacoffee.com/button-api/"
```

(The real `emoji` value is the coffee character; it is spelled out here so the
line survives a copy-paste through a terminal that mangles it.)

**Do not use the `<img src="https://img.buymeacoffee.com/...">` snippet the
vendor gives you.** Two reasons, and the second is the one that matters:

* `img-src` is `'self' data:` plus the payment provider, so it would simply be
  blocked and render as a broken image.
* Widening the policy to admit it would make a published claim false — the
  Privacy Policy says the site makes *no requests to any third party* from the
  browser — and it would hand Buy Me a Coffee every visitor's IP address and
  referring page, on every render, without anybody clicking. On an anonymity
  product that is a real leak, not a technicality.

The downloaded file is self-contained: the Cookie face is a `data:font/woff2`
inside it and the cup is an internal reference, so nothing leaves the page. If a
future version of the button pulls something remote, it stops being usable this
way — check before replacing it.

---

## Checking a generated asset before you use it

1. Shrink it to 16px. If the mark becomes a smudge, it fails — that is the size
   it will spend most of its life at.
2. Convert to greyscale. The two arcs should still read as two distinct
   elements; if the only thing separating them is hue, it will fail for anyone
   with low vision and in every print context.
3. Put it on `#13100b` **and** on white. The plate variant exists because the
   unplated mark disappears on light backgrounds.
4. Check the warmth. Beside `#13100b`, a generated near-black is very often
   cooler, and the mismatch is obvious the moment they sit side by side.

---

## The share card

`frontend/public/og-image.png` is the 1200×630 image WhatsApp, Instagram,
Facebook, X and Discord show when somebody shares a link. It is a render of
`og-card.html` in this directory: the mark from the lockup, the landing page's
headline, in the palette above. Everything important sits in the central
square, because some apps crop the card to one.

Regenerate it after changing the card, from the repository root:

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --hide-scrollbars   --allow-file-access-from-files --window-size=1200,630   --screenshot="$PWD/frontend/public/og-image.png" "file:///$PWD/docs/brand/og-card.html"
```

The fonts load from `frontend/node_modules/@fontsource`, so run
`npm run install:all` first or it renders in a fallback serif. Apps cache a
card per URL for days; after a change, Facebook's Sharing Debugger and X's
card validator force a re-fetch.

