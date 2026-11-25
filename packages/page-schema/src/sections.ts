/**
 * Page sections that remember the reader: checkable headings, student check
 * lists and locked sections, read off a page's block JSON.
 *
 * `@classmoji/page-schema/sections`. Pure and DOM-free, no BlockNote imports:
 * the pages loader, the class site, the API route, MCP and the browser all
 * use it on stored `content.json` blocks (or anything shaped like them).
 *
 * - A checkable section is a `heading` with `props.checkable === true`; its
 *   section is the heading plus the siblings that follow it up to the next
 *   heading of the same or a higher level (`checkableSectionRanges`).
 * - A student check list item is a `checkListItem` with
 *   `props.personal === true`: each reader ticks their own copy. It has no
 *   section (nothing fades). Checkable headings and student check list items
 *   are the two "check targets" (`isCheckTarget`): what a reader may tick.
 * - A `lockedSection` holds its title in `props.title` (public) and its body
 *   as children. A reader who has not unlocked it gets the block with no
 *   children (`redactLockedSections`).
 *
 * Every function tolerates malformed input (non-arrays, non-objects, missing
 * ids): it skips what it cannot read and never throws. Redaction fails closed:
 * a locked section without a readable id is never revealed.
 */

/** A stored block, as loosely as this module reads it. */
export interface SectionBlock {
  id?: unknown;
  type?: unknown;
  props?: unknown;
  content?: unknown;
  children?: unknown;
  [key: string]: unknown;
}

export const LOCKED_SECTION_TYPE = 'lockedSection';

function isObject(value: unknown): value is SectionBlock {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function blockId(block: SectionBlock): string | null {
  return typeof block.id === 'string' && block.id ? block.id : null;
}

/** A `lockedSection` block. */
export function isLockedSection(block: unknown): block is SectionBlock {
  return isObject(block) && block.type === LOCKED_SECTION_TYPE;
}

function isHeading(block: unknown): block is SectionBlock {
  return isObject(block) && block.type === 'heading';
}

/** A heading the author made checkable (`props.checkable === true`). */
export function isCheckableHeading(block: unknown): block is SectionBlock {
  return (
    isHeading(block) &&
    isObject(block.props) &&
    (block.props as Record<string, unknown>).checkable === true
  );
}

/** The heading levels that can be steps. */
export const STEP_MAX_LEVEL = 2;

/**
 * A heading the author made a step (`props.step === true`) at a level that can
 * be one (H1 and H2). The prop on a deeper heading, from an older client or a
 * level change, is ignored rather than drawn.
 */
export function isStepHeading(block: unknown): block is SectionBlock {
  return (
    isHeading(block) &&
    isObject(block.props) &&
    (block.props as Record<string, unknown>).step === true &&
    headingLevel(block) <= STEP_MAX_LEVEL
  );
}

export const CHECK_LIST_ITEM_TYPE = 'checkListItem';

/** A `checkListItem` block, personal or not. */
export function isCheckListItem(block: unknown): block is SectionBlock {
  return isObject(block) && block.type === CHECK_LIST_ITEM_TYPE;
}

/**
 * A check list item the author made personal (`props.personal === true`):
 * each reader ticks their own copy.
 */
export function isPersonalCheckListItem(block: unknown): block is SectionBlock {
  return (
    isCheckListItem(block) &&
    isObject(block.props) &&
    (block.props as Record<string, unknown>).personal === true
  );
}

/**
 * Something a reader may tick for themselves: a checkable heading or a
 * personal check list item. Every check/uncheck validation reads this.
 */
export function isCheckTarget(block: unknown): block is SectionBlock {
  return isCheckableHeading(block) || isPersonalCheckListItem(block);
}

/** A heading's level, 1 (BlockNote's default) when missing or unreadable. */
function headingLevel(block: SectionBlock): number {
  const level = isObject(block.props) ? Number((block.props as { level?: unknown }).level) : NaN;
  return Number.isFinite(level) ? level : 1;
}

/**
 * `blocks` with the body (children) of every locked section the reader may
 * not see removed: a `lockedSection` for which `reveal(id)` is false becomes
 * `{ ...block, children: [] }` (title and props kept). Revealed sections keep
 * their children, and redaction continues inside them, so a nested locked
 * section is revealed only on its own id. Every block's children are walked
 * (columns, toggles, list items, locked sections).
 *
 * Never mutates its input. Structural sharing: a subtree with nothing to
 * redact is returned as the SAME object, and a list with nothing to redact as
 * the same array, so a document without locked sections comes back as is.
 * A locked section without a string id is never revealed.
 */
export function redactLockedSections<T>(blocks: T[], reveal: (id: string) => boolean): T[];
export function redactLockedSections(blocks: unknown, reveal: (id: string) => boolean): unknown;
export function redactLockedSections(blocks: unknown, reveal: (id: string) => boolean): unknown {
  if (!Array.isArray(blocks)) return blocks;
  let out: unknown[] | null = null;
  for (let i = 0; i < blocks.length; i++) {
    const before = blocks[i];
    const after = redactBlock(before, reveal);
    if (after !== before) {
      out ??= blocks.slice();
      out[i] = after;
    }
  }
  return out ?? blocks;
}

function redactBlock(block: unknown, reveal: (id: string) => boolean): unknown {
  if (!isObject(block)) return block;
  if (isLockedSection(block)) {
    const id = blockId(block);
    if (id === null || !reveal(id)) {
      return Array.isArray(block.children) && block.children.length === 0
        ? block
        : { ...block, children: [] };
    }
  }
  if (!Array.isArray(block.children)) return block;
  const children = redactLockedSections(block.children, reveal);
  return children === block.children ? block : { ...block, children };
}

/** Depth-first visit of every block object, children after their parent. */
function walk(blocks: unknown, visit: (block: SectionBlock) => boolean | void): boolean {
  if (!Array.isArray(blocks)) return false;
  for (const block of blocks) {
    if (!isObject(block)) continue;
    if (visit(block) === true) return true;
    if (walk(block.children, visit)) return true;
  }
  return false;
}

/** The block with this id at any depth, or null. */
export function findBlock(blocks: unknown, id: string): SectionBlock | null {
  if (typeof id !== 'string' || !id) return null;
  let found: SectionBlock | null = null;
  walk(blocks, block => {
    if (block.id === id) {
      found = block;
      return true;
    }
  });
  return found;
}

/** Ids of every `lockedSection` at any depth, in document order. */
export function lockedSectionIds(blocks: unknown): string[] {
  const ids: string[] = [];
  walk(blocks, block => {
    const id = isLockedSection(block) ? blockId(block) : null;
    if (id) ids.push(id);
  });
  return ids;
}

/** Ids of every checkable heading at any depth, in document order. */
export function checkableHeadingIds(blocks: unknown): string[] {
  const ids: string[] = [];
  walk(blocks, block => {
    const id = isCheckableHeading(block) ? blockId(block) : null;
    if (id) ids.push(id);
  });
  return ids;
}

/** Ids of every personal check list item at any depth, in document order. */
export function personalCheckListItemIds(blocks: unknown): string[] {
  const ids: string[] = [];
  walk(blocks, block => {
    const id = isPersonalCheckListItem(block) ? blockId(block) : null;
    if (id) ids.push(id);
  });
  return ids;
}

/** Ids of every check target (checkable heading or personal check list item), in document order. */
export function checkTargetIds(blocks: unknown): string[] {
  const ids: string[] = [];
  walk(blocks, block => {
    const id = isCheckTarget(block) ? blockId(block) : null;
    if (id) ids.push(id);
  });
  return ids;
}

/**
 * The check list `id` belongs to: the ids of the run of ADJACENT
 * `checkListItem` siblings around it, in order (a block of another type ends
 * the run). Items nested under a member (Tab-indented) are their own list and
 * are not included. Empty when `id` is not a check list item.
 */
export function checkListRun(blocks: unknown, id: string): string[] {
  if (typeof id !== 'string' || !id) return [];
  let run: string[] = [];
  const visitList = (list: unknown): boolean => {
    if (!Array.isArray(list)) return false;
    const index = list.findIndex(block => isObject(block) && block.id === id);
    if (index !== -1) {
      if (!isCheckListItem(list[index])) return true;
      let start = index;
      while (start > 0 && isCheckListItem(list[start - 1])) start--;
      let end = index;
      while (end < list.length - 1 && isCheckListItem(list[end + 1])) end++;
      run = list
        .slice(start, end + 1)
        .map(block => blockId(block as SectionBlock))
        .filter((value): value is string => value !== null);
      return true;
    }
    return list.some(block => isObject(block) && visitList(block.children));
  };
  visitList(blocks);
  return run;
}

/**
 * Every checkable heading's section: heading id -> the ids of the heading and
 * of the siblings that follow it in the SAME list, up to (not including) the
 * next heading whose level is the same or higher (a smaller or equal number).
 * Children of a listed block are not listed: they render inside it.
 * Headings at any depth (columns, toggles, locked sections) get a range
 * within their own sibling list. Blocks without a string id are skipped.
 */
export function checkableSectionRanges(blocks: unknown): Map<string, string[]> {
  const ranges = new Map<string, string[]>();
  const visitList = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i++) {
      const block = list[i];
      if (!isObject(block)) continue;
      const id = blockId(block);
      if (id && isCheckableHeading(block) && !ranges.has(id)) {
        const level = headingLevel(block);
        const range = [id];
        for (let j = i + 1; j < list.length; j++) {
          const next = list[j];
          if (isHeading(next) && headingLevel(next) <= level) break;
          const nextId = isObject(next) ? blockId(next) : null;
          if (nextId) range.push(nextId);
        }
        ranges.set(id, range);
      }
      visitList(block.children);
    }
  };
  visitList(blocks);
  return ranges;
}

/** The characters of inline content: text runs, link runs, plain strings. */
function inlineText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(inlineText).join('');
  if (!isObject(node)) return '';
  if (typeof node.text === 'string') return node.text;
  return node.content === undefined ? '' : inlineText(node.content);
}

/**
 * A heading's (or any inline block's, e.g. a check list item's) text: the
 * plain text of its inline content, trimmed.
 */
export function headingText(block: unknown): string {
  if (!isObject(block)) return '';
  return inlineText(block.content).trim();
}

/** A locked section's title (`props.title`), trimmed; '' when missing. */
export function lockedSectionTitle(block: unknown): string {
  if (!isObject(block) || !isObject(block.props)) return '';
  const title = (block.props as Record<string, unknown>).title;
  return typeof title === 'string' ? title.trim() : '';
}

// ── Comment anchors ────────────────────────────────────────────────────────
//
// Page comments anchor on a block id and, optionally, a quote inside that
// block's text (`quote` + which match of it, `occurrence`). The server checks
// a new quote against the reader's tree and the browser finds it again to
// draw the highlight, both with the functions below, so they always agree.

/** Ids of every block at any depth, in document order (parents before their children). */
export function blockIdsInOrder(blocks: unknown): string[] {
  const ids: string[] = [];
  walk(blocks, block => {
    const id = blockId(block);
    if (id) ids.push(id);
  });
  return ids;
}

/**
 * The id of the nearest `lockedSection` that ENCLOSES the block with this id
 * (an ancestor, never the block itself), or null when there is none or the
 * block is not in `blocks`. A locked section's own title is public, so a
 * comment on the section block itself is not inside it (asked about a section
 * nested in another, this answers the outer one, whose body holds its title).
 * Nested sections answer the INNERMOST: a reader who unlocked only the outer
 * one still must not see what the inner one hides.
 */
export function enclosingLockedSectionId(blocks: unknown, id: string): string | null {
  if (typeof id !== 'string' || !id) return null;
  const search = (list: unknown, enclosing: string | null): string | null | undefined => {
    if (!Array.isArray(list)) return undefined;
    for (const block of list) {
      if (!isObject(block)) continue;
      if (block.id === id) return enclosing;
      // (A locked section without a readable id is never revealed to a
      // reader, so nothing in it can be commented on by one.)
      const next = isLockedSection(block) ? (blockId(block) ?? enclosing) : enclosing;
      const found = search(block.children, next);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return search(blocks, null) ?? null;
}

function tableText(content: SectionBlock): string {
  const rows = Array.isArray(content.rows) ? content.rows : [];
  const cells: string[] = [];
  for (const row of rows) {
    const rowCells = isObject(row) && Array.isArray(row.cells) ? row.cells : [];
    for (const cell of rowCells) cells.push(inlineText(cell));
  }
  return cells.join(' ');
}

/**
 * The text a comment quote is matched in: a block's own inline content (text
 * and link runs; a table's cells joined by a space), not its children. A
 * `lockedSection` answers its title. Untrimmed and not normalized.
 */
export function blockText(block: unknown): string {
  if (!isObject(block)) return '';
  if (block.type === LOCKED_SECTION_TYPE) return lockedSectionTitle(block);
  const content = block.content;
  if (isObject(content) && Array.isArray(content.rows)) return tableText(content);
  return inlineText(content);
}

/** Every run of whitespace as one space (quotes and block text are compared this way). */
export function normalizeQuoteText(text: string): string {
  return typeof text === 'string' ? text.replace(/\s+/gu, ' ') : '';
}

/**
 * Where the `occurrence`-th match (0-based) of `quote` starts in `text`, both
 * whitespace-normalized (`normalizeQuoteText`), or -1. Matches may overlap:
 * in "aaa", "aa" occurs at 0 and at 1. The index is into the NORMALIZED text.
 */
export function quoteOccurrenceIndex(text: string, quote: string, occurrence: number): number {
  if (!Number.isInteger(occurrence) || occurrence < 0) return -1;
  const haystack = normalizeQuoteText(text);
  const needle = normalizeQuoteText(quote);
  if (!needle) return -1;
  let index = -1;
  for (let seen = 0; seen <= occurrence; seen++) {
    index = haystack.indexOf(needle, index + 1);
    if (index === -1) return -1;
  }
  return index;
}

/** How many (possibly overlapping) times `quote` occurs in `text`, both whitespace-normalized. */
export function countQuoteOccurrences(text: string, quote: string): number {
  const haystack = normalizeQuoteText(text);
  const needle = normalizeQuoteText(quote);
  if (!needle) return 0;
  let count = 0;
  for (
    let index = haystack.indexOf(needle);
    index !== -1;
    index = haystack.indexOf(needle, index + 1)
  ) {
    count++;
  }
  return count;
}

// ── Steps ──────────────────────────────────────────────────────────────────

/** One step: what the reader draws for it, read off the document alone. */
export interface StepInfo {
  /** The step heading's level (1 or 2). */
  level: number;
  /** Its number within its run (1 for the first). */
  number: number;
  /** The step heading's id, then the ids of the siblings in its section. */
  ids: string[];
  /** True when a step of the same level follows in the same run. */
  hasNext: boolean;
  /** True when a step of the same level came before it in the same run. */
  hasPrev: boolean;
  /** True when the heading is the first block of its sibling list. */
  firstInList: boolean;
  /** How many steps contain this heading, itself included (1 = top level). */
  depth: number;
}

/**
 * Every step heading: heading id -> `StepInfo`.
 *
 * A step's section is the heading plus the siblings after it up to (not
 * including) the next heading of the same or a higher level, as for a
 * checkable section. Steps are numbered in runs: consecutive step headings of
 * one level in one sibling list. A heading of a higher level ends the runs
 * below it, and a heading of the same level that is NOT a step ends its own
 * run, so the numbers start again at 1 after it. Headings at any depth (columns,
 * toggles, locked sections) are numbered within their own sibling list.
 * Blocks without a string id are skipped.
 */
export function stepLayout(blocks: unknown): Map<string, StepInfo> {
  const steps = new Map<string, StepInfo>();
  const visitList = (list: unknown) => {
    if (!Array.isArray(list)) return;
    const counter: number[] = [];
    const previous: Array<StepInfo | undefined> = [];
    for (let i = 0; i < list.length; i++) {
      const block = list[i];
      if (!isObject(block)) continue;
      if (isHeading(block)) {
        const level = headingLevel(block);
        // Deeper runs end at any heading; this level's run ends unless this is a step.
        for (let l = level + 1; l <= 6; l++) {
          counter[l] = 0;
          previous[l] = undefined;
        }
        const id = blockId(block);
        if (id && isStepHeading(block)) {
          const before = previous[level];
          counter[level] = (counter[level] ?? 0) + 1;
          const info: StepInfo = {
            level,
            number: counter[level],
            ids: [id],
            hasNext: false,
            hasPrev: Boolean(before),
            firstInList: i === 0,
            depth: 1,
          };
          if (before) before.hasNext = true;
          previous[level] = info;
          for (let j = i + 1; j < list.length; j++) {
            const next = list[j];
            if (isHeading(next) && headingLevel(next) <= level) break;
            const nextId = isObject(next) ? blockId(next) : null;
            if (nextId) info.ids.push(nextId);
          }
          steps.set(id, info);
        } else {
          counter[level] = 0;
          previous[level] = undefined;
        }
      }
      visitList(block.children);
    }
  };
  visitList(blocks);

  // An H2 step inside an H1 step sits one level in: depth counts the steps whose
  // section holds the heading.
  for (const [id, info] of steps) {
    let depth = 0;
    for (const other of steps.values()) if (other.ids.includes(id)) depth += 1;
    info.depth = depth;
  }
  return steps;
}
