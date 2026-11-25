import { BlockNoteEditor, blockToNode } from '@blocknote/core';

import { CODE_EXCLUDED_STYLES, runSnippet } from './cleanContent.ts';
import { normalizeCodeBlockContent } from './codeContent.ts';
import { createStrictPageSchema } from './schema.ts';

/** ProseMirror's node and mark, as BlockNote builds them. */
type PMNode = ReturnType<typeof blockToNode>;
type Mark = PMNode['marks'][number];

/**
 * Page content judged by BlockNote's STOCK rules (`createStrictPageSchema`),
 * the way BlockNote 0.57 judges `initialContent`: each block built with
 * `blockToNode`, the document assembled and `check()`ed. A document that
 * passes here opens in the editor and the reader; one that does not would
 * throw there and show nothing.
 *
 * The blocks are first normalized as every reader does
 * (`normalizeCodeBlockContent`), so a code block's stored runs and links are
 * not held against it: they are drawn as plain text anyway.
 *
 * Node only in practice (it builds an unmounted editor, no DOM needed):
 * exported from `@classmoji/page-schema/server`.
 */

/** One reason a document would not open. */
export interface PageContentProblem {
  /** The block at fault (null: none could be named, e.g. a block without id). */
  blockId: string | null;
  blockType: string | null;
  /** Plain-English reason, or ProseMirror's message when there is no better one. */
  problem: string;
  /** The offending run's (or block's) first characters, when it has text. */
  text?: string;
}

let strictEditor: ReturnType<typeof createStrictEditor> | undefined;

function createStrictEditor() {
  return BlockNoteEditor.create({ schema: createStrictPageSchema() });
}

function editor() {
  strictEditor ??= createStrictEditor();
  return strictEditor;
}

/** The ProseMirror schema `validatePageBlocks` builds against. */
export function strictPmSchema() {
  return editor().pmSchema;
}

const MARK_WORDS: Record<string, string> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underlined',
  strike: 'struck through',
  textColor: 'coloured',
  backgroundColor: 'highlighted',
};

/** A text node's marks, as `check()` judges them; null when they go together. */
function markProblem(node: PMNode): string | null {
  let copy: readonly Mark[] = [];
  for (const mark of node.marks) copy = mark.addToSet(copy);
  const same = copy.length === node.marks.length && copy.every((m, i) => m.eq(node.marks[i]));
  if (same) return null;
  const names = node.marks.map(m => m.type.name);
  if (names.includes('code')) {
    const parts: string[] = [];
    if (names.includes('link')) parts.push("inline code can't be inside a link");
    const words = CODE_EXCLUDED_STYLES.filter(s => names.includes(s)).map(s => MARK_WORDS[s]);
    if (words.length > 0) {
      const list =
        words.length === 1
          ? words[0]
          : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
      parts.push(`inline code can't also be ${list}`);
    }
    if (parts.length > 0) return parts.join('; ');
  }
  return `these text styles can't go together: ${names.join(', ')}`;
}

/** BlockNote's build errors, in plain words where we know them. */
function buildProblem(error: unknown, block: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const style = /^style (.+) not found in styleSchema$/.exec(message);
  if (style) return `unknown text style '${style[1]}'`;
  const type = /^node type (.+) not found in schema$/.exec(message);
  if (type) return `unknown block type '${type[1]}'`;
  const blockType = (block as { type?: unknown } | null)?.type;
  if (typeof blockType === 'string' && !strictPmSchema().nodes[blockType]) {
    return `unknown block type '${blockType}'`;
  }
  return message;
}

type Report = (block: unknown, problem: string, text: unknown) => void;

/**
 * Inline content with what BlockNote cannot build at all taken out, each
 * removal reported: an unknown text style key (the run keeps its other
 * styles), styles that are not an object, an inline item of an unknown type.
 * Building the rest still finds every other problem in the block (a style
 * key BlockNote does not know throws before any mark is checked).
 */
function stripInline(
  content: unknown[],
  block: unknown,
  known: { styles: ReadonlySet<string>; inline: ReadonlySet<string> },
  report: Report
): unknown[] {
  let out: unknown[] | undefined;
  content.forEach((item, i) => {
    let next: unknown = item;
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const node = item as { type?: unknown; text?: unknown; styles?: unknown; content?: unknown };
      if (node.type === 'text') {
        const styles = node.styles;
        if (styles != null && (typeof styles !== 'object' || Array.isArray(styles))) {
          report(block, 'text styles must be an object of style names', node.text);
          next = { ...node, styles: {} };
        } else if (styles) {
          const unknown = Object.keys(styles).filter(key => !known.styles.has(key));
          if (unknown.length > 0) {
            for (const key of unknown) report(block, `unknown text style '${key}'`, node.text);
            const kept = { ...(styles as Record<string, unknown>) };
            for (const key of unknown) delete kept[key];
            next = { ...node, styles: kept };
          }
        }
      } else if (node.type === 'link') {
        if (Array.isArray(node.content)) {
          const inner = stripInline(node.content, block, known, report);
          if (inner !== node.content) next = { ...node, content: inner };
        }
      } else if (typeof node.type === 'string' && !known.inline.has(node.type)) {
        report(block, `unknown inline content type '${node.type}'`, '');
        next = undefined;
      }
    }
    if (next !== item) {
      out ??= content.slice(0, i);
    }
    if (out && next !== undefined) out.push(next);
  });
  return out ?? content;
}

/** `stripInline` over a block's content (inline or a table's cells) and its children. */
function stripBlocks(
  blocks: unknown[],
  known: { styles: ReadonlySet<string>; inline: ReadonlySet<string> },
  report: Report
): unknown[] {
  let out: unknown[] | undefined;
  blocks.forEach((block, i) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return;
    const b = block as { content?: unknown; children?: unknown };
    let next: Record<string, unknown> | undefined;
    if (Array.isArray(b.content)) {
      const content = stripInline(b.content, block, known, report);
      if (content !== b.content) next = { ...(block as object), content };
    } else if (
      b.content &&
      typeof b.content === 'object' &&
      (b.content as { type?: unknown }).type === 'tableContent'
    ) {
      const table = b.content as { rows?: unknown };
      if (Array.isArray(table.rows)) {
        let changed = false;
        const rows = table.rows.map(row => {
          const cells = (row as { cells?: unknown } | null)?.cells;
          if (!Array.isArray(cells)) return row;
          const nextCells = cells.map(cell => {
            if (Array.isArray(cell)) return stripInline(cell, block, known, report);
            const inner = (cell as { content?: unknown } | null)?.content;
            if (cell && typeof cell === 'object' && Array.isArray(inner)) {
              const stripped = stripInline(inner, block, known, report);
              return stripped === inner ? cell : { ...cell, content: stripped };
            }
            return cell;
          });
          if (nextCells.every((cell, c) => cell === cells[c])) return row;
          changed = true;
          return { ...(row as object), cells: nextCells };
        });
        if (changed) next = { ...(block as object), content: { ...table, rows } };
      }
    }
    if (Array.isArray(b.children)) {
      const children = stripBlocks(b.children, known, report);
      if (children !== b.children) next = { ...(next ?? (block as object)), children };
    }
    if (next) {
      out ??= blocks.slice();
      out[i] = next;
    }
  });
  return out ?? blocks;
}

function idOf(block: unknown): string | null {
  const id = (block as { id?: unknown } | null)?.id;
  return typeof id === 'string' ? id : null;
}

function typeOf(block: unknown): string | null {
  const type = (block as { type?: unknown } | null)?.type;
  return typeof type === 'string' ? type : null;
}

function blockText(node: PMNode): string {
  let text = '';
  node.descendants(child => {
    if (text.length > 60) return false;
    if (child.isText) text += child.text ?? '';
    // A nested block's text is not this block's.
    return child.type.name !== 'blockGroup';
  });
  return runSnippet(text);
}

/**
 * The problems of a block that does not build, judged part by part so one
 * bad descendant hides nothing else: the block's own content (built without
 * its children), then each child, recursively. A block whose parts all build
 * is reported with BlockNote's own error (its children do not fit it).
 */
function unbuiltProblems(
  block: unknown,
  error: unknown,
  build: (b: unknown) => PMNode,
  sourceIds: ReadonlySet<string>,
  types: ReadonlyMap<string, string>
): PageContentProblem[] {
  const self = (cause: unknown): PageContentProblem => ({
    blockId: idOf(block),
    blockType: typeOf(block),
    problem: buildProblem(cause, block),
  });
  const problems: PageContentProblem[] = [];
  const children = (block as { children?: unknown } | null)?.children;
  if (Array.isArray(children) && children.length > 0) {
    try {
      problems.push(
        ...builtProblems(build({ ...(block as object), children: [] }), sourceIds, types)
      );
    } catch (ownError) {
      problems.push(self(ownError));
    }
    for (const child of children) {
      try {
        problems.push(...builtProblems(build(child), sourceIds, types));
      } catch (childError) {
        problems.push(...unbuiltProblems(child, childError, build, sourceIds, types));
      }
    }
  }
  return problems.length > 0 ? problems : [self(error)];
}

/** Whether a node is one of BlockNote's blocks (it carries the block id). */
function isBlockNode(node: PMNode): boolean {
  return node.type.name === 'blockContainer' || node.type.isInGroup('bnBlock');
}

/**
 * Every problem in a built block: bad mark sets per text run, then, if
 * `check()` still fails, the deepest node it fails on.
 */
function builtProblems(
  root: PMNode,
  sourceIds: ReadonlySet<string>,
  types: ReadonlyMap<string, string>
): PageContentProblem[] {
  const problems: PageContentProblem[] = [];
  const owner = (node: PMNode | null): { blockId: string | null; blockType: string | null } => {
    const id = node ? (node.attrs.id as unknown) : null;
    if (typeof id === 'string' && sourceIds.has(id)) {
      return { blockId: id, blockType: types.get(id) ?? null };
    }
    return {
      blockId: null,
      blockType: node ? (blockTypeOfNode(node) ?? null) : null,
    };
  };

  const walk = (node: PMNode, block: PMNode | null) => {
    const here = isBlockNode(node) ? node : block;
    if (node.isText) {
      const problem = markProblem(node);
      if (problem) problems.push({ ...owner(here), problem, text: runSnippet(node.text) });
      return;
    }
    node.forEach(child => {
      if (child.isText && child.marks.length > 0 && !node.type.allowsMarks(child.marks)) {
        problems.push({
          ...owner(here),
          problem: `${node.type.name} can't hold formatted text (${child.marks
            .map(m => m.type.name)
            .join(', ')})`,
          text: runSnippet(child.text),
        });
      }
      walk(child, here);
    });
  };
  walk(root, null);

  try {
    root.check();
  } catch (error) {
    if (problems.length === 0) {
      const { node, block } = deepestFailure(root, null);
      problems.push({
        ...owner(block),
        problem: error instanceof Error ? deepestMessage(node, error) : String(error),
        ...(block ? { text: blockText(block) } : {}),
      });
    }
  }
  return problems;
}

/** The block type of a built block node (a blockContainer's content node). */
function blockTypeOfNode(node: PMNode): string | undefined {
  if (node.type.name === 'blockContainer') return node.firstChild?.type.name;
  return node.type.name;
}

function nodeFails(node: PMNode): unknown {
  try {
    node.check();
    return null;
  } catch (error) {
    return error;
  }
}

/** The deepest node whose `check()` throws, and the block it belongs to. */
function deepestFailure(
  node: PMNode,
  block: PMNode | null
): { node: PMNode; block: PMNode | null } {
  const here = isBlockNode(node) ? node : block;
  let found: { node: PMNode; block: PMNode | null } | null = null;
  node.forEach(child => {
    if (!found && !child.isText && nodeFails(child)) found = deepestFailure(child, here);
  });
  return found ?? { node, block: here };
}

function deepestMessage(node: PMNode, fallback: Error): string {
  const error = nodeFails(node);
  return error instanceof Error ? error.message : fallback.message;
}

function collectSource(blocks: unknown[], ids: Set<string>, types: Map<string, string>): void {
  for (const block of blocks) {
    const id = idOf(block);
    const type = typeOf(block);
    if (id) {
      ids.add(id);
      if (type) types.set(id, type);
    }
    const children = (block as { children?: unknown } | null)?.children;
    if (Array.isArray(children)) collectSource(children, ids, types);
  }
}

/**
 * The problems that would stop `blocks` from opening under BlockNote's stock
 * rules: `[]` when it opens. Every bad text run is reported (not only the
 * first), each with the id and type of the block holding it.
 */
export function validatePageBlocks(blocks: unknown): PageContentProblem[] {
  if (!Array.isArray(blocks)) {
    return [
      {
        blockId: null,
        blockType: null,
        problem: 'content must be an array of blocks',
      },
    ];
  }
  const { pmSchema, schema } = editor();
  const build = (block: unknown) => blockToNode(block as never, pmSchema, schema.styleSchema);

  const problems: PageContentProblem[] = [];
  const known = {
    styles: new Set(Object.keys(schema.styleSchema)),
    inline: new Set(Object.keys(schema.inlineContentSchema)),
  };
  // What cannot be built at all is reported here, run by run, and taken out,
  // so building the rest still finds everything else.
  const normalized = stripBlocks(
    normalizeCodeBlockContent(blocks) as unknown[],
    known,
    (block, problem, text) => {
      const snippet = runSnippet(text);
      problems.push({
        blockId: idOf(block),
        blockType: typeOf(block),
        problem,
        ...(snippet ? { text: snippet } : {}),
      });
    }
  );

  const sourceIds = new Set<string>();
  const types = new Map<string, string>();
  collectSource(normalized, sourceIds, types);

  const nodes: PMNode[] = [];
  for (const block of normalized) {
    let node: PMNode;
    try {
      node = build(block);
    } catch (error) {
      problems.push(...unbuiltProblems(block, error, build, sourceIds, types));
      continue;
    }
    nodes.push(node);
    problems.push(...builtProblems(node, sourceIds, types));
  }
  if (problems.length > 0 || nodes.length === 0) {
    // In document order (blocks as they appear; a block's own problems in
    // the order found).
    const order = new Map([...sourceIds].map((id, i) => [id, i]));
    const at = (p: PageContentProblem) =>
      p.blockId !== null ? (order.get(p.blockId) ?? order.size) : order.size;
    return problems
      .map((problem, i) => ({ problem, i }))
      .sort((a, b) => at(a.problem) - at(b.problem) || a.i - b.i)
      .map(({ problem }) => problem);
  }

  // The document as BlockNote assembles it: blocks in the root blockGroup.
  try {
    const doc = pmSchema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'blockGroup', content: nodes.map(node => node.toJSON()) }],
    });
    doc.check();
  } catch (error) {
    problems.push({
      blockId: null,
      blockType: null,
      problem: error instanceof Error ? error.message : String(error),
    });
  }
  return problems;
}
