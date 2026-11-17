/**
 * Which repository files the deck editor's file intents may name.
 *
 * The deck action deletes images, and writes and deletes theme and snippet
 * files, at paths built from what the editor sends. These rules decide, on the
 * string alone, whether a sent path or id names a file that intent may touch:
 *
 *   - a deck image is a file DIRECTLY in this deck's image folder,
 *     `<content_path>/images/<name>` (where `upload-image` writes);
 *   - a theme id is one file name in `.slidesthemes/` ending `-light.css` or
 *     `-dark.css` (what `save-theme` creates and `list-themes` lists);
 *   - a snippet id is one file name in `.slidesthemes/snippets/` ending
 *     `.html` (what `save-snippet` creates and `list-snippets` lists).
 *
 * A file name is one path segment as the repository spells it: not empty, not
 * `.` or `..`, no `/` or `\`, no control character, and no percent-escape that
 * spells one of those. Anything else a repo file name may hold (spaces,
 * unicode, `%`, a leading dot) is accepted, so every file the editor lists
 * can be acted on.
 */
import { canonicalStoredPath } from './slideDocumentAccess.ts';

const isPlainSegment = (name: string): boolean =>
  name.length > 0 &&
  name !== '.' &&
  name !== '..' &&
  [...name].every(char => {
    const code = char.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f && char !== '/' && char !== '\\';
  });

/**
 * One file name: a plain segment that is still one after its percent-escapes
 * are read (a name that is not valid percent-encoding is taken literally).
 */
const isFileName = (name: string): boolean => {
  if (!isPlainSegment(name)) return false;
  if (!name.includes('%')) return true;
  let decoded: string;
  try {
    decoded = decodeURIComponent(name);
  } catch {
    return true;
  }
  return isPlainSegment(decoded);
};

/** The deck's image folder, `<content_path>/images`, or null when it has no content path. */
export function deckImageFolder(contentPath: string | null | undefined): string | null {
  const folder = canonicalStoredPath(contentPath);
  if (!folder || folder.split('/').some(part => part === '..')) return null;
  return `${folder}/images`;
}

/** Is `path` a file directly in this deck's image folder? */
export function isDeckImagePath(path: unknown, contentPath: string | null | undefined): boolean {
  if (typeof path !== 'string') return false;
  const folder = deckImageFolder(contentPath);
  if (!folder || !path.startsWith(`${folder}/`)) return false;
  return isFileName(path.slice(folder.length + 1));
}

/**
 * The paths of a `delete-images` request when EVERY one is a file directly in
 * this deck's image folder; null when the list is empty, not a list, or any
 * entry is anything else (the whole request is then refused).
 */
export function deckImagePathsOrNull(
  paths: unknown,
  contentPath: string | null | undefined
): string[] | null {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  return paths.every(path => isDeckImagePath(path, contentPath)) ? (paths as string[]) : null;
}

/** The two theme variants a theme file is saved as. */
export const THEME_TYPES = ['light', 'dark'] as const;

export const isThemeType = (type: unknown): type is (typeof THEME_TYPES)[number] =>
  typeof type === 'string' && (THEME_TYPES as readonly string[]).includes(type);

/** Is `id` one theme file name in `.slidesthemes/` (`…-light.css` / `…-dark.css`)? */
export function isThemeFileId(id: unknown): id is string {
  return typeof id === 'string' && isFileName(id) && /-(light|dark)\.css$/.test(id);
}

/** Is `id` one snippet file name in `.slidesthemes/snippets/` (`….html`)? */
export function isSnippetFileId(id: unknown): id is string {
  return typeof id === 'string' && isFileName(id) && id.endsWith('.html');
}
