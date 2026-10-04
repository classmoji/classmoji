/**
 * Every schema the pages app renders with draws a code block in whatever
 * language the page was saved with.
 *
 * BlockNote 0.55's code block render throws `Language <x> is not supported.`
 * for any language that is not a key of its supported list, and saved pages
 * hold aliases (`bash`, `js`, `py`, `yml`), unlisted languages and `''`. The
 * shared code block (@classmoji/page-schema `createPageCodeBlockSpec`) shows
 * those in the select as their canonical entry or Plain Text. This renders
 * each app schema through `blocksToFullHTML`, which runs every block's
 * render the way the editor and the in-app viewer mount it, plus the class
 * site's own renderer.
 */
import { test, expect } from '@playwright/test';
import { ServerBlockNoteEditor } from '@blocknote/server-util';

import { schema as appSchema } from '~/components/editor/blocks/index.tsx';
import { editingSchema } from '~/components/editor/blocks/editingSchema.ts';
import { viewerSchema } from '~/components/viewer/viewerBlocks.tsx';
import { renderSitePage } from '~/site/render.server.ts';

const LANGUAGES = ['bash', 'sh', 'shell', 'js', 'jsx', 'ts', 'py', 'yml', 'brainfuck', ''];

const blocks = LANGUAGES.map((language, i) => ({
  id: `code-${i}`,
  type: 'codeBlock',
  props: { language },
  content: [{ type: 'text', text: `echo ${i}`, styles: {} }],
  children: [],
}));

const schemas: Array<[string, unknown]> = [
  ['shared editor schema (blocks/index.tsx)', appSchema],
  ['editing schema (editingSchema.ts)', editingSchema],
  ['in-app viewer schema (viewerBlocks.tsx)', viewerSchema],
];

test.describe('code blocks in any stored language', () => {
  for (const [name, schema] of schemas) {
    test(`${name} renders them`, async () => {
      const editor = ServerBlockNoteEditor.create({ schema: schema as never });
      const html = await editor.blocksToFullHTML(blocks as never);
      expect(html.match(/data-content-type="codeBlock"/g)).toHaveLength(LANGUAGES.length);
      // The stored value is what the block carries; only the select maps it.
      expect(html).toContain('data-language="bash"');
      expect(html).toContain('data-language="brainfuck"');
    });
  }

  test('the class site renders them with the stored language', async () => {
    const { html } = await renderSitePage({ blocks, resolveLink: () => null });
    for (const language of LANGUAGES.filter(Boolean)) {
      expect(html).toContain(`data-language="${language}"`);
    }
  });
});
