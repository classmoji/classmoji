/**
 * Legacy page HTML -> page blocks (`htmlToPageBlocks`), on synthetic pages
 * shaped like the old MarkdownEditor's output. Every rule the converter
 * applies has a case here, and every output must be a document the page
 * schema loads as is: it survives the Yjs seed the collab server does
 * unchanged, renders on the server, has a unique uuid on every block and
 * holds a `columnList` only with two or more columns.
 */
import * as Y from 'yjs';
import { describe, expect, it, vi } from 'vitest';

import {
  blocksToYDoc,
  getServerEditor,
  htmlToPageBlocks,
  yDocToBlocks,
  type PageBlock,
} from '../server.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PAGE_A = '11111111-1111-4111-8111-111111111111';
const PAGE_B = '22222222-2222-4222-8222-222222222222';

/** A full legacy document: optional stylesheet, the title <h1>, the body. */
function doc(body: string, { title = 'Sample Page', css = '' } = {}): string {
  return (
    `<!DOCTYPE html><html><head><title>${title}</title>` +
    (css ? `<style>${css}</style>` : '') +
    `</head><body><h1>${title}</h1>${body}</body></html>`
  );
}

function walk(blocks: PageBlock[], out: PageBlock[] = []): PageBlock[] {
  for (const block of blocks) {
    out.push(block);
    if (block.children?.length) walk(block.children, out);
  }
  return out;
}

function text(block: PageBlock | undefined): string {
  const inline = (items: unknown): string =>
    Array.isArray(items)
      ? items
          .map((item: { type?: string; text?: string; content?: unknown }) =>
            item.type === 'text' ? (item.text ?? '') : inline(item.content)
          )
          .join('')
      : '';
  return inline(block?.content);
}

/** Top-level blocks without the empty spacer paragraphs. */
function solid(blocks: PageBlock[]): PageBlock[] {
  return blocks.filter(b => !(b.type === 'paragraph' && !text(b) && !b.children?.length));
}

function ofType(blocks: PageBlock[], type: string): PageBlock[] {
  return walk(blocks).filter(b => b.type === type);
}

/** Seed a Y.Doc from the blocks, ship it as an update, read it back. */
function yjsRoundTrip(blocks: PageBlock[]): unknown[] {
  const seeded = blocksToYDoc(blocks);
  const loaded = new Y.Doc();
  Y.applyUpdate(loaded, Y.encodeStateAsUpdate(seeded));
  return yDocToBlocks(loaded);
}

const LINK = (slug: string, id: string) => `/${slug}/pages/${id}`;

const KITCHEN_SINK = doc(
  [
    '<p class="subtitle">A subtitle</p>',
    '<h2>Overview</h2>',
    '<p>Plain <b>bold</b> and <a href="https://example.com">a link</a>.</p>',
    '<div class="callout"><span class="callout-emoji">🔥</span><span>Hot tip</span></div>',
    '<div class="alert alert-warning" data-type="warning"><span>Careful</span></div>',
    '<ul><li>first<div class="callout"><span class="callout-emoji">🧪</span><span>Nested</span></div></li><li>second</li></ul>',
    '<div class="checklist-item"><input type="checkbox" checked><span>Done thing</span></div>',
    '<div class="file-tree"><pre>src/\n  index.js\n</pre></div>',
    '<details><summary>Show more</summary><div><p>Hidden text</p>',
    '<div class="columns"><div class="column"><p>In toggle L</p></div><div class="column"><p>In toggle R</p></div></div>',
    '</div></details>',
    '<div class="columns"><div class="column"><p>Left</p></div><div class="column"><p>Right</p></div></div>',
    `<div class="page-link-block"><a class="page-link" href="${LINK('sample', PAGE_A)}">Other page</a></div>`,
    `<p>See <a href="${LINK('sample', PAGE_A)}">this page</a>.</p>`,
    '<div class="terminal-block"><div class="terminal-header"><span class="terminal-title">Terminal</span></div><pre><code>npm install</code></pre></div>',
    '<figure class="image-block image-align-center"><img src="assets/one.png"></figure>',
    '<div class="video-embed"><iframe src="https://www.youtube.com/embed/abc"></iframe></div>',
    '<pre><code class="language-js">const a = <a href="https://example.com">1</a>;</code></pre>',
    '<table><tr><td>cell</td></tr></table>',
  ].join('')
);

const resolveAll = (slug: string, id: string) => `/${slug}/${id}`;

describe('htmlToPageBlocks: output the page schema loads', () => {
  it('survives the Yjs seed unchanged (ids included)', async () => {
    const blocks = await htmlToPageBlocks(KITCHEN_SINK, {
      title: 'Sample Page',
      resolvePageLink: resolveAll,
    });
    expect(yjsRoundTrip(blocks)).toEqual(blocks);
  });

  it('is what BlockNote itself holds for it (blocks -> ProseMirror -> blocks)', async () => {
    const blocks = await htmlToPageBlocks(KITCHEN_SINK, { resolvePageLink: resolveAll });
    const editor = getServerEditor();
    const node = editor._blocksToProsemirrorNode(blocks as never);
    expect(editor._prosemirrorNodeToBlocks(node)).toEqual(blocks);
  });

  it('renders on the server without throwing', async () => {
    // Toggle headings read window.localStorage when rendered, which a bare
    // JSDOM refuses (apps/pages shims it); everything else renders here.
    const withoutToggle = KITCHEN_SINK.replace(/<details>.*<\/details>/, '');
    const blocks = await htmlToPageBlocks(withoutToggle, { resolvePageLink: resolveAll });
    const html = await getServerEditor().blocksToFullHTML(blocks as never);
    expect(html).toContain('Hot tip');
    expect(html).toContain('data-node-type="columnList"');
  });

  it('gives every block, at every depth, a unique uuid', async () => {
    const all = walk(await htmlToPageBlocks(KITCHEN_SINK, { resolvePageLink: resolveAll }));
    const ids = all.map(b => b.id);
    expect(all.length).toBeGreaterThan(20);
    for (const id of ids) expect(id).toMatch(UUID);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives fresh ids on every run', async () => {
    const a = await htmlToPageBlocks('<p>one</p><p>two</p>');
    const b = await htmlToPageBlocks('<p>one</p><p>two</p>');
    expect(a.map(x => x.id)).not.toEqual(b.map(x => x.id));
  });

  it('leaks no placeholder, raw colour or legacy markup', async () => {
    const json = JSON.stringify(
      await htmlToPageBlocks(KITCHEN_SINK, { resolvePageLink: resolveAll })
    );
    for (const leak of ['LEGACY_EMBED', 'VIDEO_EMBED', 'IMAGE_EMBED', 'data-classmoji', 'rgb(']) {
      expect(json).not.toContain(leak);
    }
  });

  it('adds no trailing empty paragraph (BlockNote 0.55 never saves one)', async () => {
    const blocks = await htmlToPageBlocks('<p>Last line</p>');
    expect(blocks).toHaveLength(1);
    expect(text(blocks[0])).toBe('Last line');
  });
});

describe('htmlToPageBlocks: empty and unreadable input', () => {
  const EMPTY_PARAGRAPH = {
    type: 'paragraph',
    props: { backgroundColor: 'default', textColor: 'default', textAlignment: 'left' },
    content: [],
    children: [],
  };

  it.each([
    ['an empty string', ''],
    ['whitespace', '   \n  '],
    ['an empty body', '<html><body></body></html>'],
    ['a title only', doc('')],
    ['empty elements', '<div><span></span><p> </p></div><!-- a comment -->'],
    ['a style sheet only', '<style>p { color: red }</style>'],
  ])('%s is one empty paragraph', async (_label, html) => {
    const blocks = await htmlToPageBlocks(html, { title: 'Sample Page' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject(EMPTY_PARAGRAPH);
    expect(blocks[0].id).toMatch(UUID);
  });

  it('tag soup does not throw', async () => {
    const blocks = await htmlToPageBlocks('<<<div <p <details><summary>');
    expect(blocks.length).toBeGreaterThan(0);
    expect(JSON.stringify(blocks)).not.toContain('LEGACY_EMBED');
  });

  it('a non-string is one empty paragraph', async () => {
    const blocks = await htmlToPageBlocks(null as unknown as string);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('paragraph');
  });
});

describe('htmlToPageBlocks: the title <h1>', () => {
  it('drops the first <h1> when it is the title', async () => {
    const blocks = await htmlToPageBlocks(doc('<p>Body</p>'), { title: 'Sample Page' });
    expect(ofType(blocks, 'heading')).toHaveLength(0);
    expect(text(solid(blocks)[0])).toBe('Body');
  });

  it('compares titles ignoring case, spacing and entities', async () => {
    const html = '<html><body><h1>  Rock &amp;\n Roll </h1><p>Body</p></body></html>';
    const blocks = await htmlToPageBlocks(html, { title: 'rock & roll' });
    expect(ofType(blocks, 'heading')).toHaveLength(0);
  });

  it('keeps a first <h1> that is not the title', async () => {
    const html = '<html><body><h1>Getting started</h1><p>Body</p></body></html>';
    const blocks = await htmlToPageBlocks(html, { title: 'Sample Page' });
    const [heading] = ofType(blocks, 'heading');
    expect(heading?.props?.level).toBe(1);
    expect(text(heading)).toBe('Getting started');
  });

  it('without a title, drops a full document’s first <h1> (the old behaviour)', async () => {
    const html = '<html><body><h1>Anything</h1><h1>Second</h1></body></html>';
    const headings = ofType(await htmlToPageBlocks(html), 'heading');
    expect(headings.map(text)).toEqual(['Second']);
  });

  it('without a title, keeps the <h1> of a bare fragment', async () => {
    const headings = ofType(await htmlToPageBlocks('<h1>Fragment</h1>'), 'heading');
    expect(headings.map(text)).toEqual(['Fragment']);
  });

  it('drops the subtitle', async () => {
    const blocks = await htmlToPageBlocks(doc('<p class="subtitle">Sub</p><p>Body</p>'));
    expect(JSON.stringify(blocks)).not.toContain('Sub"');
    expect(solid(blocks).map(text)).toEqual(['Body']);
  });
});

describe('htmlToPageBlocks: the old widgets', () => {
  it('callout keeps its emoji and inline formatting', async () => {
    const blocks = await htmlToPageBlocks(
      '<div class="callout"><span class="callout-emoji">🔥</span><span>Hot <b>tip</b></span></div>'
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'callout',
      props: { emoji: '🔥' },
      content: [
        { type: 'text', text: 'Hot ', styles: {} },
        { type: 'text', text: 'tip', styles: { bold: true } },
      ],
    });
  });

  it('callout lines become hard breaks; loose text is kept', async () => {
    const [lines] = await htmlToPageBlocks(
      '<div class="callout"><span class="callout-emoji">📎</span><span>one</span><span>two</span></div>'
    );
    expect(text(lines)).toBe('one\ntwo');
    const [loose] = await htmlToPageBlocks(
      '<div class="callout"><span class="callout-emoji">📎</span>Loose <i>text</i></div>'
    );
    expect(text(loose)).toBe('Loose text');
    expect(loose.props?.emoji).toBe('📎');
  });

  it('callout without an emoji gets the default bulb', async () => {
    const [callout] = await htmlToPageBlocks('<div class="callout"><span>No emoji</span></div>');
    expect(callout).toMatchObject({ type: 'callout', props: { emoji: '💡' } });
  });

  it.each([
    ['info', '💡'],
    ['warning', '⚠️'],
    ['note', '📌'],
    ['error', '🚨'],
    ['success', '✅'],
  ])('%s alert -> %s callout', async (type, emoji) => {
    const [callout] = await htmlToPageBlocks(
      `<div class="alert alert-${type}" data-type="${type}"><span>Alert text</span></div>`
    );
    expect(callout).toMatchObject({ type: 'callout', props: { emoji } });
    expect(text(callout)).toBe('Alert text');
  });

  it('an alert typed by its class alone', async () => {
    const [callout] = await htmlToPageBlocks(
      '<div class="alert alert-note"><span>By class</span></div>'
    );
    expect(callout.props?.emoji).toBe('📌');
  });

  it('a callout inside a list item stays with the list, no marker left', async () => {
    const blocks = await htmlToPageBlocks(
      '<ul><li>item<div class="callout"><span class="callout-emoji">🧪</span><span>In li</span></div></li></ul>'
    );
    const json = JSON.stringify(blocks);
    expect(json).not.toContain('LEGACY_EMBED');
    expect(ofType(blocks, 'bulletListItem').map(text)).toEqual(['item']);
    const [callout] = ofType(blocks, 'callout');
    expect(text(callout)).toBe('In li');
  });

  it('check list items, ticked and not', async () => {
    const blocks = await htmlToPageBlocks(
      '<div class="checklist-item"><input type="checkbox" checked><span>Done</span></div>' +
        '<div class="checklist-item"><input type="checkbox"><span>To do</span></div>'
    );
    expect(blocks.map(b => [b.type, b.props?.checked, text(b)])).toEqual([
      ['checkListItem', true, 'Done'],
      ['checkListItem', false, 'To do'],
    ]);
  });

  it('file tree -> plain-text code block', async () => {
    const [tree] = await htmlToPageBlocks(
      '<div class="file-tree" data-title="Layout"><pre>app/\n  main.ts\n\n</pre></div>'
    );
    expect(tree).toMatchObject({ type: 'codeBlock', props: { language: 'text' } });
    expect(text(tree)).toBe('app/\n  main.ts');
  });

  it('<details> -> a toggle H3 with its body as children (not a toggle list item)', async () => {
    const blocks = await htmlToPageBlocks(
      '<details><summary>More <b>info</b></summary><div><p>Hidden</p><ul><li>a</li></ul></div></details>'
    );
    expect(ofType(blocks, 'toggleListItem')).toHaveLength(0);
    const [toggle] = solid(blocks);
    expect(toggle).toMatchObject({ type: 'heading', props: { level: 3, isToggleable: true } });
    expect(text(toggle)).toBe('More info');
    expect(toggle.children?.map(b => [b.type, text(b)])).toEqual([
      ['paragraph', 'Hidden'],
      ['bulletListItem', 'a'],
    ]);
  });

  it('columns -> columnList with one column per filled column', async () => {
    const blocks = await htmlToPageBlocks(
      '<div class="columns"><div class="column"><p>Left</p></div>' +
        '<div class="column"><p>Middle</p></div><div class="column"><p> </p></div></div>'
    );
    expect(blocks).toHaveLength(1);
    const [row] = blocks;
    expect(row.type).toBe('columnList');
    expect(row.children?.map(c => [c.type, c.props?.width, c.children?.map(text)])).toEqual([
      ['column', 1, ['Left']],
      ['column', 1, ['Middle']],
    ]);
  });

  it('columns with one filled column degrade to plain blocks', async () => {
    const blocks = await htmlToPageBlocks(
      '<div class="columns"><div class="column"><p>Only</p><p>Two lines</p></div>' +
        '<div class="column"></div></div>'
    );
    expect(ofType(blocks, 'columnList')).toHaveLength(0);
    expect(ofType(blocks, 'column')).toHaveLength(0);
    expect(blocks.map(text)).toEqual(['Only', 'Two lines']);
  });

  it('columns inside a column are stacked, never nested', async () => {
    const blocks = await htmlToPageBlocks(
      '<div class="columns"><div class="column"><p>Outer L</p>' +
        '<div class="columns"><div class="column"><p>Inner L</p></div><div class="column"><p>Inner R</p></div></div>' +
        '</div><div class="column"><p>Outer R</p></div></div>'
    );
    expect(ofType(blocks, 'columnList')).toHaveLength(1);
    const [left, right] = blocks[0].children ?? [];
    expect(left.children?.map(text)).toEqual(['Outer L', 'Inner L', 'Inner R']);
    expect(right.children?.map(text)).toEqual(['Outer R']);
  });

  it('every columnList, wherever it is, has two or more non-empty columns', async () => {
    const blocks = await htmlToPageBlocks(KITCHEN_SINK, { resolvePageLink: resolveAll });
    const rows = ofType(blocks, 'columnList');
    expect(rows).toHaveLength(2); // top level, and inside the toggle heading
    for (const row of rows) {
      expect(row.children?.length).toBeGreaterThanOrEqual(2);
      for (const column of row.children ?? []) {
        expect(column.type).toBe('column');
        expect(column.children?.length).toBeGreaterThan(0);
      }
    }
  });

  it('columns inside a list item stay a row under the item, and load', async () => {
    const blocks = await htmlToPageBlocks(
      '<ul><li>item<div class="columns"><div class="column"><p>L</p></div>' +
        '<div class="column"><p>R</p></div></div></li></ul>'
    );
    const [item] = blocks;
    expect(item.type).toBe('bulletListItem');
    expect(item.children?.map(c => c.type)).toEqual(['columnList']);
    expect(yjsRoundTrip(blocks)).toEqual(blocks);
  });

  it('a widget inside a table cell follows the table, no marker left', async () => {
    const blocks = await htmlToPageBlocks(
      '<table><tr><td>cell<div class="callout"><span>In cell</span></div></td></tr></table>'
    );
    expect(JSON.stringify(blocks)).not.toContain('LEGACY_EMBED');
    expect(blocks.map(b => b.type)).toEqual(['table', 'callout']);
  });
});

describe('htmlToPageBlocks: page links', () => {
  const html =
    `<div class="page-link-block"><a class="page-link" href="${LINK('sample', PAGE_A)}">` +
    '<span class="page-link-title">Week 1  notes</span></a></div>' +
    `<p><a href="${LINK('sample', PAGE_A)}">known</a> and <a href="${LINK('sample', PAGE_B)}">gone</a>` +
    ` and <a href="https://example.com/sample/pages/${PAGE_A}">external</a></p>`;

  const hrefs = (blocks: PageBlock[]) =>
    walk(blocks).flatMap(b =>
      Array.isArray(b.content)
        ? (b.content as Array<{ type: string; href?: string }>)
            .filter(i => i.type === 'link')
            .map(i => i.href)
        : []
    );

  it('with a resolver: widgets become pageLink blocks, known inline links are rewritten', async () => {
    const asked: string[] = [];
    const blocks = await htmlToPageBlocks(html, {
      resolvePageLink: (slug, id) => {
        asked.push(`${slug}/${id}`);
        return id === PAGE_A ? `/${slug}/${id}` : null;
      },
    });
    expect(ofType(blocks, 'pageLink').map(b => b.props)).toEqual([
      { pageId: PAGE_A, pageTitle: 'Week 1 notes' },
    ]);
    expect(hrefs(blocks)).toEqual([
      `/sample/${PAGE_A}`,
      LINK('sample', PAGE_B),
      `https://example.com/sample/pages/${PAGE_A}`,
    ]);
    // One lookup per page, however often it is linked.
    expect(asked.sort()).toEqual([`sample/${PAGE_A}`, `sample/${PAGE_B}`]);
  });

  it('accepts an async resolver, and a failing one leaves links alone', async () => {
    const asyncBlocks = await htmlToPageBlocks(html, {
      resolvePageLink: async (slug, id) => (id === PAGE_A ? `/${slug}/${id}` : undefined),
    });
    expect(ofType(asyncBlocks, 'pageLink')).toHaveLength(1);

    const failing = await htmlToPageBlocks(html, {
      resolvePageLink: () => {
        throw new Error('db down');
      },
    });
    expect(ofType(failing, 'pageLink')).toHaveLength(0);
    expect(hrefs(failing)).toContain(LINK('sample', PAGE_A));
  });

  it('without a resolver every link is left as it is', async () => {
    const blocks = await htmlToPageBlocks(html);
    expect(ofType(blocks, 'pageLink')).toHaveLength(0);
    expect(hrefs(blocks)).toEqual([
      LINK('sample', PAGE_A),
      LINK('sample', PAGE_A),
      LINK('sample', PAGE_B),
      `https://example.com/sample/pages/${PAGE_A}`,
    ]);
  });

  it('a page-link widget the resolver does not know stays a link', async () => {
    const blocks = await htmlToPageBlocks(html, { resolvePageLink: () => null });
    expect(ofType(blocks, 'pageLink')).toHaveLength(0);
    expect(hrefs(blocks)[0]).toBe(LINK('sample', PAGE_A));
  });

  it('ignores a page-link marker written into the HTML itself', async () => {
    const blocks = await htmlToPageBlocks(
      `<div class="page-link-block" data-classmoji-page-link="${PAGE_B}"><a href="https://example.com">x</a></div>`
    );
    expect(ofType(blocks, 'pageLink')).toHaveLength(0);
  });
});

describe('htmlToPageBlocks: colours and alignment', () => {
  const headingColors = async (html: string) =>
    ofType(await htmlToPageBlocks(html), 'heading').map(h => [text(h), h.props?.backgroundColor]);

  it('a heading’s own colour, as the nearest BlockNote colour', async () => {
    expect(
      await headingColors(
        '<h2 style="background-color: rgb(251, 228, 228)">Pink-ish red</h2>' +
          '<h2 style="background-color: #DDEBF1">Blue</h2>' +
          '<h2 style="background: #f00">Saturated red</h2>' +
          '<div class="heading-block" data-bg-color="#fbf3db"><h3>Wrapped</h3></div>' +
          '<h2 style="background-color: yellow">Named</h2>'
      )
    ).toEqual([
      ['Pink-ish red', 'red'],
      ['Blue', 'blue'],
      ['Saturated red', 'red'],
      ['Wrapped', 'yellow'],
      ['Named', 'yellow'],
    ]);
  });

  it('the stylesheet rule for the level when the heading has none of its own', async () => {
    const html = doc(
      '<h2>From CSS</h2><h2 style="background-color:#ddedea">Own</h2><h3>None</h3>',
      {
        css: 'body { margin: 0 } h2 { color: #333; background-color: #EAE4F2; }',
      }
    );
    expect(await headingColors(html)).toEqual([
      ['From CSS', 'purple'],
      ['Own', 'green'],
      ['None', 'default'],
    ]);
  });

  it('white, transparent and unreadable colours are no colour', async () => {
    expect(
      await headingColors(
        '<h2 style="background-color:#ffffff">White</h2>' +
          '<h2 style="background-color:transparent">Clear</h2>' +
          '<h2 style="background-color:rgba(200, 0, 0, 0)">Zero alpha</h2>' +
          '<div class="heading-block" data-bg-color="sparkly"><h2>Unreadable</h2></div>'
      )
    ).toEqual([
      ['White', 'default'],
      ['Clear', 'default'],
      ['Zero alpha', 'default'],
      ['Unreadable', 'default'],
    ]);
  });

  it('raw colours on other blocks become BlockNote colour names too', async () => {
    const blocks = await htmlToPageBlocks(
      '<p style="background-color: rgb(221, 237, 234)">Tinted</p>'
    );
    expect(blocks[0].props?.backgroundColor).toBe('green');
  });

  it('dark grey and black text is the page’s own ink, not a colour', async () => {
    const blocks = await htmlToPageBlocks(
      '<p style="color: #333">Ink</p><p style="color: #000">Black</p>' +
        '<p style="color: rgb(224, 62, 62)">Red</p><p style="color: #9b9a97">Grey</p>'
    );
    expect(blocks.map(b => [text(b), b.props?.textColor])).toEqual([
      ['Ink', 'default'],
      ['Black', 'default'],
      ['Red', 'red'],
      ['Grey', 'gray'],
    ]);
  });

  it('image-align-* -> image textAlignment', async () => {
    const blocks = await htmlToPageBlocks(
      '<figure class="image-block image-align-center"><img src="a.png"></figure>' +
        '<figure class="image-block image-align-right"><img src="b.png"></figure>' +
        '<figure class="image-block"><img src="c.png"></figure>' +
        '<div class="image-align-center"><img src="d.png"></div>'
    );
    expect(ofType(blocks, 'image').map(b => [b.props?.url, b.props?.textAlignment])).toEqual([
      ['a.png', 'center'],
      ['b.png', 'right'],
      ['c.png', 'left'],
      ['d.png', 'center'],
    ]);
  });

  it('puts an empty paragraph above every heading, as the old viewer spaced them', async () => {
    const blocks = await htmlToPageBlocks('<p>Intro</p><h2>Section</h2><p>Body</p>');
    expect(blocks.map(b => [b.type, text(b)])).toEqual([
      ['paragraph', 'Intro'],
      ['paragraph', ''],
      ['heading', 'Section'],
      ['paragraph', 'Body'],
    ]);
  });
});

describe('htmlToPageBlocks: a document that opens with a heading', () => {
  const shape = (blocks: PageBlock[]) => blocks.map(b => [b.type, text(b)]);

  it('starts with the heading, no blank line above it; later headings keep theirs', async () => {
    const blocks = await htmlToPageBlocks('<h2>First</h2><p>Body</p><h2>Second</h2>');
    expect(shape(blocks)).toEqual([
      ['heading', 'First'],
      ['paragraph', 'Body'],
      ['paragraph', ''],
      ['heading', 'Second'],
    ]);
  });

  it('the same once the title <h1> is dropped', async () => {
    const blocks = await htmlToPageBlocks(doc('<h2>Overview</h2><p>Body</p>'), {
      title: 'Sample Page',
    });
    expect(shape(blocks)).toEqual([
      ['heading', 'Overview'],
      ['paragraph', 'Body'],
    ]);
  });

  it('the same for a <details> toggle heading, and with widgets elsewhere', async () => {
    const blocks = await htmlToPageBlocks(
      '<details><summary>More</summary><p>Hidden</p></details>' +
        '<div class="callout"><span class="callout-emoji">🔥</span><span>Tip</span></div>'
    );
    expect(shape(blocks)).toEqual([
      ['heading', 'More'],
      ['callout', 'Tip'],
    ]);
  });

  it('a page opening with a blank line of its own keeps it and the spacer', async () => {
    const blocks = await htmlToPageBlocks('<p><br></p><h2>Section</h2>');
    expect(shape(blocks)).toEqual([
      ['paragraph', '\n'],
      ['paragraph', ''],
      ['heading', 'Section'],
    ]);
  });

  it('a heading opening a column or a toggle body keeps its spacer', async () => {
    const blocks = await htmlToPageBlocks(
      '<p>Intro</p><div class="columns"><div class="column"><h3>Left</h3></div>' +
        '<div class="column"><p>Right</p></div></div>' +
        '<details><summary>More</summary><h4>Inner</h4></details>'
    );
    const [row] = ofType(blocks, 'columnList');
    expect(shape(row.children?.[0].children ?? [])).toEqual([
      ['paragraph', ''],
      ['heading', 'Left'],
    ]);
    const toggle = ofType(blocks, 'heading').find(h => text(h) === 'More');
    expect(shape(toggle?.children ?? [])).toEqual([
      ['paragraph', ''],
      ['heading', 'Inner'],
    ]);
  });

  it('a heading alone is the whole document', async () => {
    expect(shape(await htmlToPageBlocks('<h2>Only</h2>'))).toEqual([['heading', 'Only']]);
  });
});

describe('htmlToPageBlocks: one conversion at a time', () => {
  it('never overlaps, whoever calls: results in call order, globals restored', async () => {
    const editor = getServerEditor();
    const original = editor._withJSDOM.bind(editor);
    let inJsdom = 0;
    let maxInJsdom = 0;
    const spy = vi.spyOn(editor, '_withJSDOM').mockImplementation(async work => {
      inJsdom++;
      maxInJsdom = Math.max(maxInJsdom, inJsdom);
      try {
        return await original(work);
      } finally {
        inJsdom--;
      }
    });

    // A resolver that yields mid-conversion: without the queue the pages'
    // lookups (and their JSDOM sections) interleave.
    const events: string[] = [];
    const resolvePageLink = async (slug: string, id: string) => {
      events.push(`start:${slug}`);
      await new Promise(resolve => setTimeout(resolve, 5));
      events.push(`end:${slug}`);
      return `/${slug}/${id}`;
    };
    const pages = ['a', 'b', 'c', 'd'];
    try {
      const results = await Promise.all(
        pages.map(p =>
          htmlToPageBlocks(
            `<p>Body ${p}</p><p><a href="${LINK(p, PAGE_A)}">one</a></p>` +
              `<div class="callout"><span>Note ${p}</span></div>`,
            { resolvePageLink }
          )
        )
      );

      expect(maxInJsdom).toBe(1);
      expect(events).toEqual(pages.flatMap(p => [`start:${p}`, `end:${p}`]));
      expect(results.map(blocks => text(blocks[0]))).toEqual(pages.map(p => `Body ${p}`));
      expect(results.map(blocks => text(ofType(blocks, 'callout')[0]))).toEqual(
        pages.map(p => `Note ${p}`)
      );
      expect(globalThis.window).toBeUndefined();
      expect(globalThis.document).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('a failed conversion does not fail the ones queued behind it', async () => {
    const editor = getServerEditor();
    const spy = vi
      .spyOn(editor, 'tryParseHTMLToBlocks')
      .mockRejectedValueOnce(new Error('parser blew up'));
    try {
      const failed = htmlToPageBlocks('<p>first</p>');
      const next = htmlToPageBlocks('<p>second</p>');
      await expect(failed).rejects.toThrow('parser blew up');
      expect(text((await next)[0])).toBe('second');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('htmlToPageBlocks: code', () => {
  it('a terminal block whose <code> has no language class is a terminal', async () => {
    const blocks = await htmlToPageBlocks(
      '<div class="terminal-block"><div class="terminal-header"><span class="terminal-title">Terminal</span></div>' +
        '<pre><code>npm run dev</code></pre></div>'
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'terminal',
      props: { title: 'Terminal', code: 'npm run dev' },
    });
  });

  it('bash and powershell code are terminals, before any language rewrite', async () => {
    const blocks = await htmlToPageBlocks(
      '<pre><code class="language-bash">ls -la</code></pre>' +
        '<pre><code class="language-powershell">Get-ChildItem</code></pre>'
    );
    expect(blocks.map(b => [b.type, b.props?.title, b.props?.code])).toEqual([
      ['terminal', 'Terminal', 'ls -la'],
      ['terminal', 'powershell', 'Get-ChildItem'],
    ]);
  });

  it('a "Terminal" label before code becomes the terminal title', async () => {
    const blocks = await htmlToPageBlocks(
      '<p>Run this in your terminal</p><pre><code class="language-python">print(1)</code></pre>'
    );
    expect(blocks).toEqual([
      expect.objectContaining({
        type: 'terminal',
        props: expect.objectContaining({ title: 'Run this in your terminal', code: 'print(1)' }),
      }),
    ]);
  });

  it('drops the old code header (language label, line numbers)', async () => {
    const blocks = await htmlToPageBlocks(
      '<div class="code-block"><div class="code-header"><span class="code-lang">Python</span></div>' +
        '<div class="code-body"><div class="line-numbers">12</div>' +
        '<pre><code class="language-python">x = 1\ny = 2</code></pre></div></div>'
    );
    expect(blocks.map(b => [b.type, b.props?.language, text(b)])).toEqual([
      ['codeBlock', 'python', 'x = 1\ny = 2'],
    ]);
  });

  it('stores canonical languages: aliases resolved, unknown names plain text', async () => {
    const blocks = await htmlToPageBlocks(
      '<pre><code class="language-js">a</code></pre>' +
        '<pre><code class="language-py">b</code></pre>' +
        '<pre><code class="language-sh">c</code></pre>' +
        '<pre><code class="language-klingon">d</code></pre>' +
        '<pre><code class="language-typescript">e</code></pre>'
    );
    expect(blocks.map(b => b.props?.language)).toEqual([
      'javascript',
      'python',
      'shellscript',
      'text',
      'typescript',
    ]);
  });

  it('links inside code are flattened to plain text', async () => {
    const [code] = await htmlToPageBlocks(
      '<pre><code class="language-js">go(<a href="https://example.com">here</a>)</code></pre>'
    );
    expect(code.content).toEqual([{ type: 'text', text: 'go(here)', styles: {} }]);
  });
});

describe('htmlToPageBlocks: media', () => {
  it('video embeds (iframe, <video src>, <video><source>) -> video blocks', async () => {
    const blocks = await htmlToPageBlocks(
      '<div class="video-embed"><iframe src="https://www.youtube.com/embed/abc" allowfullscreen></iframe></div>' +
        '<div class="video-embed"><video src="clip.mp4" controls></video></div>' +
        '<div class="video-embed"><video controls><source src="other.webm" type="video/webm"></video></div>'
    );
    expect(blocks.map(b => [b.type, b.props?.url])).toEqual([
      ['video', 'https://www.youtube.com/embed/abc'],
      ['video', 'clip.mp4'],
      ['video', 'other.webm'],
    ]);
  });

  it('an image alone in a list item becomes an image block, its sub-items kept', async () => {
    const blocks = await htmlToPageBlocks(
      '<ul><li><p><img src="shot.png"></p><ul><li>caption point</li></ul></li></ul>'
    );
    expect(blocks.map(b => [b.type, b.props?.url ?? text(b)])).toEqual([
      ['image', 'shot.png'],
      ['bulletListItem', 'caption point'],
    ]);
  });
});

describe('htmlToPageBlocks: review fixes', () => {
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

  it('an image the old editor put in a <p> keeps the old 512px width; <figure>/bare images do not get one', async () => {
    const blocks = await htmlToPageBlocks(
      '<p><img src="alone.png"></p>' +
        '<ul><li><p><img src="in-list.png"></p></li></ul>' +
        '<figure><img src="figure.png"></figure>' +
        '<img src="bare.png">'
    );
    expect(blocks.map(b => [b.type, b.props?.url, b.props?.previewWidth])).toEqual([
      ['image', 'alone.png', 512],
      ['image', 'in-list.png', 512],
      ['image', 'figure.png', undefined],
      ['image', 'bare.png', undefined],
    ]);
  });

  it('a linked label before code is content, not a code header', async () => {
    const blocks = await htmlToPageBlocks(
      '<p><a href="https://example.com/file.js">Download</a></p>' +
        '<pre><code class="language-js">run()</code></pre>'
    );
    expect(blocks.map(b => [b.type, text(b)])).toEqual([
      ['paragraph', 'Download'],
      ['codeBlock', 'run()'],
    ]);
  });

  it('a linked "terminal" in a sentence does not make the next code a terminal', async () => {
    const blocks = await htmlToPageBlocks(
      '<p>Open a <a href="https://example.com/t">terminal</a> window.</p>' +
        '<pre><code class="language-python">print(1)</code></pre>'
    );
    expect(blocks.map(b => [b.type, b.props?.language, text(b)])).toEqual([
      ['paragraph', undefined, 'Open a terminal window.'],
      ['codeBlock', 'python', 'print(1)'],
    ]);
  });

  it('a diff block with unreadable base64 data falls back to its <pre> text', async () => {
    const escaped = (data: string) =>
      `<p>&lt;div class="diff-block" data-content="${data}"&gt;&lt;pre&gt;- old +new&lt;/pre&gt;&lt;/div&gt;</p>`;
    const [valid, invalid, notUtf8] = await Promise.all([
      htmlToPageBlocks(escaped(b64('- a\n+ b'))),
      htmlToPageBlocks(escaped('not*base64!')),
      htmlToPageBlocks(escaped(Buffer.from([0xff, 0xfe, 0xfd]).toString('base64'))),
    ]);
    expect(valid.map(b => [b.type, text(b)])).toEqual([['codeBlock', '- a\n+ b']]);
    for (const blocks of [invalid, notUtf8]) {
      expect(blocks.map(b => [b.type, text(b)])).toEqual([['codeBlock', '- old +new']]);
    }
  });

  it('a terminal named by its author keeps the name as its title, no stray paragraph', async () => {
    const blocks = await htmlToPageBlocks(
      '<div class="terminal-block"><div class="terminal-header"><div class="terminal-dots">' +
        '<span></span><span></span><span></span></div>' +
        '<span class="terminal-title">Start the server</span></div>' +
        '<pre><code class="language-bash">npm start</code></pre></div>'
    );
    expect(blocks.map(b => [b.type, b.props?.title, b.props?.code])).toEqual([
      ['terminal', 'Start the server', 'npm start'],
    ]);
  });

  it('a terminal wrapped around an old code-block widget is one terminal', async () => {
    const blocks = await htmlToPageBlocks(
      '<div class="terminal-block"><div class="terminal-header"><span class="terminal-title">Terminal</span></div>' +
        '<div class="code-block"><div class="code-header"><span class="code-lang">bash</span></div>' +
        '<div class="code-body"><div class="line-numbers"><span class="line-number">1</span></div>' +
        '<pre><code class="language-bash">ls</code></pre></div></div></div>'
    );
    expect(blocks.map(b => [b.type, b.props?.title, b.props?.code])).toEqual([
      ['terminal', 'Terminal', 'ls'],
    ]);
  });

  it('a Notion toggle’s base64 body (the markdown importer’s data-encoded) becomes its children', async () => {
    const body = '<p>Hidden answer</p><pre><code class="language-python">x = 1</code></pre>';
    const blocks = await htmlToPageBlocks(
      `<details><summary>❓ Question</summary><div data-encoded="${b64(body)}"></div></details>`
    );
    const toggle = blocks.find(b => b.type === 'heading');
    expect(toggle?.props).toMatchObject({ isToggleable: true });
    expect(text(toggle)).toBe('❓ Question');
    expect(toggle?.children?.map(b => [b.type, text(b)])).toEqual([
      ['paragraph', 'Hidden answer'],
      ['codeBlock', 'x = 1'],
    ]);
  });

  it('an image inside a paragraph of text is kept, in reading order, formatting intact', async () => {
    const blocks = await htmlToPageBlocks(
      '<p>Intro with <img src="mid.png" alt="m"> <b>bold</b> image.</p>' +
        '<p><img src="lead.png"> trailing text</p>'
    );
    expect(blocks.map(b => [b.type, b.props?.url ?? text(b)])).toEqual([
      ['paragraph', 'Intro with '],
      ['image', 'mid.png'],
      ['paragraph', ' bold image.'],
      ['image', 'lead.png'],
      ['paragraph', ' trailing text'],
    ]);
    const bold = (
      blocks[2].content as Array<{ text: string; styles: Record<string, unknown> }>
    ).find(run => run.text === 'bold');
    expect(bold?.styles).toEqual({ bold: true });
  });

  it('an image in a table cell is left to the parser (dropped from the cell)', async () => {
    const blocks = await htmlToPageBlocks(
      '<table><tr><td>cell <img src="t.png"> x</td></tr></table>'
    );
    expect(blocks.map(b => b.type)).toEqual(['table']);
    expect(JSON.stringify(blocks)).not.toContain('t.png');
  });
});
