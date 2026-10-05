/**
 * The deck Y.Doc shape (spec "Doc shapes → Deck").
 *
 *   meta   Y.Map   theme, codeTheme, themeDark?, codeThemeDark?, config?,
 *                  customCss?, extraCss?  (absent key = field absent in deck.json)
 *                  + keyOrder: deck.json's top-level key order (byte-identity hint)
 *   slides Y.Map   id → Y.Map {
 *                    order: string        fractional index within its parent
 *                    parent: string|null  vertical-stack container id; null = top level
 *                    hidden: boolean
 *                    attrs: Y.Map<string,string>
 *                    attrOrder?: string[] attribute order hint (Y.Map has none across peers)
 *                    html?: string        LWW; ABSENT on a stack container
 *                    notes: Y.Text
 *                    hasNotes?: boolean   notes present even when empty ('' renders an aside)
 *                    keyOrder?: string[]  the slide's deck.json key order hint
 *                  }
 *   locks  Y.Map   id → SlideLock
 *
 * Why the hints: deck.json is `JSON.stringify(deck, null, 2)` and the two
 * writers that produced existing decks order keys differently (the parser puts
 * `slides` 4th, the editor's buildEditorDeck last; deckOps containers put
 * `children` 2nd). index.html emits section attributes in `attrs` insertion
 * order. A Y.Map has no iteration order that survives a round trip through
 * other peers, so the order is carried explicitly or the first checkpoint of
 * every deck would rewrite it.
 */

export const DECK_META = 'meta';
export const DECK_SLIDES = 'slides';
export const DECK_LOCKS = 'locks';

/**
 * Version of the deck doc shape. Sent as `schemaVersion` in the provider token
 * for deck rooms; the server rejects a mismatch with `schema-mismatch`. Bump on
 * any change to the shape above.
 */
export const DECK_SCHEMA_VERSION = 1;

/** Slide Y.Map field names. */
export const F = {
  order: 'order',
  parent: 'parent',
  hidden: 'hidden',
  attrs: 'attrs',
  attrOrder: 'attrOrder',
  html: 'html',
  notes: 'notes',
  hasNotes: 'hasNotes',
  keyOrder: 'keyOrder',
} as const;

/** Deck fields held in `meta` (everything but version and slides). */
export const META_FIELDS = [
  'theme',
  'codeTheme',
  'themeDark',
  'codeThemeDark',
  'config',
  'customCss',
  'extraCss',
] as const;

export type MetaField = (typeof META_FIELDS)[number];

/** deck.json top-level key order when no hint is stored (buildEditorDeck's). */
export const CANONICAL_DECK_KEYS = [
  'version',
  'theme',
  'codeTheme',
  'themeDark',
  'codeThemeDark',
  'config',
  'customCss',
  'extraCss',
  'slides',
] as const;

/** Slide key order when no hint is stored (the parser's). */
export const CANONICAL_SLIDE_KEYS = ['id', 'html', 'notes', 'hidden', 'attrs', 'children'] as const;

/** An 8-hex slide id (same shape as deckHtml's mintSlideId), browser- and Node-safe. */
export function mintDeckSlideId(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** A fresh id not in `used`. */
export function mintUniqueSlideId(used: { has(id: string): boolean }): string {
  let id = mintDeckSlideId();
  for (let guard = 0; used.has(id) && guard < 1000; guard++) id = mintDeckSlideId();
  return id;
}
