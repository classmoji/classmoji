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
import { normalizeCodeBlockContent } from '../codeContent.ts';
import {
  blocksToYDoc,
  getServerEditor,
  pageContentToYDoc,
  yDocToBlocks,
  yDocToPageContent,
} from '../server.ts';
import {
  CODE_LANGUAGES,
  RICH_CODE_TEXT,
  codeBlocks,
  richCodeBlocks,
} from './fixtures/codeBlockLanguages.ts';

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

describe('code blocks saved with links or styles, on the server', () => {
  type B = { id: string; content?: unknown; children?: B[] };
  const find = (blocks: B[], id: string): B | undefined =>
    blocks.find(b => b.id === id) ?? blocks.map(b => find(b.children ?? [], id)).find(Boolean);

  it('server HTML renders them once normalized', async () => {
    const html = await getServerEditor().blocksToFullHTML(
      normalizeCodeBlockContent(richCodeBlocks()) as never
    );
    expect(html.match(/data-content-type="codeBlock"/g)).toHaveLength(3);
    expect(html).not.toContain('href="https://example.com"');
    expect(html).toContain('curl https://example.com\necho done');
  });

  it('the Yjs seed takes them as stored and reads back plain text', () => {
    const doc = pageContentToYDoc({ blocks: richCodeBlocks() });
    const back = yDocToBlocks(doc) as B[];
    for (const [id, text] of Object.entries(RICH_CODE_TEXT)) {
      expect(find(back, id)?.content, id).toEqual([{ type: 'text', text, styles: {} }]);
    }
    // Normalizing the output again changes nothing.
    expect(normalizeCodeBlockContent(back)).toBe(back);
    expect(() => blocksToYDoc(richCodeBlocks()).destroy()).not.toThrow();
  });
});
