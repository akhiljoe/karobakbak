/**
 * The moderation entry point (§23.5).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A DISPATCH AND NOT `moderateText(message.text)`
 * ---------------------------------------------------------------------------
 * There is exactly one branch today, and there is no plan to add another — the
 * product is text only (§23). The shape exists anyway, because the alternative
 * hardens fast: once a call site reads `.text` directly, every future content
 * type has to be threaded back through code that has already assumed there is
 * only one kind of content. The dispatch costs a switch statement now and makes
 * that assumption impossible to make.
 *
 * The invariant is the point: **no content reaches delivery or persistence
 * without passing through here**, and a type this server does not handle
 * **fails closed**. It does not fall through the switch, it does not get
 * coerced to text, and it is not delivered while somebody works out what to do
 * with it. A sender who believes an image was delivered when only a caption
 * was is worse off than one whose message was refused (§23.6).
 */
import type { MessageContentType } from '../protocol/types';
import { moderationView } from './normalise';
import { evaluateText, UNSUPPORTED, type ModerationPolicy, type ModerationResult } from './policy';

export type { ModerationAction, ModerationPolicy, ModerationResult } from './policy';
export { RULE_IDS } from './rules';
export { moderationView } from './normalise';

/** One piece of content to be judged. */
export interface ModeratableContent {
  readonly type: MessageContentType;
  readonly text: string;
}

/**
 * Judge one message.
 *
 * The caller passes the content type it validated, never a bare string, so the
 * dispatch cannot be bypassed by a call site that happens to know the message
 * is text.
 */
export function moderate(content: ModeratableContent, policy: ModerationPolicy): ModerationResult {
  switch (content.type) {
    case 'text':
      return evaluateText(moderationView(content.text), policy);
    default:
      // Unreachable while `MessageContentType` is exactly `'text'`. It stops
      // being unreachable the moment a type is added to that union without a
      // branch here — and on that day this must refuse, not deliver.
      return UNSUPPORTED;
  }
}
