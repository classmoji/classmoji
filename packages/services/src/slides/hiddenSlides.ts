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
  /** Nothing but whitespace text and comments inside. */
  isBlank(section: N): boolean;
  remove(node: N): void;
}

/** Apply the rule under `root` (the `.slides` container). Returns how many sections it removed. */
export function removeHiddenSlides<N>(root: N, tree: SlideTree<N>): number {
  let removed = 0;
  for (const top of tree.sections(root)) {
    if (tree.isHidden(top)) {
      tree.remove(top);
      removed++;
      continue;
    }
    const children = tree.sections(top);
    if (children.length === 0) continue;
    let kept = 0;
    for (const child of children) {
      if (tree.isHidden(child)) {
        tree.remove(child);
        removed++;
      } else {
        kept++;
      }
    }
    if (kept === 0 && tree.isBlank(top)) {
      tree.remove(top);
      removed++;
    }
  }
  return removed;
}

const COMMENT_NODE = 8;
const TEXT_NODE = 3;

/** The browser DOM (or jsdom). */
export const domSlideTree: SlideTree<ParentNode> = {
  sections: node => Array.from(node.children).filter(el => el.tagName.toLowerCase() === 'section'),
  isHidden: section => (section as Element).getAttribute(HIDDEN_SLIDE_ATTR) === 'true',
  isBlank: section =>
    Array.from((section as Element).childNodes).every(
      n => n.nodeType === COMMENT_NODE || (n.nodeType === TEXT_NODE && !n.textContent?.trim())
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
      n => n.type === 'comment' || (n.type === 'text' && !('data' in n && n.data.trim()))
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
