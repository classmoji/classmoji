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
