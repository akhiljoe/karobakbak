/**
 * The advertising boundary (D22, I13).
 *
 * ---------------------------------------------------------------------------
 * ADVERTISING IS FRONTEND-ONLY, AND THAT IS THE CONTROL
 * ---------------------------------------------------------------------------
 * The backend has no ad module, no ad endpoint and no ad state. That is what
 * makes "advertising can never observe or influence matchmaking" structurally
 * true rather than merely intended: there is nothing on the server for an ad to
 * read, so no future change can accidentally let one in without first building
 * the surface that does not exist.
 *
 * A provider therefore gets what this file passes it and nothing else. It is
 * never handed a session id, a match id, a message, a partner, or anything
 * derived from a conversation.
 */

import { clientConfig } from '../config';

export interface AdPlacement {
  /** Where on the page. The only context a provider receives. */
  readonly slot: 'landing' | 'between-chats';
}

export interface AdCreative {
  readonly headline: string;
  readonly body: string;
}

export interface AdProvider {
  readonly name: string;
  /** Null means "show nothing", which the UI must handle as the normal case. */
  request(placement: AdPlacement): AdCreative | null;
}

/** Shows nothing. The default, and what runs until a real provider is chosen. */
export const noopProvider: AdProvider = {
  name: 'noop',
  request: () => null,
};

/**
 * House ads: the product talking about itself. No network, no third party, no
 * tracking — which is why it is the only provider that ships before the
 * retention question in the ads document is answered.
 */
export const houseProvider: AdProvider = {
  name: 'house',
  request: (placement) =>
    placement.slot === 'landing'
      ? { headline: 'Nobody knows who you are', body: 'No account, no profile, no history.' }
      : { headline: 'Say something kind', body: 'The person on the other side is real.' },
};

export function providerFrom(name: string | undefined): AdProvider {
  return name === 'house' ? houseProvider : noopProvider;
}

/** Whether ads are enabled at all, from the build-time flag. */
export function adsEnabled(): boolean {
  return clientConfig.ads.enabled;
}
