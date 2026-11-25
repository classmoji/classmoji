import { defaultStyleSpecs } from '@blocknote/core';

/**
 * Stored page content made to fit BlockNote's STOCK style rules, the rules
 * every page will be judged by (`validatePageBlocks` in
 * `@classmoji/page-schema/server`). Pure JSON in, JSON out: no editor, no DOM,
 * so the pages app runs it in the browser before a document reaches BlockNote.
 *
 * BlockNote's `code` mark excludes every formatting mark and the link, so a
 * run that is code AND bold (or italic, underlined, struck through, coloured,
 * highlighted) cannot be built, and neither can code inside a link. Older
 * editors and imports stored such runs; so did whatever wrote a link as a
 * text style (`styles.href`), which no schema knows. The rules:
 *
 * - code + bold / italic / underline / strike / textColor / backgroundColor:
 *   keep the code, drop the others;
 * - code inside a link: keep the link, drop the code;
 * - a text style `href` (a string): the run becomes a real link to that href
 *   (adjacent runs with the same href share one link); then the link rule
 *   above applies to it;
 * - any other style key BlockNote does not know: dropped.
 *
 * A style whose value is falsy (`bold: false`) builds no mark, so it is no
 * conflict and is left as it is. Code blocks are not touched: their content
 * is flattened to plain text before it is drawn (`normalizeCodeBlockContent`).
 *
 * Idempotent; content with nothing to clean comes back as the SAME array
 * (byte-identical when serialized), and otherwise only the blocks on the path
 * to a change are copied.
 */

/** The style keys BlockNote's default (stock) schema knows. */
const KNOWN_STYLES: ReadonlySet<string> = new Set(Object.keys(defaultStyleSpecs));

/**
 * The marks stock `code` excludes besides itself and the link (pinned against
 * BlockNote's own mark in `__tests__/contentRules.test.ts`).
 */
export const CODE_EXCLUDED_STYLES = [
  'bold',
  'italic',
  'underline',
  'strike',
  'textColor',
  'backgroundColor',
] as const;

/** One thing `cleanPageBlocks` changed. */
export interface PageContentChange {
  /** The block holding the run (null when the block has no id). */
  blockId: string | null;
  blockType: string | null;
  /** What was done, in plain words. */
  change: string;
  /** The run's first characters. */
  text: string;
}

type Run = { type: 'text'; text: string; styles?: Record<string, unknown> };
type Link = { type: 'link'; href: unknown; content?: unknown };
type BlockLike = {
  id?: unknown;
  type?: unknown;
  content?: unknown;
  children?: unknown;
};

/** One call's state: what it found, and how. */
interface Pass {
  changes: PageContentChange[];
  keepCodeMarks: boolean;
}

/** The pass, at one block. */
interface Ctx extends Pass {
  blockId: string | null;
  blockType: string | null;
}

export interface CleanPageBlocksOptions {
  /**
   * Leave inline code beside other marks and inside links: what the app
   * schemas (`pageStyleSpecs`) still draw. For the pages app's reader and
   * editor until those schemas take the stock styles; everything that WRITES
   * content cleans with the stock rules (the default).
   */
  keepCodeMarks?: boolean;
}

/** A run's first characters, for reports. */
export function runSnippet(text: unknown): string {
  const flat = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
}

function isRun(node: unknown): node is Run {
  return (
    !!node &&
    typeof node === 'object' &&
    (node as { type?: unknown }).type === 'text' &&
    typeof (node as { text?: unknown }).text === 'string'
  );
}

function isLink(node: unknown): node is Link {
  return !!node && typeof node === 'object' && (node as { type?: unknown }).type === 'link';
}

/**
 * One run cleaned. `href` is set when the run carried a usable `href` style
 * outside a link (the caller wraps it in a link; the returned run no longer
 * has the key).
 */
function cleanRun(run: Run, inLink: boolean, ctx: Ctx): { run: Run; href?: string } {
  const styles = run.styles;
  if (!styles || typeof styles !== 'object' || Array.isArray(styles)) return { run };
  let next: Record<string, unknown> | undefined;
  const drop = (key: string, change: string) => {
    next ??= { ...styles };
    delete next[key];
    ctx.changes.push({
      blockId: ctx.blockId,
      blockType: ctx.blockType,
      change,
      text: runSnippet(run.text),
    });
  };

  let href: string | undefined;
  for (const [key, value] of Object.entries(styles)) {
    if (KNOWN_STYLES.has(key)) continue;
    if (key === 'href' && typeof value === 'string' && value && !inLink) {
      href = value;
      drop(key, 'turned a link stored as a text style into a link');
    } else {
      drop(key, `dropped the unknown text style '${key}'`);
    }
  }

  const current = () => next ?? styles;
  if (ctx.keepCodeMarks) {
    // Nothing more: code beside other marks is drawn as it is.
  } else if ((inLink || href !== undefined) && current().code) {
    drop('code', 'dropped inline code inside a link (the link stays)');
  }
  if (!ctx.keepCodeMarks && current().code) {
    for (const key of CODE_EXCLUDED_STYLES) {
      if (current()[key]) drop(key, `dropped ${key} from inline code (the code stays)`);
    }
  }

  const cleaned = next ? { ...run, styles: next } : run;
  return href !== undefined ? { run: cleaned, href } : { run: cleaned };
}

/**
 * Inline content (an array of runs, links and anything else) cleaned, or the
 * same array when nothing changed. Outside a link, runs that carried the same
 * `href` style next to each other become one link.
 */
function cleanInline(content: unknown[], inLink: boolean, ctx: Ctx): unknown[] {
  let out: unknown[] | undefined;
  let openLink: { type: 'link'; href: string; content: Run[] } | undefined;
  const ensureOut = (upTo: number) => {
    out ??= content.slice(0, upTo);
    return out;
  };

  content.forEach((node, i) => {
    if (isRun(node)) {
      const { run, href } = cleanRun(node, inLink, ctx);
      if (href !== undefined) {
        const target = ensureOut(i);
        if (openLink && openLink.href === href && target[target.length - 1] === openLink) {
          openLink.content.push(run);
        } else {
          openLink = { type: 'link', href, content: [run] };
          target.push(openLink);
        }
        return;
      }
      if (run !== node) ensureOut(i).push(run);
      else out?.push(node);
      return;
    }
    if (isLink(node) && Array.isArray(node.content)) {
      const inner = cleanInline(node.content, true, ctx);
      if (inner !== node.content) ensureOut(i).push({ ...node, content: inner });
      else out?.push(node);
      return;
    }
    out?.push(node);
  });
  return out ?? content;
}

/** A table's content (`tableContent`: rows of cells) cleaned, or the same object. */
function cleanTable(table: Record<string, unknown>, ctx: Ctx): Record<string, unknown> {
  const rows = table.rows;
  if (!Array.isArray(rows)) return table;
  let nextRows: unknown[] | undefined;
  rows.forEach((row, r) => {
    const cells = (row as { cells?: unknown } | null)?.cells;
    if (!Array.isArray(cells)) return;
    let nextCells: unknown[] | undefined;
    cells.forEach((cell, c) => {
      let next: unknown = cell;
      if (Array.isArray(cell)) {
        next = cleanInline(cell, false, ctx);
      } else if (cell && typeof cell === 'object') {
        const inner = (cell as { content?: unknown }).content;
        if (Array.isArray(inner)) {
          const cleaned = cleanInline(inner, false, ctx);
          if (cleaned !== inner) next = { ...cell, content: cleaned };
        }
      }
      if (next !== cell) {
        nextCells ??= cells.slice();
        nextCells[c] = next;
      }
    });
    if (nextCells) {
      nextRows ??= rows.slice();
      nextRows[r] = { ...(row as object), cells: nextCells };
    }
  });
  return nextRows ? { ...table, rows: nextRows } : table;
}

function cleanBlock(block: unknown, pass: Pass): unknown {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return block;
  const b = block as BlockLike;
  const ctx: Ctx = {
    blockId: typeof b.id === 'string' ? b.id : null,
    blockType: typeof b.type === 'string' ? b.type : null,
    ...pass,
  };
  let next: BlockLike | undefined;
  if (b.type !== 'codeBlock') {
    const content = b.content;
    let cleaned: unknown = content;
    if (Array.isArray(content)) cleaned = cleanInline(content, false, ctx);
    else if (
      content &&
      typeof content === 'object' &&
      (content as { type?: unknown }).type === 'tableContent'
    ) {
      cleaned = cleanTable(content as Record<string, unknown>, ctx);
    }
    if (cleaned !== content) next = { ...b, content: cleaned };
  }
  if (Array.isArray(b.children)) {
    const children = cleanList(b.children, pass);
    if (children !== b.children) next = { ...(next ?? b), children };
  }
  return next ?? block;
}

function cleanList(blocks: unknown[], pass: Pass): unknown[] {
  let out: unknown[] | undefined;
  blocks.forEach((block, i) => {
    const next = cleanBlock(block, pass);
    if (next !== block) {
      out ??= blocks.slice();
      out[i] = next;
    }
  });
  return out ?? blocks;
}

/**
 * `blocks` (anything; only an array is read) with every text run made to fit
 * BlockNote's stock style rules, at any depth (children, columns, table
 * cells), and what was changed. See the module comment for the rules.
 */
export function cleanPageBlocks<T>(
  blocks: T,
  { keepCodeMarks = false }: CleanPageBlocksOptions = {}
): {
  blocks: T;
  changes: PageContentChange[];
} {
  const changes: PageContentChange[] = [];
  if (!Array.isArray(blocks)) return { blocks, changes };
  return { blocks: cleanList(blocks, { changes, keepCodeMarks }) as T, changes };
}
