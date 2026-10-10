/**
 * Composing one persona: socket, voice, guard, bookkeeping.
 *
 * Everything up to here is a part. This is where the parts become a thing that
 * can hold a conversation, and where the order they are stacked in matters:
 *
 *   client  ->  guard  ->  voice (model, falling back to scripted)
 *
 * The guard sits **between** the client and the voice, so every reply passes
 * through it on the way out and every incoming message passes through it on the
 * way in. Stacking it the other way round — guard inside the voice — would make
 * the limits something the model can be argued past, which is the whole failure
 * A5 exists to prevent.
 *
 * It also writes the `persona_conversations` row. That is the only place the
 * console's view of a persona conversation comes from, and it is written here
 * rather than by the chat server because the chat server does not know personas
 * exist (D-AI-6).
 */

import type { Config } from '../config';
import type { Logger } from '../logger';
import type { Database } from '../storage/pool';
import type { PersonaBudget } from './budget';
import { PersonaClient } from './client';
import type { PersonaVoice } from './client';
import { guardVoice } from './guard';
import type { LimitId } from './guard';
import type { JevClient } from './jev';
import { personaJudge } from './judge';
import type { PersonaMetrics } from './metrics';
import type { ModelProvider } from './provider';
import { generateSurface } from './surface';
import type { LivePersona } from './supervisor';
import type { PersonaCharacter } from './types';
import { modelVoice } from './voice-model';
import { scriptedVoice } from './voice-scripted';

/** Limits that mean a person should look at the conversation. */
const FLAGGING_LIMITS: ReadonlySet<LimitId> = new Set(['minor', 'crisis']);

export interface RunnerDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly db: Database;
  readonly budget: PersonaBudget;
  readonly provider: ModelProvider | null;
  /** Shared by every persona, so its breakers see the whole population's calls. */
  readonly jev: JevClient;
  readonly metrics: PersonaMetrics;
  readonly url: string;
  readonly origin: string;
}

/**
 * Start one persona and return the handle the supervisor holds.
 *
 * Returns null if the socket could not be opened. The supervisor treats that as
 * a failed dispatch and tries again on a later tick rather than retrying here:
 * a retry loop inside a dispatch would outrun the connection rate limit that
 * every persona shares (they come from one address).
 */
export async function startPersona(
  character: PersonaCharacter,
  deps: RunnerDeps,
): Promise<LivePersona | null> {
  const surface = generateSurface(character, {
    noNameChance: deps.config.personas.noNameChance,
    declineChance: deps.config.personas.declineChance,
  });

  // Scripted always exists. It is the opening act before A4's model is
  // configured, and afterwards it is the fallback when the ceiling is reached
  // or a provider is down — a persona that says something plain beats one that
  // goes silent mid-conversation.
  const scripted = scriptedVoice(character, {
    maxMessages: deps.config.personas.scriptedMaxMessages,
  });

  const inner: PersonaVoice =
    deps.provider === null
      ? scripted
      : modelVoice({
          provider: deps.provider,
          budget: deps.budget,
          character,
          surfaceDescription: describe(surface.profile),
          logger: deps.logger,
          fallback: scripted,
          onSpend: (event) => {
            deps.metrics.spend(event);
            state.cost += event.costMicroCents;
          },
          recentTurns: deps.config.personas.contextTurns,
          maxOutputTokens: deps.config.personas.maxOutputTokens,
        });

  const state = {
    cost: 0,
    replies: 0,
    limits: new Set<string>(),
    flagged: false,
    conversationId: null as string | null,
    written: false,
  };

  // One judge per conversation over one shared client: the spend callback is
  // per conversation, the breakers are per process.
  const judge = personaJudge({
    jev: deps.jev,
    logger: deps.logger,
    minConfidence: deps.config.jev.minConfidence,
    inputMicroCentsPerMTok: deps.config.jev.inputMicroCentsPerMTok,
    budget: deps.budget,
    onSpend: (event) => {
      deps.metrics.spend(event);
      state.cost += event.costMicroCents;
    },
  });

  const voice = guardVoice({
    inner,
    judge,
    logger: deps.logger,
    events: {
      onRegenerate: () => deps.metrics.regenerated(),
      onTrip: (trip) => {
        state.limits.add(trip.limit);
        deps.metrics.limitTripped(trip);
      },
      onFlagSession: (reason) => {
        state.flagged = true;
        deps.metrics.sessionFlagged(reason);
        if (FLAGGING_LIMITS.has(reason)) {
          deps.logger.warn('persona session flagged for review', {
            personaId: character.id,
            reason,
          });
        }
      },
    },
  });

  const client = new PersonaClient({
    url: deps.url,
    origin: deps.origin,
    character,
    profile: surface.profile,
    intent: surface.intent,
    voice,
    silenceTimeoutMs: deps.config.personas.silenceTimeoutSeconds * 1000,
    // Delivery is a tell of its own, so the intervals are configuration rather
    // than constants: a deployment that finds its personas readable can move
    // them without a rebuild (`PERSONA_*_MS`).
    tuning: deps.config.personas.cadence,
    repeatsBeforeLeaving: deps.config.personas.repeatsBeforeLeaving,
    onEvent: (event) => {
      switch (event.kind) {
        case 'matched':
          state.conversationId = event.matchId;
          state.written = false;
          state.replies = 0;
          deps.metrics.conversationStarted();
          void writeIndexRow();
          break;
        case 'sent':
          state.replies += 1;
          deps.metrics.replySent(character.id);
          break;
        case 'partner_gone':
          void finishConversation('partner_left');
          break;
        case 'moved_on':
          // The persona left of its own accord and is already back in the
          // queue. The row has to be closed here — `skip` produces no server
          // event for the side that sent it, so nothing else would ever finish
          // this conversation and the console would show it open forever.
          deps.logger.info('persona moved on', {
            personaId: character.id,
            reason: event.reason,
          });
          void finishConversation('we_left');
          break;
        case 'closed':
          void finishConversation('dropped');
          break;
        default:
          break;
      }
    },
  });

  /**
   * Write the console's index row when the conversation starts.
   *
   * At the start rather than at the end, because a persona whose process dies
   * mid-conversation would otherwise leave a transcript in `messages` that the
   * console cannot find — invisible in the one view whose purpose is judging
   * what personas said.
   */
  async function writeIndexRow(): Promise<void> {
    const conversationId = state.conversationId;
    if (conversationId === null || state.written) return;
    state.written = true;

    const days = deps.config.retention.days.conversation;
    try {
      await deps.db.query(
        `insert into persona_conversations
           (conversation_id, persona_id, surface, persona_session_id, provider, model,
            started_at, replies, cost_micro_cents, limits_tripped, flagged,
            retention_expires_at)
         values ($1, $2, $3, $4, $5, $6, now(), 0, 0, '{}', false, now() + ($7 || ' days')::interval)
         on conflict (conversation_id) do nothing`,
        [
          conversationId,
          character.id,
          JSON.stringify(surface.profile),
          client.currentSessionId(),
          deps.provider?.name ?? null,
          deps.config.personas.model,
          String(days),
        ],
      );
    } catch (err) {
      // Not fatal. Losing the index row costs the console its view of one
      // conversation; failing the conversation would cost a real person their
      // chat. Never make the socket wait on PostgreSQL (D16).
      deps.logger.warn('persona conversation row not written', {
        personaId: character.id,
        err: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  /** Close out the row once the conversation ends. */
  async function finishConversation(outcome: 'partner_left' | 'we_left' | 'dropped'): Promise<void> {
    const conversationId = state.conversationId;
    if (conversationId === null) return;
    state.conversationId = null;

    deps.metrics.conversationEnded(character.id, outcome, state.replies);

    try {
      await deps.db.query(
        `update persona_conversations
            set ended_at = now(), replies = $2, cost_micro_cents = $3,
                limits_tripped = $4, flagged = $5
          where conversation_id = $1`,
        [
          conversationId,
          state.replies,
          state.cost,
          [...state.limits],
          state.flagged,
        ],
      );
    } catch (err) {
      deps.logger.warn('persona conversation row not closed', {
        personaId: character.id,
        err: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  try {
    await client.connect();
  } catch (err) {
    deps.logger.warn('persona could not connect', {
      personaId: character.id,
      err: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }

  client.joinQueue();

  const handle: LivePersona = {
    characterId: character.id,
    get sessionId(): string | null {
      return client.currentSessionId();
    },
    set sessionId(_value: string | null) {
      // The client owns it; the supervisor only reads it.
    },
    get searching(): boolean {
      return client.currentState() === 'searching';
    },
    set searching(_value: boolean) {
      // Derived from the client's state, never set from outside.
    },
    withdraw: () => {
      client.leaveChat();
    },
    stop: () => {
      void finishConversation('we_left');
      client.close();
    },
  };

  return handle;
}

/** One line describing the surface, for the model's volatile prompt half. */
function describe(profile: {
  name: string | null;
  age: number | null;
  gender: string | null;
  country: string | null;
}): string {
  const parts = [
    profile.name === null ? 'no name given' : profile.name,
    profile.age === null ? null : `${profile.age}`,
    profile.gender,
    profile.country,
  ].filter((part): part is string => part !== null && part !== '');
  return parts.join(', ');
}
