# Sign-in: what is wired, what is not, and how to check

Sign-in is OIDC against an AWS Cognito user pool, federated to Google. This file
is the state of that setup and the commands that prove each claim, so nothing
here has to be taken on trust later.

`DESIGN.md` §31 and §32 are the decisions. `docs/product/FEATURE-INTAKE.md` is what an
account is *for*. This file is only the wiring.

**Every claim below was verified by running the command beside it on
2026-09-01**, against the local stack on `http://localhost:3001`. Re-run them
rather than believing the ticks.

---

## The one-command check

If you only run one thing, run this. It follows our `/auth/start` to whatever
the provider does with it:

```bash
AUTH=$(curl -s -o /dev/null -D - "http://localhost:3001/auth/start?mode=popup" \
  | grep -i "^location:" | sed 's/^[Ll]ocation: //' | tr -d '\r')
curl -s -o /dev/null -D - "$AUTH" | grep -i "^location:"
```

| What comes back | What it means |
|---|---|
| `accounts.google.com/o/oauth2/...` | fully wired — this is the healthy answer |
| `.../login?...errorMessage=Login+option+is+not+available` | Google is not ticked on the app client |
| `.../login?...` with no `errorMessage` | `AUTH_IDENTITY_PROVIDER` is empty; the hosted form will show |
| anything from `localhost` | the nginx `/auth/` proxy is missing; you are being served the SPA |

That last row is the failure that cost the most time: with no `/auth` location,
nginx answers all four routes with `index.html` — a **200 carrying the SPA**.
Sign-in appears to do nothing and nothing is logged anywhere.

---

## State

### Done and verified

| Thing | How it was proved |
|---|---|
| The four `/auth` routes reach the backend | `curl -s -o /dev/null -D - http://localhost:3001/auth/start` → `302`, not `200` |
| `identity_provider=Google` is sent | the `location:` header carries it |
| Cognito federates to Google | the one-command check above lands on `accounts.google.com` |
| Sign-in completes and creates an account | `docker compose exec -T postgres psql -U karobakbak -d karobakbak -c "select id, created_at from accounts order by created_at desc limit 5;"` |
| The popup is a real window | observed: separate Chrome window, own address bar, own title |
| The popup's landing page is served | `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/signin-done.html` → `200` |
| Its script loads under CSP | it is a separate file; `script-src 'self'` has no `'unsafe-inline'`, so an inline one would be silently blocked |
| Config is coherent at startup | `docker compose logs backend \| grep "sign-in enabled"` — on **both** replicas |

There are three rows in `accounts` as of writing: one from the earlier
Cognito-native sign-in and one from Google. They are separate accounts on
purpose — `accounts.external_id` is the provider's subject identifier, and the
federated `sub` differs from the native one. Nothing is broken by this; it is
what a second sign-in method means.

### Not done

Ordered by what would hurt most.

1. **Rotate the Cognito app-client secret if it is ever exposed.** The runbook
   below covers it: a new confidential client, both `AUTH_CLIENT_ID` and
   `AUTH_CLIENT_SECRET` updated, a real sign-in to verify the exchange
   (`accounts` is unchanged because `sub` is per user pool), and then the old
   client deleted, which is the step that actually revokes the old secret.

2. ~~Drop `profile` from Cognito's authorized scopes.~~ **Done 2026-09-01.**
   Now `email openid`. The consent screen no longer asks for name and profile
   picture, neither of which was ever read: the attribute mapping is
   `email → email` and `accountForSubject` reads the verified email only.

3. **`karobakbak.com` is not serving.** Verified: `curl https://karobakbak.com/`
   does not connect, nor do `/privacy` or `/terms`. Those three URLs are
   configured on Google's consent screen and are currently dead links. They also
   have to be authorized domains there, which is what produced
   `Missing domain: karobakbak.com` while only the Cognito host was registered.

4. **The policies behind those URLs are drafts.** Terms §10 and §11 are
   deliberately empty pending counsel and several facts are unfilled
   `{{TEMPLATE_VARIABLES}}`. Deploying the domain and publishing the policies is
   one task, not two.

5. ~~Google's consent screen names the raw Cognito host.~~ **Done 2026-09-01.**
   `auth.karobakbak.com` is live and `AUTH_AUTHORIZE_URL` / `AUTH_TOKEN_URL`
   point at it. The prefix domain still exists and still works — see the runbook.

6. **The app is in Testing and the logo is unverified.** Only listed test users
   can sign in, and the uploaded logo will not display until the app is verified,
   which needs the domain live and ownership proved in Search Console.

7. **`AUTH_SECURE_COOKIES=false` is local-only.** `loadConfig` refuses it when
   `NODE_ENV=production`, so this cannot ship by accident — but the production
   `.env` needs it true, which it is by default.

---

## Runbook: rotating the app-client secret

**Cognito cannot rotate a client secret.** It is generated once, by
`create-user-pool-client --generate-secret`, and there is no console action and
no API call that replaces it on an existing client. Rotating therefore means
creating a new app client and moving to it.

That sounds heavier than it is. Four things do *not* change, and knowing which
is most of the work:

* **Google needs no change at all.** Its OAuth client is bound to the Cognito
  *domain* — the origin and the `/oauth2/idpresponse` redirect — not to an app
  client. Nothing in Google Cloud is touched.
* **Existing accounts keep working.** `accounts.external_id` holds the
  provider's subject identifier, and `sub` is issued per *user pool*, not per app
  client. The same person signing in through the new client resolves to the same
  row.
* **Anybody signed in stays signed in.** Our session credential is minted by us
  and lives in `account_credentials`; it has no relationship to the Cognito
  client that authenticated the original sign-in.
* **The identity provider configuration is pool-level.** Google stays attached
  to the pool; it only has to be *ticked* on the new client.

### Steps

1. Cognito → pool → **App clients** → **Create app client**.
   * Type: **Confidential client** — this is what produces a secret. A public
     client has none, and the exchange would start failing with an error about
     an unexpected credential rather than a missing one.
   * Copy the new **client ID** and **client secret**.

2. Configure the new client to match the old one. Read the old one's settings
   beside it rather than from memory:
   * Allowed callback URLs: `http://localhost:3001/auth/callback`
   * Allowed sign-out URLs: `http://localhost:3001/`
   * OAuth grant type: **Authorization code grant**
   * OpenID Connect scopes: **openid**, **email**
   * Identity providers: **Google** *and* **Cognito user pool**

   Missing the last one reproduces the original bug exactly — Cognito answers
   `errorMessage=Login option is not available` and renders its email form.

3. Update `.env` — **both** values, not just the secret:

   ```bash
   AUTH_CLIENT_ID=<new client id>
   AUTH_CLIENT_SECRET=<new secret>
   ```

   Then `docker compose up -d`. No rebuild; these are backend runtime values.

   Changing only the secret is the tempting half-step and fails closed: the
   `aud` claim on the returned token still names the *old* client, and the
   validator refuses it. There is a test for that case —
   *"refuses a token minted for another client of the same pool"* in
   `backend/tests/unit/oidc.test.ts`.

4. Verify with the one-command check at the top of this file, then sign in for
   real.

5. Only then, delete the old app client. Keeping it until the new one is proven
   is the rollback: put the two old values back in `.env` and restart.

### If the secret was exposed rather than merely rotated on schedule

Deleting the old client is the step that actually revokes anything. Until it is
gone, the exposed secret still authenticates against the pool. Everything
before step 5 is preparation; step 5 is the rotation.

## Profile pictures need three things, not one

`AUTH_AVATARS=true` makes `/auth/start` request the `profile` scope and serves
the picture from `/auth/avatar`. On its own it does nothing, and the two Cognito
halves fail differently — which is what makes this worth writing down.

1. **Google IdP → Authorized scopes:** `profile email openid`. Without
   `profile`, Google never sends a picture to Cognito.
2. **App client → OpenID Connect scopes:** tick **Profile**. Without it, asking
   for the scope fails the **whole sign-in** with `invalid_scope` — loud, and
   easy to diagnose.
3. **Google IdP → Map attributes:** add `Picture → picture` beside the existing
   `Email → email`.

Step 3 is the one that cost a debugging round. Cognito only puts an attribute
into the ID token if it is mapped, so with steps 1 and 2 done and 3 missing,
everything succeeds: the scope is granted, the consent screen mentions the
picture, sign-in works — and the claim simply is not there. Nothing is logged,
because nothing failed. The symptom is an avatar that never appears.

Note also that Google will **not** re-prompt for consent if the account
previously granted `profile` to this client, so "the consent screen did not
mention the picture" is not evidence that anything is wrong.

Where it lives: the URL is a column on the browser's own credential row
(`020_credential_picture.sql`), so it survives a Redis restart; the image is
relayed by this origin and stored nowhere. Signing out clears the URL, and the
deletion worker clears it from expired credentials. A browser that signed in
before that migration has no URL until it signs in again. An absent avatar is an ordinary state everywhere — the
glyph is the answer, not a placeholder.

## Reaching it from a phone

Cognito **refuses a plain-HTTP redirect URI unless it is loopback** —
`http://localhost`, `127.0.0.1` or `[::1]`. A LAN address is rejected outright,
so a phone cannot sign in against a dev machine by IP, and the callback cannot
simply be pointed at `192.168.x.x`.

Two ways round it.

**A named Cloudflare tunnel** in front of the dev stack:

```bash
cloudflared tunnel run --url http://localhost:3001 <tunnel-name>
```

It serves the dev stack at a fixed hostname of your own, `https://<dev-hostname>`,
and that hostname does not change. Nothing changes in Google Cloud either: its
redirect points at Cognito's domain, not at yours.

What has to agree once the tunnel exists:

| | |
|---|---|
| Tunnel | `<tunnel-name>`, created with `cloudflared tunnel create` |
| DNS | `<dev-hostname>` CNAME to the tunnel, added by `cloudflared tunnel route dns` |
| `.env` | `AUTH_REDIRECT_URI=https://<dev-hostname>/auth/callback`, and the origin in `ALLOWED_ORIGINS` |
| Cognito | `https://<dev-hostname>/auth/callback` in callbacks, `https://<dev-hostname>/` in sign-out URLs |

Setting one up from nothing is four commands, one of which opens a browser:

```bash
cloudflared tunnel login                      # authorise the zone, writes ~/.cloudflared/cert.pem
cloudflared tunnel create <tunnel-name>       # tunnel + a credentials JSON to keep secret
cloudflared tunnel route dns <tunnel-name> <dev-hostname>
cloudflared tunnel run --url http://localhost:3001 <tunnel-name>
```

> **This replaced a quick tunnel — `cloudflared tunnel --url ...` with no name —
> and the reason is worth keeping.** A quick tunnel is anonymous and disposable,
> so Cloudflare mints a **new random hostname on every start**. That meant
> editing `ALLOWED_ORIGINS`, `AUTH_REDIRECT_URI` and two Cognito fields every
> session, and forgetting any one of them fails differently: a stale origin is a
> **403 on the WebSocket upgrade** and a UI stuck on "Connecting" with the page
> itself loading fine, while a stale callback fails at the provider after the
> user has already typed their password. Both were paid for at least once. A
> named tunnel makes all four edits one-time.

When adding any hostname to Cognito, *add* rather than replace, or desktop
testing on localhost stops working.

**`adb reverse tcp:3001 tcp:3001`** on Android instead, which makes `localhost`
on the phone reach the machine and keeps the loopback exemption — no
registration, no `.env` change. There is no iOS equivalent.

## The account chooser is always shown

`/auth/start` sends `prompt=select_account` whenever an IdP is named. Verified
by following the chain rather than assumed — Cognito forwards `prompt` on to
Google, and without it no `prompt` reaches Google at all.

It matters because the provider otherwise reuses whichever account is already
signed in on the device and returns immediately: no screen, no choice, no sign
that an identity was picked for you. On a shared machine that means signing in
as whoever used it last.

`select_account` and not `login`: the question is *which account*, not *prove it
is you again*. A forced password prompt on every sign-in is a heavier promise
and a different decision.

## Signing out does not sign you out of Google

Worth knowing before it surprises somebody, because it looks like a bug.

`POST /auth/signout` revokes **our** credential and clears **our** cookie. It
does not call the provider's logout endpoint, and nothing in
`backend/src/accounts/` does.

So after signing out, clicking *Continue with Google* again may sign you
straight back in with no prompt: Cognito's own session cookie is still valid on
its domain, and Google's is still valid on theirs. The sign-in looks like it
skipped a step.

This is the ordinary behaviour of federated sign-in and is not obviously wrong —
"sign out of this site" and "sign out of Google everywhere" are different
requests, and doing the second on the user's behalf would be surprising in the
other direction. But on a shared machine the first does less than somebody
expects.

If it should end the provider session too, that is a redirect to Cognito's
`/logout` with `client_id` and `logout_uri`, and `logout_uri` must be registered
as an allowed sign-out URL on the app client. It is deliberately not built: it
is a product decision about what "sign out" promises, not an oversight.

---

## Configuration reference

Backend, read by `loadConfig`. Every one is forwarded explicitly in
`docker-compose.yml` — compose has **no `env_file`**, so a variable living only
in `.env` never reaches the container, and the failure is quiet: the four routes
are simply never registered.

| Variable | Local value | Notes |
|---|---|---|
| `AUTH_ENABLED` | `true` | Off means no `/auth` routes exist at all |
| `AUTH_ISSUER` | `https://cognito-idp.<region>.amazonaws.com/<user-pool-id>` | Checked against the `iss` claim. Must be https |
| `AUTH_AUTHORIZE_URL` | `https://auth.karobakbak.com/oauth2/authorize` | A **different host** from the issuer |
| `AUTH_TOKEN_URL` | `https://auth.karobakbak.com/oauth2/token` | |
| `AUTH_JWKS_URL` | issuer host, `/.well-known/jwks.json` | The pool, not the login UI |
| `AUTH_CLIENT_ID` | the app client | Not a secret |
| `AUTH_CLIENT_SECRET` | set | Rotate if exposed, see above |
| `AUTH_REDIRECT_URI` | `http://localhost:3001/auth/callback` | See the warning below |
| `AUTH_IDENTITY_PROVIDER` | `Google` | Empty renders the hosted form |
| `AUTH_RETURN_URL` | `/` | Where a full-page sign-in lands |
| `AUTH_SECURE_COOKIES` | `false` | Local HTTP only |
| `AUTH_AVATARS` | `true` | Adds the `profile` scope; see below |

**`AUTH_REDIRECT_URI` is the origin the browser sees**, which is nginx on
`FRONTEND_PORT` — never the backend's own address. The backend publishes no host
port in either compose file; `/auth/*` is proxied through the frontend
container. This is the single most counter-intuitive fact in the setup.

Frontend, `frontend/src/features.ts`, build-time constants rather than
environment variables because turning them on is a commit:

| Constant | Value | Effect |
|---|---|---|
| `ACCOUNTS_ENABLED` | `true` | Renders the sign-in control at all |
| `SIGNIN_PROVIDER` | `'google'` | Whether the button names Google |

A `SIGNIN_PROVIDER` mismatch with `AUTH_IDENTITY_PROVIDER` is cosmetic and
nothing else: the button would say Google and the hosted form would appear.

---

## Three ports that move together

`FRONTEND_PORT` is the whole application origin, so it appears in three places
and all three must agree:

1. `FRONTEND_PORT` in `.env` — currently `3001`, because Grafana holds 3000
2. `AUTH_REDIRECT_URI`, and the callback registered on the Cognito app client
3. every entry in `ALLOWED_ORIGINS`

Miss the third and the page loads perfectly and the WebSocket upgrade is refused
with a 403 — the site appears, pressing start does nothing. `npm run where`
prints every address this machine answers on and marks each with whether
`ALLOWED_ORIGINS` accepts it.

---

## Runbook: moving to `auth.karobakbak.com`

The consent-screen heading and the popup's address bar both show
the Cognito prefix domain (`<cognito-domain>`), because that is
literally the host Google is being asked to authorize. Setting an app name in
Google does not change it. The only fix is to change the host.

**DNS for `karobakbak.com` is on Cloudflare**, verified by `nslookup -type=NS
karobakbak.com`, which returns two `*.ns.cloudflare.com` nameservers. That
matters more than it looks: see step 4.

### It is additive — answered by doing it

**Done on 2026-09-01; `auth.karobakbak.com` is live.** The open question was
whether a custom domain replaces the prefix domain. It does not: the pool's
Domain page carries **Cognito domain** and **Custom domain** as two independent
sections, each with its own Create/Edit/Delete. Both serve the same pool at the
same time.

That makes this a soft cutover. The prefix domain (`<cognito-domain>`)
still answers, so rolling back is two lines of `.env` and a restart, and sign-in
never goes down during the migration.

### 1. Certificate, in us-east-1

AWS Certificate Manager, region **N. Virginia (us-east-1)**. Not `ap-south-1`,
and not because of where anything else lives — Cognito's custom domain is served
by CloudFront, and CloudFront only reads certificates from that one region. A
certificate issued in `ap-south-1` simply will not appear in the dropdown at
step 3, with no explanation of why.

Leave **Allow export** on `Disable export`. Exportable certificates are billed
per domain at issuance *and* at every renewal, and the private key is never
needed outside AWS — Cognito and CloudFront use it internally. With export
disabled the certificate, and its automatic renewal, are free.

Note that the *Cognito* console stays on `ap-south-1` throughout. Its
certificate picker reads `us-east-1` regardless of the region shown, which is
the whole reason the certificate goes there.

Request a public certificate for:

```
auth.karobakbak.com
```

Choose **DNS validation**. ACM gives you a CNAME to create — something like
`_a1b2c3.auth.karobakbak.com` → `_x9y8z7.xxxxx.acm-validations.aws.`

Add it in Cloudflare, and mind two things:

- **Enter the name without the zone suffix.** Cloudflare appends the zone
  automatically, so pasting the full `_a1b2c3.auth.karobakbak.com` produces
  `_a1b2c3.auth.karobakbak.com.karobakbak.com` and validation never completes.
  Enter `_a1b2c3.auth`.
- **Set it to DNS only (grey cloud).** A proxied validation record can be
  rewritten by Cloudflare and ACM will not see what it expects.

Wait for the certificate to reach **Issued**. Usually a few minutes.

### 2. An A record on the parent

Cognito refuses to create a custom auth domain when the **parent** domain does
not resolve. `karobakbak.com` currently serves nothing —
`curl https://karobakbak.com/` does not connect — so this has to exist before
step 3, even if the site is not deployed yet.

In Cloudflare, add an `A` record for `@` (`karobakbak.com`) pointing at wherever
the site will live. Proxied or not does not matter for this check; Cognito only
needs the name to resolve.

This is checked when the domain is **created**, not continuously, but leave it
in place — you need it for the site anyway.

### 3. Create the custom domain in Cognito

Cognito → your pool → **Domain** → add a custom domain:

- Domain: `auth.karobakbak.com`
- Certificate: the ACM one from step 1 — if it is not listed, it was issued in
  the wrong region

Provisioning takes roughly **15–20 minutes**; it is creating a CloudFront
distribution. When it finishes, Cognito shows an **alias target** like
`d111111abcdef8.cloudfront.net`. Copy it.

### 4. Point `auth` at CloudFront — grey cloud

In Cloudflare, add:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `auth` | the `d111111abcdef8.cloudfront.net` from step 3 | **DNS only** |

**The proxy status is the trap.** With the orange cloud on, Cloudflare
terminates TLS itself and forwards to CloudFront with its own SNI, and
CloudFront — which is matching on the certificate you just issued — refuses it.
The symptom is a CloudFront error page rather than the login screen, and nothing
in Cognito or the certificate looks wrong, because nothing in them is.

Grey cloud. Every time.

Give DNS a few minutes, then:

```bash
nslookup auth.karobakbak.com          # expect the cloudfront.net target
curl -sI https://auth.karobakbak.com/ # expect a response from Cognito, not a CF error
```

### 5. Update the Google OAuth client

Google Cloud → Credentials → your OAuth client:

- Authorized JavaScript origin: add `https://auth.karobakbak.com`
- Authorized redirect URI: add `https://auth.karobakbak.com/oauth2/idpresponse`

**Add, do not replace.** Keep the `amazoncognito.com` entries until the new
domain is confirmed working — they are what the rollback depends on. Remove them
afterwards.

The consent screen's Authorized domains already needs `karobakbak.com`
registered, and that one entry covers `auth.karobakbak.com`; subdomains are
included automatically.

### 6. Update `.env`

```bash
AUTH_AUTHORIZE_URL=https://auth.karobakbak.com/oauth2/authorize
AUTH_TOKEN_URL=https://auth.karobakbak.com/oauth2/token
```

Then `docker compose up -d`. No rebuild — these are backend runtime values.

**`AUTH_ISSUER` and `AUTH_JWKS_URL` do not change.** They stay on
`cognito-idp.ap-south-1.amazonaws.com`. Those name the *pool*; the custom domain
is only the login UI. Changing them breaks token validation, and the error reads
as an invalid token rather than a wrong URL — which sends you looking in exactly
the wrong place. `loadConfig` refuses a non-https issuer for a related reason.

### 7. Verify

Run the one-command check at the top of this file. A `location:` pointing at
`accounts.google.com` means the whole chain still works. Then sign in for real
and confirm the popup's address bar reads `auth.karobakbak.com`, and that
Google's consent screen now says *"Sign in to auth.karobakbak.com"*.

### Rollback

Put the two `amazoncognito.com` URLs back in `.env` and `docker compose up -d`.
That is the whole rollback **provided** the prefix domain still exists — which
is what the check at the top of this runbook is about. If adding the custom
domain removed it, recreate the prefix domain in Cognito first, and expect a few
minutes of provisioning before sign-in works again.

This is why step 5 says add rather than replace: with both redirect URIs
registered in Google, reverting is one file and one restart.

---

## The AWS setup, if it has to be done again

**Google Cloud Console** → OAuth consent screen: External, app name, support
email, **developer contact email** (required — a blank one disables Save with no
message next to it), scopes `userinfo.email`, `userinfo.profile`, `openid`, and
your own address as a test user. Every domain used on that screen must also be
listed under Authorized domains, as a bare registrable domain with no scheme or
path.

**Credentials** → OAuth client ID → Web application:

- Authorized JavaScript origin: the Cognito hosted-UI domain
- Authorized redirect URI: that domain + `/oauth2/idpresponse`

Both are **Cognito's** domain. `localhost:3001` appears nowhere in Google's
configuration; Google redirects to Cognito, and Cognito redirects to us.

**Cognito** → pool → Social and external providers → Add → Google: the client id
and secret, authorized scopes as a space-separated string, and the attribute
mapping `Email → email`.

**Cognito** → pool → App clients → Login pages → Edit → tick **Google**. This is
the step that gets missed, because adding the provider looks like it finished
the job — and skipping it fails *quietly*, rendering the ordinary email form
with `errorMessage=Login option is not available` in a query string nobody
reads. The symptom is the exact screen the setting exists to skip.

Do that last step in the console. The CLI equivalent, `update-user-pool-client`,
replaces the entire client configuration — every field omitted is wiped,
including the callback URLs and the OAuth grant types.
