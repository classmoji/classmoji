import { describe, it, expect } from 'vitest';
import { RoomStateStore } from '../roomStateStore.ts';

/**
 * The slides multiplex server stored per-room slide positions in a module-level
 * Map that was never evicted, so it grew unbounded over the lifetime of the
 * long-running websocket process (slow memory leak -> eventual OOM).
 *
 * RoomStateStore keeps state while a room has viewers and evicts it once the
 * last viewer leaves.
 */
describe('RoomStateStore', () => {
  it('stores and returns a room position', () => {
    const store = new RoomStateStore();
    store.set('slide-1', { indexh: 2, indexv: 0 });
    expect(store.get('slide-1')).toEqual({ indexh: 2, indexv: 0 });
  });

  it('stores and returns a fragmentIndex alongside the slide position', () => {
    const store = new RoomStateStore();
    store.set('slide-1', { indexh: 4, indexv: 1, fragmentIndex: 3 });
    expect(store.get('slide-1')).toEqual({ indexh: 4, indexv: 1, fragmentIndex: 3 });
  });

  it('keeps state while viewers remain', () => {
    const store = new RoomStateStore();
    store.set('slide-1', { indexh: 1, indexv: 1 });

    store.releaseIfEmpty('slide-1', 2);

    expect(store.get('slide-1')).toEqual({ indexh: 1, indexv: 1 });
    expect(store.size).toBe(1);
  });

  it('evicts state when the last viewer leaves', () => {
    const store = new RoomStateStore();
    store.set('slide-1', { indexh: 1, indexv: 1 });

    store.releaseIfEmpty('slide-1', 0);

    expect(store.get('slide-1')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('survives a re-join after the room was evicted', () => {
    const store = new RoomStateStore();

    // First session: someone presents, then the last viewer leaves -> evicted.
    store.set('slide-1', { indexh: 1, indexv: 1 });
    store.releaseIfEmpty('slide-1', 0);
    expect(store.get('slide-1')).toBeUndefined();

    // Re-join: a new session sets position again; while viewers remain the
    // store must retain it so the next late joiner can catch up.
    store.set('slide-1', { indexh: 5, indexv: 2, fragmentIndex: 1 });
    store.releaseIfEmpty('slide-1', 2);

    expect(store.get('slide-1')).toEqual({ indexh: 5, indexv: 2, fragmentIndex: 1 });
    expect(store.size).toBe(1);
  });

  it('does not grow unbounded across many short-lived rooms', () => {
    const store = new RoomStateStore();
    for (let i = 0; i < 1000; i++) {
      const room = `slide-${i}`;
      store.set(room, { indexh: 0, indexv: 0 });
      store.releaseIfEmpty(room, 0); // everyone left
    }
    expect(store.size).toBe(0);
  });
});
