/**
 * Keeps a reader's copy (or cut) from carrying code and terminal blocks whose
 * author turned copying off (`copyable: false`, drawn as
 * `data-copyable="false"`).
 *
 * CSS makes those blocks unselectable, but a selection can still SPAN one
 * (drag across it, Select All), and BlockNote serializes a copy from its own
 * ProseMirror selection, not from what the page shows — after Select All in
 * the read-only view the two differ, and BlockNote would copy every block. So
 * a copy that touches a disabled block in EITHER selection is taken over and
 * rebuilt with those blocks cut out — from the DOM selection (what the reader
 * sees) when there is one, else from BlockNote's. A copy that touches none is
 * left to the browser and BlockNote.
 *
 * Read-only only: a disabled block inside an editable editor
 * (`contenteditable="true"`) is never in the way; editors copy everything.
 *
 * The class site has no bundle, so its inline script (site/copyScript.ts)
 * repeats the DOM half of this in ES5. Change one, change the other.
 */

export const NON_COPYABLE_SELECTOR = '[data-copyable="false"]';

/**
 * What a selection holds that is not text the reader picked: title-bar chrome,
 * and form controls (the terminal's hidden textarea repeats its code).
 */
const CHROME_SELECTOR = 'select, button, textarea, input, .bn-code-language, .terminal-header';

const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TR',
  'UL',
]);

/** The disabled blocks a reader is looking at (none inside an editable editor). */
function readOnlyBlockedElements(doc: Document): Element[] {
  return Array.from(doc.querySelectorAll(NON_COPYABLE_SELECTOR)).filter(
    el => !el.closest('[contenteditable="true"]')
  );
}

function selectionRanges(selection: Selection | null): Range[] {
  if (!selection || selection.isCollapsed) return [];
  const ranges: Range[] = [];
  for (let i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i));
  return ranges;
}

/** Do any of `ranges` reach into a disabled block? */
export function rangesTouchNonCopyable(ranges: Range[]): boolean {
  const doc = ranges[0]?.startContainer.ownerDocument;
  if (!doc) return false;
  const blocked = readOnlyBlockedElements(doc);
  return ranges.some(range => blocked.some(el => range.intersectsNode(el)));
}

/** Does the selection reach into a disabled block? */
export function selectionTouchesNonCopyable(selection: Selection | null): boolean {
  return rangesTouchNonCopyable(selectionRanges(selection));
}

/**
 * Plain text of a detached fragment, laid out the way a copy reads: a line
 * break between blocks, `<br>` as a break, a tab between table cells, text
 * verbatim (ProseMirror's whitespace is `pre-wrap`, and the site's server
 * HTML has none of its own).
 */
export function fragmentText(root: Node): string {
  let out = '';
  let pending = '';
  const push = (text: string) => {
    if (!text) return;
    if (pending && out) out += pending;
    pending = '';
    out += text;
  };
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) return;
    const tag = node.nodeType === 1 ? (node as Element).tagName : '';
    if (tag === 'BR') {
      out += '\n';
      pending = '';
      return;
    }
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') return;
    const block = BLOCK_TAGS.has(tag);
    if (block) pending = '\n';
    node.childNodes.forEach(visit);
    if (block) pending = '\n';
    else if ((tag === 'TD' || tag === 'TH') && pending !== '\n') pending = '\t';
  };
  visit(root);
  return out;
}

/**
 * What a copy of `ranges` may put on the clipboard, or `null` when they touch
 * no disabled block (let the browser and BlockNote copy as usual). Everything
 * selected may have been disabled: then both strings are empty, and the copy
 * must still be replaced, not let through.
 */
export function copyableRangesContent(ranges: Range[]): { text: string; html: string } | null {
  return rangesTouchNonCopyable(ranges) ? rangesContentWithout(ranges) : null;
}

/** The ranges' text and HTML with disabled blocks and title-bar chrome removed. */
function rangesContentWithout(ranges: Range[]): { text: string; html: string } {
  const doc = ranges[0]?.startContainer.ownerDocument;
  if (!doc) return { text: '', html: '' };
  const container = doc.createElement('div');
  for (const range of ranges) {
    const common = range.commonAncestorContainer;
    const element = common.nodeType === 1 ? (common as Element) : common.parentElement;
    // Wholly inside a disabled block: nothing of this range may go.
    if (element?.closest(NON_COPYABLE_SELECTOR)) continue;
    const fragment = range.cloneContents();
    // A partly selected block is cloned with its attributes, so it is found
    // (and dropped) here like a wholly selected one.
    fragment
      .querySelectorAll(`${NON_COPYABLE_SELECTOR}, ${CHROME_SELECTOR}`)
      .forEach(el => el.remove());
    container.appendChild(fragment);
  }
  return { text: fragmentText(container), html: container.innerHTML };
}

/** `copyableRangesContent` for the DOM selection (the class site's case). */
export function copyableSelectionContent(
  selection: Selection | null
): { text: string; html: string } | null {
  return copyableRangesContent(selectionRanges(selection));
}

/** The parts of a ProseMirror view the guard reads. */
export type GuardedView = {
  dom: Element;
  state: { selection: { from: number; to: number; empty: boolean } };
  domAtPos(pos: number): { node: Node; offset: number };
};

/** The DOM range a ProseMirror selection covers (what BlockNote would copy). */
function viewSelectionRanges(view: GuardedView, doc: Document): Range[] {
  const { from, to, empty } = view.state.selection;
  if (empty) return [];
  const start = view.domAtPos(from);
  const end = view.domAtPos(to);
  const range = doc.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return [range];
}

function isTextControl(target: EventTarget | null): target is Element {
  const tag = (target as Element | null)?.tagName;
  return tag === 'TEXTAREA' || tag === 'INPUT';
}

/**
 * Guard every copy, cut and drag in `doc` (capture phase, so it runs before
 * BlockNote's own handlers on the editor; its cut handler writes the clipboard
 * even in a read-only view). `getView` is the read-only editor whose
 * selection BlockNote would serialize. Returns the cleanup.
 */
export function installCopyGuard(
  doc: Document,
  getView: () => GuardedView | undefined = () => undefined
): () => void {
  const viewRanges = (): Range[] => {
    try {
      const view = getView();
      return view ? viewSelectionRanges(view, doc) : [];
    } catch {
      // Tiptap's placeholder view before mount throws on access: no selection yet.
      return [];
    }
  };
  /**
   * When either selection reaches a disabled block, the ranges to rebuild the
   * copy from: the DOM selection when there is one (what the reader sees),
   * else BlockNote's (Select All in a read-only view leaves the DOM selection
   * collapsed while ProseMirror holds everything). `null`: not ours.
   */
  const guardedRanges = (): Range[] | null => {
    const domRanges = selectionRanges(doc.getSelection());
    const pmRanges = viewRanges();
    if (!rangesTouchNonCopyable(domRanges) && !rangesTouchNonCopyable(pmRanges)) return null;
    return domRanges.length > 0 ? domRanges : pmRanges;
  };
  const onCopy = (event: ClipboardEvent) => {
    // A form field's own selection (e.g. the Copy button's fallback textarea).
    if (isTextControl(event.target) && !event.target.closest(NON_COPYABLE_SELECTOR)) return;
    const ranges = guardedRanges();
    if (!ranges) return;
    const content = rangesContentWithout(ranges);
    event.preventDefault();
    event.stopPropagation();
    event.clipboardData?.setData('text/plain', content.text);
    event.clipboardData?.setData('text/html', content.html);
  };
  // Dragging a selection out serializes it like a copy does; refuse that drag
  // (and only that one: an image elsewhere still drags).
  const onDragStart = (event: DragEvent) => {
    const target = event.target as Node | null;
    if (!target || !guardedRanges()) return;
    const ranges = [...selectionRanges(doc.getSelection()), ...viewRanges()];
    if (ranges.some(range => range.intersectsNode(target))) event.preventDefault();
  };
  doc.addEventListener('copy', onCopy, true);
  doc.addEventListener('cut', onCopy, true);
  doc.addEventListener('dragstart', onDragStart, true);
  return () => {
    doc.removeEventListener('copy', onCopy, true);
    doc.removeEventListener('cut', onCopy, true);
    doc.removeEventListener('dragstart', onDragStart, true);
  };
}
