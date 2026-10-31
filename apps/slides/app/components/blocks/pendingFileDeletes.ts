/**
 * pendingFileDeletes.ts — html block files the author chose to delete, held
 * until the deck save that drops their blocks has landed (the git editor).
 *
 * Deleting the file at once would leave the published deck pointing at a
 * file that is gone until the next save (or for good, when the edit is
 * discarded). So the git editor queues the delete, and after each save that
 * lands checks every queued file again: still named by a block in the live
 * editor (an undo brought it back) → dropped; still named by the saved deck
 * (a save posted before the block was removed) → kept for the next save;
 * otherwise it is deleted now. Discarding the edit, reloading the deck or a
 * save conflict drops the queue.
 *
 * Live editing does not queue: the live deck is the source of truth there,
 * and the delete happens when the author asks.
 *
 * Pure DOM, no React: the unit suite runs it under jsdom.
 */
import { htmlBlockFileNamedIn } from './slideBlocks.ts';

export interface PendingFileDeletes {
  /** Queue `blocks/` files (relative to the deck folder) to delete after the next save. */
  add(srcs: Iterable<string>): void;
  /**
   * A save landed with `saved` (the deck as stored); `live` is the editor's
   * `.slides`. Returns the files to delete now, and takes them (and the ones
   * an undo brought back) off the queue.
   */
  settle(saved: string, live: Element | DocumentFragment | null, doc?: Document): string[];
  /** Drop every queued delete (the edit was discarded, reloaded or refused). */
  clear(): void;
  /** What is queued, in order. */
  list(): string[];
}

export function createPendingFileDeletes(): PendingFileDeletes {
  let queue: string[] = [];
  return {
    add(srcs) {
      for (const src of srcs) if (!queue.includes(src)) queue.push(src);
    },
    settle(saved, live, doc = document) {
      if (queue.length === 0) return [];
      // Parsed inert: a template's content loads nothing.
      const template = doc.createElement('template');
      template.innerHTML = saved;
      const due: string[] = [];
      const kept: string[] = [];
      for (const src of queue) {
        if (htmlBlockFileNamedIn(src, live)) continue;
        if (htmlBlockFileNamedIn(src, template.content)) kept.push(src);
        else due.push(src);
      }
      queue = kept;
      return due;
    },
    clear() {
      queue = [];
    },
    list() {
      return [...queue];
    },
  };
}
