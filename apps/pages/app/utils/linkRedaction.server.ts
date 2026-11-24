import {
  parseNavGridEntries,
  serializeNavGridEntries,
  type NavGridEntry,
} from '~/components/editor/blocks/navGridShared.ts';

/**
 * Strip references to pages this viewer may not see, BEFORE the document
 * leaves the server.
 *
 * Shared by the class site's static render (`site/render.server.ts`, through
 * `site/redact.server.ts`) and the reader payload (`readerPayload.server.ts`),
 * which hands the same document to the client reader on every surface.
 *
 * A render override is not enough on its own. BlockNote's HTML serializer
 * writes every block prop onto the block wrapper as a `data-*` attribute, and
 * the reader payload ships the props themselves as JSON — so a `pageLink`
 * block whose render deliberately draws nothing still carries
 * `pageTitle: "Exam 2 Solutions"`, and a `navGrid` its entire authored
 * `entries` JSON including the hidden titles. That is precisely the leak the
 * visibility rule exists to prevent, and it is invisible on screen.
 *
 * So visibility is enforced twice, on purpose: once here (the document never
 * mentions a hidden page) and once in the renders (which resolve hrefs from
 * the viewer's link map and drop an entry that is not in it). Two layers
 * because they fail differently — this one is a data transform that a new
 * block type could forget to opt into, and that one is a rendering rule that
 * a serializer change could route around.
 */

/**
 * What a render knows about a page another block links to.
 *
 * `membersOnly` is not a secret: a resolver returns a link at all only for a
 * page THIS viewer may open, so it can only ever be true for someone who is
 * already a member. It marks the links their signed-out classmates could not
 * follow.
 */
export type ViewerPageLink = { href: string; title: string; membersOnly?: boolean };

/**
 * Resolves a page id to a link this viewer may follow, or `null`.
 *
 * `null` means "drop it entirely" — not "render it greyed out". An anonymous
 * visitor must not learn that a members-only page called "Exam 2 Solutions"
 * exists.
 */
export type ViewerLinkResolver = (pageId: string) => ViewerPageLink | null;

export interface RedactionOptions {
  /**
   * Drop every page-directory schedule entry. The reader payload sets it when
   * there is no schedule to link to (no site, or its schedule is off), so a
   * tile never points somewhere that 404s. The class site's static render
   * does not pass it: its schema drops the tile itself (`showSchedule`).
   */
  dropSchedule?: boolean;
  /**
   * REMOVE a redacted-away block instead of leaving an empty paragraph in its
   * place (the reader payload: no blank line where a hidden link was). Its
   * children, if any, take its place; a column left empty goes, and a column
   * list left with fewer than two columns is unwrapped (`removeBlocks`).
   * Without it (the class site's static render) the old replacement stands.
   */
  remove?: boolean;
}

/** A BlockNote block, loosely typed — this walks arbitrary stored documents. */
type LooseBlock = {
  type?: unknown;
  props?: Record<string, unknown>;
  children?: unknown;
  [key: string]: unknown;
};

/** What a redacted-away block becomes: an empty paragraph, which renders as nothing. */
const emptyParagraph = (): LooseBlock => ({ type: 'paragraph', content: [] });

/** Marks a block to remove (its own children are lifted into its place). */
const REMOVE = Symbol('remove');

/**
 * BlockNote's file-family blocks. Their EMPTY state (`props.url === ''`) is
 * the editor's "Add image" / "Add file" / "Add audio" button — an upload
 * affordance a reader must never be offered. An unset block is easy to leave
 * behind (add an image, never pick one, publish), so this is the common case,
 * not an exotic one.
 */
const FILE_BLOCK_TYPES = new Set(['image', 'file', 'audio']);

function redactBlock(
  block: LooseBlock,
  resolveLink: ViewerLinkResolver,
  options: RedactionOptions
): LooseBlock | typeof REMOVE {
  const children = Array.isArray(block.children)
    ? redactList(block.children as unknown[], resolveLink, options)
    : block.children;
  const childrenChanged = children !== block.children;
  const same = (): LooseBlock => (childrenChanged ? { ...block, children } : block);
  const drop = (): LooseBlock | typeof REMOVE => (options.remove ? REMOVE : emptyParagraph());

  if (typeof block.type === 'string' && FILE_BLOCK_TYPES.has(block.type)) {
    // Exactly the condition BlockNote's own wrapper branches on.
    if (String(block.props?.url ?? '') === '') return drop();
    return same();
  }

  if (block.type === 'pageLink') {
    const pageId = String(block.props?.pageId ?? '');
    const link = pageId ? resolveLink(pageId) : null;
    // Drop the whole block: its props are the leak, not its markup.
    if (!link) return drop();
    // A visible link carries the page's live title, not the copy cached when
    // it was authored (which may name what the page used to be called), and
    // only the props the block defines (`pageLinkConfig`: pageId, pageTitle).
    return {
      ...block,
      props: { pageId, pageTitle: link.title },
      ...(Array.isArray(children) ? { children } : {}),
    };
  }

  if (block.type === 'navGrid') {
    // ALWAYS re-serialized from the parsed, filtered entries: an entry the
    // parser cannot read (a misspelt kind, a numeric page id, truncated JSON)
    // must not survive inside the authored string with its title.
    const entries = parseNavGridEntries(block.props?.entries);
    const visible: NavGridEntry[] = entries.filter(entry => {
      if (entry.kind === 'page') return resolveLink(entry.pageId) !== null;
      if (entry.kind === 'schedule') return !options.dropSchedule;
      return true;
    });
    return {
      ...block,
      props: { ...block.props, entries: serializeNavGridEntries(visible) },
      ...(Array.isArray(children) ? { children } : {}),
    };
  }

  return same();
}

/**
 * A list of blocks redacted; a removed block's children take its place. In
 * remove mode a `columnList` is then repaired the way the editor (and the
 * collab server's `unwrapBrokenColumnLists`) repairs one: a column with no
 * blocks left goes, and a list with fewer than two columns is unwrapped, its
 * remaining blocks in its place. BlockNote refuses a column list with fewer
 * than two columns, and a page that holds one does not load at all.
 * Returns the input list itself when nothing in it changed.
 */
function redactList(
  list: unknown[],
  resolveLink: ViewerLinkResolver,
  options: RedactionOptions
): unknown[] {
  let changed = false;
  const out: unknown[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      out.push(item);
      continue;
    }
    const block = item as LooseBlock;
    const next = redactBlock(block, resolveLink, options);
    if (next === REMOVE) {
      changed = true;
      const lifted = Array.isArray(block.children)
        ? redactList(block.children as unknown[], resolveLink, options)
        : [];
      out.push(...lifted);
      continue;
    }
    if (options.remove && next.type === 'columnList') {
      const repaired = repairColumnList(next);
      if (repaired !== next) {
        changed = true;
        if (Array.isArray(repaired)) out.push(...repaired);
        else out.push(repaired);
        continue;
      }
    }
    if (next !== item) changed = true;
    out.push(next);
  }
  return changed ? out : list;
}

/** A column list as a reader may receive it, or the blocks that replace it. */
function repairColumnList(list: LooseBlock): LooseBlock | unknown[] {
  const columns = Array.isArray(list.children) ? (list.children as LooseBlock[]) : [];
  const kept = columns.filter(
    column =>
      column?.type !== 'column' || (Array.isArray(column.children) && column.children.length > 0)
  );
  const columnCount = kept.filter(column => column?.type === 'column').length;
  if (columnCount >= 2) return kept.length === columns.length ? list : { ...list, children: kept };
  // Unwrapped: the remaining column's blocks (and anything else in the list) in its place.
  return kept.flatMap(column =>
    column?.type === 'column' && Array.isArray(column.children) ? column.children : [column]
  );
}

/**
 * Redact a whole document for one viewer. Never mutates `blocks` (content
 * reads may be shared cache entries); an untouched block comes back by
 * identity.
 *
 * Recurses through `children` so a page link nested inside a column, a list
 * item or a toggle is covered — the leak does not care how deep the block is.
 */
export function redactDocumentForViewer(
  blocks: unknown,
  resolveLink: ViewerLinkResolver,
  options: RedactionOptions = {}
): unknown[] {
  if (!Array.isArray(blocks)) return [];
  const out = redactList(blocks, resolveLink, options);
  return out === blocks ? [...blocks] : out;
}

/**
 * Remove every block `remove` names (its children take its place), with the
 * same column repair as the redaction's remove mode. Non-mutating. For the
 * reader's last pass: media that could not be resolved.
 */
export function removeBlocks(blocks: unknown, remove: (block: LooseBlock) => boolean): unknown[] {
  if (!Array.isArray(blocks)) return [];
  const walk = (list: unknown[]): unknown[] => {
    let changed = false;
    const out: unknown[] = [];
    for (const item of list) {
      if (!item || typeof item !== 'object') {
        out.push(item);
        continue;
      }
      const block = item as LooseBlock;
      const children = Array.isArray(block.children) ? walk(block.children as unknown[]) : null;
      if (remove(block)) {
        changed = true;
        out.push(...(children ?? []));
        continue;
      }
      const next: LooseBlock =
        children && children !== block.children ? { ...block, children } : block;
      if (next.type === 'columnList') {
        const repaired = repairColumnList(next);
        if (repaired !== next) {
          changed = true;
          if (Array.isArray(repaired)) out.push(...repaired);
          else out.push(repaired);
          continue;
        }
      }
      if (next !== item) changed = true;
      out.push(next);
    }
    return changed ? out : list;
  };
  return walk(blocks);
}

/**
 * Every page id a document's links name (`pageLink` blocks and the page
 * entries of a `navGrid`), in document order, each once. The reader payload
 * looks up only these pages, so its link map can only ever hold pages the
 * document itself points at.
 */
export function linkedPageIds(blocks: unknown): string[] {
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const block = node as LooseBlock;
    if (block.type === 'pageLink') {
      const pageId = String(block.props?.pageId ?? '');
      if (pageId) seen.add(pageId);
    } else if (block.type === 'navGrid') {
      for (const entry of parseNavGridEntries(block.props?.entries)) {
        if (entry.kind === 'page' && entry.pageId) seen.add(entry.pageId);
      }
    }
    if (block.children) walk(block.children);
  };
  walk(blocks);
  return [...seen];
}

/** Whether any page directory in the document has a schedule entry. */
export function hasScheduleEntry(blocks: unknown): boolean {
  let found = false;
  const walk = (node: unknown): void => {
    if (found) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const block = node as LooseBlock;
    if (
      block.type === 'navGrid' &&
      parseNavGridEntries(block.props?.entries).some(entry => entry.kind === 'schedule')
    ) {
      found = true;
      return;
    }
    if (block.children) walk(block.children);
  };
  walk(blocks);
  return found;
}
