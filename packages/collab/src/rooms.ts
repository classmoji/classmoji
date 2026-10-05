/**
 * Room names: `page:<pageId>:<epoch>` and `deck:<slideId>:<epoch>`.
 *
 * The epoch (collab_docs.epoch, 1 when there is no row) is part of the name
 * so a browser holding a document from before a reseed cannot sync it into
 * the new one: the server rejects a room whose epoch is not current and the
 * client reloads.
 */

export type CollabKind = 'page' | 'deck';

export const COLLAB_KINDS: readonly CollabKind[] = ['page', 'deck'];

export interface CollabRoom {
  kind: CollabKind;
  /** Page.id for a page, Slide.id (kind DECK) for a deck. */
  id: string;
  epoch: number;
}

export function isCollabKind(value: unknown): value is CollabKind {
  return value === 'page' || value === 'deck';
}

function assertEpoch(epoch: number): void {
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error(`collab epoch must be a positive integer, got ${epoch}`);
  }
}

export function roomName(kind: CollabKind, id: string, epoch: number): string {
  if (!isCollabKind(kind)) throw new Error(`unknown collab kind: ${String(kind)}`);
  if (!id || id.includes(':')) throw new Error(`invalid collab doc id: ${JSON.stringify(id)}`);
  assertEpoch(epoch);
  return `${kind}:${id}:${epoch}`;
}

/** The parts of a room name, or null if it is not one of ours. */
export function parseRoom(name: string): CollabRoom | null {
  const parts = name.split(':');
  if (parts.length !== 3) return null;
  const [kind, id, epochText] = parts;
  if (!isCollabKind(kind) || !id) return null;
  if (!/^[1-9]\d*$/.test(epochText)) return null;
  const epoch = Number(epochText);
  if (!Number.isSafeInteger(epoch)) return null;
  return { kind, id, epoch };
}
