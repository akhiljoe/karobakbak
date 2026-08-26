/**
 * Three steps, answering the only question a first-time visitor actually has.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL, ON A PAGE THAT WANTS TO BE EMPTY
 * ---------------------------------------------------------------------------
 * Random chat has one barrier and it is not aesthetic: *what happens if I press
 * this?* Somebody who has never used a product like this does not know whether
 * the button starts a call, asks for a camera, or wants an account first. That
 * uncertainty is what the button loses people to, and no amount of typographic
 * confidence answers it.
 *
 * So this is three lines of information, not a marketing section. It is
 * deliberately the least prominent thing above the footer — it exists to be
 * glanced at once and never read again, which is why it is a single compact row
 * rather than three cards with icons.
 *
 * It is also the honest answer. "Meet a random stranger" is what actually
 * happens; anything warmer would be selling.
 */

interface Step {
  readonly index: string;
  readonly title: string;
  readonly detail: string;
}

const STEPS: readonly Step[] = [
  { index: '01', title: 'Start', detail: 'No signup' },
  { index: '02', title: 'Match', detail: 'A random stranger' },
  { index: '03', title: 'Talk', detail: 'See where it goes' },
];

export function HowItWorks(): JSX.Element {
  return (
    <ol
      aria-label="How it works"
      className="mx-auto flex w-full max-w-md items-start justify-between gap-2 sm:max-w-lg sm:gap-6"
    >
      {STEPS.map((step, position) => (
        <li
          key={step.index}
          className="relative flex min-w-0 flex-1 flex-col items-center text-center"
        >
          {/*
            A hairline between the steps, so they read as a sequence rather than
            three unrelated labels. Drawn from the numeral's vertical centre and
            stopping short of the next one; never after the last.
          */}
          {position < STEPS.length - 1 && (
            <span
              aria-hidden="true"
              className="absolute left-[calc(50%+1.75rem)] right-[calc(-50%+1.75rem)] top-[0.45rem] h-px bg-ink-800"
            />
          )}
          <span className="font-mono text-[0.625rem] tracking-widest text-amber-400/70">
            {step.index}
          </span>
          <span className="mt-1 text-sm font-medium text-ink-200">{step.title}</span>
          <span className="mt-0.5 text-xs leading-snug text-ink-500">{step.detail}</span>
        </li>
      ))}
    </ol>
  );
}
