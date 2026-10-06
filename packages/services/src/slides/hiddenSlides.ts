/**
 * hiddenSlides.ts — the one rule for which slides a deck shows to someone who
 * is not editing it (issue #436).
 *
 * A slide marked `data-hidden="true"` is retired without being deleted. Only
 * the editor shows it (marked `.slide-hidden`); every other surface — the
 * plain view, presenter, follow, speaker view, the stored document served to
 * non-editors, the thumbnail and the search index — leaves it out. The rule:
 *
 *   - a hidden top-level section goes, with its whole vertical stack;
 *   - a hidden child of a stack goes, its visible siblings stay;
 *   - a stack that loses every child to the filter goes too, unless it still
 *     holds real content of its own. Whitespace and HTML comments are not
 *     content, so `<section><!-- … --></section>` does not survive as a blank
 *     slide.
 *
 * The rule runs over three shapes: the browser DOM (viewers), cheerio's
 * domhandler tree (server) and deck.json (thumbnail). `removeHiddenSlides` is
 * written once against `SlideTree`, and the two tree adapters live here, so the
 * DOM and server copies cannot drift; `withoutHiddenSlides` is the deck.json
 * form, pinned to the same cases in tests/unit/hidden-slides.spec.ts.
 *
 * ZERO runtime imports, like deckRuntimeAttrs.ts: the slides client imports
 * this through `@classmoji/services/slides/hidden`, and the content extractor
 * (which must sit below services) imports it by path.
 */

import type { AnyNode, Element as HandlerElement } from 'domhandler';
import type { DeckJson, DeckSlide } from './deckTypes.ts';

export const HIDDEN_SLIDE_ATTR = 'data-hidden';

/** The few operations the rule needs from a tree. */
export interface SlideTree<N> {
  /** Direct `<section>` children of `node`, in order. */
  sections(node: N): N[];
  isHidden(section: N): boolean;
  /**
   * Nothing but whitespace text, comments and child sections inside — the
   * stack's own content, judged as if its children were gone.
   */
  isBlank(section: N): boolean;
  remove(node: N): void;
}

/** What the rule does to one top-level section and its vertical children. */
interface SlotPlan<N> {
  node: N;
  hidden: boolean;
  keep: boolean;
  children: Array<{ node: N; keep: boolean }>;
}

/** The rule, decided without touching the tree. */
function planHiddenSlides<N>(root: N, tree: SlideTree<N>): SlotPlan<N>[] {
  return tree.sections(root).map(top => {
    const children = tree.sections(top).map(node => ({ node, keep: !tree.isHidden(node) }));
    if (tree.isHidden(top)) {
      return { node: top, hidden: true, keep: false, children };
    }
    const collapses =
      children.length > 0 && children.every(child => !child.keep) && tree.isBlank(top);
    return { node: top, hidden: false, keep: !collapses, children };
  });
}

/** Apply the rule under `root` (the `.slides` container). Returns how many sections it removed. */
export function removeHiddenSlides<N>(root: N, tree: SlideTree<N>): number {
  let removed = 0;
  for (const slot of planHiddenSlides(root, tree)) {
    if (slot.hidden) {
      tree.remove(slot.node);
      removed++;
      continue;
    }
    for (const child of slot.children) {
      if (child.keep) continue;
      tree.remove(child.node);
      removed++;
    }
    if (!slot.keep) {
      tree.remove(slot.node);
      removed++;
    }
  }
  return removed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Slide positions across the rule
//
// The editor keeps hidden slides and every other view drops them, so the same
// Reveal position (`#/h/v`) names different slides in the two. These map a
// position from one numbering to the other, so switching between edit and
// view keeps the viewer on the slide they were looking at.
// ─────────────────────────────────────────────────────────────────────────────

/** A Reveal position: horizontal index, vertical index within a stack. */
export interface SlideIndices {
  h: number;
  v: number;
}

/**
 * The rule's outcome for a deck, as data: per top-level section whether it
 * survives, and per vertical child whether it does. A kept stack whose
 * children all go shows as one flat slide.
 */
export interface SlideSlot {
  keep: boolean;
  children: boolean[];
}

/** The rule's outcome under `root`, without changing anything. */
export function hiddenSlideLayout<N>(root: N, tree: SlideTree<N>): SlideSlot[] {
  return planHiddenSlides(root, tree).map(slot => ({
    keep: slot.keep,
    children: slot.children.map(child => child.keep),
  }));
}

/** Every editor position in order, with where the viewer shows it (null: hidden). */
function positionsOf(
  layout: SlideSlot[]
): Array<{ full: SlideIndices; visible: SlideIndices | null }> {
  const positions: Array<{ full: SlideIndices; visible: SlideIndices | null }> = [];
  let h = 0;
  layout.forEach((slot, i) => {
    const count = Math.max(slot.children.length, 1);
    if (!slot.keep) {
      for (let j = 0; j < count; j++) positions.push({ full: { h: i, v: j }, visible: null });
      return;
    }
    const flat = slot.children.length === 0 || slot.children.every(keep => !keep);
    let v = 0;
    for (let j = 0; j < count; j++) {
      const visible = flat ? { h, v: 0 } : slot.children[j] ? { h, v: v++ } : null;
      positions.push({ full: { h: i, v: j }, visible });
    }
    h++;
  });
  return positions;
}

/** Index of `at` in `positions` by one numbering, clamped into range. */
function clampedIndex(
  positions: Array<{ full: SlideIndices; visible: SlideIndices | null }>,
  at: SlideIndices,
  pick: (p: { full: SlideIndices; visible: SlideIndices | null }) => SlideIndices | null
): number {
  let best = -1;
  for (let k = 0; k < positions.length; k++) {
    const p = pick(positions[k]);
    if (!p) continue;
    if (p.h === at.h && p.v === at.v) return k;
    // Past the end of a stack (or of the deck): the last position before it.
    if (p.h < at.h || (p.h === at.h && p.v < at.v)) best = k;
  }
  return best;
}

function toVisible(layout: SlideSlot[], at: SlideIndices): { at: SlideIndices; exact: boolean } {
  const positions = positionsOf(layout);
  const k = clampedIndex(positions, at, p => p.full);
  if (k < 0) return { at: { h: 0, v: 0 }, exact: false };
  const here = positions[k].visible;
  const exact = here !== null && positions[k].full.h === at.h && positions[k].full.v === at.v;
  if (here) return { at: here, exact };
  // A hidden slide: the one that takes its place, else the one before it.
  for (let n = k + 1; n < positions.length; n++) {
    const next = positions[n].visible;
    if (next) return { at: next, exact: false };
  }
  for (let n = k - 1; n >= 0; n--) {
    const prev = positions[n].visible;
    if (prev) return { at: prev, exact: false };
  }
  return { at: { h: 0, v: 0 }, exact: false };
}

function toFull(layout: SlideSlot[], at: SlideIndices): { at: SlideIndices; exact: boolean } {
  const positions = positionsOf(layout);
  const k = clampedIndex(positions, at, p => p.visible);
  if (k < 0) return { at: { h: 0, v: 0 }, exact: false };
  const there = positions[k].visible!;
  return { at: positions[k].full, exact: there.h === at.h && there.v === at.v };
}

/**
 * The viewer's position (hidden slides gone) of the editor's slide at `full`.
 * A hidden slide maps to the nearest visible one: the next, else the previous.
 */
export function toVisibleIndices(layout: SlideSlot[], full: SlideIndices): SlideIndices {
  return toVisible(layout, full).at;
}

/** The editor's position (hidden slides kept) of the viewer's slide at `visible`. */
export function toFullIndices(layout: SlideSlot[], visible: SlideIndices): SlideIndices {
  return toFull(layout, visible).at;
}

/** The editor position of the first section `match` accepts, or null. */
export function slideIndicesWhere<N>(
  root: N,
  tree: SlideTree<N>,
  match: (section: N) => boolean
): SlideIndices | null {
  const tops = tree.sections(root);
  for (let h = 0; h < tops.length; h++) {
    if (match(tops[h])) return { h, v: 0 };
    const children = tree.sections(tops[h]);
    for (let v = 0; v < children.length; v++) {
      if (match(children[v])) return { h, v };
    }
  }
  return null;
}

/**
 * Carry a Reveal location hash (`#/h`, `#/h/v`, `#/h/v/f` or `#/<section-id>`)
 * across the rule: `to: 'visible'` when leaving the editor, `to: 'full'` when
 * entering it. Returns the new hash, or null when it needs no change.
 *
 * A named hash still finds its slide in the editor, and in the viewer too
 * unless that slide is hidden; only then is it rewritten, to the nearest
 * visible slide (`fullIndicesOfId` locates it in the editor numbering). A
 * fragment step is kept only while the hash still names the same slide.
 */
export function remapRevealHash(
  hash: string,
  layout: SlideSlot[],
  to: 'visible' | 'full',
  fullIndicesOfId?: (id: string) => SlideIndices | null
): string | null {
  const name = hash.replace(/^#\/?/, '');
  if (!name) return null;
  const bits = name.split('/');

  if (!/^[0-9]*$/.test(bits[0])) {
    if (to === 'full' || !fullIndicesOfId) return null;
    let id = bits[0];
    try {
      id = decodeURIComponent(id);
    } catch {
      return null;
    }
    const full = fullIndicesOfId(id);
    if (!full) return null;
    const mapped = toVisible(layout, full);
    return mapped.exact ? null : hashOf(mapped.at, undefined);
  }

  const from = { h: parseInt(bits[0], 10) || 0, v: parseInt(bits[1] ?? '', 10) || 0 };
  const fragment: string | undefined = bits[2];
  const mapped = to === 'visible' ? toVisible(layout, from) : toFull(layout, from);
  const next = hashOf(mapped.at, mapped.exact ? fragment : undefined);
  return next === `#/${name}` || next === hash ? null : next;
}

function hashOf(at: SlideIndices, fragment: string | undefined): string {
  let hash = `#/${at.h}`;
  if (at.v > 0 || fragment !== undefined) hash += `/${at.v}`;
  if (fragment !== undefined) hash += `/${fragment}`;
  return hash;
}

const COMMENT_NODE = 8;
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** The browser DOM (or jsdom). */
export const domSlideTree: SlideTree<ParentNode> = {
  sections: node => Array.from(node.children).filter(el => el.tagName.toLowerCase() === 'section'),
  isHidden: section => (section as Element).getAttribute(HIDDEN_SLIDE_ATTR) === 'true',
  isBlank: section =>
    Array.from((section as Element).childNodes).every(
      n =>
        n.nodeType === COMMENT_NODE ||
        (n.nodeType === TEXT_NODE && !n.textContent?.trim()) ||
        (n.nodeType === ELEMENT_NODE && (n as Element).tagName.toLowerCase() === 'section')
    ),
  remove: node => (node as Element).remove(),
};

/** cheerio's domhandler tree. `remove` detaches the node the way domutils does. */
export const domhandlerSlideTree: SlideTree<AnyNode> = {
  sections: node =>
    ('children' in node ? node.children : []).filter(
      c => c.type === 'tag' && (c as HandlerElement).name === 'section'
    ),
  isHidden: section => (section as HandlerElement).attribs?.[HIDDEN_SLIDE_ATTR] === 'true',
  isBlank: section =>
    ((section as HandlerElement).children ?? []).every(
      n =>
        n.type === 'comment' ||
        (n.type === 'text' && !('data' in n && n.data.trim())) ||
        (n.type === 'tag' && (n as HandlerElement).name === 'section')
    ),
  remove: node => {
    const parent = node.parent;
    if (parent) {
      const at = parent.children.indexOf(node as never);
      if (at >= 0) parent.children.splice(at, 1);
    }
    if (node.prev) node.prev.next = node.next;
    if (node.next) node.next.prev = node.prev;
    node.parent = null;
    node.prev = null;
    node.next = null;
  },
};

/** deck.json with the rule applied. The input is not mutated. */
export function withoutHiddenSlides(deck: DeckJson): DeckJson {
  const slides: DeckSlide[] = [];
  for (const slide of deck.slides) {
    if (slide.hidden) continue;
    if (!slide.children || slide.children.length === 0) {
      slides.push(slide);
      continue;
    }
    const children = slide.children.filter(child => !child.hidden);
    // A stack container's own html is absent (see DeckSlide.html), so a stack
    // with no children left has nothing to show.
    if (children.length === 0 && !slide.html?.trim()) continue;
    slides.push({ ...slide, children });
  }
  return { ...deck, slides };
}

/** Cheap pre-check: can this html contain a hidden slide at all? */
export function mayHaveHiddenSlides(html: string): boolean {
  return /data-hidden\s*=\s*["']?true/i.test(html);
}
