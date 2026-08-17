import { parseClientFrame, validateMessageText } from '../../src/protocol/validate';
import { PROTOCOL_VERSION } from '../../src/protocol/types';

const limits = { maxMessageLength: 20 };

/** Build a raw frame the way a client would. */
function frame(overrides: Record<string, unknown>): string {
  return JSON.stringify({ version: PROTOCOL_VERSION, ...overrides });
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
    expect(result).toEqual({ ok: true, command: { type: 'join_queue', clientId: null } });
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
      frame({
        type: 'message',
        payload: { text: 'hi', to: 's_victim', from: 's_admin', matchId: 'm_forged' },
      }),
      false,
      limits,
    );
    expect(result).toEqual({
      ok: true,
      command: { type: 'message', clientId: null, contentType: 'text', text: 'hi' },
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

describe('parseClientFrame — message payload', () => {
  it('accepts text and trims surrounding whitespace', () => {
    const result = parseClientFrame(frame({ type: 'message', payload: { text: '  hi  ' } }), false, limits);
    expect(result).toEqual({
      ok: true,
      command: { type: 'message', clientId: null, contentType: 'text', text: 'hi' },
    });
  });

  it('rejects a non-string text field', () => {
    expectError(
      parseClientFrame(frame({ type: 'message', payload: { text: 42 } }), false, limits),
      'VALIDATION_FAILED',
    );
    expectError(
      parseClientFrame(frame({ type: 'message', payload: {} }), false, limits),
      'VALIDATION_FAILED',
    );
    expectError(
      parseClientFrame(frame({ type: 'message', payload: { text: null } }), false, limits),
      'VALIDATION_FAILED',
    );
  });

  it('rejects empty and whitespace-only text', () => {
    expectError(
      parseClientFrame(frame({ type: 'message', payload: { text: '' } }), false, limits),
      'EMPTY_MESSAGE',
    );
    expectError(
      parseClientFrame(frame({ type: 'message', payload: { text: '   \n\t ' } }), false, limits),
      'EMPTY_MESSAGE',
    );
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
    const result = validateMessageText('<img src=x>', { maxMessageLength: 2000 });
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
    const result = parseClientFrame(frame({ type: 'message', payload: { text: 'hi' } }), false, limits);
    expect(result).toEqual({
      ok: true,
      command: { type: 'message', clientId: null, contentType: 'text', text: 'hi' },
    });
  });

  it('accepts an explicit text discriminator', () => {
    const result = parseClientFrame(
      frame({ type: 'message', payload: { type: 'text', text: 'hi' } }),
      false,
      limits,
    );
    expect(result).toEqual({
      ok: true,
      command: { type: 'message', clientId: null, contentType: 'text', text: 'hi' },
    });
  });

  it('treats an explicit null discriminator as text rather than failing', () => {
    const result = parseClientFrame(
      frame({ type: 'message', payload: { type: null, text: 'hi' } }),
      false,
      limits,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects every unimplemented content type — a client cannot opt into future features', () => {
    for (const spoofed of ['image', 'voice', 'video', 'audio', 'file', 'sticker']) {
      const result = parseClientFrame(
        frame({ type: 'message', payload: { type: spoofed, text: 'hi' } }),
        false,
        limits,
      );
      expectError(result, 'UNSUPPORTED_CONTENT_TYPE');
    }
  });

  it('rejects rather than coerces an unknown type, so a client is never told text was sent', () => {
    const result = parseClientFrame(
      frame({ type: 'message', payload: { type: 'image', text: 'caption' } }),
      false,
      limits,
    );
    // Crucially NOT { ok: true, contentType: 'text' } — coercion would mean the
    // sender believes an image was delivered when only text was.
    expect(result.ok).toBe(false);
  });

  it('rejects a non-string discriminator', () => {
    for (const bogus of [42, true, {}, ['text']]) {
      const result = parseClientFrame(
        frame({ type: 'message', payload: { type: bogus, text: 'hi' } }),
        false,
        limits,
      );
      expectError(result, 'UNSUPPORTED_CONTENT_TYPE');
    }
  });

  it('rejects reserved media fields instead of silently ignoring them', () => {
    for (const field of ['mediaId', 'media', 'attachment', 'attachments', 'blob', 'file', 'url']) {
      const result = parseClientFrame(
        frame({ type: 'message', payload: { text: 'hi', [field]: 'm_fabricated' } }),
        false,
        limits,
      );
      expectError(result, 'UNSUPPORTED_CONTENT_TYPE');
    }
  });

  it('rejects a fabricated media reference even when the type is valid text', () => {
    const result = parseClientFrame(
      frame({ type: 'message', payload: { type: 'text', text: 'hi', mediaId: 'm_1' } }),
      false,
      limits,
    );
    expectError(result, 'UNSUPPORTED_CONTENT_TYPE');
  });

  it('never names the rejected type in the error, so the reply is not a capability oracle', () => {
    const result = parseClientFrame(
      frame({ type: 'message', payload: { type: 'video', text: 'hi' } }),
      false,
      limits,
    );
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
      parseClientFrame(
        frame({ type: 'message', payload: { type: 'text', text: '' } }),
        false,
        limits,
      ),
      'EMPTY_MESSAGE',
    );
    expectError(
      parseClientFrame(
        frame({ type: 'message', payload: { type: 'text', text: 'x'.repeat(21) } }),
        false,
        limits,
      ),
      'MESSAGE_TOO_LONG',
    );
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
    for (const event of ['join_queue', 'leave_queue', 'skip', 'ping']) {
      const result = parseClientFrame(frame({ type: event, payload: {} }), false, limits);
      expect(result.ok).toBe(true);
    }
  });
});
