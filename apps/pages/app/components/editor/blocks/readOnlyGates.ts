import { hasMediaPlaceholderShape, hasMediaScheme } from '~/utils/mediaRefs.ts';

/**
 * What the page blocks show a reader (`editor.isEditable === false`) versus an
 * author, decided here so the unit suite can pin it without mounting React
 * (the Playwright test transform rewrites JSX in app files).
 *
 * `editable` is `editor.isEditable`. It is also true inside the server editor
 * (`ServerBlockNoteEditor`), so on the server every block keeps its editor
 * render; these gates change only what the client's read-only viewer draws.
 */

/** The emojis a callout's icon cycles through when its author clicks it. */
export const CALLOUT_EMOJIS = ['💡', '⚡', '🔥', '📌', '🎯', '💬', '🚀', '⭐'] as const;

/** The next emoji in the cycle; an emoji outside it starts the cycle over. */
export function nextCalloutEmoji(current: string): string {
  const index = (CALLOUT_EMOJIS as readonly string[]).indexOf(current);
  return CALLOUT_EMOJIS[(index + 1) % CALLOUT_EMOJIS.length];
}

/**
 * A block whose content is set by a field (embed URL, video URL, linked page,
 * terminal code): its content, the field an author fills it from, or — for a
 * reader of an empty one — nothing at all.
 */
export type FieldBlockView = 'content' | 'empty-state' | 'nothing';

export function fieldBlockView(editable: boolean, hasValue: boolean): FieldBlockView {
  if (hasValue) return 'content';
  return editable ? 'empty-state' : 'nothing';
}

/**
 * What the terminal block draws: the editing box for an author (the
 * highlighted code until they click into it), the highlighted code for a
 * reader, and nothing for a reader of an empty terminal. A reader never gets a
 * textarea, copyable or not: the Copy button copies.
 */
export function terminalView(editable: boolean, code: string): 'edit' | 'code' | 'nothing' {
  if (editable) return 'edit';
  return code ? 'code' : 'nothing';
}

/**
 * Whether a page-link block may ask `/api/pages/…` for the classroom's pages:
 * only for an author choosing one, never for a reader.
 */
export function pageLinkMayFetch(state: {
  editable: boolean;
  open: boolean;
  loaded: boolean;
  loading: boolean;
}): boolean {
  return state.editable && state.open && !state.loaded && !state.loading;
}

/**
 * Whether a reader can be shown a media element (image, video, file, audio)
 * for this stored URL, given what it resolved to: not when there is no URL,
 * when a `media:` reference is still unresolved, or when it resolved to the
 * placeholder for media that could not be signed. Each of those would render
 * an empty "add" control or a broken element.
 *
 * `resolvedUrl` is `useResolvedFileUrl`'s answer, which is synchronous for
 * every reference the loader shipped a display URL for, so a block is not
 * hidden while it is merely resolving; if an async answer lands later the
 * block re-renders and shows.
 */
export function readerCanShowMedia(storedUrl: unknown, resolvedUrl: unknown): boolean {
  if (typeof storedUrl !== 'string' || !storedUrl) return false;
  const shown = typeof resolvedUrl === 'string' && resolvedUrl ? resolvedUrl : storedUrl;
  return !hasMediaScheme(shown) && !hasMediaPlaceholderShape(shown);
}
