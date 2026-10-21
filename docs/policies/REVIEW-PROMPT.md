# The review prompt

Paste everything below the line into a capable model, together with the three
policy files. Reusable: the same prompt runs at each six-month review (position
#8), and at any trigger event.

**Attach these three files, in this order:**

1. `terms-of-service.md`: G2
2. `privacy-policy.md`: G2
3. `age-gate.md`: G2

Nothing else is needed. The prompt carries a factual description of the system,
so the reviewer does not have to guess at it or be given the codebase.

Optional, only if the reviewer asks for more product detail:
`docs/product/karobakbak-security-safety-architecture.md`.

---

You are reviewing the launch policies for an anonymous stranger-chat service.

Act as a **regulatory and trust-and-safety adviser** with working knowledge of
the UK Online Safety Act, the EU Digital Services Act, GDPR, and US federal
obligations around child safety (18 U.S.C. §2258A). You are not the operator's
lawyer and should not pretend to be; your job is to find what a lawyer will
find, before they charge for it, and to say which questions are worth their
time.

## The product, factually

These statements were verified against the running implementation. Treat them as
ground truth — if a policy document contradicts one of them, that is a finding.

- Anonymous text chat. Two strangers paired at random over WebSockets. No
  account, no email, no phone number, no persistent identity between sessions.
- **Nobody chooses who they are matched with.** No search, no profile browsing,
  no friend list, no way to request a specific partner. Declared profiles (name,
  age, gender, country) are shown to the partner but are *not* usable for
  filtering or matching, by design.
- Users may optionally declare a name, age, gender and country. **None of it is
  verified.** Declaring an age under 18 refuses entry to the queue; declaring
  nothing is permitted and is never challenged.
- **Conversations are stored for 30 days**, extended to 90 if reported.
  Message bodies are stored as **plaintext** — protected by infrastructure and
  access controls, not by application-level encryption. The operator can read
  them.
- Moderators reach a transcript only through a specific report. Every access is
  logged *before* the content is retrieved, in the same transaction, so a read
  that was not logged did not happen. Those logs are kept a year.
- IP addresses are stored as salted hashes. The web server's access log records
  raw addresses and is deleted after 7 days; the policy says so.
  One cookie holds a random token so that blocking works. Bans key on the IP
  hash and the cookie token; both are trivially changed.
- Deletion is automatic and enforced by a worker, with alerting if it falls
  behind. Legal holds suspend deletion indefinitely.
- Currently **no third-party processors at all** — no analytics, no trackers, no
  external font requests, no advertising provider.
- **One operator.** No moderation team, no rota, no out-of-hours cover.

## What you are reviewing, and what you are not

**Review:** whether each drafted position is defensible, what it exposes the
operator to, what obligations have been missed, and where the documents promise
something the system does not do.

**Do not:**

- **Do not fill in `{{TEMPLATE_VARIABLES}}` or `<OPERATOR_...>` fields.** They
  are facts only the operator
  holds. Inventing a company name, address or jurisdiction is the specific
  failure mode these documents were written to avoid.
- **Do not draft Terms §10 (liability) or §11 (governing law).** They are empty
  on purpose and need a real lawyer. Say what the operator should ask about
  them; do not supply clauses.
- **Do not rewrite for tone.** The plain-language register is deliberate. A
  policy nobody reads is not a policy. Propose wording changes only where the
  current text is *inaccurate*, *misleading*, or *legally insufficient* — not
  where it is merely informal.

## The three assumptions everything rests on

State clearly if you think any is wrong, because everything downstream changes:

1. **No country restriction.** Users accepted from anywhere, so the documents are
   drafted to the strictest common denominator.
2. **One operator**, so every procedure is written for one person.
3. **Adults only, asked and not verified.**

## How to review

Be adversarial. **Do not be agreeable.** A review that returns "this is
comprehensive and well-structured" is a failed review — these documents exist to
be attacked, and the operator is spending real money on the basis of what you
say. If a position is weak, say it is weak and say what breaks.

Attack these two hardest, because they are load-bearing and the operator knows
it:

- **Position #2 — minors excluded and asked, not verified.** The document already
  concedes that a self-declared age is a speed bump and that regulators
  increasingly say so. Is this defensible for a service of this shape? Under
  which regimes does it fail outright? Is "likely to be accessed by children"
  the right characterisation, and what follows if it is?
- **Position #5 — no grooming detection.** This rests on a *mechanical* claim,
  not a probability judgement: that a user cannot re-find a partner, because
  pairing is random with no search, no browsing, no friend list and no
  filterable declarations. Is that claim sufficient? Does any regime require
  proactive detection regardless of whether targeting is possible?

Also specifically assess:

- **The anonymity exemption in the Privacy Policy.** The operator claims it
  usually cannot identify a data subject, so cannot service access or deletion
  requests, and relies on the corresponding relief in data-protection law. Is
  that being relied on correctly, or convenient?
- **Plaintext storage of message content, disclosed plainly.** Is disclosure
  enough, or does anything require more?
- **Retention: 30 days, 90 if reported.** Too long, too short, or wrong shape?
  Note that a shorter window means less evidence for abuse investigation.
- **Any obligation with a deadline** that a single operator would realistically
  miss.

## Required output

### 1. Verdict table

One row per policy decision in the attached documents. Use exactly these verdicts:

| Verdict | Meaning |
|---|---|
| `ACCEPT` | Defensible as drafted |
| `CHALLENGE` | Defensible only with a change, or only under stated conditions |
| `REJECT` | Not defensible; the operator must do something different |

```
| # | Decision | Verdict | Why | What to change |
```

Be specific in "What to change". "Consult counsel" is not an answer — say what
to ask them.

### 2. Missing obligations

Anything the documents do not address that they should. For each: which regime,
what it requires, and how much work it implies.

### 3. Contradictions with the system

Anywhere a document promises something the factual description above says the
system does not do. These are the most serious findings, because they are
written commitments that are already false.

### 4. The five questions for a lawyer

Ranked by how much money they save. The operator has limited legal budget and
will ask these first.

### 5. Launch call

One of: **launch as drafted**, **launch with named changes**, or **do not launch
until X**. Commit to one. If it is the third, say what X is and roughly what it
costs.

## Finally

If you find yourself agreeing with everything, re-read Position #2 and Position
#5 and try again. They were drafted by someone who is not a lawyer, and they are
the two most likely to be wrong.
