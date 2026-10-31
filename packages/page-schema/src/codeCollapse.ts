/**
 * Collapsible code blocks: a code block whose author turned on `collapsible`
 * shows its first COLLAPSED_LINES lines, a short fade, and a bar along the
 * bottom ("Show all 77 lines" / "Show less") that opens and closes it.
 *
 * The `<code>` is the block's content (ProseMirror's contentDOM in the editor
 * and the in-app viewer), so its lines cannot be split into elements. The
 * `<pre>` is clipped instead, by CSS, to that many rows of its own line
 * height (blocknote-overrides.css, `pre[data-collapse="collapsed"]`): the
 * hidden lines are still there, so find-in-page finds them, Copy copies
 * them, and a server render needs no measuring to draw the clipped block.
 *
 * The vanilla code block (schema.ts) draws the bar for the editor and the
 * in-app viewer and attaches the behavior below; the class site's static
 * render draws the same markup (site/viewerSchema.server.ts) and its inline
 * script does what `createCodeCollapse` does here (site/copyScript.ts, ES5).
 * Change one, change the other.
 *
 * DOM is touched only in the builders and event paths, never at import: the
 * collab server and the git worker import this package without a DOM.
 */
import type { BlockNoteEditor } from '@blocknote/core';
import type { EditorState } from 'prosemirror-state';

import { guardControlEvents } from './copyControl.ts';

/** Lines a collapsed block shows. */
export const COLLAPSED_LINES = 10;
/**
 * A collapsible block collapses only when it has MORE lines than this. Hiding
 * one to five lines saves less than the click to see them costs, so a block
 * of up to 15 lines is drawn in full, with no bar.
 */
export const COLLAPSE_MIN_HIDDEN = 5;
export const COLLAPSE_ABOVE_LINES = COLLAPSED_LINES + COLLAPSE_MIN_HIDDEN;

/** The bar along the bottom of a collapsible block (the site's script keys on it). */
export const CODE_EXPAND_CLASS = 'bn-code-expand';
/** The fade from the last shown line into the bar. */
export const CODE_FADE_CLASS = 'bn-code-fade';
/** The editor's toggle for the `collapsible` prop. */
export const COLLAPSE_TOGGLE_CLASS = 'bn-collapse-toggle';
/**
 * On the `<pre>` of a block that collapses: `collapsed` or `expanded`. Absent
 * on every other code block, so CSS leaves those exactly as they were.
 */
export const COLLAPSE_ATTR = 'data-collapse';

export const SHOW_LESS_LABEL = 'Show less';
/** The toggle's fixed name; `aria-pressed` carries the state. */
export const COLLAPSE_TOGGLE_LABEL = 'Collapse long code';
export const COLLAPSE_ON_TITLE = 'Collapse long code: on';
export const COLLAPSE_OFF_TITLE = 'Collapse long code: off';

const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true" focusable="false"';

/** Lucide "chevron-down"; CSS turns it up while the block is open. */
const CHEVRON_ICON = `${SVG_OPEN}><path d="m6 9 6 6 6-6"/></svg>`;
/** Lucide "chevrons-down-up". */
export const COLLAPSE_TOGGLE_ICON = `${SVG_OPEN}><path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/></svg>`;

/**
 * Whether a block's props ask for collapsing. Props written without
 * validation (MCP) may hold anything; only `true` (or the string BlockNote
 * writes it as, `data-collapsible="true"`) turns it on.
 */
export function isCollapsible(props: { collapsible?: unknown }): boolean {
  return props.collapsible === true || props.collapsible === 'true';
}

/**
 * Source lines in a block's text: its `\n`-separated lines, wrapped or not.
 * One trailing newline ends the last line rather than starting another: a
 * static `<pre>` (the class site) draws no empty line after it, so counting
 * one would put the label and the threshold one off there.
 */
export function codeLineCount(text: string): number {
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length;
}

/** Whether a collapsible block of `lines` lines collapses (draws the bar). */
export function collapsesAt(lines: number): boolean {
  return lines > COLLAPSE_ABOVE_LINES;
}

/** A plain code block's text from its stored content (runs, or a string). */
export function codeBlockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(run =>
      typeof (run as { text?: unknown })?.text === 'string' ? (run as { text: string }).text : ''
    )
    .join('');
}

/** What the bar says while the block is collapsed. */
export function showAllLabel(lines: number): string {
  return `Show all ${lines} lines`;
}

/** The `<pre>`'s id, which the bar's `aria-controls` names. */
export function codePreId(blockId: string): string {
  return `bn-code-${blockId}`;
}

/** Toggle title for a block's `collapsible` value. */
export function collapseToggleTitle(collapsible: boolean): string {
  return collapsible ? COLLAPSE_ON_TITLE : COLLAPSE_OFF_TITLE;
}

/**
 * The bar's inner markup. Both labels are drawn and CSS shows the one for
 * `aria-expanded` (as the Copy button does with its icons), so the class
 * site's script only flips attributes. The bar is a button: copy guards drop
 * it, and `user-select: none` keeps its label out of a native selection.
 */
export function codeExpandBarHTML(lines: number): string {
  return (
    CHEVRON_ICON +
    `<span class="bn-code-expand-more">${showAllLabel(lines)}</span>` +
    `<span class="bn-code-expand-less">${SHOW_LESS_LABEL}</span>`
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = BlockNoteEditor<any, any, any>;
type PMNode = EditorState['doc'];

/** What a node view hands its render: the live node and its position. */
export interface CodeCollapseNodeView {
  node: PMNode;
  getPos: () => number | undefined;
}

/**
 * Blocks open in an editor, by id. The node view is rebuilt whenever a prop
 * changes (the language, a peer's edit to `copyable`), and an author who
 * opened a block to work in it should not see it snap shut. Never saved:
 * readers always load collapsed.
 */
const openBlocks = new WeakMap<object, Set<string>>();

function openSet(editor: AnyEditor): Set<string> {
  let set = openBlocks.get(editor);
  if (!set) {
    set = new Set();
    openBlocks.set(editor, set);
  }
  return set;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The element that scrolls `element` vertically: an app pane, or the page. */
function scrollerOf(element: HTMLElement): Element | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return element.ownerDocument.scrollingElement;
}

/** The ms the height change takes (CSS has the same, for the transition itself). */
const ANIMATION_MS = 250;

/**
 * Animate the `<pre>` from `from` px to the height its new state has. The
 * end state is already applied; this only plays the way there, through an
 * inline `max-height` that is removed when it lands.
 */
function animateHeight(pre: HTMLElement, from: number): void {
  const to = pre.getBoundingClientRect().height;
  if (Math.abs(to - from) < 2) return;
  pre.style.maxHeight = `${from}px`;
  void pre.offsetHeight;
  // `data-animating` brings the transition (and clips while it runs); it is
  // set only after the start height is in place, so nothing animates to it.
  pre.setAttribute('data-animating', '');
  pre.style.maxHeight = `${to}px`;
  const done = () => {
    clearTimeout(timer);
    pre.removeEventListener('transitionend', onEnd);
    pre.removeAttribute('data-animating');
    pre.style.removeProperty('max-height');
    if (!pre.getAttribute('style')) pre.removeAttribute('style');
  };
  const onEnd = (event: TransitionEvent) => {
    if (event.target === pre) done();
  };
  pre.addEventListener('transitionend', onEnd);
  const timer = setTimeout(done, ANIMATION_MS + 150);
}

/** The editor's toggle for the `collapsible` prop; `onToggle` flips it. */
export function createCollapseToggle(
  collapsible: boolean,
  onToggle: () => void
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = COLLAPSE_TOGGLE_CLASS;
  button.innerHTML = COLLAPSE_TOGGLE_ICON;
  button.setAttribute('aria-label', COLLAPSE_TOGGLE_LABEL);
  button.setAttribute('aria-pressed', String(collapsible));
  button.title = collapseToggleTitle(collapsible);
  guardControlEvents(button);
  button.addEventListener('click', onToggle);
  return button;
}

export interface CodeCollapse {
  /** Keeps ProseMirror from re-reading the block for the bar's own changes. */
  ignoreMutation: (mutation: { type: string; target: Node }) => boolean;
  /** Follows the block's text: line count, label, whether it collapses. */
  update?: (node: PMNode) => boolean;
  destroy: () => void;
}

/**
 * Draw the bar and fade into the code block's title-bar wrapper (`chrome`,
 * already outside the editable content) and mark the `<pre>`; with a node
 * view (`live`), also make them work:
 *
 *  - the bar opens and closes the block, animated unless the reader asked
 *    for reduced motion; "Show less" from below the block's top snaps shut
 *    and scrolls by what it removed, so the bar stays under the pointer;
 *  - a collapsed `<pre>` that scrolls (find-in-page revealing a hidden line;
 *    the editor bringing the caret into view) opens, and the page scrolls
 *    by the same amount, so what was being revealed stays where it was;
 *  - in an editable editor, the caret entering the code opens it;
 *  - the line count follows edits, local and remote (`update`).
 *
 * Without a node view (a one-off `blocksToFullHTML` render, and BlockNote's
 * internal clipboard HTML) nothing is drawn: no surface shows that markup
 * (the class site draws its own), and the bar's label is text that must not
 * travel with the code.
 */
export function createCodeCollapse({
  editor,
  blockId,
  chrome,
  pre,
  text,
  live,
}: {
  editor: AnyEditor;
  blockId: string;
  chrome: HTMLElement;
  pre: HTMLElement;
  text: string;
  live: CodeCollapseNodeView | null;
}): CodeCollapse {
  if (!live) return { ignoreMutation: () => false, destroy: () => {} };
  let lines = codeLineCount(text);
  const opened = openSet(editor);
  let expanded = opened.has(blockId);

  const bar = document.createElement('button');
  bar.type = 'button';
  bar.className = CODE_EXPAND_CLASS;
  bar.innerHTML = codeExpandBarHTML(lines);
  const more = bar.querySelector('.bn-code-expand-more') as HTMLElement;
  const fade = document.createElement('div');
  fade.className = CODE_FADE_CLASS;
  fade.setAttribute('aria-hidden', 'true');
  if (blockId) {
    pre.id = codePreId(blockId);
    bar.setAttribute('aria-controls', pre.id);
  }
  // The bar first: the fade hides by `[aria-expanded="true"] ~ .bn-code-fade`.
  chrome.appendChild(bar);
  chrome.appendChild(fade);

  const paint = () => {
    const on = collapsesAt(lines);
    bar.hidden = !on;
    fade.hidden = !on;
    if (on) pre.setAttribute(COLLAPSE_ATTR, expanded ? 'expanded' : 'collapsed');
    else pre.removeAttribute(COLLAPSE_ATTR);
    bar.setAttribute('aria-expanded', String(expanded));
    const label = showAllLabel(lines);
    if (more.textContent !== label) more.textContent = label;
  };
  paint();

  let node = live.node;

  const setExpanded = (next: boolean, animate: boolean) => {
    if (next === expanded || !collapsesAt(lines)) return;
    const from = pre.getBoundingClientRect();
    const barTop = bar.getBoundingClientRect().top;
    // Scrolled while clipped: find-in-page showing a hidden line, or the
    // editor bringing a caret there into view (ArrowUp from below lands on
    // the last line). Read before opening, which clears it.
    const shift = next ? pre.scrollTop : 0;
    expanded = next;
    if (next) opened.add(blockId);
    else opened.delete(blockId);
    paint();
    // Open without moving what was being shown: the code goes back to its
    // top and the page scrolls by as much, so the line stays where it was.
    if (shift > 0) {
      pre.scrollTop = 0;
      const scroller = scrollerOf(pre);
      if (scroller) scroller.scrollTop += shift;
      return;
    }
    // Shut from far down: snap, and keep the bar where the pointer is.
    if (!next && from.top < 0) {
      const scroller = scrollerOf(pre);
      if (scroller) scroller.scrollTop += bar.getBoundingClientRect().top - barTop;
      return;
    }
    if (animate && !prefersReducedMotion()) animateHeight(pre, from.height);
  };

  const onBar = () => setExpanded(!expanded, true);
  const releaseBar = guardControlEvents(bar);
  bar.addEventListener('click', onBar);

  const onScroll = () => {
    if (pre.scrollTop > 0) setExpanded(true, false);
  };
  pre.addEventListener('scroll', onScroll);

  /** Whether the editor's selection has an end inside this block's code. */
  const caretInside = () => {
    const pos = live.getPos();
    if (pos === undefined) return false;
    const { from, to } = editor.prosemirrorState.selection;
    const start = pos + 1;
    const end = pos + node.nodeSize - 1;
    return (from >= start && from <= end) || (to >= start && to <= end);
  };
  const offSelection = editor.isEditable
    ? editor.onSelectionChange(() => {
        if (!expanded && collapsesAt(lines) && caretInside()) setExpanded(true, true);
      })
    : undefined;

  return {
    ignoreMutation: mutation =>
      mutation.type !== 'selection' &&
      ((mutation.type === 'attributes' && mutation.target === pre) ||
        bar.contains(mutation.target) ||
        fade.contains(mutation.target)),
    // Content edits keep the node view (only a prop change rebuilds it), so
    // the count follows the text here. Returning true is ProseMirror's own
    // default for a node view with content: keep the DOM, update the code.
    update: next => {
      if (next.type !== node.type || !next.sameMarkup(node)) return false;
      node = next;
      const count = codeLineCount(next.textContent);
      if (count !== lines) {
        const was = collapsesAt(lines);
        lines = count;
        // Grown past the threshold while being written: open if the author
        // is in it (or had it open), collapsed if the change came from away.
        if (!was && collapsesAt(lines)) {
          expanded = opened.has(blockId) || caretInside();
          // Remembered, so a rebuild mid-edit (a language change, a peer's
          // prop flip) does not snap it shut.
          if (expanded) opened.add(blockId);
        }
        paint();
      }
      return true;
    },
    destroy: () => {
      releaseBar();
      bar.removeEventListener('click', onBar);
      pre.removeEventListener('scroll', onScroll);
      offSelection?.();
    },
  };
}
