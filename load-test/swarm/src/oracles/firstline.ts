/**
 * First line of an error message.
 *
 * Docker writes multi-line noise on failure and only the first line of it says
 * anything useful; the rest is a copy of the command that failed, which is
 * already known.
 *
 * The separators are built from character codes rather than written as escape
 * sequences. That is the same defence `hasForbiddenControlChar()` uses in the
 * backend, and for the same reason: a literal control character in a source
 * file has already turned one file in this repository into something git and
 * grep treat as binary.
 */
export const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

export function firstLine(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const [first] = error.message.split(LF);
  return (first ?? 'unknown').split(CR).join('');
}
