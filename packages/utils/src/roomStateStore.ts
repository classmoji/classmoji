/**
 * Stores the current position of a presentation room (slide deck) so late
 * joiners can catch up, and evicts that state once the room is empty.
 *
 * Replaces a bare module-level `Map` that was never cleaned up: entries were
 * added whenever a presenter changed slides but never removed, so the map grew
 * unbounded over the lifetime of the long-running websocket server (a slow
 * memory leak that eventually exhausts memory).
 */
export interface RoomPosition {
  indexh: number;
  indexv: number;
  fragmentIndex?: number;
}

export class RoomStateStore {
  private states = new Map<string, RoomPosition>();

  set(roomId: string, position: RoomPosition): void {
    this.states.set(roomId, position);
  }

  get(roomId: string): RoomPosition | undefined {
    return this.states.get(roomId);
  }

  /**
   * Evict the stored position when a room has no remaining viewers. Safe to
   * call on every disconnect; a no-op while viewers remain.
   */
  releaseIfEmpty(roomId: string, viewerCount: number): void {
    if (viewerCount <= 0) {
      this.states.delete(roomId);
    }
  }

  get size(): number {
    return this.states.size;
  }
}
