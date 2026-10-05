/**
 * Code block content, made loadable by BlockNote 0.55.
 *
 * Up to 0.46 a code block held INLINE content, so saved pages can have links
 * and styled runs (bold, inline code, colours) inside code. 0.55 made it
 * `plain`: a link there throws `Invalid content for node codeBlock` wherever
 * BlockNote builds a document from the blocks (the editor, the in-app viewer,
 * the Yjs seed), styles are dropped without a word, and the HTML serializer
 * (class site) would ship the link inside the code. Every path that hands stored blocks to BlockNote runs them
 * through `normalizeCodeBlockContent` first, which turns such a code block's
 * content into one unstyled text run: the same characters (newlines
 * included), no marks, no links. What is written back later is that plain
 * form.
 *
 * Pure and DOM-free. A document with nothing to flatten is returned as the
 * SAME array (blocks untouched), so already-plain content stays byte-identical.
 */

type InlineNode = {
  type?: unknown;
  text?: unknown;
  styles?: unknown;
  content?: unknown;
};

type BlockLike = {
  type?: unknown;
  content?: unknown;
  children?: unknown;
};

/** A run BlockNote 0.55 accepts in a code block as is: unstyled text. */
function isPlainRun(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const { type, text, styles } = node as InlineNode;
  return (
    type === 'text' &&
    typeof text === 'string' &&
    (styles === undefined ||
      (typeof styles === 'object' && styles !== null && Object.keys(styles).length === 0))
  );
}

/** The characters of an inline node: a run's text, a link's runs, a string. */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!node || typeof node !== 'object') return '';
  const { text, content } = node as InlineNode;
  if (typeof text === 'string') return text;
  if (content !== undefined) return textOf(content);
  return '';
}

/** One code block's content as 0.55 takes it, or `undefined` when it already is. */
function flattenCodeContent(content: unknown): unknown[] | undefined {
  if (!Array.isArray(content)) return undefined;
  if (content.every(isPlainRun)) return undefined;
  const text = textOf(content);
  return text ? [{ type: 'text', text, styles: {} }] : [];
}

/**
 * `blocks` (anything; only an array is read) with every code block's content (at any depth: list children,
 * columns) reduced to plain text. Returns the same array when nothing
 * needed it; otherwise copies only the blocks on the path to a change.
 */
export function normalizeCodeBlockContent<T>(blocks: T): T {
  if (!Array.isArray(blocks)) return blocks;
  let out: unknown[] | undefined;
  blocks.forEach((block: unknown, i) => {
    const next = normalizeBlock(block);
    if (next !== block) {
      out ??= blocks.slice();
      out[i] = next;
    }
  });
  return (out ?? blocks) as T;
}

function normalizeBlock<T>(block: T): T {
  if (!block || typeof block !== 'object') return block;
  const b = block as BlockLike;
  let next: BlockLike | undefined;
  if (b.type === 'codeBlock') {
    const flat = flattenCodeContent(b.content);
    if (flat) next = { ...b, content: flat };
  }
  if (Array.isArray(b.children)) {
    const children = normalizeCodeBlockContent(b.children);
    if (children !== b.children) next = { ...(next ?? b), children };
  }
  return (next ?? block) as T;
}
