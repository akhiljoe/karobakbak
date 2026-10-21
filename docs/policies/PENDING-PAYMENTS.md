# PENDING — policy changes that ship with payments

**Not published text.** This file holds the exact edits that must land in the
published policies **in the same commit** that flips `PAYMENTS_ENABLED` — the
compiled-in constant in `frontend/src/features.ts` and the `PAYMENTS_ENABLED`
environment variable the backend reads. Until then the documents as published
are correct and this file is a staged patch.

`scripts/verify-pending-policy.mjs` asserts every anchor below still exists. If
you edit a policy in a way that moves one, the build fails and the fix is to
update this file in the same commit — not to delete the anchor.

## Why this is staged rather than applied

Two sentences in the published privacy policy stop being true the moment a
checkout can open, and one of them is the strongest privacy claim the product
makes:

* "our pages make **no requests to any third party**"
* "There is no payment provider, because nothing is for sale."

Publishing those changes before payments work would be false in the other
direction, describing a payment provider that processes nothing. What still
blocks the flip is operator decisions, not code (see the checklist at the end).

## The unresolved question this patch does not answer

Terms §15 already carries a maintainer note about a **merchant of
record** rather than a bare payment processor. **Razorpay is a bare payment
processor.** With it, the operator is the seller of record and personally owns
cross-border tax, invoicing and refunds — which is precisely what that note
warned about, written before anything was built.

That is a business decision, not a drafting one, and this patch does not make
it. The text below is written for the integration that exists. If the choice
goes the other way, §15 changes again and so does the processor table.

---

## 1. Privacy — "What we deliberately do not collect"

**Anchor:** `make no requests to any third party`

Already narrowed once, by sign-in: the claim is now about *our pages* rather
than about the browser, because signing in deliberately takes you to another
origin. Payments narrow it a second time, and differently — the payment form is
loaded **into** our page, which is the thing this sentence is really about.

> No phone number and no password — we never see one, because signing in is
> handled by an outside provider and we are told only that it succeeded. No GPS or
> device location, no location history, and no stored IP address — the only
> location data that exists is the country you may choose to declare, and whatever
> an IP address implies while you are connected. No device fingerprinting. No
> advertising or analytics trackers, and **unless you choose to
> pay for something, our pages make no requests to any third party**, including
> for fonts. The payment form is the single exception, it is loaded only when you
> open it, and it is described under "Other companies".
>
> Chatting still requires no account of any kind. If you choose to sign in, see
> "If you sign in" above for the short list of what that adds.

## 2. Privacy — the cookie note

**Anchor:** `One cookie, nothing loaded from a third party into your browser, no analytics,`

The parenthetical currently says the model provider is reached from our servers
and therefore sets nothing. That stays true and is no longer the whole picture:
the payment form runs in the browser and does set its own storage.

Replace the paragraph under "Why we treat that cookie as strictly necessary"
with:

> One cookie, nothing loaded from a third party into your browser unless you
> open the payment form, no analytics, no advertising identifiers, and its sole
> function is making a safety feature work. (The model provider named under
> "Other companies" is reached from our servers, never from your browser, so it
> sets nothing and sees no cookie. The payment provider is the opposite case: it
> runs in your browser, it sets its own storage, and it does so only after you
> choose to pay. Nothing it sets is readable by us.)

## 3. Privacy — "Other companies"

**Anchor:** `## Other companies`
**Anchor:** `**Only these, and each only when you use the feature it serves.**`

Replace the heading paragraph and extend the table:

> **Only these, and each only when you use the feature it serves.**
>
> | Company | What it does | What it receives |
> |---|---|---|
> | `{{MODEL_PROVIDER}}` | Writes the replies for our automated accounts | The messages in that conversation, and the description of the character it is playing |
> | `{{PAYMENT_PROVIDER}}` | Takes the payment, if you buy something or send a donation | What you type into their payment form, which we never see. From us it receives an amount, a currency and a random reference number |
>
> We require terms that forbid training on what we send.
>
> We never receive your card number, your CVV, or the name on your card. Those
> go from your browser to the payment provider directly. What comes back to us
> is that a payment of a given amount succeeded or failed, against a reference
> number that means nothing outside our own records.

`{{PAYMENT_PROVIDER}}` **is a template variable on purpose**: the same rule as
`{{MODEL_PROVIDER}}`. Naming a processor that is not the one live is worse than
an obvious gap, and the choice between a bare processor and a merchant of record
is still open (see above).

## 4. Privacy — the "everything else is still none" list

**Anchor:** `- Our pages make **no requests to any third party** from your browser — no`
**Anchor:** `- There is no payment provider, because nothing is for sale.`

The first bullet narrows again; the second is deleted outright and replaced.
The sign-in bullet that used to sit here is gone already — sign-in shipped, and
it is a row in the table rather than an absence.

> - Our pages make **no requests to any third party** from your browser other
>   than the payment form, and only once you open it — no analytics, no
>   trackers, no advertising, not even external fonts. Signing in is a separate
>   and deliberate exception: you are taken to the provider's own page, you can
>   see it in the address bar, and you chose to go there. Your profile picture
>   is relayed by us rather than loaded from them, so that browsing this site
>   never tells them you were here.
> - The payment provider is named in the table above. It is reached only from
>   the payment form, and never from the chat.
> - Moderation of what users send runs on our own servers, on rules rather than
>   on an outside service.
> - Nothing is sent to any outside logging or error-reporting service.

## 5. Privacy — a new subsection under "What we collect"

**Anchor:** `### What we deliberately do not collect`

Insert immediately **before** that heading:

> ### If you pay for something
>
> A record that a payment happened: an amount, a currency, which product it was
> for, the payment provider's reference numbers, and — for a subscription — the
> account it belongs to. No card details, no billing address, no name.
>
> If you send a donation, no account is involved and nothing links the payment
> to any conversation. If you buy a subscription, it is attached to your
> account and to nothing else: not to a session, not to a conversation, not to
> a message. There is no column anywhere that could join a payment to something
> you said.
>
> The note you can type on the support page is passed to the payment provider
> and **is not stored by us**. There is no field for it in our database.
>
> These records are kept longer than anything else here, because a financial
> record has a retention period set by law rather than by us:
> `{{PAYMENT_RECORD_RETENTION_PERIOD}}`.

## 6. Terms — §15 "Paying for things"

**Anchor:** `## 15. Paying for things`
**Anchor:** `The service is free. There is nothing to buy, no subscription, and we take no`

Replace the section body. The maintainer note stays: its merchant-of-record
question is still live, not resolved.

> Chatting is free and stays free. Premium is optional, costs
> `{{PREMIUM_PRICE}}` a month, and adds matching filters and nothing else — it
> does not change how anyone is moderated, reported or protected.
>
> Payment is taken by `{{PAYMENT_PROVIDER}}`. We never see or store your card
> details. Your subscription is attached to your account and to nothing you say.
>
> Premium runs for the period you paid for. **[BILLING MODEL — see the note
> below: this sentence depends on a decision that has been taken but not built.]**
>
> Donations are voluntary, buy nothing, and grant nothing.
>
> **Refunds:** `{{REFUND_POLICY}}`

`{{REFUND_POLICY}}` is a template variable and must stay one until there is a
decision. India's consumer protection rules expect a published policy; inventing
plausible-sounding terms here would be exactly the failure mode this document
set has already had once.

> **`OPERATOR DECISION` (2026-09-04) — Premium will be a subscription that
> renews by default. The code is one-off only.**
>
> This is recorded before the code exists precisely so the policy is not written
> twice. A draft refund policy already existed saying "Premium does not
> automatically renew" — true of the code today, false of the intended product,
> and publishing it would repeat the ordering mistake this document set warns
> about elsewhere: ship a claim, then reverse it in front of the people who
> relied on it. Payments have never launched, so that can be avoided entirely by
> deciding the billing model first and publishing the policy once.
>
> **What renewal drags in, none of which is written yet:**
>
> * **RBI recurring-payment rules.** An e-mandate has to be registered, a
>   pre-debit notification sent before each charge, additional factor
>   authentication applied above the threshold, and the mandate must be
>   cancellable. Razorpay Subscriptions carries much of this; the merchant still
>   carries obligations, and this is the part most likely to be discovered late.
> * **Explicit consent.** Consumer Protection (E-Commerce) Rule 4(9) forbids
>   recording consent by pre-ticked box. Auto-renewal must be an affirmative act,
>   which is a checkout design constraint rather than a paragraph.
> * **A cancellation control that exists.** Today there is nothing to cancel and
>   saying so is honest. With renewal, "cancel" has to be a control in the
>   product, not an instruction to send an email.
> * **Entitlement arithmetic.** A renewal must *extend* `premium_until` rather
>   than overwrite it, a failed renewal needs a stated grace period, and the
>   refund clawback in `fulfilCapture` — which today subtracts one grant period —
>   needs per-cycle semantics.
> * **Price changes.** Raising the price for an existing subscriber is a notice
>   obligation, not a config edit.
>
> The refund policy is therefore **deferred rather than drafted**, and the next
> attempt should describe a renewing subscription from the first sentence.

## 7. Terms — §7 "What you send, and what is ours"

**Anchor:** `## 7. What you send, and what is ours`

No change needed, and that is worth recording so the next reader does not go
looking: a payment is not something a user "sends" in the sense §7 means, and
the section is about message content.

---

## Checklist for the commit that applies this

1. `frontend/src/features.ts` — `PAYMENTS_ENABLED = true`.
2. `PAYMENTS_ENABLED=true` plus the three Razorpay variables in the deployment.
   `assertCoherent` refuses to start without them, and refuses a `rzp_test_` key
   in production.
3. Apply `backend/src/storage/migrations-pending/011_payments.sql`. Accounts
   shipped with phase 20 and `010_accounts.sql` is already applied, as is
   `017_premium_entitlement.sql` — the `premium_until` column moved there so the
   entitlement could be *enforced* before anything could be bought. This
   migration now adds only the order and event tables.
4. Every `{{TEMPLATE_VARIABLE}}` above filled in.
5. The merchant-of-record question above recorded as decided.
6. 14 days' in-product notice before the privacy changes take effect.
7. Delete this file. `verify-pending-policy.mjs` then no-ops for it.
