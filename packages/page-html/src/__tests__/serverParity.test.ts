/**
 * The jsdom-free Y.Doc conversions (`@classmoji/page-schema/server`: a plain
 * BlockNoteEditor and `@blocknote/core/yjs`) give exactly what the path they
 * replaced gave: BlockNote's `ServerBlockNoteEditor` (from `../index.ts`) running the same
 * conversions, written here the way `server.ts` was before the split (same
 * FRAGMENT, `normalizeCodeBlockContent` before seeding, reads from a clone,
 * the cover in the meta map).
 *
 * `roundTrip.test.ts` compares the Yjs path with itself; this one compares
 * two editors, so a divergence between them fails here. Every fixture
 * document the package reads is covered, plus a legacy page as the HTML
 * converter writes it. Blocks without an id get a fixed one first: BlockNote
 * mints a random id for an id-less block, which would differ between any two
 * conversions.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  COVER_IMAGE_KEY,
  FRAGMENT,
  META_MAP,
  normalizeCodeBlockContent,
  parsePageContent,
  type PageContent,
  type PageCoverImage,
} from '@classmoji/page-schema';
import {
  blocksToYDoc,
  createPageEditor,
  pageContentToYDoc,
  yDocToBlocks,
  yDocToPageContent,
} from '@classmoji/page-schema/server';

import { ALL_BLOCKS } from '../../../services/src/content/extract/__tests__/fixtures/allBlocks.ts';
import {
  codeBlocks,
  richCodeBlocks,
} from '../../../page-schema/src/__tests__/fixtures/codeBlockLanguages.ts';
import { createServerEditor, htmlToPageBlocks, type PageServerEditor } from '../index.ts';

/* The pre-split `server.ts`, on BlockNote's server editor. */

function oldCloneDoc(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

function oldBlocksToYDoc(blocks: unknown[], editor: PageServerEditor): Y.Doc {
  return editor.blocksToYDoc(normalizeCodeBlockContent(blocks) as never, FRAGMENT);
}

function oldYDocToBlocks(doc: Y.Doc, editor: PageServerEditor): unknown[] {
  return editor.yDocToBlocks(oldCloneDoc(doc), FRAGMENT);
}

function oldPageContentToYDoc(content: PageContent, editor: PageServerEditor): Y.Doc {
  const doc = oldBlocksToYDoc(content.blocks, editor);
  if (content.coverImage != null) doc.getMap(META_MAP).set(COVER_IMAGE_KEY, content.coverImage);
  return doc;
}

function oldYDocToPageContent(doc: Y.Doc, editor: PageServerEditor): PageContent {
  const copy = oldCloneDoc(doc);
  const blocks: unknown[] = editor.yDocToBlocks(copy, FRAGMENT);
  const cover = copy.getMap(META_MAP).get(COVER_IMAGE_KEY) as PageCoverImage | undefined;
  return cover == null ? { blocks } : { blocks, coverImage: cover };
}

/* Fixtures */

const SERVICES_FIXTURES = new URL(
  '../../../services/src/content/extract/__tests__/fixtures/',
  import.meta.url
);

const read = (url: URL) => readFileSync(url, 'utf8');

type AnyBlock = { id?: string; children?: AnyBlock[] };

/** A fixed id on every block that has none (`fx-<path>`), at every depth. */
function withIds(blocks: unknown[], path = 'fx'): unknown[] {
  return (blocks as AnyBlock[]).map((block, i) => {
    const at = `${path}-${i}`;
    return {
      ...block,
      id: block.id || at,
      ...(Array.isArray(block.children) ? { children: withIds(block.children, at) } : {}),
    };
  });
}

function flatten(blocks: unknown[], out: AnyBlock[] = []): AnyBlock[] {
  for (const block of blocks as AnyBlock[]) {
    out.push(block);
    if (Array.isArray(block.children)) flatten(block.children, out);
  }
  return out;
}

const COVER: PageCoverImage = { url: 'assets/cover.jpg', position: 30 };

async function fixtures(): Promise<Array<{ name: string; content: PageContent }>> {
  const legacy = await htmlToPageBlocks(
    read(new URL('sample-page-legacy.index.html', SERVICES_FIXTURES)),
    {
      title: 'Sample Page',
    }
  );
  const list: Array<{ name: string; content: PageContent }> = [
    {
      name: 'kitchen-sink.content.json',
      content: parsePageContent(
        read(
          new URL(
            '../../../page-schema/src/__tests__/fixtures/kitchen-sink.content.json',
            import.meta.url
          )
        )
      ),
    },
    {
      name: 'sample-page-home.content.json',
      content: parsePageContent(read(new URL('sample-page-home.content.json', SERVICES_FIXTURES))),
    },
    {
      name: 'sample-page-prelab.content.json',
      content: parsePageContent(
        read(new URL('sample-page-prelab.content.json', SERVICES_FIXTURES))
      ),
    },
    { name: 'allBlocks.ts (extractor fixture)', content: { blocks: ALL_BLOCKS } },
    { name: 'codeBlocks() (every stored language)', content: { blocks: codeBlocks() } },
    { name: 'richCodeBlocks() (0.46 inline code)', content: { blocks: richCodeBlocks() } },
    {
      name: 'sample-page-legacy.index.html (converted)',
      content: { blocks: legacy, coverImage: COVER },
    },
  ];
  return list.map(({ name, content }) => ({
    name,
    content: { ...content, blocks: withIds(content.blocks) },
  }));
}

const FIXTURES = await fixtures();

/** Encode `doc` as the DB stores it and load it into a new doc. */
function shipped(doc: Y.Doc): Y.Doc {
  const loaded = new Y.Doc();
  Y.applyUpdate(loaded, Y.encodeStateAsUpdate(doc));
  return loaded;
}

describe('plain editor (/server) vs ServerBlockNoteEditor (/html): same conversions', () => {
  // Fresh editors on both sides, plus the shared default the consumers get.
  const server = createServerEditor();
  const plain = createPageEditor();

  it('covers every fixture with ids on every block', () => {
    for (const { content } of FIXTURES) {
      expect(flatten(content.blocks).every(block => typeof block.id === 'string')).toBe(true);
    }
    // The kitchen sink holds every block type of the schema.
    const kitchen = FIXTURES[0].content.blocks as Array<{ type?: string }>;
    const types = new Set(flatten(kitchen).map(block => (block as { type?: string }).type));
    expect([...types].sort()).toEqual(Object.keys(plain.schema.blockSpecs).sort());
  });

  for (const { name, content } of FIXTURES) {
    describe(name, () => {
      const expected = oldYDocToBlocks(oldBlocksToYDoc(content.blocks, server), server);

      it('blocks -> Y.Doc -> blocks', () => {
        expect(yDocToBlocks(blocksToYDoc(content.blocks, plain), plain)).toStrictEqual(expected);
        expect(yDocToBlocks(blocksToYDoc(content.blocks))).toStrictEqual(expected);
      });

      it('a doc one side seeded reads the same on the other', () => {
        expect(yDocToBlocks(oldBlocksToYDoc(content.blocks, server))).toStrictEqual(expected);
        expect(oldYDocToBlocks(blocksToYDoc(content.blocks), server)).toStrictEqual(expected);
      });

      it('page content -> Y.Doc -> encoded update -> new Y.Doc -> page content', () => {
        const before = oldYDocToPageContent(shipped(oldPageContentToYDoc(content, server)), server);
        const after = yDocToPageContent(shipped(pageContentToYDoc(content)));
        expect(after).toStrictEqual(before);
        expect(after.coverImage ?? null).toStrictEqual(content.coverImage ?? null);
        // And across: the old side's stored update, read by the new side.
        expect(yDocToPageContent(shipped(oldPageContentToYDoc(content, server)))).toStrictEqual(
          before
        );
      });
    });
  }
});

describe('a Y.Doc holding what the schema rejects reads the same on both editors', () => {
  const server = createServerEditor();

  /** Kitchen sink seeded, then: unknown block, unknown prop, unknown mark, heading level 9. */
  function hostileDoc(): Y.Doc {
    const doc = blocksToYDoc(FIXTURES[0].content.blocks);
    const group = doc.getXmlFragment(FRAGMENT).get(0) as Y.XmlElement;
    doc.transact(() => {
      // An unknown block type in a container of its own.
      const unknown = new Y.XmlElement('blockContainer');
      unknown.setAttribute('id', 'hostile-unknown');
      const mystery = new Y.XmlElement('mysteryBlock');
      mystery.setAttribute('flavour', 'odd');
      const mysteryText = new Y.XmlText();
      mysteryText.insert(0, 'from a newer schema');
      mystery.insert(0, [mysteryText]);
      unknown.insert(0, [mystery]);

      // A paragraph with an unknown prop and text under an unknown mark.
      const para = new Y.XmlElement('blockContainer');
      para.setAttribute('id', 'hostile-para');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.setAttribute('sparkle', 'yes');
      const text = new Y.XmlText();
      text.insert(0, 'plain ');
      text.insert(6, 'glittery', { glitter: { level: 3 } });
      paragraph.insert(0, [text]);
      para.insert(0, [paragraph]);

      // A heading at a level the schema does not have.
      const head = new Y.XmlElement('blockContainer');
      head.setAttribute('id', 'hostile-heading');
      const heading = new Y.XmlElement('heading');
      heading.setAttribute('level', 9 as never);
      const headingText = new Y.XmlText();
      headingText.insert(0, 'Level nine');
      heading.insert(0, [headingText]);
      head.insert(0, [heading]);

      group.insert(1, [unknown, para, head]);
    });
    return doc;
  }

  /** The value, or the error message when the conversion throws. */
  function outcome(read: () => unknown): unknown {
    try {
      return { ok: read() };
    } catch (err) {
      return { threw: err instanceof Error ? err.message : String(err) };
    }
  }

  it('the new yDocToBlocks and the server editor’s give identical output', () => {
    const doc = hostileDoc();
    const before = Y.encodeStateAsUpdate(doc);
    const fresh = outcome(() => yDocToBlocks(oldCloneDoc(doc)));
    const old = outcome(() => oldYDocToBlocks(oldCloneDoc(doc), server));
    expect(fresh).toStrictEqual(old);
    // Something was really rejected: the unknown block is gone, and so is the
    // text under the unknown mark (BlockNote 0.55 drops the whole text node).
    expect(fresh).toHaveProperty('ok');
    expect(JSON.stringify(fresh)).not.toContain('hostile-unknown');
    expect(JSON.stringify(fresh)).not.toContain('glittery');
    // Both read clones: the hostile doc itself is untouched.
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
  });
});
