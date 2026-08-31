import {
  parseClientFrame,
  validateMessageText,
  validateProfile,
  validateReportNote,
} from '../../src/protocol/validate';
import {
  COUNTRY_CODES,
  GENDERS,
  COUNTRY_NAMES,
  countryName,
  MAX_DECLARED_AGE,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_DECLARED_AGE,
  PROTOCOL_VERSION,
  REPORT_CATEGORIES,
} from '../../src/protocol/types';

/** Deliberately different numbers, so a test can tell which limit fired. */
const limits = { maxMessageLength: 20, maxReportNoteLength: 30 };

/** Build a raw frame the way a client would. */
function frame(overrides: Record<string, unknown>): string {
  return JSON.stringify({ version: PROTOCOL_VERSION, ...overrides });
}

/**
 * A `message` frame always carries an envelope id — it is the dedupe key and
 * the server rejects a message without one (D24). Tests that are not about the
 * id itself use this so the interesting assertion is the only thing varying.
 */
function messageFrame(payload: unknown, overrides: Record<string, unknown> = {}): string {
  return frame({ type: 'message', id: 'c_1', payload, ...overrides });
}

function expectError(result: ReturnType<typeof parseClientFrame>, code: string) {
  if (result.ok) {
    throw new Error(`expected failure with ${code}, got a valid ${result.command.type} command`);
  }
  expect(result.code).toBe(code);
  return result;
}

describe('parseClientFrame — envelope', () => {
  it('accepts a minimal valid control frame and reports no client id', () => {
    const result = parseClientFrame(frame({ type: 'join_queue', payload: {} }), false, limits);
    expect(result).toEqual({
      ok: true,
      command: {
        type: 'join_queue',
        clientId: null,
        // Absent, null and every-field-declined all normalise to one shape.
        profile: { name: null, country: null, age: null, gender: null, vibe: null },
      },
    });
  });

  it('treats a missing payload as an empty payload for zero-argument events', () => {
    const result = parseClientFrame(frame({ type: 'skip' }), false, limits);
    expect(result).toEqual({ ok: true, command: { type: 'skip', clientId: null } });
  });

  it('rejects binary frames — the protocol is JSON text only', () => {
    const result = parseClientFrame(Buffer.from([0x01, 0x02, 0x03]), true, limits);
    expectError(result, 'BAD_ENVELOPE');
  });

  it('rejects malformed JSON without throwing', () => {
    expectError(parseClientFrame('{"type":', false, limits), 'BAD_JSON');
    expectError(parseClientFrame('', false, limits), 'BAD_JSON');
    expectError(parseClientFrame('not json at all', false, limits), 'BAD_JSON');
  });

  it('rejects JSON that is not an object', () => {
    expectError(parseClientFrame('[]', false, limits), 'BAD_ENVELOPE');
    expectError(parseClientFrame('"string"', false, limits), 'BAD_ENVELOPE');
    expectError(parseClientFrame('null', false, limits), 'BAD_ENVELOPE');
    expectError(parseClientFrame('42', false, limits), 'BAD_ENVELOPE');
  });

  it('rejects a missing or mismatched protocol version', () => {
    expectError(
      parseClientFrame(JSON.stringify({ type: 'ping', payload: {} }), false, limits),
      'UNSUPPORTED_VERSION',
    );
    expectError(
      parseClientFrame(JSON.stringify({ type: 'ping', version: 2, payload: {} }), false, limits),
      'UNSUPPORTED_VERSION',
    );
    expectError(
      parseClientFrame(JSON.stringify({ type: 'ping', version: '1', payload: {} }), false, limits),
      'UNSUPPORTED_VERSION',
    );
  });

  it('rejects unknown and server-only event types', () => {
    expectError(parseClientFrame(frame({ type: 'nope', payload: {} }), false, limits), 'UNKNOWN_EVENT');
    // `matched` is a server->client event; a client must not be able to send it.
    expectError(
      parseClientFrame(frame({ type: 'matched', payload: {} }), false, limits),
      'UNKNOWN_EVENT',
    );
    // Same for the revision-2 server events.
    for (const serverOnly of ['presence', 'partner_typing', 'report_ack']) {
      expectError(
        parseClientFrame(frame({ type: serverOnly, payload: {} }), false, limits),
        'UNKNOWN_EVENT',
      );
    }
    expectError(parseClientFrame(frame({ type: 7, payload: {} }), false, limits), 'UNKNOWN_EVENT');
  });

  it('rejects a non-object payload', () => {
    expectError(parseClientFrame(frame({ type: 'ping', payload: 'x' }), false, limits), 'BAD_ENVELOPE');
    expectError(parseClientFrame(frame({ type: 'ping', payload: [] }), false, limits), 'BAD_ENVELOPE');
  });

  it('echoes a well-formed client id and rejects a malformed one', () => {
    const ok = parseClientFrame(frame({ type: 'ping', id: 'c-123_AB', payload: {} }), false, limits);
    expect(ok).toEqual({ ok: true, command: { type: 'ping', clientId: 'c-123_AB' } });

    expectError(
      parseClientFrame(frame({ type: 'ping', id: 'has spaces', payload: {} }), false, limits),
      'BAD_ENVELOPE',
    );
    expectError(
      parseClientFrame(frame({ type: 'ping', id: 'x'.repeat(65), payload: {} }), false, limits),
      'BAD_ENVELOPE',
    );
    expectError(
      parseClientFrame(frame({ type: 'ping', id: 12345, payload: {} }), false, limits),
      'BAD_ENVELOPE',
    );
  });

  it('ignores client-supplied timestamps entirely', () => {
    const result = parseClientFrame(
      frame({ type: 'ping', timestamp: 'not-a-date-at-all', payload: {} }),
      false,
      limits,
    );
    expect(result.ok).toBe(true);
  });

  it('ignores client attempts to assert identity or routing', () => {
    const result = parseClientFrame(
      messageFrame({ text: 'hi', to: 's_victim', from: 's_admin', matchId: 'm_forged' }),
      false,
      limits,
    );
    expect(result).toEqual({
      ok: true,
      command: { type: 'message', clientId: 'c_1', contentType: 'text', text: 'hi' },
    });
    // The parsed command carries no routing information at all: the server
    // resolves the recipient from its own match record.
    if (result.ok) {
      expect(Object.keys(result.command).sort()).toEqual([
        'clientId',
        'contentType',
        'text',
        'type',
      ]);
    }
  });
});

/**
 * The envelope id is optional everywhere except `message`, where it is the
 * per-match replay-protection key (R4/D24, invariant I14). A message that
 * arrives without one cannot be deduplicated, so it is refused rather than
 * accepted with a generated id — a server-generated key would make every retry
 * a fresh message and silently disable replay protection.
 */
describe('parseClientFrame — required message id', () => {
  it('rejects a message with no envelope id', () => {
    const result = parseClientFrame(
      frame({ type: 'message', payload: { text: 'hi' } }),
      false,
      limits,
    );
    expectError(result, 'BAD_ENVELOPE');
  });

  it('rejects a message whose id is explicitly null', () => {
    expectError(
      parseClientFrame(frame({ type: 'message', id: null, payload: { text: 'hi' } }), false, limits),
      'BAD_ENVELOPE',
    );
  });

  it('reports the missing id before any payload problem', () => {
    // Structural defects are reported first, so a client that forgot the id is
    // not sent chasing a content error it does not have.
    const result = parseClientFrame(
      frame({ type: 'message', payload: { text: '', type: 'image' } }),
      false,
      limits,
    );
    expectError(result, 'BAD_ENVELOPE');
  });

  it('still allows every other event to omit an id', () => {
    for (const event of ['join_queue', 'leave_queue', 'skip', 'block', 'ping']) {
      const result = parseClientFrame(frame({ type: event, payload: {} }), false, limits);
      expect(result.ok).toBe(true);
    }
    expect(
      parseClientFrame(frame({ type: 'typing', payload: { active: true } }), false, limits).ok,
    ).toBe(true);
  });

  it('surfaces the id on the validated command so the dedupe key cannot be lost', () => {
    const result = parseClientFrame(messageFrame({ text: 'hi' }, { id: 'c_dedupe' }), false, limits);
    expect(result).toEqual({
      ok: true,
      command: { type: 'message', clientId: 'c_dedupe', contentType: 'text', text: 'hi' },
    });
  });
});

describe('parseClientFrame — message payload', () => {
  it('accepts text and trims surrounding whitespace', () => {
    const result = parseClientFrame(messageFrame({ text: '  hi  ' }), false, limits);
    expect(result).toEqual({
      ok: true,
      command: { type: 'message', clientId: 'c_1', contentType: 'text', text: 'hi' },
    });
  });

  it('rejects a non-string text field', () => {
    expectError(parseClientFrame(messageFrame({ text: 42 }), false, limits), 'VALIDATION_FAILED');
    expectError(parseClientFrame(messageFrame({}), false, limits), 'VALIDATION_FAILED');
    expectError(parseClientFrame(messageFrame({ text: null }), false, limits), 'VALIDATION_FAILED');
  });

  it('rejects empty and whitespace-only text', () => {
    expectError(parseClientFrame(messageFrame({ text: '' }), false, limits), 'EMPTY_MESSAGE');
    expectError(parseClientFrame(messageFrame({ text: '   \n\t ' }), false, limits), 'EMPTY_MESSAGE');
  });

  it('rejects text longer than the configured limit, measured before trimming', () => {
    const result = validateMessageText('x'.repeat(21), limits);
    expect(result).toEqual({
      ok: false,
      code: 'MESSAGE_TOO_LONG',
      message: 'message exceeds 20 characters',
    });
    // A padded payload is reported as oversized, not as empty: the client gets
    // the accurate reason and the server never allocates the trimmed copy.
    const padded = validateMessageText(' '.repeat(500), limits);
    expect(padded.ok).toBe(false);
    if (!padded.ok) expect(padded.code).toBe('MESSAGE_TOO_LONG');
  });

  it('accepts text exactly at the limit', () => {
    const result = validateMessageText('x'.repeat(20), limits);
    expect(result).toEqual({ ok: true, text: 'x'.repeat(20) });
  });

  it('preserves newlines and tabs but rejects other control characters', () => {
    expect(validateMessageText('line1\nline2\twide', limits)).toEqual({
      ok: true,
      text: 'line1\nline2\twide',
    });
    const nul = validateMessageText(`bad${String.fromCharCode(0)}text`, limits);
    expect(nul.ok).toBe(false);
    if (!nul.ok) expect(nul.code).toBe('VALIDATION_FAILED');

    const esc = validateMessageText(`ansi${String.fromCharCode(27)}[31m`, limits);
    expect(esc.ok).toBe(false);
    if (!esc.ok) expect(esc.code).toBe('VALIDATION_FAILED');
  });

  it('accepts valid astral-plane text but rejects lone surrogates', () => {
    expect(validateMessageText('hey 👋 there', limits)).toEqual({ ok: true, text: 'hey 👋 there' });

    const lonely = validateMessageText(`a${String.fromCharCode(0xd83d)}b`, limits);
    expect(lonely.ok).toBe(false);
    if (!lonely.ok) expect(lonely.code).toBe('VALIDATION_FAILED');

    const trailing = validateMessageText(String.fromCharCode(0xdc4b), limits);
    expect(trailing.ok).toBe(false);
    if (!trailing.ok) expect(trailing.code).toBe('VALIDATION_FAILED');
  });

  it('treats HTML and script payloads as ordinary text — the frontend renders text nodes', () => {
    const result = validateMessageText('<img src=x>', {
      maxMessageLength: 2000,
      maxReportNoteLength: 500,
    });
    expect(result).toEqual({ ok: true, text: '<img src=x>' });
  });

  it('never echoes user content back in the error message', () => {
    const secret = 'SUPER_SECRET_MESSAGE_BODY';
    const result = validateMessageText(`${secret}${'x'.repeat(100)}`, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain(secret);
  });
});

/**
 * The content-type discriminator is the one media-related seam implemented
 * today (DESIGN.md §23). It exists so a future type can be added without a
 * protocol version bump — and because it is client-supplied, it is also a
 * spoofing surface that must be closed.
 */
describe('parseClientFrame — message content type', () => {
  it('defaults to text when the client omits the discriminator', () => {
    const result = parseClientFrame(messageFrame({ text: 'hi' }), false, limits);
    expect(result).toEqual({
      ok: true,
      command: { type: 'message', clientId: 'c_1', contentType: 'text', text: 'hi' },
    });
  });

  it('accepts an explicit text discriminator', () => {
    const result = parseClientFrame(messageFrame({ type: 'text', text: 'hi' }), false, limits);
    expect(result).toEqual({
      ok: true,
      command: { type: 'message', clientId: 'c_1', contentType: 'text', text: 'hi' },
    });
  });

  it('treats an explicit null discriminator as text rather than failing', () => {
    const result = parseClientFrame(messageFrame({ type: null, text: 'hi' }), false, limits);
    expect(result.ok).toBe(true);
  });

  it('rejects every unimplemented content type — a client cannot opt into future features', () => {
    for (const spoofed of ['image', 'voice', 'video', 'audio', 'file', 'sticker']) {
      const result = parseClientFrame(messageFrame({ type: spoofed, text: 'hi' }), false, limits);
      expectError(result, 'UNSUPPORTED_CONTENT_TYPE');
    }
  });

  it('rejects rather than coerces an unknown type, so a client is never told text was sent', () => {
    const result = parseClientFrame(messageFrame({ type: 'image', text: 'caption' }), false, limits);
    // Crucially NOT { ok: true, contentType: 'text' } — coercion would mean the
    // sender believes an image was delivered when only text was.
    expect(result.ok).toBe(false);
  });

  it('rejects a non-string discriminator', () => {
    for (const bogus of [42, true, {}, ['text']]) {
      const result = parseClientFrame(messageFrame({ type: bogus, text: 'hi' }), false, limits);
      expectError(result, 'UNSUPPORTED_CONTENT_TYPE');
    }
  });

  it('rejects reserved media fields instead of silently ignoring them', () => {
    for (const field of ['mediaId', 'media', 'attachment', 'attachments', 'blob', 'file', 'url']) {
      const result = parseClientFrame(
        messageFrame({ text: 'hi', [field]: 'm_fabricated' }),
        false,
        limits,
      );
      expectError(result, 'UNSUPPORTED_CONTENT_TYPE');
    }
  });

  it('rejects a fabricated media reference even when the type is valid text', () => {
    const result = parseClientFrame(
      messageFrame({ type: 'text', text: 'hi', mediaId: 'm_1' }),
      false,
      limits,
    );
    expectError(result, 'UNSUPPORTED_CONTENT_TYPE');
  });

  it('never names the rejected type in the error, so the reply is not a capability oracle', () => {
    const result = parseClientFrame(messageFrame({ type: 'video', text: 'hi' }), false, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain('video');
      expect(result.message).not.toContain('image');
    }
  });

  it('still rejects binary frames — the WebSocket is not a media transport', () => {
    // This is the architectural boundary of DESIGN.md §23.2, enforced in code.
    const result = parseClientFrame(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), true, limits);
    expectError(result, 'BAD_ENVELOPE');
  });

  it('applies text validation regardless of an explicit discriminator', () => {
    expectError(
      parseClientFrame(messageFrame({ type: 'text', text: '' }), false, limits),
      'EMPTY_MESSAGE',
    );
    expectError(
      parseClientFrame(messageFrame({ type: 'text', text: 'x'.repeat(21) }), false, limits),
      'MESSAGE_TOO_LONG',
    );
  });
});

describe('parseClientFrame — typing', () => {
  it('accepts both an explicit start and an explicit stop', () => {
    expect(parseClientFrame(frame({ type: 'typing', payload: { active: true } }), false, limits)).toEqual(
      { ok: true, command: { type: 'typing', clientId: null, active: true } },
    );
    expect(
      parseClientFrame(frame({ type: 'typing', payload: { active: false } }), false, limits),
    ).toEqual({ ok: true, command: { type: 'typing', clientId: null, active: false } });
  });

  it('requires a strict boolean rather than anything truthy', () => {
    // "false", 0 and 1 are exactly the values that would flip a stop into a
    // start under JavaScript coercion.
    for (const bogus of ['true', 'false', 0, 1, null, {}, []]) {
      expectError(
        parseClientFrame(frame({ type: 'typing', payload: { active: bogus } }), false, limits),
        'VALIDATION_FAILED',
      );
    }
  });

  it('requires the active field to be present', () => {
    expectError(
      parseClientFrame(frame({ type: 'typing', payload: {} }), false, limits),
      'VALIDATION_FAILED',
    );
    expectError(parseClientFrame(frame({ type: 'typing' }), false, limits), 'VALIDATION_FAILED');
  });

  it('carries no match or partner reference — routing is server-resolved', () => {
    const result = parseClientFrame(
      frame({ type: 'typing', payload: { active: true, matchId: 'm_forged', to: 's_victim' } }),
      false,
      limits,
    );
    expect(result).toEqual({
      ok: true,
      command: { type: 'typing', clientId: null, active: true },
    });
  });
});

describe('parseClientFrame — report', () => {
  it('accepts every declared category', () => {
    for (const category of REPORT_CATEGORIES) {
      const result = parseClientFrame(
        frame({ type: 'report', payload: { category } }),
        false,
        limits,
      );
      expect(result).toEqual({
        ok: true,
        command: { type: 'report', clientId: null, category, note: null },
      });
    }
  });

  it('rejects a category outside the closed enum', () => {
    for (const bogus of ['HARASSMENT', 'other ', 'custom-reason', '', 42, null, undefined, {}]) {
      expectError(
        parseClientFrame(frame({ type: 'report', payload: { category: bogus } }), false, limits),
        'VALIDATION_FAILED',
      );
    }
  });

  it('never echoes the rejected category, which is attacker-controlled text', () => {
    const canary = 'CATEGORY_CANARY_VALUE';
    const result = parseClientFrame(
      frame({ type: 'report', payload: { category: canary } }),
      false,
      limits,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain(canary);
  });

  it('accepts and trims a note', () => {
    const result = parseClientFrame(
      frame({ type: 'report', payload: { category: 'spam', note: '  they sent links  ' } }),
      false,
      limits,
    );
    expect(result).toEqual({
      ok: true,
      command: { type: 'report', clientId: null, category: 'spam', note: 'they sent links' },
    });
  });

  it('normalises absent, null and whitespace-only notes to a single null', () => {
    for (const note of [undefined, null, '', '   ', '\n\t ']) {
      const result = parseClientFrame(
        frame({ type: 'report', payload: { category: 'other', note } }),
        false,
        limits,
      );
      expect(result).toEqual({
        ok: true,
        command: { type: 'report', clientId: null, category: 'other', note: null },
      });
    }
  });

  it('enforces the note limit independently of the message limit', () => {
    // 25 characters: over the 20-character message limit, under the 30-character
    // note limit. A shared limit would reject this.
    const note = 'y'.repeat(25);
    const ok = parseClientFrame(
      frame({ type: 'report', payload: { category: 'threats', note } }),
      false,
      limits,
    );
    expect(ok).toEqual({
      ok: true,
      command: { type: 'report', clientId: null, category: 'threats', note },
    });

    const tooLong = parseClientFrame(
      frame({ type: 'report', payload: { category: 'threats', note: 'y'.repeat(31) } }),
      false,
      limits,
    );
    // VALIDATION_FAILED, not MESSAGE_TOO_LONG: the message code would send the
    // client to check the wrong limit.
    expectError(tooLong, 'VALIDATION_FAILED');
  });

  it('rejects a non-string note', () => {
    for (const bogus of [42, true, {}, ['note']]) {
      expectError(
        parseClientFrame(
          frame({ type: 'report', payload: { category: 'scam', note: bogus } }),
          false,
          limits,
        ),
        'VALIDATION_FAILED',
      );
    }
  });

  it('applies message-grade character rules to the note', () => {
    // A note reaches a human moderator's console; a terminal escape in it is
    // the same injection vector as in a message body.
    const esc = validateReportNote(`ansi${String.fromCharCode(27)}[31m`, limits);
    expect(esc.ok).toBe(false);
    if (!esc.ok) expect(esc.code).toBe('VALIDATION_FAILED');

    const nul = validateReportNote(`bad${String.fromCharCode(0)}note`, limits);
    expect(nul.ok).toBe(false);

    const lonely = validateReportNote(`a${String.fromCharCode(0xd83d)}b`, limits);
    expect(lonely.ok).toBe(false);

    expect(validateReportNote('line1\nline2', limits)).toEqual({ ok: true, note: 'line1\nline2' });
  });

  it('never echoes the note back in an error message', () => {
    const secret = 'REPORTER_PRIVATE_WORDS';
    const result = validateReportNote(`${secret}${'x'.repeat(40)}`, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain(secret);
  });

  it('ignores any client attempt to name who is being reported', () => {
    const result = parseClientFrame(
      frame({
        type: 'report',
        payload: { category: 'hate', reportedSessionId: 's_victim', matchId: 'm_forged' },
      }),
      false,
      limits,
    );
    expect(result).toEqual({
      ok: true,
      command: { type: 'report', clientId: null, category: 'hate', note: null },
    });
  });
});

describe('parseClientFrame — block', () => {
  it('takes no arguments', () => {
    expect(parseClientFrame(frame({ type: 'block', payload: {} }), false, limits)).toEqual({
      ok: true,
      command: { type: 'block', clientId: null },
    });
    expect(parseClientFrame(frame({ type: 'block' }), false, limits)).toEqual({
      ok: true,
      command: { type: 'block', clientId: null },
    });
  });

  it('ignores a client-supplied target — the server blocks the current partner', () => {
    const result = parseClientFrame(
      frame({ type: 'block', payload: { target: 's_someone_else', ipHash: 'forged' } }),
      false,
      limits,
    );
    expect(result).toEqual({ ok: true, command: { type: 'block', clientId: null } });
  });
});

describe('protocol surface — future signalling is not accepted early', () => {
  it('rejects WebRTC-style signalling events that are not implemented', () => {
    for (const event of [
      'call.offer',
      'call.answer',
      'call.ice-candidate',
      'call.started',
      'call.ended',
      'media.upload',
    ]) {
      expectError(
        parseClientFrame(frame({ type: event, payload: {} }), false, limits),
        'UNKNOWN_EVENT',
      );
    }
  });

  it('keeps every currently implemented event working', () => {
    for (const event of ['join_queue', 'leave_queue', 'skip', 'block', 'ping']) {
      const result = parseClientFrame(frame({ type: event, payload: {} }), false, limits);
      expect(result.ok).toBe(true);
    }
    expect(
      parseClientFrame(frame({ type: 'typing', payload: { active: true } }), false, limits).ok,
    ).toBe(true);
    expect(
      parseClientFrame(frame({ type: 'report', payload: { category: 'spam' } }), false, limits).ok,
    ).toBe(true);
    expect(parseClientFrame(messageFrame({ text: 'hi' }), false, limits).ok).toBe(true);
  });
});

describe('validateProfile', () => {
  it('treats absent, null and all-declined as one shape', () => {
    // "Told us nothing" must have a single representation, or every consumer
    // has to handle three.
    const empty = { name: null, country: null, age: null, gender: null, vibe: null };
    expect(validateProfile(undefined)).toEqual({ ok: true, profile: empty });
    expect(validateProfile(null)).toEqual({ ok: true, profile: empty });
    expect(validateProfile({})).toEqual({ ok: true, profile: empty });
    expect(validateProfile({ name: '', country: '', age: null })).toEqual({
      ok: true,
      profile: empty,
    });
    expect(validateProfile({ name: '   ' })).toEqual({ ok: true, profile: empty });
  });

  it('accepts a full declaration and trims the name', () => {
    expect(
      validateProfile({ name: '  Sam  ', country: 'IN', age: 27, gender: 'female', vibe: 'chill' }),
    ).toEqual({
      ok: true,
      profile: { name: 'Sam', country: 'IN', age: 27, gender: 'female', vibe: 'chill' },
    });
  });

  it('refuses a name that is too long, before trimming', () => {
    // Length before trim, so a megabyte of whitespace is rejected as oversized
    // rather than accepted as empty.
    const long = 'a'.repeat(MAX_DISPLAY_NAME_LENGTH + 1);
    const result = validateProfile({ name: long });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('VALIDATION_FAILED');

    expect(validateProfile({ name: ' '.repeat(MAX_DISPLAY_NAME_LENGTH + 1) }).ok).toBe(false);
  });

  it('gives a name the same character treatment as a message body', () => {
    // A name is displayed to a stranger and read back by a moderator, so it is
    // just as capable of carrying a terminal escape as a message is (I8).
    const control = validateProfile({ name: `Sam${String.fromCharCode(7)}` });
    expect(control.ok).toBe(false);
    if (!control.ok) expect(control.code).toBe('VALIDATION_FAILED');

    const surrogate = validateProfile({ name: `Sam${String.fromCharCode(0xd800)}` });
    expect(surrogate.ok).toBe(false);
  });

  it('never echoes the declared name in a rejection', () => {
    const result = validateProfile({ name: `CANARY${String.fromCharCode(7)}` });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain('CANARY');
  });

  it('refuses a country outside the list rather than dropping it', () => {
    // Silently ignoring an unknown code would let a client believe it had set a
    // country it had not.
    for (const country of ['XX', 'in', 'IND', 'I', 42, {}]) {
      expect(validateProfile({ country }).ok).toBe(false);
    }
    expect(validateProfile({ country: 'IN' })).toEqual({
      ok: true,
      profile: { name: null, country: 'IN', age: null, gender: null, vibe: null },
    });
  });

  it('refuses an age below the minimum with its own code', () => {
    // Its own code so the client can say what the service is, and so the server
    // can count the declaration as a safety signal rather than inferring it
    // from a generic validation failure.
    for (const age of [17, 13, 1, 0, -5]) {
      const result = validateProfile({ age });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('AGE_BELOW_MINIMUM');
    }
    expect(validateProfile({ age: MIN_DECLARED_AGE }).ok).toBe(true);
  });

  it('refuses an age that is not a whole number in range', () => {
    for (const age of [18.5, Number.NaN, Infinity, '25', MAX_DECLARED_AGE + 1]) {
      const result = validateProfile({ age });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('VALIDATION_FAILED');
    }
  });

  it('refuses a profile that is not an object', () => {
    for (const value of ['Sam', 42, true, []]) {
      expect(validateProfile(value).ok).toBe(false);
    }
  });

  it('refuses a gender outside the closed list', () => {
    // Closed for the same reason country is a code: a free-text identity field
    // is somewhere to write a sentence, a slur or a contact handle.
    for (const gender of ['Female', 'f', 'attack helicopter', 42, {}]) {
      expect(validateProfile({ gender }).ok).toBe(false);
    }
    for (const gender of GENDERS) {
      expect(validateProfile({ gender }).ok).toBe(true);
    }
    // Omitting the field is how you decline to say.
    expect(validateProfile({ gender: null }).ok).toBe(true);
    expect(validateProfile({ gender: '' }).ok).toBe(true);
  });

  it('has a display name for every code, and no orphans', () => {
    // The code is what travels; the name is only how it is spelled. A code
    // without a name would render as raw "ZZ" in the chat header and in the
    // moderation console, which is the kind of thing nobody notices until a
    // user asks what country "MF" is.
    const missing = COUNTRY_CODES.filter((code) => !(code in COUNTRY_NAMES));
    const orphans = Object.keys(COUNTRY_NAMES).filter(
      (code) => !(COUNTRY_CODES as readonly string[]).includes(code),
    );
    expect(missing).toEqual([]);
    expect(orphans).toEqual([]);
    expect(countryName('IN')).toBe('India');
    expect(countryName(null)).toBeNull();
    // An unknown code renders as itself rather than as "undefined".
    expect(countryName('ZZ')).toBe('ZZ');
  });

  it('rides along on a join_queue frame', () => {
    const result = parseClientFrame(
      frame({
        type: 'join_queue',
        payload: {
          profile: { name: 'Sam', country: 'IN', age: 27, gender: 'female', vibe: 'deep' },
        },
      }),
      false,
      limits,
    );
    expect(result).toEqual({
      ok: true,
      command: {
        type: 'join_queue',
        clientId: null,
        profile: { name: 'Sam', country: 'IN', age: 27, gender: 'female', vibe: 'deep' },
      },
    });
  });

  it('fails the whole join when the declaration is bad', () => {
    // Rejecting the frame rather than dropping the field: a client that thinks
    // it set an age and was quietly ignored will display one the server does
    // not have.
    const result = parseClientFrame(
      frame({ type: 'join_queue', payload: { profile: { age: 15 } } }),
      false,
      limits,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('AGE_BELOW_MINIMUM');
  });
});
