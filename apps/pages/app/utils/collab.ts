/**
 * Live collaborative editing — the pure decisions the page route and editor
 * share. No React, no BlockNote, no server imports: the Playwright unit runner
 * tests this module directly (tests/unit/collab-mode.spec.ts), and the client
 * bundle imports it.
 *
 * A page is in COLLAB MODE when the loader handed out `collab` loader data:
 * the classroom has `collab_enabled`, this user may edit, and the page is not
 * showing a preview branch. In collab mode the document lives on the collab
 * server; the git save machinery (ops diff, conflict chooser, merged-document
 * adoption, Cmd-S, beforeunload, unsaved tracking) is switched off, because
 * the git worker is the only thing that writes content.json.
 */

import {
  isCollabRejectReason,
  type CollabLoaderData,
  type CollabRejectReason,
} from '@classmoji/collab';

export type { CollabLoaderData, CollabRejectReason };

/** True when the page is edited live (the loader handed out collab data). */
export function isCollabMode(
  collab: CollabLoaderData | null | undefined
): collab is CollabLoaderData {
  return Boolean(collab && collab.wsUrl && collab.room);
}

/**
 * Whether the git save machinery runs for this page view: only for someone
 * who edits, and never in collab mode. Unflagged classrooms keep exactly
 * today's behaviour.
 */
export function saveMachineryEnabled({
  canEdit,
  collab,
}: {
  canEdit: boolean;
  collab: CollabLoaderData | null | undefined;
}): boolean {
  return canEdit && !isCollabMode(collab);
}

// ─── Connection state ────────────────────────────────────────────────────────

/** The provider's WebSocket status (`WebSocketStatus` values). */
export type ProviderStatus = 'connecting' | 'connected' | 'disconnected';

/** What the header shows. */
export type SyncStatus = 'synced' | 'syncing' | 'offline';

export const SYNC_STATUS_LABEL: Record<SyncStatus, string> = {
  synced: 'Synced',
  syncing: 'Syncing',
  offline: 'Offline',
};

/**
 * The header's sync status from the provider's state: offline while the
 * socket is not open, syncing until the first handshake finished and while
 * local changes wait for the server's acknowledgement, synced otherwise.
 */
export function deriveSyncStatus({
  status,
  synced,
  unsyncedChanges,
  localUnsynced = false,
}: {
  status: ProviderStatus;
  synced: boolean;
  unsyncedChanges: number;
  /** Local edits made since the server last acknowledged everything. */
  localUnsynced?: boolean;
}): SyncStatus {
  if (status !== 'connected') return 'offline';
  if (!synced || unsyncedChanges > 0 || localUnsynced) return 'syncing';
  return 'synced';
}

/**
 * Whether leaving now could lose edits: the live editor is open (synced at
 * least once, not refused) and its state is anything but synced — local
 * changes awaiting the server, or no connection to send them on. Drives the
 * unload warning and the in-app navigation blocker.
 */
export function liveLeaveUnsafe({
  hasSynced,
  refused,
  syncStatus,
}: {
  hasSynced: boolean;
  refused: boolean;
  syncStatus: SyncStatus;
}): boolean {
  return hasSynced && !refused && syncStatus !== 'synced';
}

// ─── Refusals ────────────────────────────────────────────────────────────────

/**
 * Why a live session ended, as the client acts on it: the server's refusal
 * reasons (`COLLAB_REJECT_REASONS`), or `reload` — the server closed the room
 * (flag turned off, page deleted; close code `COLLAB_CLOSE_RELOAD`) and the
 * route must be loaded again.
 */
export type LiveRefusal = CollabRejectReason | 'reload';

/**
 * A refusal reason as the client acts on it. Hocuspocus sends
 * `error.reason ?? 'permission-denied'`; any reason that is not one of ours
 * is treated as forbidden (the safe reading: stop editing).
 */
export function normalizeRejectReason(reason: unknown): CollabRejectReason {
  return isCollabRejectReason(reason) ? reason : 'forbidden';
}

export interface RejectionNotice {
  /**
   * `reload` reloads the route at once (when it is safe to); `prompt` asks
   * the person to reload; `readonly` stops editing and offers a reload.
   */
  action: 'reload' | 'prompt' | 'readonly';
  message: string;
}

export function rejectionNotice(reason: LiveRefusal): RejectionNotice {
  switch (reason) {
    case 'reload':
      return { action: 'reload', message: 'This page changed. Reload to keep working.' };
    case 'stale-epoch':
      return { action: 'reload', message: 'This page was updated. Reload to keep editing.' };
    case 'schema-mismatch':
      return { action: 'prompt', message: 'Reload to get the latest editor.' };
    case 'unavailable':
      return { action: 'prompt', message: 'Couldn’t connect to live editing. Try again.' };
    case 'legacy-html':
      return {
        action: 'readonly',
        message: 'This page uses an older format and can’t be edited live yet.',
      };
    case 'forbidden':
    default:
      return { action: 'readonly', message: 'You can no longer edit this page.' };
  }
}

/**
 * Whether a refusal may reload the page by itself. A closed room always may
 * (the server saved it first). A stale room may only when this browser holds
 * no edits the server has not acknowledged — reloading would throw them away —
 * and only once per room (`claimStaleReload`).
 */
export function autoReloadAllowed(reason: LiveRefusal, localUnsynced: boolean): boolean {
  if (reason === 'reload') return true;
  if (reason === 'stale-epoch') return !localUnsynced;
  return false;
}

// ─── Presence ────────────────────────────────────────────────────────────────

export interface CollabPeer {
  /** User id when known; peers without one are keyed by their client id. */
  key: string;
  /** The display name, without the server's " (agent)" suffix. */
  name: string;
  color: string;
  /** True for the local user. */
  self: boolean;
  /** An agent editing through the collab server (MCP), not a person. */
  agent: boolean;
}

/** The suffix the collab server puts on an agent's awareness name. */
const AGENT_SUFFIX = /\s*\(agent\)\s*$/i;

/** A name without the " (agent)" suffix. */
export function stripAgentSuffix(name: string): string {
  return name.replace(AGENT_SUFFIX, '').trim() || name.trim();
}

/** What an avatar's tooltip says: the name, marked when it is an agent or you. */
export function peerLabel(peer: Pick<CollabPeer, 'name' | 'self' | 'agent'>): string {
  if (peer.self) return `${peer.name} (you)`;
  return peer.agent ? `${peer.name} (agent)` : peer.name;
}

/**
 * Connected users from awareness states, one entry per user (two tabs of the
 * same person show once), the local user first. BlockNote's cursor plugin
 * puts `{ name, color, id? }` under the `user` field.
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
    const existing = byKey.get(key);
    if (existing) {
      existing.self = existing.self || self;
      continue;
    }
    byKey.set(key, {
      key,
      name: stripAgentSuffix(user.name),
      color: typeof user.color === 'string' && user.color ? user.color : '#6b7280',
      self,
      agent: user.agent === true || AGENT_SUFFIX.test(user.name),
    });
  }
  const peers = [...byKey.values()];
  peers.sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
  return peers;
}

/** One or two initials for an avatar (letters and digits only, agent suffix ignored). */
export function initialsOf(name: string): string {
  const words = stripAgentSuffix(name)
    .split(/\s+/)
    .map(word => word.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1][0] ?? '') : '';
  return (first + last).toUpperCase();
}

// ─── Cover image in the live document ────────────────────────────────────────

export interface CollabCoverImage {
  url: string;
  position: number;
}

/**
 * The cover as stored in the document's meta map, or null. Anything that is
 * not a `{ url, position }` object with a non-empty url reads as no cover.
 */
export function readCoverValue(value: unknown): CollabCoverImage | null {
  if (!value || typeof value !== 'object') return null;
  const { url, position } = value as { url?: unknown; position?: unknown };
  if (typeof url !== 'string' || !url) return null;
  return { url, position: typeof position === 'number' ? position : 50 };
}

/** Extensions a page cover may have (the server's own cover rule). */
export const COVER_IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg)$/i;

// ─── Stale rooms ─────────────────────────────────────────────────────────────

/** Session-storage key recording that a stale room already reloaded once. */
export const STALE_RELOAD_KEY = 'classmoji:collab-stale-reload';

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

// ─── Connecting ──────────────────────────────────────────────────────────────

/** How long the room may take to arrive before the page says it could not. */
export const LIVE_CONNECT_GRACE_MS = 10_000;

/**
 * Whether to tell the person the live editor could not be reached: never
 * before the grace period (the provider retries a failed connect on its own,
 * and the read-only page is on screen meanwhile), and never once the room has
 * synced or the server has refused (that has its own banner).
 */
export function liveUnreachable({
  hasSynced,
  refused,
  status,
  elapsedMs,
}: {
  hasSynced: boolean;
  refused: boolean;
  status: ProviderStatus;
  elapsedMs: number;
}): boolean {
  return !hasSynced && !refused && status !== 'connected' && elapsedMs >= LIVE_CONNECT_GRACE_MS;
}

// ─── Messages from the collab server ─────────────────────────────────────────

/** The last checkpoint covering this page, as the header shows it. */
export interface LiveCheckpoint {
  /** ISO time of the run. */
  at: string;
  commit?: string;
  /** Why the run did not save this page (absent when it did). */
  error?: string;
}

/** Stateless messages the collab server broadcasts to a page's room. */
export type LiveStatelessMessage =
  | ({ type: 'checkpoint' } & LiveCheckpoint)
  | { type: 'page-meta'; title?: string; width?: number };

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
    return {
      type: 'checkpoint',
      at: message.at,
      ...(typeof message.commit === 'string' && message.commit ? { commit: message.commit } : {}),
      ...(typeof message.error === 'string' && message.error ? { error: message.error } : {}),
    };
  }
  if (message.type === 'page-meta') {
    const title = typeof message.title === 'string' ? message.title : undefined;
    const width =
      typeof message.width === 'number' && Number.isInteger(message.width)
        ? message.width
        : undefined;
    if (title === undefined && width === undefined) return null;
    return {
      type: 'page-meta',
      ...(title !== undefined ? { title } : {}),
      ...(width !== undefined ? { width } : {}),
    };
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

/** The longest reason shown in the "not saved" tooltip. */
const REASON_CAP = 120;

/**
 * The header's "saved to GitHub" line: when the last checkpoint covering the
 * page saved it (tooltip: the commit), or that it has not been saved yet
 * (tooltip: a short reason). Null before anything is known.
 */
export function savedToGitHubStatus(
  checkpoint: LiveCheckpoint | null,
  now: number
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
  const when = relativeTimeFrom(checkpoint.at, now);
  return {
    tone: 'saved',
    label: when ? `Saved to GitHub ${when}` : 'Saved to GitHub',
    title: checkpoint.commit ? `Commit ${checkpoint.commit.slice(0, 7)}` : undefined,
  };
}

/** How long "Saving version…" waits for the checkpoint that answers it. */
export const SAVE_VERSION_WAIT_MS = 60_000;

/**
 * Whether a checkpoint message answers a pending "Save version": it arrived
 * after the request was accepted (allowing for clock skew between this
 * browser and the worker).
 */
export function checkpointAnswersSaveVersion(
  checkpoint: LiveCheckpoint,
  pendingSince: number | null,
  skewMs = 30_000
): boolean {
  if (pendingSince === null) return false;
  const at = Date.parse(checkpoint.at);
  return Number.isNaN(at) || at >= pendingSince - skewMs;
}

/**
 * The page's title and width with a live `page-meta` message applied on top
 * of the loader's (each field only when the message carries it; a blank
 * title is not applied).
 */
export function applyPageMeta<T extends string | null>(
  loaded: { title: T; width: number },
  meta: { title?: string; width?: number } | null | undefined
): { title: T | string; width: number } {
  if (!meta) return loaded;
  return {
    title: typeof meta.title === 'string' && meta.title.trim() ? meta.title : loaded.title,
    width: typeof meta.width === 'number' ? meta.width : loaded.width,
  };
}
