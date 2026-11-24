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

// ─── "View as" a student: their state, drawn read-only ───────────────────────

test.describe('viewing as a student ("View as")', () => {
  const UNLOCKED_AT = '2026-11-01T10:00:00.000Z';
  const blocks = [
    {
      id: 'h-done',
      type: 'heading',
      props: { level: 2, checkable: true },
      content: text('Setup'),
      children: [],
    },
    { id: 'p-1', type: 'paragraph', content: text('Do the setup.') },
    {
      id: 'h-todo',
      type: 'heading',
      props: { level: 2, checkable: true },
      content: text('Next'),
      children: [],
    },
    {
      id: 'item-done',
      type: 'checkListItem',
      props: { checked: false, personal: true },
      content: text('Install Node'),
    },
    {
      id: 'item-todo',
      type: 'checkListItem',
      // The author's box is ticked; the student's is not.
      props: { checked: true, personal: true },
      content: text('Install Git'),
    },
    // Still locked for the student: no body was sent.
    { id: 'lock', type: 'lockedSection', props: { title: 'Solution' }, children: [] },
    // Unlocked by the student: the body was sent.
    {
      id: 'opened',
      type: 'lockedSection',
      props: { title: 'Hint' },
      children: [{ id: 'hint-body', type: 'paragraph', content: text('the hint body') }],
    },
  ];
  const viewAs = () => {
    const data = siteIslandData(blocks);
    data.payload.readerSections = {
      staff: false,
      signedIn: true,
      member: true,
      showChecks: true,
      showUnlock: true,
      canCheck: false,
      canUnlock: false,
      checked: ['h-done', 'item-done'],
      unlocked: { opened: UNLOCKED_AT },
    };
    return data;
  };

  test('the student’s ticks and unlocks, every control inert, nothing posted', async ({ page }) => {
    const posts: string[] = [];
    page.on('request', request => {
      if (request.method() !== 'GET') posts.push(`${request.method()} ${request.url()}`);
    });
    await mountReader(page, blocks, { data: viewAs() });

    const box = (id: string) => page.locator(`.bn-block[data-id="${id}"] .pg-section-check`);
    const boxState = (id: string) =>
      box(id).evaluate(el => ({
        hidden: (el as HTMLButtonElement).hidden,
        disabled: (el as HTMLButtonElement).disabled,
        checked: el.getAttribute('aria-checked'),
        label: el.getAttribute('aria-label'),
        tooltip: el.getAttribute('data-tooltip'),
        afterContent: getComputedStyle(el, '::after').content,
        cursor: getComputedStyle(el).cursor,
      }));
    expect(await boxState('h-done')).toEqual({
      hidden: false,
      disabled: true,
      checked: 'true',
      label: "'Setup' done",
      tooltip: null,
      afterContent: 'none',
      cursor: 'default',
    });
    expect(await boxState('h-todo')).toMatchObject({
      hidden: false,
      disabled: true,
      checked: 'false',
      label: "'Next' not done",
    });
    await expect(box('h-done')).toBeVisible();

    // The done section fades, as it does for the student.
    await expect
      .poll(() =>
        page
          .locator('.bn-block[data-id="p-1"]')
          .evaluate(el => Number(getComputedStyle(el.closest('.bn-block-outer')!).opacity))
      )
      .toBeLessThan(1);

    // Student check list items: the student's state, not the author's, disabled.
    const itemState = (id: string) =>
      page.locator(`.bn-block[data-id="${id}"] input[type="checkbox"]`).evaluate(el => ({
        checked: (el as HTMLInputElement).checked,
        disabled: (el as HTMLInputElement).disabled,
      }));
    expect(await itemState('item-done')).toEqual({ checked: true, disabled: true });
    expect(await itemState('item-todo')).toEqual({ checked: false, disabled: true });

    // The student's unlocked section is open; the locked one is their card,
    // hold control and note included, the control disabled.
    const lock = page.locator('.bn-block[data-id="lock"] .pg-locked');
    await expect(lock).toHaveAttribute('data-mode', 'view');
    await expect(lock).toContainText('Hold to unlock');
    await expect(lock).toContainText('Staff can see when you unlock this.');
    const hold = lock.locator('.pg-hold-btn');
    await expect(hold).toBeDisabled();
    // Inert to the pointer too: no hand, a swipe on it scrolls.
    expect(
      await hold.evaluate(el => ({
        cursor: getComputedStyle(el).cursor,
        touchAction: getComputedStyle(el).touchAction,
      }))
    ).toEqual({ cursor: 'default', touchAction: 'auto' });
    expect(
      await page
        .locator('.bn-block[data-id="item-done"] input[type="checkbox"]')
        .evaluate(el => getComputedStyle(el).cursor)
    ).toBe('default');
    const describedBy = await hold.getAttribute('aria-describedby');
    expect(await page.locator(`[id="${describedBy}"]`).count()).toBe(1);
    await expect(page.locator('.bn-block[data-id="opened"] .pg-locked').first()).toHaveAttribute(
      'data-mode',
      'unlocked'
    );
    await expect(page.locator('#reader-island-root')).toContainText('the hint body');

    // Clicking a box, ticking an item and holding the padlock change nothing.
    await box('h-todo').click({ force: true });
    await page
      .locator('.bn-block[data-id="item-todo"] input[type="checkbox"]')
      .click({ force: true });
    const at = await hold.boundingBox();
    if (!at) throw new Error('the hold control is not drawn');
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(1600);
    await page.mouse.up();
    expect(await boxState('h-todo')).toMatchObject({ checked: 'false', disabled: true });
    expect(await itemState('item-todo')).toEqual({ checked: false, disabled: true });
    await expect(lock).toHaveAttribute('data-mode', 'view');
    expect(posts).toEqual([]);
  });

  test('a payload without the draw flags draws what it may act on', async ({ page }) => {
    const data = viewAs();
    const { showChecks: _s, showUnlock: _u, ...older } = data.payload.readerSections;
    data.payload.readerSections = older as typeof data.payload.readerSections;
    await mountReader(page, blocks, { data });
    expect(
      await page
        .locator('.bn-block[data-id="h-done"] .pg-section-check')
        .evaluate(el => (el as HTMLButtonElement).hidden)
    ).toBe(true);
    await expect(page.locator('.bn-block[data-id="lock"] .pg-locked')).toHaveAttribute(
      'data-mode',
      'closed'
    );
  });

  test('the student themself: the same controls, live, each posting once', async ({ page }) => {
    const data = viewAs();
    data.payload.readerSections = {
      ...data.payload.readerSections,
      canCheck: true,
      canUnlock: true,
    };
    await mountReader(page, blocks, { data });
    // Answer the section API (registered after the harness's own route, so it wins).
    const posts: Array<{ blockId: string; intent: string }> = [];
    await page.route('**/api/page-sections', async route => {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        blockId: string;
        intent: string;
      };
      posts.push({ blockId: body.blockId, intent: body.intent });
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(
          body.intent === 'unlock'
            ? { ok: true, unlockedAt: '2026-11-02T10:00:00.000Z' }
            : { ok: true, checked: body.intent === 'check' }
        ),
      });
    });

    // The heading box: enabled, with its tooltip; a click posts one check.
    const box = page.locator('.bn-block[data-id="h-todo"] .pg-section-check');
    await expect(box).toBeEnabled();
    expect(await box.getAttribute('data-tooltip')).toBe('Mark done');
    await box.click();
    await expect.poll(() => posts.length).toBe(1);
    expect(posts[0]).toEqual({ blockId: 'h-todo', intent: 'check' });
    await expect(box).toHaveAttribute('aria-checked', 'true');

    // The student's check list item: enabled; ticking posts one check.
    const item = page.locator('.bn-block[data-id="item-todo"] input[type="checkbox"]');
    await expect(item).toBeEnabled();
    await item.click();
    await expect.poll(() => posts.length).toBe(2);
    expect(posts[1]).toEqual({ blockId: 'item-todo', intent: 'check' });

    // The locked section: the live hold; a full hold posts one unlock.
    const lock = page.locator('.bn-block[data-id="lock"] .pg-locked');
    await expect(lock).toHaveAttribute('data-mode', 'hold');
    const hold = lock.locator('.pg-hold-btn');
    await expect(hold).toBeEnabled();
    expect(await hold.evaluate(el => getComputedStyle(el).touchAction)).toBe('none');
    expect(await item.evaluate(el => getComputedStyle(el).cursor)).toBe('pointer');
    expect(await hold.getAttribute('aria-label')).toBe("Hold to unlock 'Solution'");
    const at = await hold.boundingBox();
    if (!at) throw new Error('the hold control is not drawn');
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await page.mouse.down();
    await expect.poll(() => posts.length, { timeout: 5_000 }).toBe(3);
    await page.mouse.up();
    expect(posts[2]).toEqual({ blockId: 'lock', intent: 'unlock' });
    await page.waitForTimeout(500);
    expect(posts).toHaveLength(3);
  });
});

test.describe('a click selects nothing in the reader', () => {
  test('a block made the selected node gets no selection overlay', async ({ page }) => {
    await mountReader(page, [
      { type: 'navGrid', props: {} },
      { type: 'callout', props: { emoji: '🔥' }, content: 'A callout' },
      { type: 'terminal', props: { code: 'npm install', title: 'Terminal' } },
    ]);
    // BlockNote's rule, read from its own stylesheet: the test fails if the
    // class it keys on is ever renamed, instead of passing on nothing.
    const drawn = await page.evaluate(() => {
      const results: { type: string | null; before: string; after: string }[] = [];
      for (const content of document.querySelectorAll('.bn-block-content')) {
        const wrapper = content.parentElement?.classList.contains('react-renderer')
          ? content.parentElement
          : content;
        const target = content.firstElementChild;
        if (!target) continue;
        const before = getComputedStyle(target, '::after').content;
        wrapper.classList.add('ProseMirror-selectednode');
        const after = getComputedStyle(target, '::after').content;
        const editor = content.closest('.bn-editor') as HTMLElement;
        // The same node in an EDITABLE editor must still get the overlay.
        editor.setAttribute('contenteditable', 'true');
        const editable = getComputedStyle(target, '::after').content;
        editor.setAttribute('contenteditable', 'false');
        wrapper.classList.remove('ProseMirror-selectednode');
        results.push({
          type: content.getAttribute('data-content-type'),
          before,
          after: `${after}|${editable}`,
        });
      }
      return results;
    });
    expect(drawn.length).toBeGreaterThanOrEqual(3);
    for (const block of drawn) {
      const [reader, editable] = block.after.split('|');
      expect(reader, `${block.type} in the reader`).toBe('none');
      expect(editable, `${block.type} in an editor`).toBe('""');
    }
  });
});
