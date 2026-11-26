/**
 * Which blocks a pending preview changes, for the rendered preview page.
 *
 * The preview is reviewed as the page itself — the preview's document,
 * rendered — with the blocks it adds or edits highlighted. Never a diff view.
 * Blocks it removes cannot be pointed at in a page that no longer has them,
 * so they are only counted.
 *
 * Pure (no React, no BlockNote): the loader computes this once, the viewer
 * turns it into a stylesheet, and the unit suite tests it directly
 * (tests/unit/preview-highlight.spec.ts).
 */

export interface PreviewChanges {
  /** Ids in both documents whose own content (props, text, type) differs. */
  changed: string[];
  /** Ids only the preview has. */
  added: string[];
  /** How many blocks the live page has that the preview does not. */
  removed: number;
  /** The preview sets, changes or removes the cover. */
  coverChanged?: boolean;
}

export const NO_PREVIEW_CHANGES: PreviewChanges = { changed: [], added: [], removed: 0 };

interface BlockNode {
  id?: unknown;
  children?: unknown;
  [key: string]: unknown;
}

/** Sorted-key JSON, so key order never reads as a change (twin of blockOpsDiff's). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter(key => record[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

/**
 * Every block with an id, anywhere in the tree, mapped to its OWN content: the
 * block without its children. A child that changed highlights the child, not
 * every ancestor around it. The first occurrence of a duplicated id wins.
 */
function ownContentById(doc: unknown): { order: string[]; byId: Map<string, string> } {
  const order: string[] = [];
  const byId = new Map<string, string>();
  const walk = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const { id, children, ...own } = block as BlockNode;
      if (typeof id === 'string' && id && !byId.has(id)) {
        order.push(id);
        byId.set(id, canonicalJson(own));
      }
      walk(children);
    }
  };
  walk(doc);
  return { order, byId };
}

/**
 * The preview's changes against the live page, in the preview's document
 * order. Either side that is not a block array reads as an empty document.
 */
export function previewBlockChanges(live: unknown, preview: unknown): PreviewChanges {
  const before = ownContentById(live);
  const after = ownContentById(preview);
  const changed: string[] = [];
  const added: string[] = [];
  for (const id of after.order) {
    const was = before.byId.get(id);
    if (was === undefined) added.push(id);
    else if (was !== after.byId.get(id)) changed.push(id);
  }
  let removed = 0;
  for (const id of before.order) if (!after.byId.has(id)) removed++;
  return { changed, added, removed };
}

/** True when there is anything to show. */
export function hasPreviewChanges(changes: PreviewChanges | null | undefined): boolean {
  return Boolean(
    changes &&
    (changes.changed.length > 0 ||
      changes.added.length > 0 ||
      changes.removed > 0 ||
      changes.coverChanged)
  );
}

/** Whether two covers differ (url or position; no cover vs a cover). */
export function coverDiffers(
  before: { url: string; position?: number } | null | undefined,
  after: { url: string; position?: number } | null | undefined
): boolean {
  if (!before || !after) return Boolean(before) !== Boolean(after);
  return before.url !== after.url || (before.position ?? 50) !== (after.position ?? 50);
}

/**
 * A block id as a CSS attribute-selector string literal. BlockNote ids are
 * UUID-like, but the document is author data, so anything outside a safe
 * alphabet is escaped rather than trusted.
 */
export function cssAttrValue(id: string): string {
  return `"${id
    .replace(/["\\]/g, ch => `\\${ch}`)
    .replace(/[\n\r\f]/g, ' ')
    // Never `</style>` inside a stylesheet, whatever the id says.
    .replace(/</g, '\\3c ')}"`;
}

/**
 * The mark sits in the gutter, not on the text: the block is padded past the
 * 3px bar and pulled left by the same amount, so the first letter stays where
 * it is and is never covered. Same in light and dark (the dark rules only
 * change colours).
 */
export const MARK_OFFSET = 'padding-left: 0.75rem; margin-left: -0.75rem;';

/**
 * The stylesheet that marks the changed and added blocks inside `scope` (a
 * class on the viewer's wrapper). Each block's own content row is marked, so a
 * nested change marks the nested block only. Light and dark variants.
 */
export function previewHighlightCss(changes: PreviewChanges, scope: string): string {
  // A toggle block's content sits in its frame (BlockNote's toggle frame),
  // beside the chevron, which used to sit inside the content. The mark
  // reaches back over the chevron (24px) as it did then, with the chevron
  // drawn on top; a toggle heading's content already spans the chevron
  // (blocknote-overrides.css) and keeps that padding, plus the mark's.
  const plain = (ids: string[]) =>
    ids.map(id => `.${scope} .bn-block[data-id=${cssAttrValue(id)}] > .bn-block-content`);
  const frame = (id: string) =>
    `.${scope} .bn-block-outer > .bn-block[data-id=${cssAttrValue(id)}] > .bn-toggle-frame`;
  const HEADING = '.bn-block-content[data-content-type="heading"]';
  const framedList = (ids: string[]) =>
    ids.map(
      id =>
        `${frame(id)}:not(:has(> .bn-toggle-slot > ${HEADING})) > .bn-toggle-slot > .bn-block-content`
    );
  const framedHeading = (ids: string[]) =>
    ids.map(
      id => `${frame(id)}:has(> .bn-toggle-slot > ${HEADING}) > .bn-toggle-slot > ${HEADING}`
    );
  const chevrons = (ids: string[]) => ids.map(id => `${frame(id)} > .bn-toggle-button`);
  // A colored heading's bar padding is `!important` and always beat the
  // mark's own padding, so a marked colored heading (chevron and text)
  // sat 0.75rem further left; a toggle heading keeps that.
  const COLORED = `${HEADING}:is(${[
    'blue',
    'red',
    'yellow',
    'orange',
    'green',
    'purple',
    'pink',
    'brown',
    'gray',
  ]
    .map(color => `[data-background-color="${color}"]`)
    .join(', ')})`;
  const coloredFrame = (id: string) => `${frame(id)}:has(> .bn-toggle-slot > ${COLORED})`;
  const coloredHeading = (ids: string[]) =>
    ids.map(id => `${coloredFrame(id)} > .bn-toggle-slot > ${COLORED}`);
  const coloredChevrons = (ids: string[]) =>
    ids.map(id => `${coloredFrame(id)} > .bn-toggle-button`);

  const mark = (ids: string[], look: string, dark: string) => {
    if (ids.length === 0) return [];
    const all = [...plain(ids), ...framedList(ids), ...framedHeading(ids)];
    return [
      `${plain(ids).join(',\n')} { ${look} ${MARK_OFFSET} }`,
      `${framedList(ids).join(',\n')} { ${look} padding-left: calc(32px + 0.75rem); margin-left: calc(-32px - 0.75rem); width: calc(100% + 32px); box-sizing: border-box; }`,
      `${framedHeading(ids).join(',\n')} { ${look} padding-left: calc(var(--heading-pad-left, 0px) + var(--toggle-check-room, 0px) + 24px + 0.75rem) !important; margin-left: -0.75rem; }`,
      `${coloredHeading(ids).join(',\n')} { padding-left: calc(var(--heading-pad-left, 0px) + var(--toggle-check-room, 0px) + 24px) !important; }`,
      `${chevrons(ids).join(',\n')} { position: relative; z-index: 1; }`,
      `${coloredChevrons(ids).join(',\n')} { margin-left: calc(var(--toggle-pad-left, 0px) + var(--toggle-check-room, 0px) - 0.75rem); }`,
      `${all.map(s => `.dark ${s}`).join(',\n')} { ${dark} }`,
    ];
  };
  return [
    ...mark(
      changes.changed,
      'background-color: rgba(245, 158, 11, 0.14); box-shadow: inset 3px 0 0 rgb(245, 158, 11); border-radius: 4px;',
      'background-color: rgba(245, 158, 11, 0.16); box-shadow: inset 3px 0 0 rgb(251, 191, 36);'
    ),
    ...mark(
      changes.added,
      'background-color: rgba(16, 185, 129, 0.12); box-shadow: inset 3px 0 0 rgb(16, 185, 129); border-radius: 4px;',
      'background-color: rgba(16, 185, 129, 0.15); box-shadow: inset 3px 0 0 rgb(52, 211, 153);'
    ),
  ].join('\n');
}

/** The preview bar's one-line summary, from the data alone. */
export function previewChangesSummary(changes: PreviewChanges): string | null {
  const parts: string[] = [];
  const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (changes.changed.length > 0) parts.push(`${n(changes.changed.length, 'block')} edited`);
  if (changes.added.length > 0) parts.push(`${n(changes.added.length, 'block')} added`);
  if (changes.removed > 0) parts.push(`${n(changes.removed, 'block')} removed`);
  if (changes.coverChanged) parts.push('cover changed');
  if (parts.length === 0) return null;
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}
