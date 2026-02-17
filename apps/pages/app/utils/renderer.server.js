import { ServerBlockNoteEditor } from '@blocknote/server-util';

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
export async function renderBlocksToHtml(blocks, schema) {
  const editor = ServerBlockNoteEditor.create({ schema });
  const html = await editor.blocksToFullHTML(blocks);
  return html;
}
