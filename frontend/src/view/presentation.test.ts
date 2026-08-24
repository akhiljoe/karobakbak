/**
 * The mapping from protocol state to layout.
 *
 * This file had no tests, and that is not incidental to what was wrong with
 * it. When D42 reversed D7 — a dropped socket stopped ending the conversation —
 * the reducer was updated and so were its tests. `presentation.ts` was not, and
 * nothing failed, so `phaseOf` went on sending a disconnected-but-still-matched
 * session to the landing screen for as long as the feature existed. The parts
 * of a codebase that have tests get updated; the parts that do not, do not.
 */
import { describe, expect, it } from 'vitest';

import { initialState, type ChatState } from '../state/machine';
import { composerDisabled, connectionOf, phaseOf } from './presentation';

function state(overrides: Partial<ChatState>): ChatState {
  return { ...initialState, ...overrides };
}

describe('which layout is on screen', () => {
  it('keeps the conversation on screen while the socket comes back', () => {
    // The reducer deliberately preserves `matchId` and the transcript through a
    // `socket_closed`, because the server is holding the seat (§28). Reading
    // the screen alone threw that away: the user was shown a landing page
    // headed "Meet someone new." over a conversation that had not ended, and
    // the obvious response to that page — closing the tab — takes the
    // `sessionStorage` resume token with it and makes the ending real.
    expect(phaseOf(state({ screen: 'disconnected', matchId: 'm_1' }))).toBe('chatting');
  });

  it('shows the landing layout for a disconnect with nothing to hold', () => {
    expect(phaseOf(state({ screen: 'disconnected', matchId: null }))).toBe('idle');
    expect(phaseOf(state({ screen: 'connecting' }))).toBe('idle');
    expect(phaseOf(state({ screen: 'idle' }))).toBe('idle');
  });

  it('maps the settled screens unchanged', () => {
    expect(phaseOf(state({ screen: 'searching' }))).toBe('searching');
    expect(phaseOf(state({ screen: 'chatting', matchId: 'm_1' }))).toBe('chatting');
    expect(phaseOf(state({ screen: 'ended' }))).toBe('ended');
  });

  it('does not resurrect a conversation that genuinely ended', () => {
    // `ended` carries no matchId, and a disconnect afterwards must not be read
    // as a conversation to hold.
    expect(phaseOf(state({ screen: 'ended', matchId: null }))).toBe('ended');
  });
});

describe('what the connection pill and banner say', () => {
  it('calls a dropped socket reconnecting, because the client always retries', () => {
    expect(connectionOf('disconnected')).toBe('reconnecting');
  });

  it('separates the first connection from a reconnection', () => {
    expect(connectionOf('connecting')).toBe('connecting');
  });

  it('says nothing at all once the socket is up', () => {
    expect(connectionOf('chatting')).toBe('connected');
    expect(connectionOf('idle')).toBe('connected');
    expect(connectionOf('searching')).toBe('connected');
    expect(connectionOf('ended')).toBe('connected');
  });

  it('is reconnecting exactly when the shell is showing a held conversation', () => {
    // The pair that matters: the layout stays, and the banner inside it now has
    // something to say. Before, `ReconnectBanner` was mounted only inside
    // `ChatShell`, `ChatShell` rendered only for screens that map to
    // 'connected', and so the component could never display anything at all.
    const dropped = state({ screen: 'disconnected', matchId: 'm_1' });
    expect(phaseOf(dropped)).toBe('chatting');
    expect(connectionOf(dropped.screen)).toBe('reconnecting');
  });
});

describe('whether the composer accepts input', () => {
  it('is closed while the socket is away, however the layout reads', () => {
    // The conversation stays on screen; the ability to send does not. A message
    // handed to a closed socket goes nowhere, and nothing is buffered (D43).
    const dropped = state({ screen: 'disconnected', matchId: 'm_1' });
    expect(phaseOf(dropped)).toBe('chatting');
    expect(composerDisabled(dropped)).toBe(true);
  });

  it('is closed while the partner is away, for the same reason', () => {
    expect(
      composerDisabled(state({ screen: 'chatting', matchId: 'm_1', partnerAway: '2026-08-19T10:00:20.000Z' })),
    ).toBe(true);
  });

  it('is open in a live conversation', () => {
    expect(composerDisabled(state({ screen: 'chatting', matchId: 'm_1' }))).toBe(false);
  });
});
