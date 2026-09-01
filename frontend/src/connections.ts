/**
 * Saved connections: the people you and somebody else both chose to keep.
 *
 * ---------------------------------------------------------------------------
 * A HANDLE, NEVER AN ACCOUNT ID
 * ---------------------------------------------------------------------------
 * The server sends a handle derived from the pair and salted with the viewer's
 * own account. It is meaningless anywhere else, it differs for each side of the
 * same connection, and it cannot be turned back into an account by anybody but
 * the server. That is deliberate: `/auth/session` already refuses to hand this
 * page its own account id, and somebody else's is worse by the same argument.
 *
 * ---------------------------------------------------------------------------
 * A DATE IS ALL THERE IS TO SHOW, AND THAT IS NOT A GAP
 * ---------------------------------------------------------------------------
 * Nothing durable describes another account — the server keeps no profile
 * between sessions (D34, §24.3) — so a name or a picture in this list would
 * mean storing one. That is a decision about what people learn about each other
 * rather than a display detail, and it is not made here.
 */

/** One connection, as the browser is allowed to see it. */
export interface Connection {
  /** Opaque, per-viewer. The only way to address this connection. */
  readonly handle: string;
  /** ISO timestamp of when the two of you connected. */
  readonly since: string;
}

/**
 * Fetch the list, newest first.
 *
 * Answers null — rather than an empty list — when it could not be read at all,
 * so the panel can say "we could not load this" instead of "you have none".
 * Those are different statements and only one of them is a lie.
 */
export async function readConnections(): Promise<Connection[] | null> {
  let response: Response;
  try {
    response = await fetch('/auth/connections', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  try {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const rows = (body as { connections?: unknown }).connections;
    if (!Array.isArray(rows)) return null;
    return rows.filter(isConnection);
  } catch {
    return null;
  }
}

/** Remove one. Answers whether the server confirmed it. */
export async function removeConnection(handle: string): Promise<boolean> {
  try {
    const response = await fetch('/auth/connections/remove', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ handle }),
    });
    // Only a confirmed removal. Dropping the row from the list on a failure
    // would show somebody a connection they still have, and they would find out
    // the next time they opened this panel.
    return response.ok;
  } catch {
    return false;
  }
}

function isConnection(value: unknown): value is Connection {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<Connection>;
  return typeof row.handle === 'string' && typeof row.since === 'string';
}
