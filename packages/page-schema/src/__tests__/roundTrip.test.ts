/**
 * Round-trip harness: page content -> Y.Doc -> page content.
 *
 * What the collab service and the git worker rely on is that the Yjs layer
 * adds nothing and loses nothing: a page seeded into a live document and
 * rendered back by the worker must produce the content.json today's editor
 * would save. So for every fixture:
 *
 *   1. the Yjs round trip (seed -> encode -> fresh doc -> render) is
 *      byte-identical, after `serializePageContent`, to the same blocks put
 *      through BlockNote alone (blocks -> ProseMirror -> blocks, no Yjs);
 *   2. it is idempotent (a second trip changes nothing);
 *   3. for documents BlockNote 0.55 itself wrote, it is byte-identical to the
 *      file as stored.
 *
 * Where (3) cannot hold — documents written by an older BlockNote, or
 * hand-written test fixtures that omit props — the difference is BlockNote's
 * normalisation, not Yjs, and is pinned below so a change shows up.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { ALL_BLOCKS } from '../../../services/src/content/extract/__tests__/fixtures/allBlocks.ts';
import { FRAGMENT, META_MAP, COVER_IMAGE_KEY } from '../constants.ts';
import { parsePageContent, serializePageContent, type PageContent } from '../content.ts';
import {
  blocksToYDoc,
  getServerEditor,
  pageContentToYDoc,
  yDocToBlocks,
  yDocToPageContent,
} from '../server.ts';

const SERVICES_FIXTURES = new URL(
  '../../../services/src/content/extract/__tests__/fixtures/',
  import.meta.url
);

function readFixture(url: URL): { text: string; content: PageContent } {
  const text = readFileSync(url, 'utf8');
  return { text, content: parsePageContent(text) };
}

/** Seed a doc, ship it as a binary update (as the DB stores it), render it. */
function yjsRoundTrip(content: PageContent): PageContent {
  const seeded = pageContentToYDoc(content);
  const stored = Y.encodeStateAsUpdate(seeded);
  const loaded = new Y.Doc();
  Y.applyUpdate(loaded, stored);
  return yDocToPageContent(loaded);
}

/** The same blocks through BlockNote alone (no Yjs): what the editor would save. */
function blockNoteNormalize(blocks: unknown[]): unknown[] {
  const editor = getServerEditor();
  return editor._prosemirrorNodeToBlocks(editor._blocksToProsemirrorNode(blocks as never));
}

type AnyBlock = { id?: string; type?: string; children?: AnyBlock[] };

function flatten(blocks: unknown[], out: AnyBlock[] = []): AnyBlock[] {
  for (const b of blocks as AnyBlock[]) {
    out.push(b);
    if (b.children) flatten(b.children, out);
  }
  return out;
}

/** The value as content.json would hold it (undefined dropped, key order kept). */
function asJson(content: PageContent): unknown {
  return JSON.parse(serializePageContent(content));
}

/** Top-level block ids whose serialized form differs between `a` and `b`. */
function differingBlocks(a: unknown[], b: unknown[]): string[] {
  const out: string[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as AnyBlock | undefined;
    const y = b[i] as AnyBlock | undefined;
    if (JSON.stringify(x) !== JSON.stringify(y))
      out.push(`${x?.type ?? y?.type}:${x?.id ?? y?.id}`);
  }
  return out;
}

const fixtures: Array<{ name: string; text?: string; content: PageContent }> = [
  {
    name: 'kitchen-sink.content.json',
    ...readFixture(new URL('./fixtures/kitchen-sink.content.json', import.meta.url)),
  },
  {
    name: 'sample-page-home.content.json',
    ...readFixture(new URL('sample-page-home.content.json', SERVICES_FIXTURES)),
  },
  {
    name: 'sample-page-prelab.content.json',
    ...readFixture(new URL('sample-page-prelab.content.json', SERVICES_FIXTURES)),
  },
  { name: 'allBlocks.ts (extractor fixture)', content: { blocks: ALL_BLOCKS } },
];

function findFixture(name: string) {
  const fixture = fixtures.find(f => f.name === name);
  if (!fixture) throw new Error(`no fixture ${name}`);
  return fixture;
}

describe('Yjs round trip adds and loses nothing', () => {
  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      const trip = yjsRoundTrip(fixture.content);

      it('matches BlockNote-only normalisation byte for byte', () => {
        const expected = serializePageContent({
          blocks: blockNoteNormalize(fixture.content.blocks),
          coverImage: fixture.content.coverImage,
        });
        expect(serializePageContent(trip)).toBe(expected);
      });

      it('is idempotent', () => {
        expect(serializePageContent(yjsRoundTrip(trip))).toBe(serializePageContent(trip));
      });

      it('keeps every block id, in order', () => {
        const before = flatten(fixture.content.blocks).map(b => b.id);
        const after = flatten(trip.blocks).map(b => b.id);
        expect(after).toEqual(before);
      });

      it('keeps the cover image', () => {
        expect(trip.coverImage ?? null).toEqual(fixture.content.coverImage ?? null);
      });
    });
  }
});

describe('documents BlockNote 0.55 wrote are byte-identical as stored', () => {
  for (const name of ['kitchen-sink.content.json', 'sample-page-prelab.content.json']) {
    it(name, () => {
      const fixture = findFixture(name);
      const stored = serializePageContent(parsePageContent(fixture.text ?? ''));
      expect(serializePageContent(yjsRoundTrip(fixture.content))).toBe(stored);
    });
  }
});

describe('older or hand-written documents: only BlockNote normalisation differs', () => {
  it('sample-page-home: same blocks, heading props in 0.55 key order', () => {
    const fixture = findFixture('sample-page-home.content.json');
    const trip = yjsRoundTrip(fixture.content);
    // Deep-equal as JSON, ignoring key order: nothing is lost or added...
    expect(asJson(trip)).toEqual(asJson(fixture.content));
    // ...the bytes differ only where 0.46 wrote heading props in another order.
    const changed = differingBlocks(fixture.content.blocks, trip.blocks);
    expect(changed.every(id => id.startsWith('heading:') || id.startsWith('columnList:'))).toBe(
      true
    );
  });

  it('allBlocks: hand-written props are filled with defaults, nothing dropped', () => {
    const fixture = findFixture('allBlocks.ts (extractor fixture)');
    const trip = yjsRoundTrip(fixture.content);
    const types = (bs: unknown[]) => flatten(bs).map(b => b.type);
    expect(types(trip.blocks)).toEqual(types(fixture.content.blocks));
  });
});

describe('page meta', () => {
  it('a page without a cover has no coverImage key and no meta entry', () => {
    const doc = pageContentToYDoc({ blocks: [] });
    expect(doc.getMap(META_MAP).has(COVER_IMAGE_KEY)).toBe(false);
    expect(Object.keys(yDocToPageContent(doc))).toEqual(['blocks']);
    expect(serializePageContent(yDocToPageContent(doc))).not.toContain('coverImage');
  });

  it('blocks live in the document-store fragment, not BlockNote’s default', () => {
    const doc = blocksToYDoc(fixtures[0].content.blocks);
    expect(doc.getXmlFragment(FRAGMENT).length).toBeGreaterThan(0);
    expect(doc.getXmlFragment('prosemirror').length).toBe(0);
  });

  it('reads convert a clone: the live document is not touched', () => {
    const doc = blocksToYDoc(fixtures[0].content.blocks);
    const before = Y.encodeStateVector(doc);
    yDocToBlocks(doc);
    expect(Y.encodeStateVector(doc)).toEqual(before);
  });
});

describe('serializePageContent', () => {
  it('writes exactly what savePageContent writes', () => {
    const blocks = [{ id: 'a', type: 'paragraph' }];
    expect(serializePageContent({ blocks })).toBe(JSON.stringify({ blocks }, null, 2));
    expect(serializePageContent({ blocks, coverImage: null })).toBe(
      JSON.stringify({ blocks }, null, 2)
    );
    const coverImage = { url: 'assets/c.jpg', position: 50 };
    expect(serializePageContent({ blocks, coverImage })).toBe(
      JSON.stringify({ blocks, coverImage }, null, 2)
    );
  });

  it('reads both stored shapes', () => {
    expect(parsePageContent('[{"id":"a"}]')).toEqual({ blocks: [{ id: 'a' }], coverImage: null });
    expect(parsePageContent('{"blocks":[]}')).toEqual({ blocks: [], coverImage: null });
  });
});
