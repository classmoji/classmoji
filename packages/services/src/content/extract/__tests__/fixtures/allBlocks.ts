/**
 * One BlockNote document containing every block type in this app's editor
 * schema (`apps/pages/app/components/editor/blocks/index.tsx:54-71`).
 *
 * Real cs52 content (the `.json` / `.html` files beside this one) proves the
 * extractor works on production documents, but no single real page uses all 21
 * types — so this fixture exists to hold the block table to its word.
 *
 * Two families of sentinel:
 *   `*_TEXT` / `*_NAME` / `*_CAPTION` …  MUST reach the extracted text.
 *   `NOISE_*`                            MUST NOT — formatting props, asset
 *                                        URLs, ids and language tags.
 *
 * Prop shapes are the real ones, read off the specs: BlockNote 0.46.2's
 * `defaultBlockSpecs`, `multiColumnSchema.blockSpecs`, and the nine overrides in
 * `apps/pages/app/components/editor/blocks/*.tsx`.
 */

const text = (value: string) => ({ type: 'text', text: value, styles: {} });

const inlineProps = {
  backgroundColor: 'NOISE_BG',
  textColor: 'NOISE_FG',
  textAlignment: 'NOISE_ALIGN',
};

/** `navGrid.entries` is a JSON-encoded STRING — props must be primitives. */
export const NAV_GRID_ENTRIES = JSON.stringify([
  { kind: 'page', pageId: 'NAVGRID_TARGET_ID', title: 'NAVGRID_PAGE_TITLE' },
  { kind: 'external', url: 'https://example.com/somewhere', label: 'NAVGRID_EXTERNAL_LABEL' },
  { kind: 'external', url: 'https://www.navgrid-fallback.test/deep/path' },
  { kind: 'schedule' },
  // Unsafe protocol: dropped entirely, so it is not even a reference.
  { kind: 'external', url: 'javascript:alert(1)', label: 'NOISE_BLOCKED_ENTRY' },
  // Duplicate target: one reference, not two.
  { kind: 'page', pageId: 'NAVGRID_TARGET_ID', title: 'NAVGRID_PAGE_TITLE' },
]);

export const ALL_BLOCKS: unknown[] = [
  {
    id: 'b-heading',
    type: 'heading',
    props: { ...inlineProps, level: 2, isToggleable: false },
    content: [text('HEADING_TEXT')],
    children: [],
  },
  {
    id: 'b-paragraph',
    type: 'paragraph',
    props: inlineProps,
    // A styled run split mid-sentence: the two pieces must rejoin with no
    // extra space, and the link's own child text must come through.
    content: [
      text('PARAGRAPH_TEXT '),
      { type: 'text', text: 'bolded', styles: { bold: true } },
      { type: 'link', href: 'https://example.com/NOISE_LINK_HREF', content: [text(' LINK_TEXT')] },
    ],
    children: [],
  },
  {
    id: 'b-bullet',
    type: 'bulletListItem',
    props: inlineProps,
    content: [text('BULLET_TEXT')],
    // Nested list item — invisible without the `children` recursion.
    children: [
      {
        id: 'b-bullet-nested',
        type: 'bulletListItem',
        props: inlineProps,
        content: [text('BULLET_NESTED_TEXT')],
        children: [],
      },
    ],
  },
  {
    id: 'b-numbered',
    type: 'numberedListItem',
    props: { ...inlineProps, start: 1 },
    content: [text('NUMBERED_TEXT')],
    children: [],
  },
  {
    id: 'b-check',
    type: 'checkListItem',
    props: { ...inlineProps, checked: false },
    content: [text('CHECK_TEXT')],
    children: [],
  },
  {
    id: 'b-toggle',
    type: 'toggleListItem',
    props: inlineProps,
    content: [text('TOGGLE_TEXT')],
    children: [
      {
        id: 'b-toggle-child',
        type: 'paragraph',
        props: inlineProps,
        content: [text('TOGGLE_CHILD_TEXT')],
        children: [],
      },
    ],
  },
  {
    id: 'b-quote',
    type: 'quote',
    props: { backgroundColor: 'NOISE_BG', textColor: 'NOISE_FG' },
    content: [text('QUOTE_TEXT')],
    children: [],
  },
  {
    id: 'b-code',
    type: 'codeBlock',
    props: { language: 'NOISE_LANGUAGE' },
    content: [text('CODEBLOCK_TEXT')],
    children: [],
  },
  {
    id: 'b-callout',
    type: 'callout',
    props: { textAlignment: 'NOISE_ALIGN', emoji: '💡' },
    content: [text('CALLOUT_TEXT')],
    children: [],
  },
  {
    id: 'b-table',
    type: 'table',
    props: { textColor: 'NOISE_FG' },
    content: {
      type: 'tableContent',
      columnWidths: [null, null],
      headerRows: 1,
      rows: [
        {
          cells: [
            { type: 'tableCell', content: [text('TABLE_HEAD_A')], props: { colspan: 1 } },
            { type: 'tableCell', content: [text('TABLE_HEAD_B')], props: { colspan: 1 } },
          ],
        },
        {
          cells: [
            { type: 'tableCell', content: [text('TABLE_CELL_A')], props: { colspan: 1 } },
            { type: 'tableCell', content: [text('TABLE_CELL_B')], props: { colspan: 1 } },
          ],
        },
      ],
    },
    children: [],
  },
  {
    id: 'b-file',
    type: 'file',
    props: {
      backgroundColor: 'NOISE_BG',
      name: 'FILE_NAME.pdf',
      url: 'https://cdn.example.com/NOISE_FILE_URL.pdf',
      caption: 'FILE_CAPTION',
    },
    children: [],
  },
  {
    id: 'b-image',
    type: 'image',
    props: {
      textAlignment: 'NOISE_ALIGN',
      backgroundColor: 'NOISE_BG',
      name: 'IMAGE_NAME.png',
      url: 'https://cdn.example.com/NOISE_IMAGE_URL.png',
      caption: 'IMAGE_CAPTION',
      showPreview: true,
      previewWidth: 512,
    },
    children: [],
  },
  {
    id: 'b-video',
    type: 'video',
    props: { url: 'https://youtu.be/NOISE_VIDEO_URL', caption: 'VIDEO_CAPTION' },
    children: [],
  },
  { id: 'b-divider', type: 'divider', props: {}, children: [] },
  {
    id: 'b-embed',
    type: 'embed',
    props: { url: 'https://example.com/NOISE_EMBED_URL', type: 'NOISE_EMBED_TYPE' },
    children: [],
  },
  {
    id: 'b-columnlist',
    type: 'columnList',
    props: {},
    // No content, no text props: every word below is reachable only through
    // `children`, two levels down.
    children: [
      {
        id: 'b-column-1',
        type: 'column',
        props: { width: 1 },
        children: [
          {
            id: 'b-column-1-heading',
            type: 'heading',
            props: { ...inlineProps, level: 3 },
            content: [text('COLUMN_HEADING_TEXT')],
            children: [],
          },
        ],
      },
      {
        id: 'b-column-2',
        type: 'column',
        props: { width: 1 },
        children: [
          {
            id: 'b-column-2-paragraph',
            type: 'paragraph',
            props: inlineProps,
            content: [text('COLUMN_PARAGRAPH_TEXT')],
            children: [],
          },
        ],
      },
    ],
  },
  {
    id: 'b-terminal',
    type: 'terminal',
    props: { code: 'TERMINAL_CODE npm run dev', title: 'TERMINAL_TITLE' },
    children: [],
  },
  {
    id: 'b-profile',
    type: 'profile',
    props: {
      name: 'PROFILE_NAME',
      title: 'PROFILE_TITLE',
      imageUrl: 'https://cdn.example.com/NOISE_PROFILE_IMAGE.jpg',
      links: 'PROFILE_LINKS',
    },
    children: [],
  },
  {
    id: 'b-pagelink',
    type: 'pageLink',
    props: { pageId: 'PAGELINK_TARGET_ID', pageTitle: 'PAGELINK_TITLE' },
    children: [],
  },
  {
    id: 'b-navgrid',
    type: 'navGrid',
    props: { entries: NAV_GRID_ENTRIES, columns: 2 },
    children: [],
  },
];

/** Every sentinel that MUST survive extraction. */
export const EXPECTED_TEXT = [
  'HEADING_TEXT',
  'PARAGRAPH_TEXT bolded LINK_TEXT',
  'BULLET_TEXT',
  'BULLET_NESTED_TEXT',
  'NUMBERED_TEXT',
  'CHECK_TEXT',
  'TOGGLE_TEXT',
  'TOGGLE_CHILD_TEXT',
  'QUOTE_TEXT',
  'CODEBLOCK_TEXT',
  'CALLOUT_TEXT',
  'TABLE_HEAD_A',
  'TABLE_HEAD_B',
  'TABLE_CELL_A',
  'TABLE_CELL_B',
  'FILE_NAME.pdf',
  'FILE_CAPTION',
  'IMAGE_NAME.png',
  'IMAGE_CAPTION',
  'VIDEO_CAPTION',
  'COLUMN_HEADING_TEXT',
  'COLUMN_PARAGRAPH_TEXT',
  'TERMINAL_CODE npm run dev',
  'TERMINAL_TITLE',
  'PROFILE_NAME',
  'PROFILE_TITLE',
  'PROFILE_LINKS',
];

/**
 * Every sentinel that MUST NOT reach the extracted text.
 *
 * The `PAGELINK_*` / `NAVGRID_*` entries are not noise — they are the titles
 * and ids of OTHER documents. They belong in `references`, never in `text`:
 * this page's draft state says nothing about theirs.
 */
export const EXPECTED_ABSENT = [
  'PAGELINK_TITLE',
  'PAGELINK_TARGET_ID',
  'NAVGRID_PAGE_TITLE',
  'NAVGRID_EXTERNAL_LABEL',
  'NAVGRID_TARGET_ID',
  'navgrid-fallback.test',
  'example.com/somewhere',
  'NOISE_BG',
  'NOISE_FG',
  'NOISE_ALIGN',
  'NOISE_LANGUAGE',
  'NOISE_LINK_HREF',
  'NOISE_FILE_URL',
  'NOISE_IMAGE_URL',
  'NOISE_VIDEO_URL',
  'NOISE_EMBED_URL',
  'NOISE_EMBED_TYPE',
  'NOISE_PROFILE_IMAGE',
  'NOISE_BLOCKED_ENTRY',
];

/** The outbound references this document declares, in order, deduped. */
export const EXPECTED_REFERENCES = [
  { kind: 'page', id: 'PAGELINK_TARGET_ID' },
  { kind: 'page', id: 'NAVGRID_TARGET_ID' },
  { kind: 'external', id: 'https://example.com/somewhere' },
  { kind: 'external', id: 'https://www.navgrid-fallback.test/deep/path' },
  { kind: 'schedule', id: '' },
];
