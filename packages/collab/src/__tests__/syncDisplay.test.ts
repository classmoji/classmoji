import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SYNCING_MIN_VISIBLE_MS,
  SYNCING_SHOW_DELAY_MS,
  initialSyncDisplay,
  syncDisplayDeadline,
  syncDisplayReducer,
  type SyncDisplayState,
  type SyncDisplayStatus,
} from '../syncDisplay.ts';

/**
 * The apps' hook, without React: a reducer plus one timeout armed at the
 * deadline (fired with `now` no earlier than the deadline, as the hook does).
 */
function display(initial: SyncDisplayStatus) {
  let state: SyncDisplayState = initialSyncDisplay(initial);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const shownLog: SyncDisplayStatus[] = [state.shown];
  const apply = (next: SyncDisplayState) => {
    if (next === state) return;
    if (next.shown !== state.shown) shownLog.push(next.shown);
    state = next;
    if (timer) clearTimeout(timer);
    timer = null;
    const deadline = syncDisplayDeadline(state);
    if (deadline !== null) {
      timer = setTimeout(
        () =>
          apply(syncDisplayReducer(state, { type: 'tick', now: Math.max(Date.now(), deadline) })),
        Math.max(0, deadline - Date.now())
      );
    }
  };
  return {
    set: (raw: SyncDisplayStatus) =>
      apply(syncDisplayReducer(state, { type: 'raw', raw, now: Date.now() })),
    get shown() {
      return state.shown;
    },
    shownLog,
  };
}

describe('displayed sync status', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('never shows syncing for typing at 15 chars/s (short blips)', () => {
    const d = display('synced');
    for (let i = 0; i < 45; i++) {
      d.set('syncing');
      vi.advanceTimersByTime(30);
      expect(d.shown).toBe('synced');
      d.set('synced');
      vi.advanceTimersByTime(36);
    }
    vi.advanceTimersByTime(5000);
    expect(d.shownLog).toEqual(['synced']);
  });

  it('a blip just under the delay never shows', () => {
    const d = display('synced');
    d.set('syncing');
    vi.advanceTimersByTime(SYNCING_SHOW_DELAY_MS - 1);
    d.set('synced');
    vi.advanceTimersByTime(5000);
    expect(d.shownLog).toEqual(['synced']);
  });

  it('shows sustained syncing after the delay, not before', () => {
    const d = display('synced');
    d.set('syncing');
    vi.advanceTimersByTime(SYNCING_SHOW_DELAY_MS - 1);
    expect(d.shown).toBe('synced');
    vi.advanceTimersByTime(1);
    expect(d.shown).toBe('syncing');
  });

  it('a repeated syncing does not restart the delay', () => {
    const d = display('synced');
    d.set('syncing');
    vi.advanceTimersByTime(600);
    d.set('syncing');
    vi.advanceTimersByTime(400);
    expect(d.shown).toBe('syncing');
  });

  it('a return to synced restarts the delay', () => {
    const d = display('synced');
    d.set('syncing');
    vi.advanceTimersByTime(900);
    d.set('synced');
    d.set('syncing');
    vi.advanceTimersByTime(900);
    expect(d.shown).toBe('synced');
    vi.advanceTimersByTime(100);
    expect(d.shown).toBe('syncing');
  });

  it('holds a shown syncing for the minimum, then shows synced', () => {
    const d = display('synced');
    d.set('syncing');
    vi.advanceTimersByTime(SYNCING_SHOW_DELAY_MS);
    vi.advanceTimersByTime(100);
    d.set('synced');
    expect(d.shown).toBe('syncing');
    vi.advanceTimersByTime(SYNCING_MIN_VISIBLE_MS - 100 - 1);
    expect(d.shown).toBe('syncing');
    vi.advanceTimersByTime(1);
    expect(d.shown).toBe('synced');
  });

  it('shows synced at once after the minimum has passed', () => {
    const d = display('synced');
    d.set('syncing');
    vi.advanceTimersByTime(SYNCING_SHOW_DELAY_MS + SYNCING_MIN_VISIBLE_MS + 200);
    d.set('synced');
    expect(d.shown).toBe('synced');
  });

  it('a return to syncing during the hold keeps syncing, without flicker', () => {
    const d = display('synced');
    d.set('syncing');
    vi.advanceTimersByTime(SYNCING_SHOW_DELAY_MS);
    d.set('synced');
    vi.advanceTimersByTime(200);
    d.set('syncing');
    vi.advanceTimersByTime(5000);
    expect(d.shownLog).toEqual(['synced', 'syncing']);
  });

  it('offline shows at once: from synced, during the delay, during the hold', () => {
    const a = display('synced');
    a.set('offline');
    expect(a.shown).toBe('offline');

    const b = display('synced');
    b.set('syncing');
    vi.advanceTimersByTime(300);
    b.set('offline');
    expect(b.shown).toBe('offline');
    vi.advanceTimersByTime(5000);
    expect(b.shownLog).toEqual(['synced', 'offline']);

    const c = display('synced');
    c.set('syncing');
    vi.advanceTimersByTime(SYNCING_SHOW_DELAY_MS);
    c.set('offline');
    expect(c.shown).toBe('offline');
  });

  it('leaves offline at once (reconnect: syncing, then synced after the minimum)', () => {
    const d = display('offline');
    d.set('syncing');
    expect(d.shown).toBe('syncing');
    vi.advanceTimersByTime(50);
    d.set('synced');
    expect(d.shown).toBe('syncing');
    vi.advanceTimersByTime(SYNCING_MIN_VISIBLE_MS);
    expect(d.shown).toBe('synced');

    const e = display('offline');
    e.set('synced');
    expect(e.shown).toBe('synced');
  });

  it('starts at the exact status, and the first handshake is not held', () => {
    const d = display('syncing');
    expect(d.shown).toBe('syncing');
    d.set('synced');
    expect(d.shown).toBe('synced');
  });

  it('returns the same state when nothing changes', () => {
    const s = initialSyncDisplay('synced');
    expect(syncDisplayReducer(s, { type: 'raw', raw: 'synced', now: 5 })).toBe(s);
    expect(syncDisplayReducer(s, { type: 'tick', now: 5 })).toBe(s);
    expect(syncDisplayDeadline(s)).toBeNull();
  });
});
