import {
  parseNavGridEntries,
  serializeNavGridEntries,
  type NavGridEntry,
} from '~/components/editor/blocks/navGridShared.ts';
import type { PageLinkResolver } from './viewerSchema.server.ts';

/**
 * Strip references to pages this viewer may not see, BEFORE serialization.
 *
 * A static render override is not enough on its own. BlockNote's internal HTML
 * serializer writes every block prop onto the block wrapper as a `data-*`
 * attribute, whatever the block's own render returns — so a `pageLink` block
 * whose render deliberately emitted nothing still ships
 * `data-page-title="Exam 2 Solutions"` in the anonymous HTML, and a `navGrid`
 * ships its entire authored `entries` JSON including the hidden titles. That
 * is precisely the leak the visibility rule exists to prevent, and it is
 * invisible on screen: you only find it in view-source.
 *
 * So visibility is enforced twice, on purpose: once here (the document the
 * serializer sees never mentions a hidden page) and once in the render
 * overrides (which resolve hrefs and would drop an entry anyway). Two layers
 * because they fail differently — this one is a data transform that a new
 * block type could forget to opt into, and that one is a rendering rule that
 * a serializer change could route around.
 */

/** A BlockNote block, loosely typed — this walks arbitrary stored documents. */
type LooseBlock = {
  type?: unknown;
  props?: Record<string, unknown>;
  children?: unknown;
  [key: string]: unknown;
};

/** What a redacted-away block becomes: an empty paragraph, which renders as nothing. */
const emptyParagraph = (): LooseBlock => ({ type: 'paragraph', content: [] });

/**
 * BlockNote's file-family blocks, which this app does NOT override in the
 * viewer schema.
 *
 * Their populated state is fine on a static site (an `<img>`, a download link).
 * Their EMPTY state is not: `FileBlockWrapper` branches on `props.url === ''`
 * and renders the editor's "Add image" / "Add file" button — a clickable
 * affordance, on a page with no JavaScript, offering a visitor an upload the
 * site cannot and must not perform. An unset block is easy to leave behind (add
 * an image, never pick one, publish), so this is the common case, not an
 * exotic one.
 *
 * Redacting rather than adding two more schema overrides keeps the fix in the
 * layer that already owns "this block must not reach the serializer".
 */
const FILE_BLOCK_TYPES = new Set(['image', 'file']);

function redactBlock(block: LooseBlock, resolveLink: PageLinkResolver): LooseBlock {
  const children = Array.isArray(block.children)
    ? (block.children as LooseBlock[]).map(child => redactBlock(child, resolveLink))
    : block.children;

  if (typeof block.type === 'string' && FILE_BLOCK_TYPES.has(block.type)) {
    // Exactly the condition BlockNote's own wrapper branches on.
    if (String(block.props?.url ?? '') === '') return emptyParagraph();
    return children === block.children ? block : { ...block, children };
  }

  if (block.type === 'pageLink') {
    const pageId = String(block.props?.pageId ?? '');
    if (!pageId || !resolveLink(pageId)) {
      // Drop the whole block: its props are the leak, not its markup.
      return emptyParagraph();
    }
    return children === block.children ? block : { ...block, children };
  }

  if (block.type === 'navGrid') {
    const entries = parseNavGridEntries(block.props?.entries);
    const visible: NavGridEntry[] = entries.filter(
      entry => entry.kind !== 'page' || resolveLink(entry.pageId) !== null
    );

    if (visible.length === entries.length) {
      return children === block.children ? block : { ...block, children };
    }

    return {
      ...block,
      props: { ...block.props, entries: serializeNavGridEntries(visible) },
      children,
    };
  }

  return children === block.children ? block : { ...block, children };
}

/**
 * Redact a whole document for one viewer.
 *
 * Recurses through `children` so a page link nested inside a column, a list
 * item or a toggle is covered — the leak does not care how deep the block is.
 */
export function redactDocumentForViewer(blocks: unknown, resolveLink: PageLinkResolver): unknown[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.map(block =>
    block && typeof block === 'object' ? redactBlock(block as LooseBlock, resolveLink) : block
  );
}
