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

/** The configuration this page is running with. */
export const clientConfig: ClientConfig = loadClientConfig(
  import.meta.env as unknown as Record<string, unknown>,
);
