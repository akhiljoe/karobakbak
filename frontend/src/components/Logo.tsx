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
 * The arcs are asymmetric on purpose, and in **two** ways: the answering arc is
 * both shorter and half-opacity. Two identical arcs read as a decorative shape
 * — or worse, as a loading spinner. One leading and one answering reads as a
 * conversation, and the size difference carries that even in greyscale, where
 * the opacity difference alone very nearly disappears.
 *
 * Geometry is rebuilt from `docs/brand/new-logo.png`, which is the source the
 * mark was designed against. If it changes there, it changes here and in
 * `public/favicon.svg` — a favicon that has drifted from the logo is the kind
 * of thing nobody notices and everybody feels.
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
      {/* The one that speaks first: taller, and at full strength. */}
      <path
        d="M16.1 13.5 A 13.5 13.5 0 0 1 16.1 34.5"
        stroke={lead}
        strokeWidth="2.7"
        strokeLinecap="round"
      />
      {/* The one answering — shorter and quieter, so the pair reads as exchange. */}
      <path
        d="M31.9 17 A 9.7 9.7 0 0 0 31.9 31"
        stroke={answer}
        strokeOpacity={mono ? 0.45 : 0.5}
        strokeWidth="2.7"
        strokeLinecap="round"
      />
      {/* What passes between them. */}
      <circle cx="25.1" cy="24" r="1.4" fill={lead} />
    </svg>
  );
}

interface LogoProps {
  /** Mark size in pixels. */
  readonly size?: number;
  /**
   * Type scale for the word, when the default does not suit the surface.
   *
   * The mark and the word are sized separately because the wordmark does *not*
   * scale with the mark automatically, and a lockup where only one half grew
   * is worse than either size on its own. The sign-in dialog is the case: it
   * is the one surface that hands somebody to another origin, so the name has
   * to be readable at a glance rather than a caption under a button.
   */
  readonly wordClassName?: string;
  readonly className?: string;
}

/**
 * Mark plus wordmark, as one unit.
 *
 * The name is lowercase everywhere, including at the start of a sentence. It is
 * a word rather than a proper noun being announced, which is the tone the whole
 * product is written in.
 */
export function Logo({
  size = 28,
  wordClassName = 'text-base',
  className,
}: LogoProps): JSX.Element {
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ''}`}>
      <LogoMark size={size} />
      <span
        className={`font-display font-semibold tracking-tight text-ink-50 ${wordClassName}`}
      >
        karobakbak
      </span>
    </span>
  );
}
