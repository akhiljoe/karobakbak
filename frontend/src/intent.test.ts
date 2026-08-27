/**
 * The one-shot "start chatting" request.
 *
 * Small enough to look obviously correct and worth a test anyway: the whole
 * value of the module is that reading *clears*, and a version that forgot to
 * would arm every later return to the home screen in the same tab — a visitor
 * who read the Rules once would be dropped into the queue every time they
 * navigated home afterwards.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { consumeChatRequest, requestChat } from './intent';

describe('the start-chatting request', () => {
  beforeEach(() => {
    // The module is a singleton across tests; drain anything left behind.
    consumeChatRequest();
  });

  it('is absent until somebody asks', () => {
    expect(consumeChatRequest()).toBe(false);
  });

  it('survives long enough to be read once', () => {
    requestChat();
    expect(consumeChatRequest()).toBe(true);
  });

  it('is spent when it is read', () => {
    requestChat();
    consumeChatRequest();
    expect(consumeChatRequest()).toBe(false);
  });

  it('does not stack, so two presses are still one conversation', () => {
    requestChat();
    requestChat();
    expect(consumeChatRequest()).toBe(true);
    expect(consumeChatRequest()).toBe(false);
  });
});
