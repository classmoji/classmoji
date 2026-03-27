import { ServerBlockNoteEditor } from '@blocknote/server-util';
import type { BlockLike } from '~/types/pages.ts';
import type { PageBlockEditor, PageBlockInsertions } from '~/components/editor/blocks/index.tsx';

/**
 * Render BlockNote JSON blocks to HTML for read-only page views.
 *
 * Uses the same custom schema as the editor so custom blocks
 * (alert, terminal, etc.) render correctly.
 *
 * @param {Array} blocks - BlockNote document blocks
 * @param {Object} schema - BlockNote schema with custom blocks
 * @returns {Promise<string>} Full HTML string
 */
type PageBlockSchema = PageBlockEditor['schema'];

export async function renderBlocksToHtml(
  blocks: BlockLike[],
  schema: PageBlockSchema
): Promise<string> {
  const editor = ServerBlockNoteEditor.create({ schema });
  const html = await editor.blocksToFullHTML(blocks as unknown as PageBlockInsertions);
  return html;
}
