/**
 * Whether a click in the chat body should put the cursor back in the input.
 * Focusing an input clears the page's text selection, so the click that ends a
 * drag-select must leave focus alone or a reply cannot be copied (#733).
 */
export function shouldFocusInput(selection: Pick<Selection, 'isCollapsed'> | null): boolean {
  return !selection || selection.isCollapsed;
}
