/**
 * Unit tests for the class-site SSR renderer.
 *
 * These run in the Playwright runner without a browser or the dev stack: the
 * renderer is a pure function of (document, viewer link resolver).
 *
 * What they exist to hold:
 *  - EVERY block type in the editor schema can be serialized. Two of them have
 *    historically taken down the whole render (pageLink via `useNavigate`,
 *    toggles via `localStorage` on an opaque origin), and a third silently
 *    disappeared. The coverage test is schema-derived, so adding a block to
 *    the editor fails here until it has been considered for the site.
 *  - A viewer never sees, in the HTML, the TITLE of a page they may not open.
 *    That leak is invisible on screen — it lives in `data-*` attributes.
 *  - Concurrent renders do not corrupt each other, despite BlockNote
 *    serializing through process-global JSDOM.
 */

import * as fs from 'fs';

import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations and `@types/jsdom` is
// not a dependency; the cast below pins the shape this file uses.
import { JSDOM as UntypedJSDOM } from 'jsdom';

import {
  addHeadingAnchors,
  renderSitePage,
  siteArticleWidthClass,
  siteArticleWrapper,
  slugifyHeading,
} from '~/site/render.server.ts';
import { SITE_STYLES } from '~/site/styles.ts';
import { redactDocumentForViewer } from '~/site/redact.server.ts';
import { allBlockTypes, OVERRIDDEN_BLOCK_TYPES } from '~/site/viewerSchema.server.ts';
import { migrateHtmlToBlockNote } from '~/utils/migration.server.ts';
import { schema } from '~/components/editor/blocks/index.tsx';

const JSDOM = UntypedJSDOM as new (html?: string) => { window: { document: Document } };

/** Parse rendered HTML so assertions can ask about ELEMENTS, not substrings. */
const parse = (html: string): Document => new JSDOM(`<body>${html}</body>`).window.document;

/** A resolver where `visible` is readable and everything else is not. */
const resolveLink = (pageId: string) =>
  pageId === 'visible' ? { href: '/syllabus', title: 'Syllabus' } : null;

/** A resolver that hides everything — the anonymous-visitor case. */
const resolveNothing = () => null;

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];

/**
 * One sample block per type in the editor schema.
 *
 * Deliberately exhaustive and deliberately hand-written: the point is that a
 * human decided what each block should look like on a public site.
 */
const SAMPLES: Record<string, unknown> = {
  paragraph: { type: 'paragraph', content: text('a paragraph') },
  heading: { type: 'heading', props: { level: 2 }, content: text('A Heading') },
  bulletListItem: { type: 'bulletListItem', content: text('bullet') },
  numberedListItem: { type: 'numberedListItem', content: text('numbered') },
  checkListItem: { type: 'checkListItem', props: { checked: true }, content: text('checked') },
  toggleListItem: { type: 'toggleListItem', content: text('toggle') },
  quote: { type: 'quote', content: text('quoted') },
  codeBlock: { type: 'codeBlock', props: { language: 'js' }, content: text('const a = 1;') },
  image: {
    type: 'image',
    props: { url: 'https://example.test/a.png', caption: 'cap', previewWidth: 400 },
  },
  file: { type: 'file', props: { url: 'https://example.test/a.pdf', name: 'a.pdf' } },
  table: {
    type: 'table',
    content: { type: 'tableContent', rows: [{ cells: [text('cell')] }] },
  },
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
  // `column` never appears at the top level; it is exercised inside columnList.
  column: null,
  callout: { type: 'callout', props: { emoji: '💡' }, content: text('callout body') },
  terminal: { type: 'terminal', props: { code: 'npm run dev', title: 'Terminal' } },
  profile: {
    type: 'profile',
    props: { name: 'Ada', title: 'Instructor', imageUrl: '', links: '' },
  },
  divider: { type: 'divider' },
  embed: { type: 'embed', props: { url: 'https://example.test/embed', type: '' } },
  video: { type: 'video', props: { url: 'https://youtu.be/abc123', caption: 'a video' } },
  pageLink: { type: 'pageLink', props: { pageId: 'visible', pageTitle: 'Syllabus' } },
  navGrid: {
    type: 'navGrid',
    props: {
      entries: JSON.stringify([{ kind: 'page', pageId: 'visible', title: 'Syllabus' }]),
      columns: 2,
    },
  },
};

test.describe('block coverage', () => {
  test('every block type in the editor schema has a considered site rendering', () => {
    const schemaTypes = allBlockTypes();
    const covered = Object.keys(SAMPLES).sort();

    // Fails the moment a block is added to the editor without deciding what it
    // does on a public site.
    expect(covered).toEqual(schemaTypes);
  });

  test('overridden types are all real block types', () => {
    const schemaTypes = new Set(allBlockTypes());
    for (const type of OVERRIDDEN_BLOCK_TYPES) {
      expect(schemaTypes.has(type), `${type} is not in the editor schema`).toBe(true);
    }
  });

  /**
   * How a rendered block of each type is recognized in the HTML.
   *
   * Almost every block lands inside a `bn-block-content` wrapper carrying
   * `data-content-type`; the multi-column blocks are structural and instead
   * carry `data-node-type` on their own container.
   */
  const marker = (type: string): string =>
    type === 'columnList' || type === 'column'
      ? `data-node-type="${type}"`
      : `data-content-type="${type}"`;

  for (const [type, block] of Object.entries(SAMPLES)) {
    if (!block) continue;
    test(`renders ${type} without throwing`, async () => {
      const { html } = await renderSitePage({ blocks: [block], resolveLink });
      expect(html).toContain(marker(type));
    });
  }

  test('renders the whole sample document in one pass', async () => {
    const blocks = Object.values(SAMPLES).filter(Boolean);
    const { html } = await renderSitePage({ blocks, resolveLink });
    for (const type of Object.keys(SAMPLES)) {
      // `column` has no standalone sample but is rendered inside columnList,
      // so its marker is expected here too.
      expect(html, `${type} missing from combined render`).toContain(marker(type));
    }
  });
});

test.describe('editor affordances are stripped', () => {
  test('code blocks ship no language picker', async () => {
    const { html } = await renderSitePage({ blocks: [SAMPLES.codeBlock], resolveLink });
    expect(html).not.toContain('<select');
    expect(html).toContain('<pre');
    expect(html).toContain('const a = 1;');
  });

  test('profile blocks ship no text inputs or upload control', async () => {
    const { html } = await renderSitePage({ blocks: [SAMPLES.profile], resolveLink });
    expect(html).not.toContain('<input');
    expect(html).toContain('Ada');
    expect(html).toContain('Instructor');
  });

  test('terminal blocks ship the code as text, not a textarea', async () => {
    const { html } = await renderSitePage({ blocks: [SAMPLES.terminal], resolveLink });
    expect(html).not.toContain('<textarea');
    expect(html).toContain('npm run dev');
  });

  test('the only inputs anywhere are disabled checkboxes', async () => {
    const blocks = Object.values(SAMPLES).filter(Boolean);
    const { html } = await renderSitePage({ blocks, resolveLink });
    const inputs = html.match(/<input[^>]*>/g) ?? [];
    for (const input of inputs) {
      expect(input, `unexpected interactive input: ${input}`).toContain('disabled');
    }
  });

  /**
   * BlockNote class names that only exist in EDITOR states.
   *
   * `<input>`/`<select>`/`<textarea>` was too narrow a scan: BlockNote's file
   * wrapper builds its "Add image" control out of plain `<div>`s, so the tag
   * check saw nothing while a clickable upload affordance shipped to the
   * public site.
   */
  const EDITOR_ONLY_CLASSES = ['bn-add-file-button', 'bn-file-loading-preview'];

  /**
   * The blocks whose EMPTY state is an editor control.
   *
   * `image` and `file` are not overridden in the viewer schema (their populated
   * renders are correct for a static page), and BlockNote's `FileBlockWrapper`
   * branches on `props.url === ''` to render "Add image" / "Add file". Leaving
   * an image block unset is a completely ordinary authoring mistake, so this is
   * the common case rather than an exotic one. Kept OUT of `SAMPLES` on
   * purpose: that map is the block-coverage contract and must keep describing
   * one populated sample per type.
   */
  const EMPTY_FILE_SAMPLES: Record<string, unknown> = {
    image: { type: 'image', props: { url: '' } },
    file: { type: 'file', props: { url: '' } },
  };

  for (const [type, block] of Object.entries(EMPTY_FILE_SAMPLES)) {
    test(`an unset ${type} block ships no add-file affordance`, async () => {
      const { html } = await renderSitePage({ blocks: [block], resolveLink });
      for (const className of EDITOR_ONLY_CLASSES) {
        expect(html, `${type} shipped ${className}`).not.toContain(className);
      }
      expect(html).not.toContain('Add image');
      expect(html).not.toContain('Add file');
      // It renders as nothing at all, like every other redacted block.
      expect(html).toContain('data-content-type="paragraph"');
    });
  }

  test('unset file blocks stay inert inside a full document render', async () => {
    const blocks = [
      ...Object.values(SAMPLES).filter(Boolean),
      ...Object.values(EMPTY_FILE_SAMPLES),
    ];
    const { html } = await renderSitePage({ blocks, resolveLink });
    for (const className of EDITOR_ONLY_CLASSES) {
      expect(html, `combined render shipped ${className}`).not.toContain(className);
    }
    // The POPULATED samples still render — this is not a blanket ban on files.
    expect(html).toContain('https://example.test/a.png');
    expect(html).toContain('https://example.test/a.pdf');
  });

  test('unset file blocks nested inside a column are redacted too', async () => {
    const { html } = await renderSitePage({
      blocks: [
        {
          type: 'columnList',
          children: [
            { type: 'column', props: { width: 1 }, children: [EMPTY_FILE_SAMPLES.image] },
            { type: 'column', props: { width: 1 }, children: [EMPTY_FILE_SAMPLES.file] },
          ],
        },
      ],
      resolveLink,
    });
    for (const className of EDITOR_ONLY_CLASSES) {
      expect(html, `nested render shipped ${className}`).not.toContain(className);
    }
  });
});

test.describe('embedded media is sandboxed', () => {
  test('https embeds get a restrictive sandbox and no top-navigation', async () => {
    const { html } = await renderSitePage({ blocks: [SAMPLES.embed], resolveLink });
    expect(html).toContain('sandbox="allow-scripts allow-same-origin allow-presentation"');
    expect(html).not.toContain('allow-top-navigation');
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('loading="lazy"');
  });

  test('non-https embeds degrade to a plain link instead of a blocked frame', async () => {
    const { html } = await renderSitePage({
      blocks: [{ type: 'embed', props: { url: 'http://insecure.test/x', type: '' } }],
      resolveLink,
    });
    expect(html).not.toContain('<iframe');
    expect(html).toContain('href="http://insecure.test/x"');
  });

  test('youtube urls become embed urls', async () => {
    const { html } = await renderSitePage({ blocks: [SAMPLES.video], resolveLink });
    expect(html).toContain('https://www.youtube.com/embed/abc123');
  });
});

test.describe('per-viewer visibility', () => {
  const HIDDEN_TITLE = 'Exam 2 Solutions';

  const hidingDocument = [
    { type: 'pageLink', props: { pageId: 'secret', pageTitle: HIDDEN_TITLE } },
    {
      type: 'navGrid',
      props: {
        entries: JSON.stringify([
          { kind: 'page', pageId: 'visible', title: 'Syllabus', emoji: '📘' },
          { kind: 'page', pageId: 'secret', title: HIDDEN_TITLE },
          { kind: 'external', url: 'https://dartmouth.edu', label: 'Dartmouth' },
        ]),
        columns: 2,
      },
    },
  ];

  test('a hidden page title appears nowhere in the HTML, including data attributes', async () => {
    const { html } = await renderSitePage({ blocks: hidingDocument, resolveLink });
    expect(html).not.toContain(HIDDEN_TITLE);
    expect(html).not.toContain('secret');
  });

  test('visible entries still render, with real hrefs', async () => {
    const { html } = await renderSitePage({ blocks: hidingDocument, resolveLink });
    expect(html).toContain('href="/syllabus"');
    expect(html).toContain('Syllabus');
    expect(html).toContain('href="https://dartmouth.edu/"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test('an anonymous viewer who may see nothing gets no page links at all', async () => {
    const { html } = await renderSitePage({ blocks: hidingDocument, resolveLink: resolveNothing });
    expect(html).not.toContain(HIDDEN_TITLE);
    expect(html).not.toContain('Syllabus');
    // The external entry is not page-gated and survives.
    expect(html).toContain('Dartmouth');
  });

  test('navGrid honours the columns prop', async () => {
    const { html } = await renderSitePage({
      blocks: [
        {
          type: 'navGrid',
          props: {
            entries: JSON.stringify([{ kind: 'external', url: 'https://a.test', label: 'A' }]),
            columns: 1,
          },
        },
      ],
      resolveLink,
    });
    expect(html).toContain('data-columns="1"');
    expect(html).toContain('repeat(1, minmax(0, 1fr))');
  });

  test('every navGrid tile carries an emoji slot, with or without an emoji', async () => {
    // The slot is a fixed-width column inside the tile. Emitting it only when
    // an emoji was authored left every plain tile's label starting further
    // left than its neighbour's.
    const { html } = await renderSitePage({
      blocks: [
        {
          type: 'navGrid',
          props: {
            entries: JSON.stringify([
              { kind: 'page', pageId: 'visible', title: 'Syllabus', emoji: '📌' },
              { kind: 'page', pageId: 'visible', title: 'Resources' },
            ]),
            columns: 2,
          },
        },
      ],
      resolveLink,
    });

    const document = parse(html);
    const tiles = [...document.querySelectorAll('.bn-nav-grid-item')];
    expect(tiles).toHaveLength(2);
    expect(tiles[0].querySelector('.bn-nav-grid-emoji')?.textContent).toBe('📌');
    expect(tiles[1].querySelector('.bn-nav-grid-emoji')?.textContent).toBe('');
  });

  test('a members-only entry is badged, for the member who can already open it', async () => {
    const { html } = await renderSitePage({
      blocks: [
        {
          type: 'navGrid',
          props: {
            entries: JSON.stringify([
              { kind: 'page', pageId: 'members', title: 'Solutions' },
              { kind: 'page', pageId: 'visible', title: 'Syllabus' },
            ]),
            columns: 2,
          },
        },
      ],
      // A member's resolver: both pages resolve, one of them members-only.
      resolveLink: (pageId: string) =>
        pageId === 'members'
          ? { href: '/solutions', title: 'Solutions', membersOnly: true }
          : pageId === 'visible'
            ? { href: '/syllabus', title: 'Syllabus' }
            : null,
    });

    const document = parse(html);
    const badges = [...document.querySelectorAll('.bn-nav-grid-badge')];
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toBe('Members');
    // On the members-only tile, not the public one beside it.
    expect(badges[0].closest('.bn-nav-grid-item')?.getAttribute('href')).toBe('/solutions');
  });

  /** A directory holding the schedule beside an ordinary page. */
  const scheduleDocument = [
    {
      type: 'navGrid',
      props: {
        entries: JSON.stringify([
          { kind: 'page', pageId: 'visible', title: 'Syllabus' },
          { kind: 'schedule' },
        ]),
        columns: 2,
      },
    },
  ];

  test('a schedule entry links to /schedule when the schedule is published', async () => {
    const { html } = await renderSitePage({
      blocks: scheduleDocument,
      resolveLink,
      showSchedule: true,
    });

    const document = parse(html);
    const tile = document.querySelector('.bn-nav-grid-item[data-kind="schedule"]');
    expect(tile).not.toBeNull();
    expect(tile!.getAttribute('href')).toBe('/schedule');
    // Default label and emoji come from the render, never from storage.
    expect(tile!.querySelector('.bn-nav-grid-label')?.textContent).toBe('Schedule');
    expect(tile!.querySelector('.bn-nav-grid-emoji')?.textContent).toBe('📅');
    // The page beside it is untouched.
    expect(document.querySelectorAll('.bn-nav-grid-item')).toHaveLength(2);
  });

  test('a schedule entry disappears when the schedule is not published', async () => {
    // `/schedule` 404s with the setting off, so the tile would be a link into
    // a wall. Dropped the way an invisible page is — never rendered disabled.
    const { html } = await renderSitePage({
      blocks: scheduleDocument,
      resolveLink,
      showSchedule: false,
    });

    const document = parse(html);
    expect(document.querySelector('[data-kind="schedule"]')).toBeNull();
    expect(document.querySelectorAll('.bn-nav-grid-item')).toHaveLength(1);
  });

  test('a caller that never mentions the schedule does not link to it', async () => {
    // The default is the safe one: every existing call site renders no tile
    // rather than a link that may 404.
    const { html } = await renderSitePage({ blocks: scheduleDocument, resolveLink });
    expect(html).not.toContain('data-kind="schedule"');
  });

  test('an authored label and emoji win over the defaults', async () => {
    const { html } = await renderSitePage({
      blocks: [
        {
          type: 'navGrid',
          props: {
            entries: JSON.stringify([{ kind: 'schedule', label: 'Weekly plan', emoji: '🗓️' }]),
            columns: 1,
          },
        },
      ],
      resolveLink,
      showSchedule: true,
    });

    const document = parse(html);
    const tile = document.querySelector('[data-kind="schedule"]')!;
    expect(tile.querySelector('.bn-nav-grid-label')?.textContent).toBe('Weekly plan');
    expect(tile.querySelector('.bn-nav-grid-emoji')?.textContent).toBe('🗓️');
  });

  test('an anonymous viewer gets no badge, because the entry never resolves', async () => {
    // The flag is never what hides a page — the resolver is. This pins that
    // the badge cannot become a leak just by existing.
    const { html } = await renderSitePage({
      blocks: [
        {
          type: 'navGrid',
          props: {
            entries: JSON.stringify([{ kind: 'page', pageId: 'members', title: 'Solutions' }]),
            columns: 2,
          },
        },
      ],
      resolveLink: resolveNothing,
    });
    expect(html).not.toContain('bn-nav-grid-badge');
    expect(html).not.toContain('Solutions');
  });

  test('redaction reaches page links nested inside columns', () => {
    const nested = [
      {
        type: 'columnList',
        children: [
          {
            type: 'column',
            children: [{ type: 'pageLink', props: { pageId: 'secret', pageTitle: HIDDEN_TITLE } }],
          },
        ],
      },
    ];
    const redacted = JSON.stringify(redactDocumentForViewer(nested, resolveLink));
    expect(redacted).not.toContain(HIDDEN_TITLE);
    expect(redacted).not.toContain('pageLink');
  });
});

test.describe('heading anchors', () => {
  test('h1-h3 get slugified ids', async () => {
    const { html } = await renderSitePage({
      blocks: [
        { type: 'heading', props: { level: 1 }, content: text('Grading & Late Work') },
        { type: 'heading', props: { level: 3 }, content: text('Office Hours') },
      ],
      resolveLink,
    });
    expect(html).toContain('id="grading-late-work"');
    expect(html).toContain('id="office-hours"');
  });

  test('duplicate headings get distinct ids', () => {
    const { html, headings } = addHeadingAnchors(
      '<h2>Grading</h2><h2>Grading</h2><h2>Grading</h2>'
    );
    expect(html).toContain('id="grading"');
    expect(html).toContain('id="grading-2"');
    expect(html).toContain('id="grading-3"');
    expect(headings.map(h => h.id)).toEqual(['grading', 'grading-2', 'grading-3']);
  });

  test('an existing id is never overwritten', () => {
    const { html } = addHeadingAnchors('<h1 id="kept">Title</h1>');
    expect(html).toBe('<h1 id="kept">Title</h1>');
  });

  test('h4-h6 are left alone', () => {
    const { html } = addHeadingAnchors('<h4>Deep</h4>');
    expect(html).toBe('<h4>Deep</h4>');
  });

  test('slugify degrades to a stable fallback', () => {
    expect(slugifyHeading('!!!')).toBe('section');
    expect(slugifyHeading('  Hello   World  ')).toBe('hello-world');
  });

  /**
   * The anchor pass used to be a regex that spliced `id="slug"` back into
   * whatever it matched. BlockNote writes every block prop onto the block
   * wrapper as a `data-*` attribute, and block props are AUTHOR-CONTROLLED —
   * so a terminal block whose `code` reads `<h1 a>b</h1>` matched the regex
   * *inside `data-code="…"`* and got two unescaped quote characters spliced
   * into the attribute value. The first quote closes the attribute and
   * everything after it becomes live markup: a stored XSS reachable from an
   * ordinary block field, on a public multi-tenant host.
   *
   * The fix parses, mutates and re-serializes, so an id can no longer be
   * written anywhere except as a real attribute.
   *
   * NOTE what is deliberately NOT asserted: the payload text still appears in
   * the output, because the HTML serialization spec escapes only `&`, `"` and
   * nbsp inside an attribute value — `<` is legal there. That is correct and
   * inert. The invariant is that it stays DATA: no `<img>` element exists in
   * the parsed document, and no element ever got `id="b"`.
   */
  const XSS_PROP = '<h1 a>b</h1><img src=x onerror=alert(1)>';

  test('an author-controlled block prop cannot become markup via the anchor pass', async () => {
    const { html } = await renderSitePage({
      blocks: [{ type: 'terminal', props: { code: XSS_PROP, title: 'Terminal' } }],
      resolveLink,
    });

    const doc = parse(html);
    expect(doc.querySelector('img'), 'the payload broke out of the attribute').toBeNull();
    expect(doc.querySelector('#b'), 'an id was spliced into an attribute value').toBeNull();
    expect(html).not.toContain('id="b"');

    // The attribute survives intact, as one attribute holding the whole value.
    expect(doc.querySelector('[data-code]')?.getAttribute('data-code')).toBe(XSS_PROP);
    // And the code is still displayed to the reader, escaped.
    expect(html).toContain('&lt;h1 a&gt;b&lt;/h1&gt;');
  });

  test('the same payload in a navGrid entry title is inert too', async () => {
    const { html } = await renderSitePage({
      blocks: [
        {
          type: 'navGrid',
          props: {
            entries: JSON.stringify([{ kind: 'external', url: 'https://a.test', label: XSS_PROP }]),
            columns: 1,
          },
        },
      ],
      resolveLink,
    });

    const doc = parse(html);
    expect(doc.querySelector('img')).toBeNull();
    expect(doc.querySelector('#b')).toBeNull();
    expect(html).not.toContain('id="b"');
  });

  test('headings inside real content still get ids after the parse rewrite', () => {
    const { html, headings } = addHeadingAnchors(
      '<div data-code="<h1 a>b</h1>"><h2>Real Heading</h2></div>'
    );
    const doc = parse(html);
    expect(doc.querySelector('h2')?.getAttribute('id')).toBe('real-heading');
    // Only the REAL heading is reported; the one inside the attribute is data.
    expect(headings).toEqual([{ id: 'real-heading', level: 2, text: 'Real Heading' }]);
  });

  test('a slug can never break out of the attribute it is written to', () => {
    // slugifyHeading cannot emit a quote, but the serializer is the actual
    // guarantee: whatever lands in setAttribute comes back escaped.
    const { html } = addHeadingAnchors('<h2>a" onmouseover="alert(1)</h2>');
    const doc = parse(html);
    expect(doc.querySelectorAll('h2')).toHaveLength(1);
    expect(doc.querySelector('h2')?.hasAttribute('onmouseover')).toBe(false);
  });
});

test.describe('wrapper markup', () => {
  test('emits the exact BlockNote wrapper chain', () => {
    const wrapped = siteArticleWrapper('<p>x</p>');
    expect(wrapped).toBe(
      '<div class="bn-root bn-container bn-mantine" data-color-scheme="light" ' +
        'data-mantine-color-scheme="light">' +
        '<div class="ProseMirror bn-editor bn-default-styles"><p>x</p></div></div>'
    );
  });
});

test.describe('resilience', () => {
  test('an empty document renders an empty paragraph, not a crash', async () => {
    const { html } = await renderSitePage({ blocks: [], resolveLink });
    expect(html).toContain('data-content-type="paragraph"');
  });

  test('a non-array document is treated as empty', async () => {
    const { html } = await renderSitePage({ blocks: null, resolveLink });
    expect(html).toContain('data-content-type="paragraph"');
  });

  test('legacy HTML survives the migration path and renders', async () => {
    const legacy =
      '<html><body><h1>Old Title</h1><p>Legacy body text.</p>' +
      '<ul><li>one</li><li>two</li></ul></body></html>';
    const blocks = await migrateHtmlToBlockNote(legacy, schema);
    const { html } = await renderSitePage({ blocks, resolveLink });
    expect(html).toContain('Legacy body text.');
    expect(html).toContain('data-content-type="bulletListItem"');
  });

  /**
   * The regression this guards: BlockNote serializes by swapping
   * `globalThis.window`/`document` for JSDOM. Two renders in flight at once
   * would interleave on those globals and splice one visitor's page into
   * another's — on a multi-tenant public host.
   */
  test('20 concurrent renders do not contaminate each other', async () => {
    const renders = Array.from({ length: 20 }, (_, i) =>
      renderSitePage({
        blocks: [
          { type: 'heading', props: { level: 2 }, content: text(`Heading ${i}`) },
          { type: 'paragraph', content: text(`unique-marker-${i}-end`) },
          { type: 'terminal', props: { code: `run-${i}`, title: `T${i}` } },
        ],
        resolveLink,
      })
    );

    const results = await Promise.all(renders);

    results.forEach((result, i) => {
      expect(result.html, `render ${i} lost its own content`).toContain(`unique-marker-${i}-end`);
      expect(result.html, `render ${i} lost its terminal`).toContain(`run-${i}`);

      for (let other = 0; other < 20; other++) {
        if (other === i) continue;
        expect(
          result.html.includes(`unique-marker-${other}-end`),
          `render ${i} was contaminated by render ${other}`
        ).toBe(false);
      }
    });
  });

  test('renders remain correct when interleaved with legacy migrations', async () => {
    const work = Array.from({ length: 6 }, (_, i) =>
      i % 2 === 0
        ? renderSitePage({
            blocks: [{ type: 'paragraph', content: text(`direct-${i}`) }],
            resolveLink,
          }).then(r => r.html)
        : migrateHtmlToBlockNote(`<body><p>migrated-${i}</p></body>`, schema)
            .then(blocks => renderSitePage({ blocks, resolveLink }))
            .then(r => r.html)
    );

    const results = await Promise.all(work);
    results.forEach((html, i) => {
      expect(html).toContain(i % 2 === 0 ? `direct-${i}` : `migrated-${i}`);
    });
  });
});

/**
 * The site and the editor are two renderings of ONE page, and the places where
 * they are styled by different stylesheets are where they drift apart in ways
 * no unit test would otherwise see.
 */
test.describe('editor parity', () => {
  /** Every `height:` declared for `.page-header-image`, in source order. */
  const coverHeights = (css: string): string[] => {
    const heights: string[] = [];
    const blocks = css.matchAll(/\.page-header-image\s*\{([^}]*)\}/g);
    for (const [, body] of blocks) {
      const height = body.match(/height:\s*([^;]+);/);
      if (height) heights.push(height[1].trim());
    }
    return heights;
  };

  test('the cover band is the same height on the site as in the editor', () => {
    // A viewport-relative band on the site (20vh, 140-280px) against the
    // editor's fixed 12/16/18rem meant the same cover was cropped differently
    // in the two surfaces — so an author positioned an image against one crop
    // and published another.
    const editorCss = fs.readFileSync(
      new URL('../../app/styles/page-viewer.css', import.meta.url),
      'utf-8'
    );

    const editor = coverHeights(editorCss);
    expect(editor, 'page-viewer.css should still size .page-header-image').not.toHaveLength(0);
    expect(coverHeights(SITE_STYLES)).toEqual(editor);
  });
});

test.describe('article width', () => {
  test('mirrors the editor width map', () => {
    // Same numbers as `widthClasses` in the editor's page route. A page
    // authored at width 3 and served at max-w-3xl is the cramping this fixes.
    expect(siteArticleWidthClass(1)).toBe('max-w-2xl');
    expect(siteArticleWidthClass(2)).toBe('max-w-4xl');
    expect(siteArticleWidthClass(3)).toBe('max-w-5xl');
    expect(siteArticleWidthClass(4)).toBe('max-w-7xl');
  });

  test('an unreadable width keeps the width the site has always used', () => {
    for (const width of [null, undefined, 0, 9, -1]) {
      expect(siteArticleWidthClass(width)).toBe('max-w-3xl');
    }
  });
});

/* ------------------------------------------------------------------ *
 * Responsive images on the class site
 * ------------------------------------------------------------------ */

/**
 * The site renders images through a STATIC image spec, not the editor's.
 *
 * The editor's image block is built on BlockNote's `ResizableFileBlockWrapper`,
 * which needs editor context the server render does not provide: it throws,
 * BlockNote swallows the throw, and the block renders as NOTHING at all. The
 * block-coverage test above is what caught that; these pin what replaced it.
 *
 * Rendering the candidates here rather than post-processing the HTML is also
 * what makes `sizes` correct — `previewWidth` lives in the block's props and
 * nowhere in the markup, and it is the only thing that says how wide the image
 * will actually be laid out.
 */
const SITE_SIGNED = 'https://content.classmoji.io/c/abc/blob/aaa.png?p=month&sig=x';
const SITE_LADDER = `${SITE_SIGNED}&w=800&fmt=auto 800w, ${SITE_SIGNED}&w=1600&fmt=auto 1600w`;

const renderImage = (props: Record<string, unknown>, srcSets?: Record<string, string>) =>
  renderSitePage({
    blocks: [{ type: 'image', props }],
    resolveLink: () => null,
    ...(srcSets ? { srcSets } : {}),
  });

test.describe('class-site images', () => {
  test('renders the image at all — the whole reason it is overridden', async () => {
    const { html } = await renderImage({ url: SITE_SIGNED, caption: 'A diagram' });

    // Matched without the query string: `&` is HTML-escaped inside an
    // attribute value, which is correct and not what this test is about.
    expect(html).toContain('/blob/aaa.png');
    expect(html).toContain('bn-visual-media');
    expect(html).toContain('A diagram');
  });

  test('hangs the candidates and a column-width hint off a plain image', async () => {
    const { html } = await renderImage({ url: SITE_SIGNED }, { [SITE_SIGNED]: SITE_LADDER });

    expect(html).toContain('srcset="');
    expect(html).toContain('800w');
    expect(html).toContain('sizes="(max-width: 1024px) 100vw, 1024px"');
  });

  test('a resized image asks for the width it will actually be painted at', async () => {
    const { html } = await renderImage(
      { url: SITE_SIGNED, previewWidth: 300 },
      { [SITE_SIGNED]: SITE_LADDER }
    );

    // The regression: one global 1024px hint made a 300px image fetch a 2560px
    // rendition. The width also lands inline, so the site matches the editor.
    expect(html).toContain('sizes="min(100vw, 300px)"');
    expect(html).toContain('width: 300px');
  });

  test('an avatar asks for 64px, not a column', async () => {
    const { html } = await renderSitePage({
      blocks: [{ type: 'profile', props: { name: 'Ada', imageUrl: SITE_SIGNED } }],
      resolveLink: () => null,
      srcSets: { [SITE_SIGNED]: SITE_LADDER },
    });

    expect(html).toContain('profile-avatar-image');
    expect(html).toContain('sizes="64px"');
  });

  test('an image with no candidates renders one size and no empty attributes', async () => {
    const { html } = await renderImage({ url: 'https://images.example.com/hero.png' }, {});

    expect(html).toContain('https://images.example.com/hero.png');
    expect(html).not.toContain('srcset');
    expect(html).not.toContain('sizes=');
  });

  test('showPreview:false still renders the filename rather than a picture', async () => {
    const { html } = await renderImage({ url: SITE_SIGNED, name: 'diagram.png', showPreview: false });

    expect(html).toContain('diagram.png');
    expect(html).not.toContain('bn-visual-media');
  });
});
