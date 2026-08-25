/**
 * The console's HTTP surface, mounted behind the session guard.
 *
 * ---------------------------------------------------------------------------
 * WHAT A REQUEST BODY IS ALLOWED TO DECIDE
 * ---------------------------------------------------------------------------
 * A report id, a duration, and words a human typed. Nothing else.
 *
 * In particular **no route accepts an identity hash**. Which party gets
 * sanctioned is derived on the server from the report being acted on. This is
 * the same rule the chat protocol applies to every frame — the server is
 * authoritative, identity never arrives from the client — and it matters more
 * here: a console session that could name its own subject could ban a hash it
 * observed or guessed, and the audit row would record a perfectly well-formed
 * decision with nothing to show it was forged.
 *
 * Every route that discloses or changes anything requires a justification,
 * validated before the work starts. The column is `not null` in the schema;
 * this is where a blank one is refused with a message rather than a constraint
 * violation.
 */
import type { Logger } from '../logger';
import { errorFields } from '../logger';
import { EnforcementService, InvalidBanDurationError } from './enforce';
import {
  JustificationRequiredError,
  normaliseJustification,
  ReviewService,
} from './review';
import type { PersonaConsoleService } from './personas';
import type { PersonaControl, ControlMode, ControlScope } from '../personas/control';
import type { AdminRoute } from './server';
import type { Config } from '../config';

export function createConsoleRoutes(deps: {
  config: Config;
  logger: Logger;
  review: ReviewService;
  enforcement: EnforcementService;
  /** Absent when the persona feature is not deployed; the routes then 404. */
  personas?: PersonaConsoleService;
  personaControl?: PersonaControl;
}): readonly AdminRoute[] {
  const { config, logger, review, enforcement, personas, personaControl } = deps;

  /**
   * Turn the two validation errors into 400s.
   *
   * Anything else propagates to the server's own handler and becomes a 500,
   * which is correct: an unexpected failure here should look like a fault, not
   * like a rejected input the operator could fix by retyping.
   */
  const guard = async (
    work: () => Promise<{ status: number; body: unknown }>,
  ): Promise<{ status: number; body: unknown }> => {
    try {
      return await work();
    } catch (err) {
      if (err instanceof JustificationRequiredError || err instanceof InvalidBanDurationError) {
        return { status: 400, body: { error: 'invalid_request', detail: err.message } };
      }
      logger.error('console route failed', errorFields(err));
      throw err;
    }
  };

  const reportId = (body: Record<string, unknown>): string => {
    const value = body.reportId;
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
      throw new JustificationRequiredError('request is missing a report');
    }
    return value;
  };

  const conversationId = (body: Record<string, unknown>): string => {
    const value = body.conversationId;
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
      throw new JustificationRequiredError('request is missing a conversation');
    }
    return value;
  };

  /** A closed set, so a body cannot invent a scope the table would reject. */
  const controlScope = (value: unknown): ControlScope => {
    if (value === 'global' || value === 'character' || value === 'provider') return value;
    throw new JustificationRequiredError('scope must be global, character or provider');
  };

  const controlSubject = (value: unknown): string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
      throw new JustificationRequiredError('a character or provider name is required');
    }
    return value;
  };

  return [
    {
      method: 'GET',
      path: '/api/reports',
      handle: async () =>
        guard(async () => ({ status: 200, body: { reports: await review.listOpenReports() } })),
    },

    {
      // POST rather than GET, and not because it changes a report: it writes
      // an audit row, and a GET that leaves a permanent record behind is one a
      // browser, a proxy or a prefetcher will happily repeat on its own.
      method: 'POST',
      path: '/api/reports/open',
      handle: async ({ body, identity }) =>
        guard(async () => {
          const justification = normaliseJustification(body.justification);
          const detail = await review.openReport(reportId(body), justification, identity);
          if (detail === null) {
            // Also the answer when the conversation has already been deleted by
            // the retention worker, which is ordinary rather than an error.
            return { status: 404, body: { error: 'not_found' } };
          }
          return { status: 200, body: detail };
        }),
    },

    {
      method: 'POST',
      path: '/api/reports/resolve',
      handle: async ({ body, identity }) =>
        guard(async () => {
          const justification = normaliseJustification(body.justification);
          const outcome = body.outcome === 'ACTIONED' ? 'ACTIONED' : 'DISMISSED';
          const resolution =
            typeof body.resolution === 'string' ? body.resolution.slice(0, 500) : '';
          const applied = await review.resolveReport(
            reportId(body),
            outcome,
            resolution,
            justification,
            identity,
          );
          if (!applied) {
            // Somebody else closed it first. Reported as a conflict rather than
            // a success, so two moderators cannot each believe theirs was the
            // decision that landed.
            return { status: 409, body: { error: 'already_resolved' } };
          }
          return { status: 200, body: { status: 'resolved', outcome } };
        }),
    },

    /* ---------------------------------------------------------------- */
    /* AI personas (D-AI-12)                                             */
    /* ---------------------------------------------------------------- */

    {
      // The list carries no user content — persona ids, our own generated
      // surfaces, counts and costs — so it needs no justification and writes no
      // audit row. Auditing a page rendered on every visit would bury the reads
      // that matter in noise.
      method: 'GET',
      path: '/api/personas',
      handle: async () =>
        guard(async () => {
          if (personas === undefined) return { status: 404, body: { error: 'not_deployed' } };
          const [conversations, overview, switches] = await Promise.all([
            personas.list(50, false),
            personas.overview(),
            personaControl === undefined ? Promise.resolve([]) : personaControl.list(),
          ]);
          return { status: 200, body: { conversations, overview, switches } };
        }),
    },

    {
      // POST, and not because it changes anything: it writes an audit row, and
      // a GET that leaves a permanent record behind is one a browser, a proxy
      // or a prefetcher will happily repeat on its own.
      //
      // Unlike a reported conversation, no report is required to open this
      // (D-AI-12). That makes the audit row the only remaining control on
      // reading a stranger's messages, which is why the justification is still
      // mandatory here.
      method: 'POST',
      path: '/api/personas/open',
      handle: async ({ body, identity }) =>
        guard(async () => {
          if (personas === undefined) return { status: 404, body: { error: 'not_deployed' } };
          const justification = normaliseJustification(body.justification);
          const detail = await personas.open(conversationId(body), justification, identity);
          if (detail === null) return { status: 404, body: { error: 'not_found' } };
          return { status: 200, body: detail };
        }),
    },

    {
      // The kill switch. A body may name a scope and a subject, which looks
      // like the identity-hash rule being broken — it is not: a persona id and
      // a provider name are source constants and public labels, not identities,
      // and nothing a chat user does can reach this table. The rule protects
      // against a console naming a *person*; it does not forbid naming a
      // character the operator wrote.
      method: 'POST',
      path: '/api/personas/control',
      handle: async ({ body, identity }) =>
        guard(async () => {
          if (personaControl === undefined) return { status: 404, body: { error: 'not_deployed' } };
          const justification = normaliseJustification(body.justification);

          const scope = controlScope(body.scope);
          const subject = scope === 'global' ? '' : controlSubject(body.subject);
          const enabled = body.enabled === true;
          // Drain unless a hard stop was asked for explicitly. Ending live
          // conversations mid-sentence is the exception, never the default.
          const mode: ControlMode = body.mode === 'hard' ? 'hard' : 'drain';

          await personaControl.set({
            scope,
            subject,
            enabled,
            mode,
            updatedBy: identity.username,
            reason: justification,
          });

          logger.info('persona control changed', {
            actor: identity.accountId,
            scope,
            subject,
            enabled,
            mode,
          });

          return { status: 200, body: { scope, subject, enabled, mode } };
        }),
    },

    {
      method: 'POST',
      path: '/api/enforcement/ban',
      handle: async ({ body, identity }) =>
        guard(async () => {
          const justification = normaliseJustification(body.justification);
          const seconds =
            typeof body.seconds === 'number' && Number.isFinite(body.seconds)
              ? Math.floor(body.seconds)
              : config.enforcement.defaultBanSeconds;
          const reason = typeof body.reason === 'string' ? body.reason.slice(0, 200) : 'moderation';

          const result = await enforcement.issueBanForReport({
            reportId: reportId(body),
            seconds,
            reason,
            justification,
            identity,
          });

          if (result.status === 'no_subject') {
            // Nothing to attach a sanction to: the reported party's session had
            // expired and no block recorded their hashes. Said plainly, because
            // the alternative is a console that reports success and does
            // nothing.
            return {
              status: 422,
              body: {
                error: 'no_subject',
                detail: 'no identity was recorded for this conversation, so a ban has nothing to attach to',
              },
            };
          }
          if (result.status === 'apply_failed') {
            return {
              status: 503,
              body: {
                error: 'apply_failed',
                detail: 'the decision was recorded and then withdrawn because it could not be applied',
              },
            };
          }
          return {
            status: 200,
            body: {
              status: 'banned',
              enforcementId: result.enforcementId,
              dimensions: result.dimensions,
              expiresAt: result.expiresAt.toISOString(),
            },
          };
        }),
    },

    {
      method: 'POST',
      path: '/api/enforcement/revoke',
      handle: async ({ body, identity }) =>
        guard(async () => {
          const justification = normaliseJustification(body.justification);
          const enforcementId = body.enforcementId;
          if (typeof enforcementId !== 'string' || enforcementId.length === 0) {
            return { status: 400, body: { error: 'invalid_request' } };
          }
          const lifted = await enforcement.revokeBan(enforcementId, justification, identity);
          if (!lifted) return { status: 404, body: { error: 'not_found' } };
          return { status: 200, body: { status: 'revoked' } };
        }),
    },
  ];
}
