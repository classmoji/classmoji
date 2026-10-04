/**
 * Code blocks in any stored language, on the server: the page schema's
 * ServerBlockNoteEditor renders them (blocksToFullHTML runs each block's
 * render, which is where BlockNote 0.55 throws on an unlisted language), and
 * the Yjs round trip the collab server and git worker use keeps every
 * language string exactly as stored.
 */
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';

import { serializePageContent, type PageContent } from '../content.ts';
import { getServerEditor, pageContentToYDoc, yDocToPageContent } from '../server.ts';
import { CODE_LANGUAGES, codeBlocks } from './fixtures/codeBlockLanguages.ts';

describe('code blocks with any stored language on the server', () => {
  it('blocksToFullHTML renders them without throwing, stored language intact', async () => {
    const html = await getServerEditor().blocksToFullHTML(codeBlocks() as never);
    expect(html.match(/data-content-type="codeBlock"/g)).toHaveLength(CODE_LANGUAGES.length);
    expect(html).toContain('data-language="bash"');
    expect(html).toContain('data-language="brainfuck"');
  });

  it('the Yjs round trip keeps every language string byte-identical', () => {
    const content: PageContent = { blocks: codeBlocks() };
    const seeded = pageContentToYDoc(content);
    const loaded = new Y.Doc();
    Y.applyUpdate(loaded, Y.encodeStateAsUpdate(seeded));
    const back = yDocToPageContent(loaded);
    expect(
      (back.blocks as Array<{ props: { language: string } }>).map(b => b.props.language)
    ).toEqual(CODE_LANGUAGES.map(([stored]) => stored));
    expect(serializePageContent(back)).toBe(serializePageContent(content));
  });
});
