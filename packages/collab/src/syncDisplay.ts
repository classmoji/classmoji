/**
 * The sync indicator's DISPLAYED state, debounced from the exact one.
 *
 * Every keystroke makes the exact status `syncing` for one round trip (a few
 * ms to a few hundred). Showing that would flash the indicator while someone
 * types, so the header shows `syncing` only once the exact status has been
 * `syncing` without a break for `SYNCING_SHOW_DELAY_MS`, and keeps it at least
 * `SYNCING_MIN_VISIBLE_MS` once shown. `offline` shows at once, and leaving
 * `offline` shows at once too.
 *
 * Only the display is debounced: the exact status still drives the leave-page
 * warning and Save version. Pure, clock passed in; the apps wire it to React
 * with a reducer and one timeout armed at `syncDisplayDeadline`.
 */

export type SyncDisplayStatus = 'synced' | 'syncing' | 'offline';

/** How long the exact status must stay `syncing` before the header says so. */
export const SYNCING_SHOW_DELAY_MS = 1000;
/** Once shown, `syncing` stays at least this long (no flicker back). */
export const SYNCING_MIN_VISIBLE_MS = 500;

export interface SyncDisplayState {
  /** The exact status. */
  raw: SyncDisplayStatus;
  /** When `raw` last changed (ms). */
  rawSince: number;
  /** What the header shows. */
  shown: SyncDisplayStatus;
  /** When `shown` last changed (ms). */
  shownSince: number;
}

export type SyncDisplayAction =
  | { type: 'raw'; raw: SyncDisplayStatus; now: number }
  | { type: 'tick'; now: number };

/**
 * The state at mount: show the exact status. Times start at 0, so the first
 * handshake's `syncing` is not held for the minimum.
 */
export function initialSyncDisplay(raw: SyncDisplayStatus): SyncDisplayState {
  return { raw, rawSince: 0, shown: raw, shownSince: 0 };
}

/** When the shown status may next change by itself (ms), or null. */
export function syncDisplayDeadline(state: SyncDisplayState): number | null {
  const { raw, shown } = state;
  if (raw === shown || raw === 'offline' || shown === 'offline') return null;
  if (raw === 'syncing') return state.rawSince + SYNCING_SHOW_DELAY_MS;
  return state.shownSince + SYNCING_MIN_VISIBLE_MS;
}

function settle(state: SyncDisplayState, now: number): SyncDisplayState {
  const { raw, shown } = state;
  if (raw === shown) return state;
  const deadline = syncDisplayDeadline(state);
  if (deadline !== null && now < deadline) return state;
  return { ...state, shown: raw, shownSince: now };
}

/**
 * Next state for a change of the exact status (`raw`) or a timer (`tick`).
 * Returns the same object when nothing changed, so React skips the render.
 */
export function syncDisplayReducer(
  state: SyncDisplayState,
  action: SyncDisplayAction
): SyncDisplayState {
  if (action.type === 'raw' && action.raw !== state.raw) {
    return settle({ ...state, raw: action.raw, rawSince: action.now }, action.now);
  }
  return settle(state, action.now);
}
