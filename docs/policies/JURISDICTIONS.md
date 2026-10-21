# Which countries to serve — the decision, and what it costs

**Status: analysis for the operator, to be verified by counsel. Not legal
advice, and not written by a lawyer.**

Read this as *shape and cost drivers*, not as a statement of current law.
Platform regulation is moving fast in every jurisdiction below, and anything
here that decides real money should be confirmed rather than trusted. What it is
good for is knowing which questions are worth paying to have answered.

**The operator is in India.** That single fact drives most of what follows, and
it changes the answer more than any other input.

---

## 1. The part you cannot opt out of

You can block users from a country. **You cannot block yourself out of your own
country's law.** Being resident in India means Indian obligations attach to you
personally and to the service, whoever the users are and wherever it is hosted.

So India is not a market decision. It is the floor.

What that floor appears to involve — verify each:

| Regime | What it means here |
|---|---|
| **IT Rules 2021** (intermediary due diligence) | Publish rules, privacy policy and user agreement. Appoint a **Grievance Officer** with a *published* name and contact, acknowledging complaints within 24 hours and resolving within 15 days. Act on government/court takedown orders within the specified window. Following this is what preserves safe-harbour protection under IT Act s.79 — losing it means being treated as the publisher of what users say |
| **DPDP Act 2023** | Consent and notice obligations. Defines a **child as under 18** and requires verifiable parental consent to process their data, plus restrictions on tracking and targeted advertising toward children |
| **POCSO Act** | **Mandatory reporting.** Broadly, a person with knowledge or apprehension of a sexual offence against a child must report it to the Special Juvenile Police Unit or local police, and *failing to report is itself an offence*. This attaches to you as a person, not to a company |
| **IT Act s.67B** | Publishing or transmitting material depicting children in sexually explicit conduct. Serious criminal exposure |

Two things follow immediately, and both correct drafts already written.

### The CSAM escalation route in the earlier minor-safety procedure pointed at the wrong country

The earlier escalation table named **NCMEC** and **IWF** and treated the local
route as a
placeholder. For an India-based operator that is backwards. The primary
obligation is **POCSO reporting to Indian police / the SJPU**, with the National
Cyber Crime Reporting Portal (`cybercrime.gov.in`) as the practical channel.

NCMEC becomes relevant mainly if hosting in the US brings you inside the US
provider definition — which is a hosting decision, not a given. That row needs
rewriting once hosting is settled.

**This matters more than most items on the reviewer's list**, because POCSO
non-reporting is a personal criminal exposure with a short fuse, and the
procedure currently tells you to contact the wrong body.

### Drafted position #13 ("publish no response time") is probably wrong for India

It was drafted on the reasoning that a solo operator should not publish a
commitment they cannot keep. Sound in general — but the IT Rules appear to
*require* a published grievance mechanism with defined timelines and a named
officer. If so, the choice is not whether to publish a number but which number,
and the "no public commitment" position has to go.

Worth noting the shape of the trap: **the obligation is to acknowledge, not to
resolve.** A 24-hour acknowledgement can be automated. A 15-day resolution is a
human commitment. Those are very different costs and should not be conflated.

### The "child is under 18" alignment is a small piece of good news

DPDP's under-18 threshold matches the 18+ rule the product already states, so
the age floor does not need re-deciding for India. The gap is the same one the
reviewer identified: stating it is not checking it.

---

## 2. What the expensive markets actually cost

The cost of a market is not "compliance" in the abstract. It is a small number
of concrete, mostly recurring line items.

### The EEA — the most expensive per user you do not have yet

Two separate regimes each require a **designated representative established in
the EU** when the service provider is outside it: one under the DSA for
intermediary services, one under GDPR Article 27. These are commercial services
with an annual fee, and they are not optional add-ons — they are a precondition
of offering the service there.

On top of that sit the DSA obligations the reviewer listed: notice-and-action,
statements of reasons when you restrict someone, contact points, and Article 28
measures for minors' safety where the platform is accessible to them.

**Blocking the EEA removes two mandated paid representatives and the whole DSA
work item in one configuration change.** Of everything in this document, this is
the single largest saving relative to effort.

### The UK — the most active regulator for exactly this product shape

The Online Safety Act reaches services with UK links regardless of where the
operator sits, and Ofcom has been explicit that it will pursue them. For a
user-to-user service the duties include a children's access assessment and an
illegal-content risk assessment as *retained written artefacts*, not
conclusions you reach privately.

The specific problem for this product is the one the review identified: a
terms-only "18+" statement does not establish that children cannot access the
service. Without effective age assurance you proceed on the basis that they can,
and the children's duties follow.

A UK GDPR representative may also be required.

**Blocking the UK removes the regime most likely to be enforced against a random
stranger-chat service, run by the regulator most interested in the category.**

### The US — genuinely mixed, and the one worth thinking about rather than reflexing

Favourable: s.230 intermediary protection has no equivalent elsewhere, and there
is no representative requirement.

Unfavourable: **§2258A reporting duties attach to providers**, so US hosting
pulls you into that regime whether or not you serve US users. State-level
age-verification laws have been multiplying, and they vary.

It is also the market most likely to be worth actual money.

Do not settle this until hosting is settled, because hosting decides half of it.

### Everywhere else — lighter, and this is where the users are anyway

Most of South and Southeast Asia, Latin America and Africa have privacy statutes
of varying strictness and comparatively little platform-specific regulation of
this kind. Brazil's LGPD is GDPR-shaped and worth its own look if Brazil matters
to you.

For a product with no revenue and no marketing budget, this is where a
population would realistically come from regardless.

---

## 3. The recommendation

**Launch with the EEA and the UK blocked. Decide the US alongside hosting. Serve
everywhere else.**

The reasoning is not that those users do not matter. It is that they are the
only ones who currently cost money *before* you have any:

* two mandated paid representatives (EU DSA + EU GDPR, plus possibly UK GDPR),
* two statutory written risk assessments,
* a notice-and-action and statement-of-reasons mechanism,
* the age-assurance question in its sharpest form.

None of that scales with how many users you have. All of it is owed on day one
for a single user in those regions.

**This is the answer to the cost question asked at the very start of this
work** — "no country restriction, it depends on cost". Accepting everyone is the
expensive option, and this is what it costs.

Reopen the decision when there is revenue to pay for it. Geography is a
configuration change in both directions, which is precisely what makes it the
right lever to pull first.

---

## 4. What geo-blocking does and does not have to achieve

**It does not have to be perfect.** Regulators are generally concerned with
whether a service *targets* a market — local language, local payment methods,
marketing, a local presence. A determined user on a VPN is not usually treated
as a compliance failure by a service that took genuine measures and does not
solicit that market.

What that means practically:

* **Do block by IP geolocation at the edge**, and say so in the Terms.
* **Do not market to, price for, or localise for** a blocked market. Targeting
  undoes the block far more effectively than a VPN does.
* **Do not** build increasingly desperate VPN detection. It is an arms race with
  no defensible finish line, it will block legitimate privacy-conscious users —
  who are disproportionately your audience — and it is not what the obligation
  asks for.

A blocked user should get a plain page saying the service is not available in
their country. Not an error, and not a challenge to route around.

---

## 5. Implementing it, in this codebase

**Do it at the edge, not in the application.** Country lookup on the message
path is exactly the kind of work D16 keeps out of the hot path, and a blocked
request should never reach a backend at all.

Two options in increasing order of cost:

1. **A CDN or proxy that does country blocking** — the common ones expose it as
   a rule with no code at all, and several offer it on a free tier. Cheapest by
   a wide margin, and it also absorbs the blocked traffic before it costs you
   anything.
2. **nginx with a GeoIP module** at `frontend/nginx.conf`, refusing before the
   WebSocket upgrade is proxied.

### One trap specific to this codebase

`clientAddress()` in `backend/src/ws/upgrade.ts` reads `X-Forwarded-For`
**counting from the right**, by exactly `TRUST_PROXY_HOPS` entries — deliberately,
because reading the leftmost entry would let any client choose its own
rate-limit bucket and shed its blocks with a header.

**Putting a CDN in front adds a hop.** If `TRUST_PROXY_HOPS` is not increased to
match, every address resolves to the wrong entry: rate limits, blocks and bans
all key on something a client controls. The `Caddyfile` comment already records
that the current chain was *measured* rather than assumed — do the same
measurement again after adding anything in front, and do it before launch rather
than after.

There is no need to store or log the country. The block happens before the
connection exists, and the declared country in the profile remains what it has
always been: a claim, not a location (D37).

---

## 6. What this does not fix

Blocking the UK and the EEA removes the regimes with the sharpest child-safety
requirements. **It does not remove the child-safety problem**, and it would be a
mistake to read it that way.

India's own DPDP treats under-18s as children. POCSO reporting duties apply to
you personally. And the reviewer's substantive point stands independently of any
regulator: a service that pairs strangers at random, with no effective age
check, can put a child in a private conversation with an adult.

The floor is worth doing whatever the geography decision is, and it is small:

1. Correct the false statements in the published documents *(in progress)*.
2. A real age gate before the first conversation — a statement, not verification.
3. A report mechanism that works and is actually read.
4. A written CSAM procedure pointed at **Indian** authorities, prepared before it
   is needed.
5. A named grievance officer and a published contact, which India appears to
   require anyway.

That is days of work, not months. Everything else waits for users and revenue.
