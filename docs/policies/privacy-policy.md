# Privacy Policy

**Status: draft. Not published.**

Fields written as `<OPERATOR_...>` and `{{TEMPLATE_VARIABLES}}` are facts only
the operator of a deployment holds. They must be filled in before this policy
is published.

In this service, **"we" is karobakbak**, the trading name of the operator,
`<OPERATOR_NAME>`, registered in India under registration number
`<OPERATOR_REGISTRATION>`, contactable at `contact@karobakbak.com`.

Who is responsible for your data:

- Legal name: `<OPERATOR_NAME>`, trading as karobakbak
- Role: Data Fiduciary under the Digital Personal Data Protection Act, 2023
- Business structure: `<OPERATOR_BUSINESS_STRUCTURE>`
- Country: India
- Email: `contact@karobakbak.com`
- Phone: `<OPERATOR_PHONE>`

---

**Last updated:** `7 September 2026`

## The short version

- You do not need an account. We never require your name, email, or phone
  number, and there is nothing to sign up for. You *may* choose to enter a name
  to show the person you are matched with — that is optional, we do not check
  it, and it does not have to be your real one.
- **We do store your conversations for 30 days.** If someone reports a
  conversation, we keep it for 90 days so it can be investigated.
- We keep a scrambled version of your IP address for limits, blocks and bans.
  Our web server's access logs record the address itself, and those logs are
  deleted after 7 days.
- We do not sell anything about you. Your conversations leave this service in
  only two cases, both listed under "Other companies": when you talk with one
  of our automated accounts, and when a conversation you are in is reported.
- The stranger you talked to never receives anything that identifies you.
- We cannot normally work out who you are either — but read "What we collect"
  before treating that as absolute. We keep a scrambled fingerprint of your
  network address, and honesty about it is worth more to you than a flat
  promise we could not stand behind.

## What we collect

### Your messages

The text you send is stored in our database, along with when it was sent and
which conversation it belonged to.

**These are stored as ordinary text, not encrypted by the application.** They
are protected by the security of our servers and our access controls, not by
encryption that would make them unreadable to us. We can read them, and we do
when a conversation is reported. We are telling you this plainly because a
service that says "encrypted" while somebody can still read your messages has
told you something false.

Kept for **30 days**, or **90 days** if the conversation is reported.

### Messages in a conversation with one of our automated accounts

When your partner is one of our automated accounts (Terms section 3a), what you
type is also sent to the company that provides the language model behind it, so
that it can write a reply. There is no way around this — it has to read what you
wrote in order to answer.

That happens **only** in conversations with an automated account. When you are
talking to another person, nothing you type leaves our own servers.

The companies we use for this are named below under "Other companies". We
require terms that forbid them training on what we send.

### A scrambled version of your IP address

Your IP address is combined with a secret value and turned into a fingerprint
that cannot be reversed back into an address. **The fingerprint is what we
keep.** The one exception is our web server's access log, which records the IP
address of each request so that problems and abuse can be investigated. Those
logs are deleted automatically after 7 days.

The fingerprint is what makes it possible to apply rate limits, to honour a
block, and to enforce a ban. It is stored:

- while you are connected, to enforce limits;
- for up to 30 days, if you block someone or someone blocks you;
- for up to 90 days, if a moderator bans that fingerprint.

### A cookie

One cookie, holding a random value that means nothing on its own. It exists so
that blocking works — if you block somebody, we need some way to avoid matching
you with them again, and this is the only way to do that without knowing who
either of you is.

It cannot be read by JavaScript, it is not used for advertising, and it is not
shared with anyone. It lasts 30 days.

If you sign in there are two more, and only then: one that lasts ten minutes
while you are being sent to the sign-in provider and back, and one that keeps
you signed in afterwards. Both are random values, neither can be read by
JavaScript, and signing out deletes the second. Nobody who does not sign in ever
receives either. "Cookies and what your browser stores" below sets out
everything else your browser keeps and why none of it reaches us.

### Anything you choose to tell us about yourself

Before you start chatting you can optionally enter a name, age, gender and
country. All of it is optional and none of it is checked — we have no way to
know whether any of it is true, and you should assume the same about whatever a
stranger tells you.

If you enter any of it, it is shown to the people you are matched with and is
stored with the conversation record for the same 30 or 90 days. It is kept in
your own browser between visits, so you only type it once; it is never stored
against you on our servers between sessions.

### Reports

If you report a conversation, we store the category you chose, any note you
wrote, and which conversation it referred to. Your note is treated exactly like
a message — it is your own words, and it is handled with the same care.

Kept for **90 days**.

### If you sign in

Signing in is optional and free, and chatting never needs it. It exists so that
the strangers you chose to save, and your recent conversations, survive closing
the tab.

We use an outside sign-in provider, so **we never see a password**. When you
sign in we receive:

- an opaque identifier for you from that provider, which is what your saved
  connections hang off. It means nothing anywhere else.
- your email address, which is used to confirm the provider verified it and is
  then discarded. It is not stored.
- if you have one, the address of your profile picture. Your picture is shown
  only to you, on your own account control. It is never shown to anyone you
  chat with, it is never stored on our servers, and your browser never contacts
  the provider to fetch it — we relay it, so that opening this site does not
  tell them you were here. Signing out discards it immediately.

What signing in does **not** do: it does not attach your name, your email or
your picture to anything you say. Conversations are not linked to your account,
and nobody you are matched with learns that you have one.

### People you have blocked

Blocking is enforced by two scrambled keys — one from your address, one from a
cookie — and both of those change, so a block has always been impossible for you
to find again afterwards.

If you are signed in when you block somebody, we record which account made the
block, so that you can see your blocks and undo one. What is stored is your
account, the scrambled keys, and the date. **Not who they were**: the person you
blocked is a scrambled key to us as well, they may have no account at all, and
we do not work out who they are in order to show you a list.

It is deleted when the block expires, which is 30 days, so the record cannot
outlive the block it describes. Blocking while signed out works exactly as
before and is not recorded against anybody.

### What we deliberately do not collect

No phone number and no password — we never see one, because signing in is
handled by an outside provider and we are told only that it succeeded. No GPS or
device location, no location history, and no stored IP address beyond the
7-day web server logs described above. The only
location data that exists is the country you may choose to declare, and whatever
an IP address implies while you are connected. No device fingerprinting. No
advertising or analytics trackers, and
**our pages make no requests to any third party**, including for fonts.

Chatting still requires no account of any kind. If you choose to sign in, see
"If you sign in" above for the short list of what that adds.

## Why we keep conversations at all

Because an anonymous chat service with no record is a service where nothing can
be investigated. If somebody threatens you, harasses you, or sends something
illegal, "we keep nothing" means "we can do nothing".

That is the trade, and it is deliberate. The window is kept short — 30 days —
so that the record exists long enough to act on and not longer.

## Who can see your conversations

**This service is run by one person**, and how that person reaches a
conversation depends on who was in it. There is no moderation team. We would
rather you knew the true size of the answer than pictured a department.

The controls on that are not just policy:

- **A conversation between two people** is opened only when one of them reports
  it. There is no browsing, no search across conversations, and no way to pull
  up a random chat. **A conversation with one of our automated accounts is
  different — we may open those at any time**, to check they are behaving
  properly. One side of that conversation is ours and the other side is yours,
  and reviewing our own writing means reading yours alongside it.
- **Every single access is logged before the content is retrieved**, together
  with who looked and why. A read that was not logged does not happen — the
  system is built so that the log failing means the content is not returned.
- Those logs are kept for a year.
- The moderation system runs as a separate service with its own database
  credentials, which cannot delete anything, and the chat service's credentials
  cannot read the moderation accounts.

The stranger you talked to sees only what you typed and whatever you chose to
declare. They never receive anything that identifies you.

## How long we keep things

| What | How long |
|---|---|
| Conversations and messages | 30 days |
| Conversations that were reported | 90 days |
| Reports | 90 days |
| Automated moderation records | 90 days |
| Bans | 90 days |
| Blocks | 30 days |
| Moderator access logs | 1 year |
| Encrypted database backups | 7 days (7 daily backups, oldest pruned) |

Deletion is automatic, not a promise to remember. A background worker removes
expired data on a schedule, and if it ever fails, an alert fires.

**One exception:** if data is subject to a legal hold — an ongoing
investigation, a law-enforcement request — deletion is suspended until the hold
is lifted. Holds record who placed them and why.

## Backups

Backups are encrypted before they are written, using a passphrase held
separately from the data. Seven daily backups are kept; the eighth is removed
automatically.

Deleted data may persist in a backup until that backup is rotated out, so
ordinary expiry finishes clearing a backup within seven days of the deletion.

Two things are outside that. Anything under a **legal hold** is not deleted at
all while the hold stands, so no clock is running on it. And a **reported**
conversation is on the 90-day window rather than the 30-day one before any of
this begins.

## Cookies and what your browser stores

Almost everything the site remembers about you is kept **in your own browser and
never sent to us**. It is worth separating the two, because most privacy
policies do not and the distinction is the whole point here.

**The one cookie we set:**

| Cookie | What it is for | How long |
|---|---|---|
| Block token | A random value that means nothing on its own. It is the only way to honour a block without knowing who either person is. | 30 days |

It cannot be read by JavaScript, it is not used for advertising, and it goes
nowhere else.

**Stored in your browser only — we never receive any of it:**

| Where | What | Cleared when |
|---|---|---|
| `localStorage` | Your acknowledgement of the age statement, and which version of it you agreed to | You clear site data |
| `localStorage` | Anything you chose to declare — name, age, gender, country — so you type it once | You clear it, or clear site data |
| `localStorage` | Interface preferences you have set | You clear site data |
| `sessionStorage` | A single-use token that lets you reclaim your conversation if your connection drops | You close the tab |

The reconnection token deserves a note. It is deliberately in `sessionStorage`
rather than `localStorage` so it dies with the tab, exactly as the conversation
does. We hold only a one-way scramble of it, it works once, and it is replaced
each time it is used.

You can clear all of this from your browser settings at any time. Doing so will
make the age statement appear again and will forget anything you declared.

**Why we treat that cookie as strictly necessary:**
One cookie, nothing loaded from a third party into your browser, no analytics,
no advertising identifiers, and its sole function is making a safety feature
work. (The model provider named under "Other companies" is reached from our
servers, never from your browser, so it sets nothing and sees no cookie.)

The age acknowledgement is kept in your browser and **not** on our servers. A
durable per-person record of who accepted what, held by us, would be exactly
the cross-conversation identifier this service is built not to have.

## Other companies

**Only these, and each only when you use the feature it serves.**

| Company | What it does | What it receives |
|---|---|---|
| `{{MODEL_PROVIDER}}` | Writes the replies for our automated accounts | The messages in that conversation, and the description of the character it is playing |
| `{{IDENTITY_PROVIDER}}` | Runs signing in, for the people who choose to | That somebody is signing in to this service, and the account they sign in with |
| `{{FEDERATED_PROVIDER}}` | The account you sign in *with*, if you choose that option | That you signed in to this service, at the time you did it |
| `{{CLASSIFICATION_PROVIDER}}` | Sorts reports by urgency for a human reviewer, when report triage is enabled, and checks automated accounts' replies | The recent messages of a reported conversation and the report category; in conversations with an automated account, the messages being checked |

We require terms that forbid training on what we send.

The two sign-in entries apply **only if you sign in**. Nobody who simply opens
the site and chats is sent to either of them, and neither is contacted by your
browser while you are using the service.

Everything else is still none:

- Our pages make **no requests to any third party** from your browser — no
  analytics, no trackers, no advertising, not even external fonts. Signing in is
  the one exception and it is a deliberate one: you are taken to the provider's
  own page, you can see it in the address bar, and you chose to go there. Your
  profile picture is relayed by us rather than loaded from them, so that
  browsing this site never tells them you were here.
- There is no payment provider, because nothing is for sale.
- Automatic moderation of what users send runs on our own servers, on rules.
  The classification service above only sorts reports for a person to review;
  it never takes action against anyone on its own.
- Nothing is sent to any outside logging or error-reporting service.

The infrastructure the service runs on — the hosting provider, and wherever
encrypted backups are copied to — necessarily holds the data described above.

## Where your data is

The service runs on servers in India. That is where your conversations are held
while they are retained, and where every request you make is answered.

**Backups are stored outside India.** Encrypted copies of the database are kept
with **Cloudflare R2**, an object storage service. Cloudflare selects which of
its regions holds the data, and none of them are in India. This is the only part
of the service that involves your data leaving the country, and it is disclosed
here rather than described as something else.

Two things about those backups are worth stating plainly, because they are what
make the arrangement reasonable rather than merely convenient:

* **They are encrypted before they leave our server**, with a key the storage
  provider does not hold and cannot obtain. The provider stores a file it cannot
  read.
* **They exist to survive the loss of the server**, which is the failure a
  backup on the same machine does not protect against. A copy in a different
  place is the entire point of having one.

## Where you cannot use this service

The service is not available in the European Economic Area or the United
Kingdom. A visitor from those countries gets a plain page saying so.

This is a deliberate choice, not a technical accident.

The check is made on the country your network connection appears to come from,
before any conversation exists. We do not store it and we do not log it.

## Automated decisions

Some things happen to you here without a person being involved:

- **Rate limits.** Sending too fast, or reconnecting too often, gets slowed
  down or refused.
- **Moderation rules.** Messages are checked against automated rules. A message
  may be flagged and still delivered; a **declared name** that trips a rule is
  refused outright, because a name is shown to everyone you meet rather than
  said once in context.
- **Disconnection.** Repeatedly sending malformed or oversized data ends the
  connection.

None of these is permanent and none of them is a ban.

**A ban is different: it is issued by a person, never automatically.** A
moderator reviews a report, decides, and the decision is recorded with their
identity and reason before it takes effect.

If you think a ban was wrong, write to `contact@karobakbak.com`. A human will look at
it — the same human, which is the honest version of "human review".

## Security

Traffic is encrypted in transit (HTTPS/WSS). Databases are not reachable from
the internet. Passwords for moderator accounts are hashed with a
memory-hard algorithm and protected by two-factor authentication.

Message content is deliberately kept out of logs, metrics and error reports by
an automatic filter that blocks it — outside production, that filter throws an
error rather than allowing the write, so a mistake is caught in development
rather than discovered in a log file.

Nothing here makes a system unbreachable, and we are not claiming that.

## Your rights

An honest constraint worth understanding: **for conversations, because we do not
know who you are, we usually cannot find your data on request.** A conversation
is identified by a random session number that we cannot connect to you, and we
have no way to verify that a conversation was yours. Asking for proof would mean
collecting the identity information we deliberately avoid.

**If you have signed in, your account is different.** It can be found, because
signing in is what makes that possible. Sign in and ask us, and we can tell you
what the account holds — an identifier from the sign-in provider, when it was
created, and the connections you saved — and delete it along with everything
attached to it. That still does not reach your conversations, for the reason
above: nothing recorded during a chat says which account was signed in.

In practice this means:

- **Deletion:** everything deletes itself within 30 days, or 90 if reported.
  Closing the tab ends your connection, and the conversation is released
  shortly afterwards — but the stored record still follows the 30 or 90 day
  window above. Leaving does not erase what was said. An account is the one
  thing you can have deleted on request, because it is the one thing we can
  confirm is yours.
- **Access:** if you can identify a specific conversation — for example because
  you reported it and have the reference — we may be able to locate it.
  Otherwise we cannot. If you have an account, what it holds can be provided.
- **Correction:** there is nothing stored that could be incorrect, beyond what
  you typed yourself and, if you signed in, an identifier from your sign-in
  provider that only they can change.
- **What is in your browser is yours to delete.** Anything you declared about
  yourself, your acknowledgement of the age statement and your interface
  preferences live on your device, not on our servers. Clearing site data
  removes them immediately, without asking us.

That limitation is real and not an excuse. Asking us to delete "your" data would
require you to prove which records are yours, and the only way to do that would
be for us to keep something identifying — which is precisely the thing we have
chosen not to do.

## Children

This service is for people aged **18 or over**.

We ask, and we do not check. If you tell us you are under 18 you cannot join a
conversation, but nothing stops someone entering a different age or none at all.
**We are not claiming to verify anyone's age, and you should not read our asking
as a guarantee that everyone here is an adult.**

If you believe a child is using this service, report the conversation. Reports
involving a suspected minor are treated as the most serious category we handle.

## Changes

We have no way to email you, because we do not know your email address. That is
a consequence of collecting nothing, and it means notice has to happen in the
product itself.

If we change this policy in a way that materially affects you — keeping things
longer, collecting something new, sharing with someone new — we will show a
notice in the interface **before** the change takes effect and leave it up for
at least 14 days. The date at the top always reflects the current version.

## Contact

Privacy questions, and anything about this policy: `privacy@karobakbak.com`.

Legal requests, takedown notices and regulator correspondence:
`abuse@karobakbak.com`.

**Grievance Officer:** `<OPERATOR_NAME>`, Grievance Officer, karobakbak.
Email `contact@karobakbak.com`, phone `<OPERATOR_PHONE>`. We acknowledge complaints within
**24 hours** and aim to resolve them within **15 days**.

Content covered by Rule 3(2)(b) of the IT Rules — non-consensual intimate
imagery, nudity, impersonation including synthetic media — is removed within
**24 hours** of a complaint.

If you are not satisfied with the outcome, you may appeal to the Grievance
Appellate Committee at `gac.gov.in` within 30 days of our decision.
