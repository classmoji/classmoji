/**
 * Page sections that remember the reader: checkable headings and locked
 * sections, read off a page's block JSON.
 *
 * `@classmoji/page-schema/sections`. Pure and DOM-free, no BlockNote imports:
 * the pages loader, the class site, the API route, MCP and the browser all
 * use it on stored `content.json` blocks (or anything shaped like them).
 *
 * - A checkable section is a `heading` with `props.checkable === true`; its
 *   section is the heading plus the siblings that follow it up to the next
 *   heading of the same or a higher level (`checkableSectionRanges`).
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

/** A heading's text: the plain text of its inline content, trimmed. */
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
