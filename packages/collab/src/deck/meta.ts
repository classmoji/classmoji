/**
 * Deck-level fields in the live document: theme and code theme, with the
 * editor's merge rules (slideService.buildEditorDeck) applied on change.
 */
import type * as Y from 'yjs';

import { deckMeta } from './convert.ts';

/**
 * The starter deck's seeded customCss — a copy of slideService
 * STARTER_CUSTOM_CSS (that module is server-only); a test pins the two equal.
 */
export const DECK_STARTER_CUSTOM_CSS = `
    .reveal h1, .reveal h2, .reveal h3 { color: #333; }
    .reveal .slides section { text-align: left; }
    .reveal pre { width: 100%; }
    .reveal code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; }
  `;

export function readDeckThemes(doc: Y.Doc): { theme: string; codeTheme: string } {
  const meta = deckMeta(doc);
  const theme = meta.get('theme');
  const codeTheme = meta.get('codeTheme');
  return {
    theme: typeof theme === 'string' && theme ? theme : 'white',
    codeTheme: typeof codeTheme === 'string' && codeTheme ? codeTheme : 'github',
  };
}

/**
 * Change the theme and/or code theme. As in the editor's save: an explicit
 * theme change clears the paired dark theme and drops the starter template's
 * css; a code-theme change clears the dark code theme. Returns true if
 * anything changed.
 */
export function setDeckThemes(
  doc: Y.Doc,
  next: { theme?: string; codeTheme?: string },
  origin: unknown = null
): boolean {
  const meta = deckMeta(doc);
  const current = readDeckThemes(doc);
  const themeChanged = next.theme !== undefined && next.theme !== current.theme;
  const codeChanged = next.codeTheme !== undefined && next.codeTheme !== current.codeTheme;
  if (!themeChanged && !codeChanged) return false;
  doc.transact(() => {
    if (themeChanged) {
      meta.set('theme', next.theme as string);
      if (meta.has('themeDark')) meta.delete('themeDark');
      if (meta.get('customCss') === DECK_STARTER_CUSTOM_CSS) meta.delete('customCss');
    }
    if (codeChanged) {
      meta.set('codeTheme', next.codeTheme as string);
      if (meta.has('codeThemeDark')) meta.delete('codeThemeDark');
    }
  }, origin);
  return true;
}
