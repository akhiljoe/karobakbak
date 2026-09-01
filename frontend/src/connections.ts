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
  /**
   * What you call them, or null.
   *
   * Yours alone: they have their own word for you and neither of you sees the
   * other's. It is never sent to the person it names.
   */
  readonly label: string | null;
  /**
   * Whether they are here right now.
   *
   * False also covers somebody who turned presence off, and that is
   * deliberate — a distinguishable "hidden" would disclose exactly what the
   * setting exists to hide.
   */
  readonly online: boolean;
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
    // Normalised rather than trusted: the guard proves handle and since, and
    // the two newer fields are filled in here so a row from an older server
    // renders as unnamed and offline instead of `undefined`.
    return rows.filter(isConnection).map((row) => ({
      handle: row.handle,
      since: row.since,
      label: typeof row.label === 'string' && row.label !== '' ? row.label : null,
      online: row.online === true,
    }));
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
  // `label` and `online` are read leniently: an older server answering this
  // page would simply omit them, and a friends list is not the place to fail
  // closed over a missing nickname.
  return typeof row.handle === 'string' && typeof row.since === 'string';
}

/** Rename a connection, for you only. An empty label clears it. */
export async function labelConnection(handle: string, label: string): Promise<string | null> {
  try {
    const response = await fetch('/auth/connections/label', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ handle, label }),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const saved = (body as { label?: unknown }).label;
    return typeof saved === 'string' ? saved : null;
  } catch {
    return null;
  }
}

/** Whether you appear online to your connections. Null when it could not be read. */
export async function readPresenceSharing(): Promise<boolean | null> {
  try {
    const response = await fetch('/auth/presence', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const share = (body as { share?: unknown }).share;
    return typeof share === 'boolean' ? share : null;
  } catch {
    return null;
  }
}

/** Change it. Answers the value the server confirmed, or null on failure. */
export async function setPresenceSharing(share: boolean): Promise<boolean | null> {
  try {
    const response = await fetch('/auth/presence', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ share }),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const saved = (body as { share?: unknown }).share;
    return typeof saved === 'boolean' ? saved : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------ *
 * Blocks
 * ------------------------------------------------------------------------ */

/**
 * One block, as its owner may see it.
 *
 * A date and a handle. The blocked person stays a hash on the server and never
 * reaches this page — they may have no account at all, and resolving one for
 * them would be the cross-chat correlation the product exists not to do.
 */
export interface Block {
  /** Names the moment the block was made. Resolved against your own rows. */
  readonly handle: string;
  readonly since: string;
}

/** Your blocks, newest first, or null when the list could not be read. */
export async function readBlocks(): Promise<Block[] | null> {
  try {
    const response = await fetch('/auth/blocks', {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const rows = (body as { blocks?: unknown }).blocks;
    if (!Array.isArray(rows)) return null;
    return rows.filter(isBlock);
  } catch {
    return null;
  }
}

/** Lift one. Answers whether the server confirmed it. */
export async function removeBlock(handle: string): Promise<boolean> {
  try {
    const response = await fetch('/auth/blocks/remove', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ handle }),
    });
    // Only a confirmed removal, for the reason the connection one gives: a row
    // dropped on failure shows somebody a block as lifted while it still holds.
    return response.ok;
  } catch {
    return false;
  }
}

function isBlock(value: unknown): value is Block {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<Block>;
  return typeof row.handle === 'string' && typeof row.since === 'string';
}
