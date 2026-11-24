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

// ─── Frames in the reader: the hosts and the display map reach the blocks ────

test.describe('the frame rule in the reader reads the payload’s hosts and display map', () => {
  const CLASSROOM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const DELIVERY_URL = `https://content.classmoji.test/c/${CLASSROOM}/blob/abc123/handout.pdf?sig=x`;
  const HOSTS = {
    hosts: ['app.classmoji.test', 'content.classmoji.test', 'pages.classmoji.test'],
    siteDomain: 'classmoji.test',
    framed: ['slides.classmoji.test'],
    delivery: 'content.classmoji.test',
  };
  const embed = (id: string, url: string) => ({ id, type: 'embed', props: { url }, children: [] });

  test("the class's own PDF frames unsandboxed; the same URL typed, an outside PDF and our web app do not", async ({
    page,
  }) => {
    const blocks = [
      // A repo reference the server resolved (in the payload's display map).
      embed('own', 'pages/lab/handout.pdf'),
      // The very same delivery URL, typed by an author: not in the map.
      embed('typed', DELIVERY_URL),
      embed('outside', 'https://example.com/docs/notes.pdf'),
      embed('webapp', 'https://app.classmoji.test/student/cs52'),
    ];
    const data = siteIslandData(blocks);
    data.payload.assets = { 'pages/lab/handout.pdf': DELIVERY_URL };
    data.payload.frameHosts = HOSTS;
    await mountReader(page, blocks, { data });
    const shown = await page.evaluate(() => {
      const of = (id: string) => document.querySelector(`.bn-block[data-id="${id}"]`);
      const frame = (id: string) => of(id)?.querySelector('iframe') ?? null;
      return {
        own: {
          src: frame('own')?.getAttribute('src'),
          sandbox: frame('own')?.hasAttribute('sandbox'),
        },
        typed: {
          iframe: Boolean(frame('typed')),
          link: of('typed')?.querySelector('a')?.getAttribute('href') ?? null,
        },
        outside: {
          iframe: Boolean(frame('outside')),
          card: of('outside')?.querySelector('a.bn-frame-file-open')?.getAttribute('href') ?? null,
        },
        webapp: {
          iframe: Boolean(frame('webapp')),
          link: of('webapp')?.querySelector('a')?.getAttribute('href') ?? null,
        },
      };
    });
    expect(shown.own).toEqual({ src: DELIVERY_URL, sandbox: false });
    expect(shown.typed).toEqual({ iframe: false, link: DELIVERY_URL });
    expect(shown.outside).toEqual({ iframe: false, card: 'https://example.com/docs/notes.pdf' });
    expect(shown.webapp).toEqual({
      iframe: false,
      link: 'https://app.classmoji.test/student/cs52',
    });
  });
});

// ─── A locked section for a signed-in non-member ─────────────────────────────

test.describe('a locked section as each reader sees it', () => {
  const locked = [
    {
      id: 'lock',
      type: 'lockedSection',
      props: { title: 'Solution' },
      content: [],
      children: [],
    },
  ];
  const sectionsFor = (signedIn: boolean, member: boolean) => {
    const data = siteIslandData(locked);
    data.payload.readerSections = { ...data.payload.readerSections, signedIn, member };
    return data;
  };
  const lockOf = (page: Page) =>
    page.$eval('.bn-block[data-id="lock"]', block => ({
      mode: block.querySelector('.pg-locked')?.getAttribute('data-mode') ?? null,
      text: (block as HTMLElement).innerText,
      links: block.querySelectorAll('a').length,
    }));

  test('signed in, not a member: the one line, no link', async ({ page }) => {
    await mountReader(page, locked, { data: sectionsFor(true, false) });
    const shown = await lockOf(page);
    expect(shown.mode).toBe('members');
    expect(shown.text).toContain('Only class members can unlock this.');
    expect(shown.text).not.toContain('Sign in');
    expect(shown.links).toBe(0);
  });

  test('signed out: the sign-in link, not the members line', async ({ page }) => {
    await mountReader(page, locked, { data: sectionsFor(false, false) });
    const shown = await lockOf(page);
    expect(shown.mode).toBe('signin');
    expect(shown.text).not.toContain('Only class members');
    expect(shown.links).toBe(1);
  });
});
