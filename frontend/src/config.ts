/**
 * Client configuration, in one place.
 *
 * ---------------------------------------------------------------------------
 * WHY MOST OF THIS IS NOT AN ENVIRONMENT VARIABLE
 * ---------------------------------------------------------------------------
 * Vite inlines `import.meta.env.VITE_*` at **build** time, so every variable
 * has to be threaded through a Dockerfile build arg and a compose entry, and it
 * bakes into the bundle — changing one means a rebuild, not a restart. That is
 * a fair price for something that genuinely differs between a laptop and
 * production, and a bad one for a value that is the same everywhere.
 *
 * So the split is by *what varies*, not by what happens to be a number:
 *
 *  * **Environment** — the socket URL and the advertising provider. Different
 *    per deployment, and read from `import.meta.env` below.
 *  * **Here** — timings and thresholds that are product decisions. They were
 *    literals scattered through components; being in one documented module is
 *    the actual fix. If one of them ever needs to differ per deployment, it
 *    moves up a section and gains a build arg.
 *
 * ---------------------------------------------------------------------------
 * ON THE BACKEND'S "NEVER A MODULE SINGLETON" RULE
 * ---------------------------------------------------------------------------
 * `CLAUDE.md` forbids `export const config = loadConfig()` in the backend,
 * because one process serves many sessions and tests must build their own.
 * Neither applies here: a page load is one client with one configuration, and
 * there is no second tenant to confuse it with. `loadClientConfig` is still a
 * pure function of its input so it can be tested directly, and `clientConfig`
 * is simply the instance this page runs with.
 */

/** The shape everything downstream reads. */
export interface ClientConfig {
  /** Where the WebSocket lives. Empty means "derive it from the page origin". */
  readonly wsUrl: string;
  readonly ads: {
    readonly enabled: boolean;
    readonly provider: string;
  };
  /**
   * Where the published Terms and Privacy Policy live.
   *
   * Environment rather than a literal, because they are per deployment: a
   * review build has nowhere to point, and the real URLs depend on a domain
   * that is not this repository's business.
   *
   * **Empty is a launch blocker, not a default.** The age gate links both and
   * they must be reachable *without* passing it, so a build that ships with
   * these unset has a gate that states obligations a user cannot go and read.
   * `hasLegalLinks` below is what the interface tests, and
   * `docs/policies/README.md` step 5 is the reason: a policy nobody can find is
   * not published.
   */
  readonly legal: {
    readonly termsUrl: string;
    readonly privacyUrl: string;
  };
  /**
   * A pre-supplied account credential, for local testing only.
   *
   * ---------------------------------------------------------------------------
   * THIS MUST BE EMPTY IN ANY REAL BUILD
   * ---------------------------------------------------------------------------
   * There is no accounts system yet, so there is nowhere for the premium page
   * to get a bearer credential from and the Subscribe button falls through to
   * the sign-in modal. That makes the paid path untestable in a browser, which
   * is the only reason this exists.
   *
   * Vite inlines build-time variables into the bundle, so whatever is set here
   * is **readable by anyone who loads the page**. It is a bearer credential:
   * whoever reads it can buy a subscription for that account. That is
   * acceptable for a throwaway row in a local database and is a credential leak
   * anywhere else.
   *
   * It goes away entirely when the accounts phase ships and the credential
   * comes from wherever accounts decide to keep it.
   */
  readonly devAccountCredential: string;

  /**
   * Where people write in. Empty until there is a domain to host a role
   * address on.
   *
   * Empty means the Contact link is omitted, never rendered as a `mailto:`
   * pointing nowhere. An address that bounces is worse than no address: the
   * Privacy Policy commits to acknowledging complaints within 24 hours, and an
   * unread inbox is documented notice that was received and ignored.
   */
  readonly contactEmail: string;
  /**
   * Where "buy me a coffee" points. Empty hides it entirely.
   *
   * **A link, never an embed.** The Privacy Policy states that the site makes
   * "no requests to any third party from your browser — no analytics, no
   * trackers, no advertising, not even external fonts". A donation *widget* is
   * a third-party script and would make that sentence false the day it shipped;
   * an anchor makes no request until somebody clicks it and leaves. The whole
   * value of that claim is that it is checkable, so it is worth more than the
   * convenience of an embedded button.
   */
  readonly supportUrl: string;
  readonly timings: {
    /**
     * How long after the last keystroke the typing indicator is withdrawn.
     *
     * The server hands the client a `typingPerSecond` limit precisely so it can
     * throttle itself rather than discover the bucket by being refused, and
     * this is the other half of that: one notification per burst, withdrawn on
     * a timer.
     */
    readonly typingIdleMs: number;
    /**
     * Reconnect backoff, in order. The last entry repeats for every attempt
     * after it, so the client keeps trying without hammering a server that is
     * plainly still down.
     */
    readonly reconnectBackoffMs: readonly number[];
    /**
     * Two messages from the same side closer together than this are grouped
     * into one visual block. Purely presentational.
     */
    readonly messageGroupingMs: number;
    /** How long a transient notice stays on screen before dismissing itself. */
    readonly toastVisibleMs: number;
  };
}

/**
 * Build the configuration from an environment.
 *
 * Pure, and takes the environment as an argument, so a test can pass whatever
 * it likes without touching `import.meta`.
 */
export function loadClientConfig(env: Record<string, unknown>): ClientConfig {
  return {
    wsUrl: readString(env.VITE_WS_URL, ''),
    ads: {
      // Strictly the string 'true'. Anything else is off, including 'TRUE' and
      // '1', because a flag that turns advertising on deserves one spelling.
      enabled: env.VITE_ADS_ENABLED === 'true',
      provider: readString(env.VITE_ADS_PROVIDER, 'noop'),
    },
    legal: {
      termsUrl: readString(env.VITE_TERMS_URL, ''),
      privacyUrl: readString(env.VITE_PRIVACY_URL, ''),
    },
    contactEmail: readString(env.VITE_CONTACT_EMAIL, ''),
    supportUrl: readString(env.VITE_SUPPORT_URL, ''),
    devAccountCredential: readString(env.VITE_DEV_ACCOUNT_CREDENTIAL, ''),
    timings: {
      typingIdleMs: 3000,
      reconnectBackoffMs: [500, 1000, 2000, 5000, 10_000],
      messageGroupingMs: 60_000,
      toastVisibleMs: 4000,
    },
  };
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * Whether this build can show a user the documents it refers to.
 *
 * Both, not either. Linking one and silently dropping the other would leave the
 * gate citing a document that cannot be opened, which is worse than a gate that
 * admits the links are missing.
 */
export function hasLegalLinks(config: ClientConfig): boolean {
  return config.legal.termsUrl !== '' && config.legal.privacyUrl !== '';
}

/** The configuration this page is running with. */
export const clientConfig: ClientConfig = loadClientConfig(
  import.meta.env as unknown as Record<string, unknown>,
);

/*
 * Said out loud, every page load, because the quiet version of this mistake is
 * a testing credential shipped in a public bundle and nobody noticing. It is
 * the one value in this file that is dangerous when set rather than when empty.
 */
if (clientConfig.devAccountCredential !== '') {
  console.warn(
    'VITE_DEV_ACCOUNT_CREDENTIAL is set: this build carries a testing account ' +
      'credential that anyone loading the page can read. Local testing only.',
  );
}
