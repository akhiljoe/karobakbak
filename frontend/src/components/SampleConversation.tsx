/**
 * A few messages, so the landing screen shows the product instead of promising
 * it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EARNS SPACE ON A SCREEN THAT HAS NONE TO SPARE
 * ---------------------------------------------------------------------------
 * The page had four elements: a headline, a line under it, a button, and a
 * reassurance. All four *describe*. None of them let somebody see what pressing
 * the button leads to, and "what actually happens if I click" is one of the two
 * questions that lose people — the other being "is anybody there", which the
 * searching screen now answers.
 *
 * It also does something copy cannot: it carries tone. Three messages establish
 * that this is light and a bit silly faster than any adjective, and warmth was
 * the thing the page was most short of.
 *
 * ---------------------------------------------------------------------------
 * VISIBLY AN ILLUSTRATION, AND NOT NEGOTIABLE
 * ---------------------------------------------------------------------------
 * It is labelled as an example and the messages are invented. It must never be
 * dressed up as a captured transcript, and it must never acquire names, avatars
 * or a timestamp that implies a real pair of people — that would be fabricated
 * social proof wearing a different coat, and the same rule applies to it as to
 * a made-up user count (D21).
 *
 * The invention is the point: nothing here was said by anybody, so nothing here
 * is anybody's conversation to have leaked.
 *
 * ---------------------------------------------------------------------------
 * HIDDEN ON SHORT SCREENS
 * ---------------------------------------------------------------------------
 * It sits below the reassurance so the button's position is unchanged, and
 * `tiny:hidden` drops it below 700px of viewport height. That threshold is not
 * the same as `short` (760px): `short` compresses spacing on ordinary laptops,
 * and hiding this there would mean a 695px window — a very common laptop —
 * never saw it at all. 700 is where the arithmetic actually stops working.
 *
 * The invariant it must not break: at 375x667 the path from arrival to "Start
 * chatting" stays visible without scrolling.
 */

interface Line {
  readonly from: 'them' | 'you';
  readonly text: string;
}

/**
 * Deliberately trivial.
 *
 * A sample that showed something meaningful being discussed would set an
 * expectation the next stranger cannot meet. Most conversations here open with
 * something daft, and showing that is both truer and less intimidating than
 * showing two people being interesting at each other.
 */
const LINES: readonly Line[] = [
  { from: 'them', text: 'ok settle something. is a hotdog a sandwich' },
  { from: 'you', text: 'absolutely not' },
  { from: 'them', text: 'we are going to have a problem' },
];

export function SampleConversation(): JSX.Element {
  return (
    <figure className="mx-auto w-full max-w-sm">
      <figcaption className="mb-2 text-center text-xs uppercase tracking-wider text-ink-600">
        An example — not a real conversation
      </figcaption>

      <div className="rounded-2xl border border-ink-800 bg-ink-900/50 p-3">
        <ol className="flex flex-col gap-1.5">
          {LINES.map((line, index) => (
            <li
              key={line.text}
              className={`flex ${line.from === 'you' ? 'justify-end' : 'justify-start'}`}
            >
              <span
                className={`max-w-[85%] animate-fade-in rounded-2xl px-3 py-1.5 text-left text-sm leading-snug ${
                  line.from === 'you'
                    ? 'rounded-br-md bg-amber-400 text-ink-950'
                    : 'rounded-bl-md bg-ink-800 text-ink-200'
                }`}
                /*
                 * Staggered so they land like messages rather than a block
                 * appearing at once. The global reduced-motion rule collapses
                 * every duration to near zero, so this resolves to "they are
                 * simply there" for anybody who asked for less movement.
                 */
                style={{ animationDelay: `${index * 140}ms` }}
              >
                {line.text}
              </span>
            </li>
          ))}

          {/* The other person still typing — the product's most human moment. */}
          <li className="flex justify-start">
            <span
              className="flex animate-fade-in items-center gap-1 rounded-2xl rounded-bl-md bg-ink-800 px-3 py-2.5"
              style={{ animationDelay: `${LINES.length * 140}ms` }}
              aria-label="the stranger is typing"
            >
              {[0, 1, 2].map((dot) => (
                <span
                  key={dot}
                  className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-500"
                  style={{ animationDelay: `${dot * 180}ms` }}
                />
              ))}
            </span>
          </li>
        </ol>
      </div>
    </figure>
  );
}
