# The age gate — BUILT

The one piece of G2 that is code, and it now exists:
`frontend/src/components/AgeGate.tsx`, backed by `frontend/src/agegate.ts`,
mounted in `App.tsx`. The wording below is what shipped.

It was written down before it was built because what it should say depends on
the minor-safety position, and that position is now drafted: exclude minors
and ask. This screen is therefore the whole of the enforcement.

## What existed before it

Nothing on the landing screen mentioned age, terms or privacy. The only age
control was a field inside the optional profile editor: entering a number below
18 refuses the join, with its own error code and a safety counter. A user who
declared nothing was never asked. That field still exists and still refuses —
the gate is in front of it, not instead of it.

There **was** a false statement here, and it is fixed. The landing screen used
to read "No signup · No account · Nothing kept after you leave", which
contradicted the footer directly beneath it. That was finding F-016; the line
now reads "Your profile stays on this device", which says the true thing the
original was reaching for — the declaration is not kept server-side (D34) —
without making an unqualified retention claim.

Recorded here because a reviewer working from this document alone would
otherwise report a live false statement that no longer exists.

## What it does

A blocking interstitial before the first conversation, not a banner:

- States that the service is for over-18s.
- Requires an explicit action to continue. A button that says what it means —
  "I am 18 or over" — rather than a checkbox next to dense text.
- Links Terms and the Privacy Policy, both reachable **without** passing the
  gate.
- Records the acknowledgement in `localStorage` so it is asked once per browser,
  not once per conversation — carrying the *version* of the wording, so a
  material change re-asks and nothing else does.

## What it must not do, and does not

- **It must not claim to verify anything.** The copy states a requirement; it
  does not check one, and the code says so explicitly.
- It must not store the acknowledgement server-side. That would be a durable
  per-user record in a product whose design avoids exactly that
  (`DESIGN.md` §24.3), and it would be the beginnings of the cross-chat
  correlator the design forbids. `localStorage`, client-side, same as the
  profile.
- It must not be dismissible by pressing Escape or clicking outside. Every other
  dialog in this interface closes that way, so this one needs to be deliberately
  different.

## Where it went

`App.tsx`, rendered *over* the shell rather than instead of it — the socket
connects while the gate is up, because what the gate blocks is entering the
queue, not opening the connection.

It contributes to `overlayOpen`, so the global Enter and Escape shortcuts stand
down while it shows. Escape skips a conversation, and a keypress reaching past
this screen would act on a product the person has not been allowed into yet.

Storage access is guarded exactly as `preferences.ts` guards it, and **fails
towards showing the gate**: a private window or blocked site data means the
acknowledgement cannot be remembered, so the person is asked again. Asking twice
costs an interruption; failing the other way would remove the only control that
exists.

### The links are a deployment requirement

`VITE_TERMS_URL` and `VITE_PRIVACY_URL` are build-time values, empty in
development and **required in production** — `docker-compose.prod.yml` refuses
to build without them. A build that has neither shows a notice saying the
documents are not published rather than rendering links to nowhere, because a
gate citing a document that cannot be opened is worse than one that admits it.

## The wording

> **`DRAFTED POSITION` — the copy below.**
>
> The minor-safety position settles on "exclude minors, and ask", which makes
> this screen the entire enforcement. Its wording therefore carries more weight
> than any other string in the product, and it has one job: to be a statement
> the user actually read, rather than a dialog they dismissed.

```
                     You must be 18 or over

     karobakbak connects you with a randomly chosen stranger.
     We do not check anyone's age, and we cannot tell you who
     anyone is. Conversations are kept for 30 days so they can
     be investigated if someone reports them.

              [ I am 18 or over ]      [ Leave ]

              Terms · Privacy Policy
```

Four deliberate choices in that:

* **The heading is the requirement**, not a greeting. It is the one line that
  survives being skimmed.
* **"We do not check anyone's age"** is stated on the gate itself, not buried in
  the Terms. A gate that implies verification is worse than no gate — it
  manufactures a false sense of safety in the person who passes it.
* **Retention is mentioned here**, because this is the last moment before a
  conversation starts and F-016 exists precisely because the landing screen
  currently says the opposite.
* **`Leave` is a real button.** A gate whose only action is agreement is not a
  choice, and in some regimes not a valid one. It navigates away rather than
  silently closing.

## How often it is shown

> **`DRAFTED POSITION` — once per browser, for ever, until the copy changes.**
>
> Re-asking on a schedule would be theatre: the same person clicks the same
> button, and nothing about the second click is more truthful than the first. It
> would cost every returning user an interruption and buy nothing.
>
> The acknowledgement stores the **version** of the gate copy alongside the
> flag. If the wording materially changes — a different age, a different
> statement about what is kept — the version no longer matches and every user is
> asked again. That is the only re-ask that means anything: it tracks *what was
> agreed to*, not how long ago.

## Demonstrability — the open question for counsel

> **`FOR COUNSEL` — this is the one requirement that would force a server-side
> change, and it must be asked explicitly rather than assumed either way.**

The acknowledgement lives in `localStorage`. That is enough to *implement* a
gate and worth nothing as *evidence*: a client-side flag demonstrates nothing to
a regulator, and it is trivially removed by the user.

The question is whether any applicable regime requires the operator to
demonstrate that the gate was shown and accepted — not merely to show that the
product contains one.

The two answers lead to very different places:

| If counsel says | Then |
|---|---|
| Showing the gate is sufficient | Nothing changes. The `localStorage` flag stays and no record leaves the browser |
| Acceptance must be demonstrable | A server-side record is needed, and it collides with `DESIGN.md` §24.3 and D34 — a durable per-user record is the cross-chat correlator the design forbids. It would need to be an aggregate ("N acceptances of version X"), never per user, and even that needs designing rather than adding |

**Do not build the server-side record speculatively.** It is the one change here
that would reverse an architectural decision, and it is cheap to add later and
expensive to unpick.
