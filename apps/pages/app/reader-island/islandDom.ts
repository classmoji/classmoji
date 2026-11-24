/**
 * The island's DOM-only pieces: the failure state and the document markers.
 * No React and no imports beyond the render contract's constants, so the
 * client entry can show a failure even when the reader's chunk never loads.
 */
import { VIEW_ERROR_ATTRIBUTE, VIEW_READY_ATTRIBUTE } from '@classmoji/services/render-contract';

import { READER_ISLAND_ROOT_ID } from './contract.ts';

export const ISLAND_ERROR_MESSAGE = 'This page could not be shown. Reload to try again.';

/**
 * Replace whatever the mount element holds (the server's loading line, or a
 * reader that threw) with a plain message, and mark the document failed, so
 * a page never sits on "Loading content…" and a render driver stops waiting.
 */
export function showIslandError(error: unknown, doc: Document = document): void {
  console.error('[reader-island] could not show the page', error);
  const root = doc.getElementById(READER_ISLAND_ROOT_ID);
  if (root) {
    const box = doc.createElement('div');
    box.setAttribute('role', 'alert');
    box.className =
      'mx-auto max-w-2xl px-4 py-12 text-center text-gray-600 dark:text-gray-300 reader-island-error';
    box.textContent = ISLAND_ERROR_MESSAGE;
    root.replaceChildren(box);
  }
  const html = doc.documentElement;
  html.removeAttribute(VIEW_READY_ATTRIBUTE);
  html.setAttribute(VIEW_ERROR_ATTRIBUTE, error instanceof Error ? error.name : 'error');
}

/** Raise the ready marker (`how`: 'settled', or what timed out). Never after a failure. */
export function markIslandReady(how: string, doc: Document = document): void {
  const html = doc.documentElement;
  if (html.hasAttribute(VIEW_ERROR_ATTRIBUTE)) return;
  html.setAttribute(VIEW_READY_ATTRIBUTE, how);
}
