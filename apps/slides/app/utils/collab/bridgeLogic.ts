/**
 * The live deck bridge's decisions, as pure functions (unit-tested without a
 * DOM, a Y.Doc or a clock).
 */
import {
  LOCK_BLUR_RELEASE_MS,
  LOCK_HEARTBEAT_MS,
  LOCK_RELEASE_IDLE_MS,
  type LockState,
  type SlideLock,
} from '@classmoji/collab';

/** The bridge's debounce between an edit and its write into the live deck. */
export const SERIALIZE_DEBOUNCE_MS = 300;

export type LocalEditDecision =
  /** Write the slide's html into the live deck now. */
  | 'write'
  /** Take the slide's lock first; write once the claim is confirmed. */
  | 'claim'
  /** Our claim is not confirmed yet: keep the edit, decide again later. */
  | 'wait'
  /** Someone else holds it: put the slide back as the live deck has it. */
  | 'revert';

/**
 * What to do with a local html edit to a slide, given its lock and whether
 * our claim on it has been confirmed (the server has every local update, and
 * the lock still names us — so a lost race never lands our html).
 */
export function decideLocalEdit(lock: LockState, confirmed: boolean): LocalEditDecision {
  switch (lock) {
    case 'free':
      return 'claim';
    case 'mine':
      return confirmed ? 'write' : 'wait';
    case 'held':
    case 'stale':
    default:
      return 'revert';
  }
}

/**
 * Whether a remote html change to a slide is rendered into this editor. Never
 * for a slide this person holds or is claiming (their own edit wins and is
 * about to be written), otherwise yes.
 */
export function shouldRenderRemoteHtml({
  yHtml,
  renderedYHtml,
  heldByMe,
  claiming,
}: {
  yHtml: string | undefined;
  renderedYHtml: string | undefined;
  heldByMe: boolean;
  claiming: boolean;
}): boolean {
  if (yHtml === renderedYHtml) return false;
  return !heldByMe && !claiming;
}

/**
 * Release a held slide after LOCK_RELEASE_IDLE_MS without an edit, or after
 * LOCK_BLUR_RELEASE_MS once the caret has left it.
 */
export function shouldRelease({
  now,
  lastEditAt,
  focused,
  blurredAt,
}: {
  now: number;
  lastEditAt: number;
  focused: boolean;
  blurredAt: number | null;
}): boolean {
  if (now - lastEditAt >= LOCK_RELEASE_IDLE_MS) return true;
  if (!focused) {
    const since = Math.max(lastEditAt, blurredAt ?? lastEditAt);
    return now - since >= LOCK_BLUR_RELEASE_MS;
  }
  return false;
}

/** Heartbeat the held lock at most every LOCK_HEARTBEAT_MS of activity. */
export function heartbeatDue(lastBeatAt: number, now: number): boolean {
  return now - lastBeatAt >= LOCK_HEARTBEAT_MS;
}

export interface SlideLockView {
  slideId: string;
  holder: Pick<SlideLock, 'userId' | 'name' | 'color' | 'clientId'>;
  state: LockState;
  /** True when this person may take the slide over (holder idle or gone). */
  canTakeOver: boolean;
}

/** What the editor shows for one lock. */
export function lockView(slideId: string, lock: SlideLock, state: LockState): SlideLockView {
  return {
    slideId,
    holder: { userId: lock.userId, name: lock.name, color: lock.color, clientId: lock.clientId },
    state,
    canTakeOver: state === 'stale',
  };
}

/** "Collab Teacher 1 is editing" — the holder's full display name. */
export function editingLabel(name: string): string {
  const full = name.trim().replace(/\s+/g, ' ');
  return `${full || 'Someone'} is editing`;
}
