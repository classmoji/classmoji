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
  splitAgentName,
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
 * Whether a refusal may reload the page by itself: a closed or stale room,
 * and only when this browser holds no edits the server has not acknowledged —
 * reloading would throw them away (the banner then offers to copy them). A
 * stale room reloads only once per room (`claimStaleReload`).
 */
export function autoReloadAllowed(reason: LiveRefusal, localUnsynced: boolean): boolean {
  if (reason === 'reload' || reason === 'stale-epoch') return !localUnsynced;
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
  /**
   * An agent's tag as the server numbers it: `agent`, or `agent 2` while the
   * same person has several agent sessions on the page.
   */
  agentTag?: string;
}

/** A name without the server's " (agent)" / " (agent 2)" suffix. */
export function stripAgentSuffix(name: string): string {
  return splitAgentName(name).name;
}

/** What an avatar's tooltip says: the name, marked when it is an agent or you. */
export function peerLabel(
  peer: Pick<CollabPeer, 'name' | 'self' | 'agent'> & { agentTag?: string }
): string {
  if (peer.self) return `${peer.name} (you)`;
  return peer.agent ? `${peer.name} (${peer.agentTag ?? 'agent'})` : peer.name;
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
    const split = splitAgentName(user.name);
    const agent = user.agent === true || split.tag !== null;
    byKey.set(key, {
      key,
      name: split.name,
      color: typeof user.color === 'string' && user.color ? user.color : '#6b7280',
      self,
      agent,
      ...(agent ? { agentTag: split.tag ?? 'agent' } : {}),
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
  /**
   * ISO time of the run; null when the page is saved to GitHub but the time
   * is unknown (pushed before checkpoint times were recorded).
   */
  at: string | null;
  commit?: string;
  /** Why the run did not save this page (absent when it did). */
  error?: string;
  /** The Save version requests this run answers (their `requestId`s). */
  requestIds?: string[];
  /** Nothing was left to save: the page was already on GitHub as it is. */
  alreadySaved?: boolean;
  /**
   * The live document has edits this checkpoint did not take (the buffer's
   * version is ahead of the pushed one): from the loader, or the room's
   * message when the server says so.
   */
  editsSince?: boolean;
}

/** Stateless messages the collab server broadcasts to a page's room. */
export type LiveStatelessMessage =
  | ({ type: 'checkpoint' } & LiveCheckpoint)
  | { type: 'page-meta'; title?: string; width?: number }
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
      ? message.requestIds.filter(isSaveVersionRequestId)
      : [];
    return {
      type: 'checkpoint',
      at: message.at,
      ...(typeof message.commit === 'string' && message.commit ? { commit: message.commit } : {}),
      ...(typeof message.error === 'string' && message.error ? { error: message.error } : {}),
      ...(requestIds.length > 0 ? { requestIds } : {}),
      ...(message.alreadySaved === true ? { alreadySaved: true } : {}),
      ...(message.editsSince === true ? { editsSince: true } : {}),
    };
  }
  if (message.type === 'preview-changed') return { type: 'preview-changed' };
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
 * (tooltip: a short reason). Null before anything is known. `editsSince`:
 * the page has changed since that checkpoint, so the line says the save is
 * the last one, not the page as it is now.
 */
export function savedToGitHubStatus(
  checkpoint: LiveCheckpoint | null,
  now: number,
  editsSince = false
): {
  tone: 'saved' | 'unsaved';
  label: string;
  title: string | undefined;
  editsSince: boolean;
} | null {
  if (!checkpoint) return null;
  if (checkpoint.error) {
    const reason = checkpoint.error.replace(/\s+/g, ' ').trim();
    return {
      tone: 'unsaved',
      label: 'Not saved to GitHub yet',
      title: reason.length > REASON_CAP ? `${reason.slice(0, REASON_CAP - 1)}…` : reason,
      editsSince: false,
    };
  }
  const when = checkpoint.at ? relativeTimeFrom(checkpoint.at, now) : '';
  const saved = when ? `Saved to GitHub ${when}` : 'Saved to GitHub';
  return {
    tone: 'saved',
    label: editsSince ? `${saved} · edits since` : saved,
    title: checkpoint.commit ? `Commit ${checkpoint.commit.slice(0, 7)}` : undefined,
    editsSince,
  };
}

/**
 * What the header's screen-reader status says about GitHub: only the state,
 * never the relative time, so a clock tick re-announces nothing.
 */
export function savedToGitHubAnnouncement(status: ReturnType<typeof savedToGitHubStatus>): string {
  if (!status) return '';
  if (status.tone === 'unsaved') return 'Not saved to GitHub yet';
  return status.editsSince ? 'Edits since the last save to GitHub' : 'Saved to GitHub';
}

/** How long "Saving version…" waits for the checkpoint that answers it. */
export const SAVE_VERSION_WAIT_MS = 60_000;

/** How long Save version waits for this browser's edits to reach the server. */
export const SAVE_VERSION_SYNC_WAIT_MS = 10_000;

/** A Save version request id: what this browser generates and the server echoes. */
const SAVE_VERSION_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function isSaveVersionRequestId(value: unknown): value is string {
  return typeof value === 'string' && SAVE_VERSION_REQUEST_ID.test(value);
}

/** A fresh Save version request id. */
export function newSaveVersionRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * When Save version may go: at once when this browser's edits are all on the
 * server; `wait` while some are on their way (the version must include
 * them); `offline` when there is no connection to send them on.
 */
export function saveVersionGate(syncStatus: SyncStatus): 'now' | 'wait' | 'offline' {
  if (syncStatus === 'offline') return 'offline';
  return syncStatus === 'syncing' ? 'wait' : 'now';
}

/** A Save version the server accepted and this browser is waiting on. */
export interface PendingSaveVersion {
  /** The request's id, as the server echoed it (null: it did not, so nothing can answer it). */
  id: string | null;
  /** When the server accepted it (ms since epoch). */
  since: number;
}

export type SaveVersionOutcome = 'saved' | 'already-saved' | 'failed';

/** What the person is told for each outcome (and when nothing answers in time). */
export const SAVE_VERSION_MESSAGES: Record<SaveVersionOutcome | 'unconfirmed', string> = {
  saved: 'Version saved.',
  'already-saved': 'Already saved.',
  failed: 'The version could not be saved to GitHub. Try again.',
  unconfirmed: 'The version was not confirmed. Try again.',
};

/**
 * The outcome a checkpoint message gives a pending Save version, or null when
 * it is not the answer to it: only the message naming the request's id
 * answers it (a routine run landing just after the click does not). Pure and
 * idempotent, so a message may be checked again.
 */
export function saveVersionOutcome(
  checkpoint: LiveCheckpoint,
  pending: PendingSaveVersion | null
): SaveVersionOutcome | null {
  if (!pending?.id || !checkpoint.requestIds?.includes(pending.id)) return null;
  if (checkpoint.error) return 'failed';
  return checkpoint.alreadySaved ? 'already-saved' : 'saved';
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

/**
 * Whether a refused session's banner offers "Copy my unsaved changes": the
 * editor was open and holds edits the server never acknowledged, which a
 * reload would throw away.
 */
export function offerCopyUnsaved({
  refused,
  hasSynced,
  localUnsynced,
}: {
  refused: boolean;
  hasSynced: boolean;
  localUnsynced: boolean;
}): boolean {
  return refused && hasSynced && localUnsynced;
}

/**
 * The header's "saved to GitHub" state when the page is opened: the snapshot's
 * last checkpoint when it has one; otherwise, from the buffer's bookkeeping, a
 * page whose live document has nothing unsaved and that exists in git (it was
 * seeded from a file, or pushed) is saved — just with no time known (pushed
 * before checkpoint times were recorded). Null only for a page with no git
 * history at all, or with unsaved live edits and no checkpoint yet.
 */
export function initialCheckpoint({
  lastCheckpointAt,
  lastCheckpointError,
  row,
}: {
  lastCheckpointAt: unknown;
  lastCheckpointError: unknown;
  row: {
    version: number;
    pushed_version: number;
    pushed_commit: string | null;
    source_sha: string | null;
  } | null;
}): LiveCheckpoint | null {
  const error =
    typeof lastCheckpointError === 'string' && lastCheckpointError ? lastCheckpointError : null;
  const commit = row?.pushed_commit ?? undefined;
  if (typeof lastCheckpointAt === 'string' && lastCheckpointAt) {
    return {
      at: lastCheckpointAt,
      ...(commit ? { commit } : {}),
      ...(error ? { error } : {}),
      ...(row && row.version > row.pushed_version ? { editsSince: true } : {}),
    };
  }
  if (!row || error) return null;
  const clean = row.version === row.pushed_version;
  const inGit = Boolean(row.pushed_commit || row.source_sha);
  return clean && inGit ? { at: null, ...(commit ? { commit } : {}) } : null;
}
