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

import { test, expect } from '@playwright/test';

import {
  addHeadingAnchors,
  renderSitePage,
  siteArticleWrapper,
  slugifyHeading,
} from '~/site/render.server.ts';
import { redactDocumentForViewer } from '~/site/redact.server.ts';
import { allBlockTypes, OVERRIDDEN_BLOCK_TYPES } from '~/site/viewerSchema.server.ts';
import { migrateHtmlToBlockNote } from '~/utils/migration.server.ts';
import { schema } from '~/components/editor/blocks/index.tsx';

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
      { type: 'column', props: { width: 1 }, children: [{ type: 'paragraph', content: text('L') }] },
      { type: 'column', props: { width: 1 }, children: [{ type: 'paragraph', content: text('R') }] },
    ],
  },
  // `column` never appears at the top level; it is exercised inside columnList.
  column: null,
  callout: { type: 'callout', props: { emoji: '💡' }, content: text('callout body') },
  terminal: { type: 'terminal', props: { code: 'npm run dev', title: 'Terminal' } },
  profile: { type: 'profile', props: { name: 'Ada', title: 'Instructor', imageUrl: '', links: '' } },
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
