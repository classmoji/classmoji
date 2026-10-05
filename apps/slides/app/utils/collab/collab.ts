/**
 * Live collaborative editing — the pure decisions the deck route and editor
 * share. No React, no Reveal, no server imports: the Playwright unit runner
 * tests this module directly, and the client bundle imports it.
 *
 * A deck is in COLLAB MODE when the loader handed out `collab` loader data:
 * the classroom has `collab_enabled`, this user may edit the deck, and the
 * view is not a preview branch. In collab mode the deck lives on the collab
 * server; the git save machinery (save button, ops diff, conflict chooser,
 * fetch-latest, beforeunload) is switched off, because the git worker is the
 * only thing that writes deck.json.
 */

import {
  isCollabRejectReason,
  splitAgentName,
  type CollabLoaderData,
  type CollabRejectReason,
} from '@classmoji/collab';

export type { CollabLoaderData, CollabRejectReason };

/** True when the deck is edited live (the loader handed out collab data). */
export function isCollabMode(
  collab: CollabLoaderData | null | undefined
): collab is CollabLoaderData {
  return Boolean(collab && collab.wsUrl && collab.room);
}

// ─── Connection state ────────────────────────────────────────────────────────

/** The provider's WebSocket status (`WebSocketStatus` values). */
export type ProviderStatus = 'connecting' | 'connected' | 'disconnected';

/** What the header shows (`connecting`: not synced even once yet — not a drop). */
export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'connecting';

export const SYNC_STATUS_LABEL: Record<SyncStatus, string> = {
  synced: 'Synced',
  syncing: 'Syncing',
  offline: 'Offline',
  connecting: 'Connecting',
};

/**
 * The header's sync status from the provider's state: connecting until the
 * socket first opens and syncs (offline at once if the room was refused),
 * offline when it is not open after that,
 * syncing until the handshake finished and while local changes wait for the
 * server's acknowledgement, synced otherwise.
 */
export function deriveSyncStatus({
  status,
  synced,
  unsyncedChanges,
  hasSynced,
  rejected,
}: {
  status: ProviderStatus;
  synced: boolean;
  unsyncedChanges: number;
  /** Synced at least once this session (absent: assume so). */
  hasSynced?: boolean;
  /** The server refused the room: no connection is coming. */
  rejected?: unknown;
}): SyncStatus {
  if (rejected) return 'offline';
  if (status !== 'connected') return hasSynced === false ? 'connecting' : 'offline';
  if (!synced || unsyncedChanges > 0) return 'syncing';
  return 'synced';
}

// ─── Refusals ────────────────────────────────────────────────────────────────

/**
 * The server's refusal, as the client acts on it. Hocuspocus sends
 * `error.reason ?? 'permission-denied'`; any reason that is not one of ours
 * is treated as forbidden (the safe reading: stop editing).
 */
/** Why live editing stopped (the shared contract's reasons). */
export type LiveRejectReason = CollabRejectReason;

/** Anything that is not one of ours reads as forbidden (the safe reading). */
export function normalizeRejectReason(reason: unknown): LiveRejectReason {
  return isCollabRejectReason(reason) ? reason : 'forbidden';
}

export interface RejectionNotice {
  /** `reload` reloads the route at once; `prompt` asks; `readonly` explains. */
  action: 'reload' | 'prompt' | 'readonly';
  message: string | null;
}

export function rejectionNotice(reason: LiveRejectReason): RejectionNotice {
  switch (reason) {
    case 'stale-epoch':
      return { action: 'reload', message: null };
    case 'schema-mismatch':
      return { action: 'prompt', message: 'Reload to get the latest editor.' };
    case 'unavailable':
      return { action: 'prompt', message: "Couldn't connect to live editing. Try again." };
    case 'legacy-html':
      return { action: 'readonly', message: "This deck can't be edited live." };
    case 'forbidden':
    default:
      return { action: 'readonly', message: 'You can no longer edit this deck.' };
  }
}

// ─── Presence ────────────────────────────────────────────────────────────────

export interface CollabPeer {
  /** User id when known; peers without one are keyed by their client id. */
  key: string;
  name: string;
  color: string;
  /** True for the local user. */
  self: boolean;
  /** The slide (data-cm-id) this person is on, when they share it. */
  slideId: string | null;
  /** An agent editing on someone's behalf (`name` is without the " (agent)" suffix). */
  agent: boolean;
  /** An agent's tag: `agent`, or `agent 2` while one person has several agent sessions here. */
  agentTag?: string;
}

/** An awareness name split into the person's name, whether it is an agent, and its tag. */
export function agentName(
  name: string,
  flagged = false
): { name: string; agent: boolean; tag?: string } {
  const split = splitAgentName(name);
  if (split.tag) return { name: split.name, agent: true, tag: split.tag };
  return flagged ? { name, agent: true, tag: 'agent' } : { name, agent: false };
}

/** The label for a peer: "Name", "Name (agent)", "Name (agent 2)" or "Name (you)". */
export function peerLabel(
  peer: Pick<CollabPeer, 'name' | 'agent'> & { self?: boolean; agentTag?: string }
): string {
  if (peer.self) return `${peer.name} (you)`;
  return peer.agent ? `${peer.name} (${peer.agentTag ?? 'agent'})` : peer.name;
}

/**
 * Connected users from awareness states, one entry per user (two tabs of the
 * same person show once), the local user first. The deck editor puts
 * `{ id, name, color }` under `user` and the current slide id under `slide`.
 */
export function peersFromAwareness(
  states: Iterable<[number, Record<string, unknown>]>,
  localClientId: number,
  localUserId: string
): CollabPeer[] {
  const byKey = new Map<string, CollabPeer>();
  for (const [clientId, state] of states) {
    const user = state?.user as
      | { id?: unknown; name?: unknown; color?: unknown; agent?: unknown }
      | undefined;
    if (!user || typeof user.name !== 'string' || !user.name) continue;
    const id = typeof user.id === 'string' && user.id ? user.id : null;
    const key = id ?? `client:${clientId}`;
    const self = clientId === localClientId || (id !== null && id === localUserId);
    const slideId = typeof state.slide === 'string' && state.slide ? state.slide : null;
    const existing = byKey.get(key);
    if (existing) {
      existing.self = existing.self || self;
      existing.slideId ??= slideId;
      continue;
    }
    const who = agentName(user.name, user.agent === true);
    byKey.set(key, {
      key,
      name: who.name,
      agent: who.agent,
      ...(who.tag ? { agentTag: who.tag } : {}),
      color: typeof user.color === 'string' && user.color ? user.color : '#6b7280',
      self,
      slideId,
    });
  }
  const peers = [...byKey.values()];
  peers.sort(
    (a, b) =>
      Number(b.self) - Number(a.self) ||
      a.name.localeCompare(b.name) ||
      Number(a.agent) - Number(b.agent) ||
      (a.agentTag ?? '').localeCompare(b.agentTag ?? '', undefined, { numeric: true })
  );
  return peers;
}

/** One or two initials for an avatar (an agent's suffix ignored). */
export function initialsOf(name: string): string {
  const words = agentName(name).name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1][0] ?? '') : '';
  return (first + last).toUpperCase();
}

// ─── Messages from the collab server ─────────────────────────────────────────

/** The last checkpoint covering this deck, as the header shows it. */
export interface LiveCheckpoint {
  /** ISO time of the run; '' when the deck is saved but the time is not known. */
  at: string;
  commit?: string;
  /** Why the run did not save this deck (absent when it did). */
  error?: string;
  /** The Save-version requests this run answered (only the run that consumed them). */
  requestIds?: string[];
  /** With `requestIds`: there was nothing to push for this deck. */
  alreadySaved?: true;
  /** The deck held edits this run did not push (made while it ran, or refused). */
  editsSince?: boolean;
}

/** Stateless messages the collab server broadcasts to a deck's room. */
export type LiveStatelessMessage =
  | ({ type: 'checkpoint' } & LiveCheckpoint)
  | { type: 'deck-meta'; title?: string }
  | { type: 'preview-changed' };

/** A stateless payload as one of ours, or null for anything else. */
export function parseStatelessMessage(payload: unknown): LiveStatelessMessage | null {
  let value: unknown = payload;
  if (typeof payload === 'string') {
    try {
      value = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const message = value as Record<string, unknown>;
  if (message.type === 'checkpoint') {
    if (typeof message.at !== 'string' || !message.at) return null;
    const requestIds = Array.isArray(message.requestIds)
      ? message.requestIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    return {
      type: 'checkpoint',
      at: message.at,
      ...(typeof message.commit === 'string' && message.commit ? { commit: message.commit } : {}),
      ...(typeof message.error === 'string' && message.error ? { error: message.error } : {}),
      ...(requestIds.length > 0 ? { requestIds } : {}),
      ...(message.alreadySaved === true ? { alreadySaved: true as const } : {}),
      ...(message.editsSince === true ? { editsSince: true } : {}),
    };
  }
  if (message.type === 'preview-changed') return { type: 'preview-changed' };
  if (message.type === 'deck-meta') {
    if (typeof message.title !== 'string' || !message.title) return null;
    return { type: 'deck-meta', title: message.title };
  }
  return null;
}

/** "just now", "2 minutes ago", "3 hours ago", "4 days ago". */
export function relativeTimeFrom(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return 'just now';
  const unit = (value: number, word: string) => `${value} ${word}${value === 1 ? '' : 's'} ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return unit(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return unit(hours, 'hour');
  return unit(Math.round(hours / 24), 'day');
}

const REASON_CAP = 120;

/**
 * The header's "saved to GitHub" line: when the last checkpoint covering the
 * deck saved it (tooltip: the commit), or that it has not been saved yet
 * (tooltip: a short reason). Null before anything is known.
 */
export function savedToGitHubStatus(
  checkpoint: LiveCheckpoint | null,
  now: number,
  editsSince = false
): { tone: 'saved' | 'unsaved'; label: string; title: string | undefined } | null {
  if (!checkpoint) return null;
  if (checkpoint.error) {
    const reason = checkpoint.error.replace(/\s+/g, ' ').trim();
    return {
      tone: 'unsaved',
      label: 'Not saved to GitHub yet',
      title: reason.length > REASON_CAP ? `${reason.slice(0, REASON_CAP - 1)}…` : reason,
    };
  }
  const when = checkpoint.at ? relativeTimeFrom(checkpoint.at, now) : '';
  const saved = when ? `Saved to GitHub ${when}` : 'Saved to GitHub';
  return {
    tone: 'saved',
    // The deck changed since: the save is the last one, not the deck as it is.
    label: editsSince ? `${saved} · edits since` : saved,
    title: checkpoint.commit ? `Commit ${checkpoint.commit.slice(0, 7)}` : undefined,
  };
}

/** The header's checkpoint from a collab_docs row (null row = only git has the deck). */
export function checkpointFromRow(
  row: {
    last_checkpoint_at: Date | null;
    last_checkpoint_error: string | null;
    pushed_commit: string | null;
    version: number;
    pushed_version: number;
  } | null
): LiveCheckpoint | null {
  if (!row) return { at: '' };
  const commit = row.pushed_commit ? { commit: row.pushed_commit } : {};
  if (row.last_checkpoint_at) {
    return {
      at: row.last_checkpoint_at.toISOString(),
      ...(row.last_checkpoint_error ? { error: row.last_checkpoint_error } : commit),
      ...(row.version > row.pushed_version ? { editsSince: true } : {}),
    };
  }
  return row.version === row.pushed_version ? { at: '', ...commit } : null;
}
/** How long "Saving version…" waits for the checkpoint that answers it. */
export const SAVE_VERSION_WAIT_MS = 60_000;

/**
 * Run `then` once this editor's live edits have reached the collab server
 * (written into the deck and acknowledged) — or after `maxMs` regardless, so
 * a flaky connection never blocks. A checkpoint the server takes before that
 * would miss the last keystrokes.
 */
export function whenLocalEditsSent(
  bridge: { flushLocal(): void; hasPendingLocal(): boolean } | null,
  session: { getState(): { unsyncedChanges: number } } | null,
  maxMs: number,
  then: () => void
): void {
  bridge?.flushLocal();
  const startedAt = Date.now();
  const check = () => {
    const pending =
      Boolean(bridge?.hasPendingLocal()) || (session?.getState().unsyncedChanges ?? 0) > 0;
    if (pending && Date.now() - startedAt < maxMs) {
      setTimeout(check, 150);
      return;
    }
    then();
  };
  check();
}

/** A fresh Save-version request id (the collab contract: 8–64 of `[A-Za-z0-9_-]`). */
export function newSaveVersionRequestId(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `sv-${uuid}`;
}

/** What a checkpoint message says about one Save-version request (null: not about it). */
export function saveVersionAnswer(
  checkpoint: LiveCheckpoint,
  requestId: string | null
): 'saved' | 'already-saved' | 'error' | null {
  if (!requestId || !checkpoint.requestIds?.includes(requestId)) return null;
  if (checkpoint.error) return 'error';
  return checkpoint.alreadySaved ? 'already-saved' : 'saved';
}

// ─── Stale rooms ─────────────────────────────────────────────────────────────

/** Session-storage key recording that a stale room already reloaded once. */
export const STALE_RELOAD_KEY = 'classmoji:collab-stale-reload';

/**
 * A stale room reloads on its own only when nothing typed here is still
 * waiting for the server (a reload would drop it); otherwise the banner asks.
 */
export function mayAutoReloadStale(unsyncedChanges: number): boolean {
  return unsyncedChanges === 0;
}

// ─── Presenting ──────────────────────────────────────────────────────────────

/** The presenter's notice when the latest live edits were not in git yet. */
export const PRESENT_SAVING_NOTICE =
  'Your latest edits are still saving. Refresh in a moment to see them.';

/**
 * Where the editor's Present button goes once its save answered (`outcome`,
 * or undefined when no answer came at all). `?saved=1`: saved, present at
 * once. `?saving=1`: the wait is over but the save is not confirmed — present
 * what git has at once, with the notice while the deck still holds edits git
 * lacks. Plain: not a live deck after all (the presenter checks itself).
 */
export function presentUrlAfterSave(slideId: string, outcome: string | undefined): string {
  if (outcome === 'saved') return `/${slideId}/present?saved=1`;
  if (outcome === 'not-live') return `/${slideId}/present`;
  return `/${slideId}/present?saving=1`;
}

/** The notice for a save the presenter's own load waited for. */
export function presentNoticeFor(outcome: string | null | undefined): string | null {
  return outcome === 'timeout' || outcome === 'error' ? PRESENT_SAVING_NOTICE : null;
}

/**
 * Leaving the page loses edits the server has not acknowledged yet: warn
 * (beforeunload, in-app navigation) while editing live and not in sync.
 */
export function liveLeaveRisk({
  editing,
  unsyncedChanges,
  status,
  localPending,
}: {
  editing: boolean;
  unsyncedChanges: number;
  status: ProviderStatus;
  localPending: boolean;
}): boolean {
  // After Done too: until the server has every update, leaving loses them.
  if (localPending || unsyncedChanges > 0) return true;
  return editing && status !== 'connected';
}

/**
 * Whether an in-app navigation leaves this editor (the live leave guard asks
 * only then). Leaving = another pathname. A hash-only change (Reveal moving
 * between slides: same pathname and search) and a search-only change (the
 * "View preview" link) keep this page and its live session, so they are never
 * blocked — and Reveal's hash changes, which the router did not create, could
 * not be blocked anyway.
 */
export function leavesLiveEditor(
  currentLocation: { pathname: string; search: string; hash: string },
  nextLocation: { pathname: string; search: string; hash: string }
): boolean {
  return currentLocation.pathname !== nextLocation.pathname;
}

/**
 * Whether a `stale-epoch` refusal for `room` may reload the page now. Once per
 * room: if the reloaded page is refused for the same room again, the loader
 * and the server disagree about the epoch, and reloading again would loop —
 * the person is asked instead.
 */
export function claimStaleReload(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null | undefined,
  room: string
): boolean {
  if (!storage) return false;
  try {
    if (storage.getItem(STALE_RELOAD_KEY) === room) return false;
    storage.setItem(STALE_RELOAD_KEY, room);
    return true;
  } catch {
    return false;
  }
}
