/**
 * conflictChooser.ts — pure helpers for the side-by-side deck preview-conflict
 * chooser (plan §3b Phase 7), mirroring apps/pages' twin.
 *
 * No JSX/React imports here: PreviewControls renders these, and the Playwright
 * runner unit-tests them directly (tests/unit/conflict-chooser.spec.ts)
 * without a browser.
 */

/** A per-conflict choice: `ours` = the live (main) side, `theirs` = the preview side. */
export type MergeChoice = 'ours' | 'theirs';

/** One chooser decision, keyed by the conflict id from the accept report. */
export interface MergeResolution {
  id: string;
  choose: MergeChoice;
}

/** Sentinel conflict id for the top-level slide order; stacks use `__order__:<id>`. */
export const ORDER_CONFLICT_ID = '__order__';
/** Sentinel conflict id for deck-level meta (theme/config/css) collisions. */
export const META_CONFLICT_ID = '__meta__';

/** A stack's child-order conflict id (`__order__:<stackId>`). */
export function isChildOrderId(id: string): boolean {
  return id.startsWith(`${ORDER_CONFLICT_ID}:`);
}

/**
 * One conflicted unit from the accept 409 payload (the service's
 * DeckMergeConflict shapes). Slide units carry DeckSlide sides (null =
 * deleted on that side); order sentinels carry id arrays; `__meta__` carries
 * partial deck-meta objects with only the double-changed fields.
 */
export interface ConflictUnit {
  id: string;
  /** Dotted position, '4' or '4.2' ('' for sentinels). */
  index: string;
  reason?:
    | 'content'
    | 'delete_vs_edit'
    | 'both_added'
    | 'placement'
    | 'child_order'
    | 'order'
    | 'meta'
    | string;
  ours?: unknown;
  theirs?: unknown;
  base?: unknown;
}

/** The slide fields the chooser reads (DeckSlide subset; sides are untyped JSON). */
export interface SlideSide {
  id?: string;
  html?: string;
  notes?: string;
  children?: SlideSide[];
}

const REASON_LABELS: Record<string, string> = {
  content: 'Edited in both versions',
  delete_vs_edit: 'Deleted in one version, edited in the other',
  both_added: 'Added in both versions',
  placement: 'Moved differently in both versions',
  child_order: 'Stack order changed in both versions',
  order: 'Slide order changed in both versions',
  meta: 'Deck settings changed in both versions',
};

/** Human label for a conflict reason (fallback for future reasons). */
export function reasonLabel(reason: string | undefined): string {
  return (reason && REASON_LABELS[reason]) || 'Changed in both versions';
}

/**
 * The renderable HTML for one side of a slide conflict: the slide's own html,
 * or — for vertical-stack containers — the children's htmls joined with a
 * dashed separator.
 */
export function slideSideHtml(side: SlideSide | null | undefined): string {
  if (!side) return '';
  if (typeof side.html === 'string' && side.html.trim()) return side.html;
  if (Array.isArray(side.children) && side.children.length > 0) {
    return side.children
      .map(child => (typeof child?.html === 'string' ? child.html : ''))
      .filter(Boolean)
      .join('\n<hr style="border:none;border-top:1px dashed #bbb;margin:12px 0">\n');
  }
  return '';
}

/**
 * Self-contained srcdoc for a sandboxed slide-side preview. The hosting
 * `<iframe sandbox srcdoc>` keeps scripts OFF (empty sandbox allowlist) — this
 * doc adds none of its own, only bounding styles that scale the slide content
 * down into the card.
 */
export function buildSlideSrcdoc(html: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    'html,body{margin:0;padding:0;background:#fff;color:#111;}',
    'body{padding:16px;font-family:system-ui,-apple-system,sans-serif;font-size:26px;',
    'line-height:1.35;transform:scale(0.45);transform-origin:top left;width:222%;}',
    'img,video,iframe{max-width:100%;height:auto;}',
    'pre{white-space:pre-wrap;font-size:0.7em;}',
    'h1,h2,h3{margin:0.3em 0;}',
    '</style></head><body>',
    html,
    '</body></html>',
  ].join('');
}

/** One row of the `__meta__` field diff table. */
export interface MetaFieldRow {
  field: string;
  ours: string;
  theirs: string;
}

/** Compact display value for a deck-meta field. */
export function formatMetaValue(value: unknown): string {
  if (value === undefined) return '(not set)';
  if (value === null) return '(none)';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/** Field diff rows for the `__meta__` card (union of both sides' fields). */
export function metaFieldRows(
  ours: Record<string, unknown> | null | undefined,
  theirs: Record<string, unknown> | null | undefined
): MetaFieldRow[] {
  const fields = [...new Set([...Object.keys(ours ?? {}), ...Object.keys(theirs ?? {})])];
  return fields.map(field => ({
    field,
    ours: formatMetaValue((ours ?? {})[field]),
    theirs: formatMetaValue((theirs ?? {})[field]),
  }));
}

/** true when every listed conflict id has an ours/theirs choice. */
export function allResolved(ids: string[], choices: Record<string, MergeChoice>): boolean {
  return ids.length > 0 && ids.every(id => choices[id] === 'ours' || choices[id] === 'theirs');
}

/** Build the resolutions payload the accept intent posts (one entry per id). */
export function buildResolutions(
  ids: string[],
  choices: Record<string, MergeChoice>
): MergeResolution[] {
  return ids.map(id => ({ id, choose: choices[id] }));
}
