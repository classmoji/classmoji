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

import type { CollabLoaderData, CollabRejectReason } from '@classmoji/collab';

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
}: {
  status: ProviderStatus;
  synced: boolean;
  unsyncedChanges: number;
}): SyncStatus {
  if (status !== 'connected') return 'offline';
  if (!synced || unsyncedChanges > 0) return 'syncing';
  return 'synced';
}

// ─── Refusals ────────────────────────────────────────────────────────────────

/**
 * The server's refusal, as the client acts on it. Hocuspocus sends
 * `error.reason ?? 'permission-denied'`; any reason that is not one of ours
 * is treated as forbidden (the safe reading: stop editing).
 */
export function normalizeRejectReason(reason: unknown): CollabRejectReason {
  if (reason === 'stale-epoch' || reason === 'schema-mismatch') return reason;
  return 'forbidden';
}

export interface RejectionNotice {
  /** `reload` reloads the route at once; `prompt` asks; `readonly` explains. */
  action: 'reload' | 'prompt' | 'readonly';
  message: string | null;
}

export function rejectionNotice(reason: CollabRejectReason): RejectionNotice {
  switch (reason) {
    case 'stale-epoch':
      return { action: 'reload', message: null };
    case 'schema-mismatch':
      return { action: 'prompt', message: 'Reload to get the latest editor.' };
    case 'forbidden':
    default:
      return { action: 'readonly', message: 'You can no longer edit this page.' };
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
    const user = state?.user as { id?: unknown; name?: unknown; color?: unknown } | undefined;
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
      name: user.name,
      color: typeof user.color === 'string' && user.color ? user.color : '#6b7280',
      self,
    });
  }
  const peers = [...byKey.values()];
  peers.sort((a, b) => Number(b.self) - Number(a.self) || a.name.localeCompare(b.name));
  return peers;
}

/** One or two initials for an avatar. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
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
