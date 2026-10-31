/**
 * The refusals Ask Moji's admission and session start can return, and
 * whether each is permanent. One table for the services (which decide), the
 * task (which closes the chat on a permanent one) and the widget (which shows
 * the code's line from copy.ts).
 *
 *   permanent  the conversation takes no more turns: the task writes the
 *              notice and closes the chat; the user starts a new one
 *   transient  this message is refused, the conversation stays open
 */
import type { AskMojiCopyCode } from './copy.ts';

export const ASK_MOJI_REFUSALS = {
  /** No such Ask Moji conversation on this runtime (missing, another type, no grant, not the owner's). */
  NOT_FOUND: 'permanent',
  /** The conversation was ended (New conversation, or a newer one for the same view). */
  CONVERSATION_ENDED: 'permanent',
  /** The grant no longer holds: another user, or the impersonation behind it ended. */
  SESSION_ENDED: 'permanent',
  /** The user is no longer a member of the conversation's classroom. */
  NOT_A_MEMBER: 'permanent',
  /** The user no longer holds the role the conversation was started as. */
  NOT_ALLOWED: 'permanent',
  CLASSROOM_LOCKED: 'transient',
  CLASSROOM_UNPUBLISHED: 'transient',
  /** Not Pro (or the lookup failed). */
  UNAVAILABLE: 'transient',
  /** `syllabus_bot_enabled` is off. */
  NOT_ENABLED: 'transient',
  /** Sent within `MIN_TURN_INTERVAL_MS` of the previous admitted message. */
  PACE: 'transient',
  /** Not one well-formed user text message (metadata included), or an id reused for another text. */
  INVALID_MESSAGE: 'transient',
  /** Too many conversations started recently (`START_RATE_LIMIT`; session start only). */
  RATE_LIMITED: 'transient',
} as const satisfies Partial<Record<AskMojiCopyCode, 'permanent' | 'transient'>>;

export type AskMojiRefusalCode = keyof typeof ASK_MOJI_REFUSALS;

export const isPermanentRefusal = (code: AskMojiRefusalCode): boolean =>
  ASK_MOJI_REFUSALS[code] === 'permanent';
