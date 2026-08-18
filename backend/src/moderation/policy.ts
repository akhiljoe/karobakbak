/**
 * Turning rule matches into a decision (D20).
 *
 * ---------------------------------------------------------------------------
 * FLAG, NOT WITHHOLD
 * ---------------------------------------------------------------------------
 * The default action for a match is `flag`: the message is delivered and a
 * signal is recorded. That is the security document's position (§22) and it is
 * the right one for a chat product — local deterministic rules have a real
 * false-positive rate, and a false positive here is a person being told they
 * cannot say something they are allowed to say, which is far more visible and
 * far more damaging than a flagged message a moderator later ignores.
 *
 * Enforcement comes from reports and from the block button, which are the
 * compensating controls. An explicit hard-block set exists for rules an
 * operator is prepared to be wrong about.
 */
import type { Severity } from './rules';
import { RULES, SEVERITY_ORDER, type RuleOptions } from './rules';

/** What the pipeline should do with the message. */
export type ModerationAction = 'allow' | 'flag' | 'withhold' | 'block';

/** Actions an operator may configure as the default for a match. */
export type ConfigurableAction = Exclude<ModerationAction, 'allow'>;

export interface ModerationPolicy extends RuleOptions {
  readonly enabled: boolean;
  readonly defaultAction: ConfigurableAction;
  /** Rule ids that escalate a match to `block` outright. */
  readonly hardBlockRules: readonly string[];
}

export interface ModerationResult {
  readonly action: ModerationAction;
  /** Rule ids that fired. Safe for logs, labels and stored rows — no user text. */
  readonly flags: readonly string[];
  /** The highest severity among the rules that fired. */
  readonly severity: Severity | null;
  /** True when the message may be handed to the partner. */
  readonly deliverable: boolean;
}

const ALLOWED: ModerationResult = {
  action: 'allow',
  flags: [],
  severity: null,
  deliverable: true,
};

/**
 * Evaluate the text rules against an already-normalised moderation view.
 *
 * Every rule runs, even after one has matched: the flags are the product here,
 * and stopping at the first match would make the record depend on the order
 * the rules happen to be declared in.
 */
export function evaluateText(view: string, policy: ModerationPolicy): ModerationResult {
  if (!policy.enabled) return ALLOWED;

  const flags: string[] = [];
  let severity: Severity | null = null;

  for (const rule of RULES) {
    if (!rule.test(view, policy)) continue;
    flags.push(rule.id);
    if (severity === null || SEVERITY_ORDER[rule.severity] > SEVERITY_ORDER[severity]) {
      severity = rule.severity;
    }
  }

  if (flags.length === 0) return ALLOWED;

  const hardBlocked = flags.some((flag) => policy.hardBlockRules.includes(flag));
  const action: ModerationAction = hardBlocked ? 'block' : policy.defaultAction;

  // Only `flag` still delivers. `withhold` and `block` both stop the message;
  // they differ in what the sender is told, not in what the partner sees.
  return { action, flags, severity, deliverable: action === 'flag' };
}

/** The decision for content this server does not know how to moderate. */
export const UNSUPPORTED: ModerationResult = {
  action: 'block',
  flags: ['unsupported_content_type'],
  severity: 'high',
  deliverable: false,
};
