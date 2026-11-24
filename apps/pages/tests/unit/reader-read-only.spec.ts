/**
 * Every block type, drawn by the real reader (the island the class site and
 * the MCP's page render mount: `tests/helpers/readerHarness.ts`), is
 * read-only: no enabled form control, nothing contenteditable, no upload
 * affordance.
 *
 * The block list comes from the reader's schema, so a block added to the
 * schema fails here until it has a sample: someone has to decide what it
 * looks like to a reader. This replaces the class site's static-render
 * coverage test (site-render.spec.ts), which held the same line for the
 * server-rendered HTML.
 */
import { test, expect, type Page } from '@playwright/test';

import { viewerSchema } from '~/components/viewer/viewerBlocks.tsx';
import { mountReader, siteIslandData } from '../helpers/readerHarness.ts';

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];
const IMAGE =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#888"/></svg>'
  ).toString('base64');

/** One populated sample per block type in the reader's schema. */
const SAMPLES: Record<string, unknown> = {
  paragraph: { type: 'paragraph', content: text('a paragraph') },
  heading: { type: 'heading', props: { level: 2, isToggleable: true }, content: text('Heading') },
  bulletListItem: { type: 'bulletListItem', content: text('bullet') },
  numberedListItem: { type: 'numberedListItem', content: text('numbered') },
  checkListItem: { type: 'checkListItem', props: { checked: true }, content: text('checked') },
  toggleListItem: {
    type: 'toggleListItem',
    content: text('toggle'),
    children: [{ type: 'paragraph', content: text('inside the toggle') }],
  },
  quote: { type: 'quote', content: text('quoted') },
  codeBlock: { type: 'codeBlock', props: { language: 'js' }, content: text('const a = 1;') },
  image: { type: 'image', props: { url: IMAGE, caption: 'cap', previewWidth: 200 } },
  file: { type: 'file', props: { url: 'https://example.test/a.pdf', name: 'a.pdf' } },
  audio: { type: 'audio', props: { url: 'https://example.test/a.mp3', name: 'a.mp3' } },
  video: { type: 'video', props: { url: 'https://youtu.be/abc123', caption: 'a video' } },
  table: { type: 'table', content: { type: 'tableContent', rows: [{ cells: [text('cell')] }] } },
  columnList: {
    type: 'columnList',
    children: [
      {
        type: 'column',
        props: { width: 1 },
        children: [{ type: 'paragraph', content: text('L') }],
      },
      {
        type: 'column',
        props: { width: 1 },
        children: [{ type: 'paragraph', content: text('R') }],
      },
    ],
  },
  // Never at the top level: exercised inside columnList.
  column: null,
  callout: { type: 'callout', props: { emoji: '💡' }, content: text('callout body') },
  terminal: { type: 'terminal', props: { code: 'npm run dev', title: 'Terminal' } },
  profile: { type: 'profile', props: { name: 'Ada', title: 'Instructor', imageUrl: IMAGE } },
  divider: { type: 'divider' },
  embed: { type: 'embed', props: { url: 'https://example.test/embed', type: '' } },
  pageLink: { type: 'pageLink', props: { pageId: 'visible', pageTitle: 'Syllabus' } },
  navGrid: {
    type: 'navGrid',
    props: {
      entries: JSON.stringify([
        { kind: 'page', pageId: 'visible', title: 'Syllabus' },
        { kind: 'external', url: 'https://example.test', label: 'Elsewhere' },
      ]),
      columns: 2,
    },
  },
  lockedSection: {
    type: 'lockedSection',
    props: { title: 'Solution' },
    children: [{ type: 'paragraph', content: text('locked body') }],
  },
};

/** Blocks whose EMPTY state is an editor control in BlockNote (`Add image`). */
const EMPTY_SAMPLES = [
  { type: 'image', props: { url: '' } },
  { type: 'file', props: { url: '' } },
  { type: 'audio', props: { url: '' } },
  { type: 'video', props: { url: '' } },
  { type: 'embed', props: { url: '' } },
  { type: 'terminal', props: { code: '' } },
  // What the reader payload leaves of a profile whose photo did not resolve.
  { type: 'profile', props: { name: 'Ada', title: 'Instructor', imageUrl: '' } },
  {
    type: 'columnList',
    children: [
      { type: 'column', props: { width: 1 }, children: [{ type: 'image', props: { url: '' } }] },
      { type: 'column', props: { width: 1 }, children: [{ type: 'file', props: { url: '' } }] },
    ],
  },
];

/** What a reader must never be handed. */
async function editingAffordances(page: Page) {
  return page.evaluate(() => {
    const root = document.getElementById('reader-island-root')!;
    const describe = (el: Element) => el.outerHTML.slice(0, 160);
    return {
      enabledControls: [...root.querySelectorAll('input, select, textarea')]
        .filter(el => !(el as HTMLInputElement).disabled)
        .map(describe),
      editable: [...root.querySelectorAll('[contenteditable="true"], [contenteditable=""]')].map(
        describe
      ),
      upload: [...root.querySelectorAll('.bn-add-file-button, .bn-file-loading-preview')].map(
        describe
      ),
      addText: /Add (image|file|audio|video|embed)/.test(root.textContent ?? ''),
    };
  });
}

const NONE = { enabledControls: [], editable: [], upload: [], addText: false };

test.describe('every block, read-only in the reader', () => {
  test('every block type in the reader schema has a sample', () => {
    // Fails the moment a block is added without deciding what a reader sees.
    expect(Object.keys(SAMPLES).sort()).toEqual(Object.keys(viewerSchema.blockSpecs).sort());
  });

  test('the whole sample document: no control, nothing editable, no upload affordance', async ({
    page,
  }) => {
    const blocks = Object.values(SAMPLES).filter(Boolean);
    const data = siteIslandData(blocks);
    data.payload.links = { visible: { href: '/syllabus', title: 'Syllabus', membersOnly: false } };
    await mountReader(page, blocks, { data });

    // Every sample was drawn (column inside columnList), so the checks below
    // looked at something.
    const drawn = await page.$$eval('[data-content-type], [data-node-type]', els => [
      ...new Set(
        els.map(el => el.getAttribute('data-content-type') ?? el.getAttribute('data-node-type'))
      ),
    ]);
    for (const type of Object.keys(SAMPLES)) expect(drawn, type).toContain(type);
    // The control scan reaches real inputs: the check list's box is one, disabled.
    expect(
      await page.locator('#reader-island-root input[type="checkbox"]').count()
    ).toBeGreaterThan(0);
    expect(await editingAffordances(page)).toEqual(NONE);
  });

  test('unset file, media and embed blocks: nothing to click, nested ones too', async ({
    page,
  }) => {
    await mountReader(page, [
      { type: 'paragraph', content: text('before') },
      ...EMPTY_SAMPLES,
      { type: 'paragraph', content: text('after') },
    ]);
    expect(await editingAffordances(page)).toEqual(NONE);
  });
});

test.describe('terminal code is text, as typed', () => {
  test('styles, tags and entities in a command survive verbatim; only the <pre> loses its background', async ({
    page,
  }) => {
    const code = 'echo "background-color:red;" <b>x</b> && echo a & b';
    await mountReader(page, [{ type: 'terminal', props: { code, title: 'Terminal' } }]);
    // Shiki loads after the reader is ready.
    await expect
      .poll(() => page.locator('.terminal-content pre.shiki').count(), { timeout: 15_000 })
      .toBe(1);
    const shown = await page.$eval('.terminal-content pre.shiki', pre => ({
      text: pre.textContent,
      injected: pre.querySelectorAll('b, img, script').length,
      preStyle: pre.getAttribute('style') ?? '',
      preBackground: getComputedStyle(pre).backgroundColor,
      tokensKeepColor: [...pre.querySelectorAll('span[style]')].some(span =>
        /color:/.test(span.getAttribute('style') ?? '')
      ),
    }));
    expect(shown.text).toBe(code);
    expect(shown.injected).toBe(0);
    expect(shown.preStyle).not.toMatch(/background/i);
    expect(shown.preBackground).toBe('rgba(0, 0, 0, 0)');
    // Still coloured: the token colours are untouched.
    expect(shown.tokensKeepColor).toBe(true);
  });
});
