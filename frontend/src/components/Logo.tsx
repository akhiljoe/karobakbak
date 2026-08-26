/**
 * The karobakbak mark and wordmark.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS
 * ---------------------------------------------------------------------------
 * Two arcs facing each other, with a point between them. Two voices meeting —
 * deliberately **not** a speech bubble, because every chat product already is
 * one and a generic mark is worth less than no mark.
 *
 * The arcs are asymmetric on purpose: one solid, one half-opacity. Two
 * identical arcs read as a decorative shape; one leading and one answering
 * reads as a conversation, and the imbalance is what stops it looking like a
 * loading spinner.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COLOURS ARE LITERAL AND NOT `currentColor`
 * ---------------------------------------------------------------------------
 * The two-tone *is* the mark. Collapsing it to one colour loses the "two
 * voices" reading entirely, so `currentColor` is offered as an explicit `mono`
 * variant rather than being the default — for a favicon mask, a print context,
 * or anywhere the surrounding colour has to win.
 *
 * No external asset: inline SVG, because the Content Security Policy is
 * `default-src 'self'` and this has to render inside the bundle.
 */

interface LogoMarkProps {
  /** Rendered size in pixels. 24 in the header, 16 for a favicon-scale use. */
  readonly size?: number;
  /** Single-colour variant, inheriting the surrounding text colour. */
  readonly mono?: boolean;
  /**
   * A label makes it an image to a screen reader; without one it is decorative.
   * Beside the wordmark it should be decorative, because the word already says
   * the name and announcing it twice is noise.
   */
  readonly label?: string;
  readonly className?: string;
}

export function LogoMark({
  size = 28,
  mono = false,
  label,
  className,
}: LogoMarkProps): JSX.Element {
  const lead = mono ? 'currentColor' : '#ffb420';
  const answer = mono ? 'currentColor' : '#ffc94a';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      className={className}
      {...(label === undefined
        ? { 'aria-hidden': true as const }
        : { role: 'img' as const, 'aria-label': label })}
    >
      {/* The one that speaks first. */}
      <path
        d="M31 9 A 19 19 0 0 0 31 39"
        stroke={lead}
        strokeWidth="3.6"
        strokeLinecap="round"
      />
      {/* The one answering — quieter, so the pair reads as a exchange. */}
      <path
        d="M17 9 A 19 19 0 0 1 17 39"
        stroke={answer}
        strokeOpacity={mono ? 0.45 : 0.5}
        strokeWidth="3.6"
        strokeLinecap="round"
      />
      {/* What passes between them. */}
      <circle cx="24" cy="24" r="2.4" fill={lead} />
    </svg>
  );
}

interface LogoProps {
  /** Mark size; the wordmark scales alongside it. */
  readonly size?: number;
  readonly className?: string;
}

/**
 * Mark plus wordmark, as one unit.
 *
 * The name is lowercase everywhere, including at the start of a sentence. It is
 * a word rather than a proper noun being announced, which is the tone the whole
 * product is written in.
 */
export function Logo({ size = 28, className }: LogoProps): JSX.Element {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <LogoMark size={size} />
      <span className="font-display text-base font-semibold tracking-tight text-ink-50">
        karobakbak
      </span>
    </span>
  );
}
