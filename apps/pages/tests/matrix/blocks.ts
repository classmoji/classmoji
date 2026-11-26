// Every block type in the page editor's schema, plus the combinations that can
// break a stylesheet: nested lists, toggles, colored and checkable headings,
// and steps that hold each kind of block.
export const text = (t: string, styles: Record<string, unknown> = {}) => ({
  type: 'text',
  text: t,
  styles,
});
let n = 0;
export const resetIds = () => {
  n = 0;
};
const id = () => 'm' + ++n;
export const b = (
  type: string,
  props: Record<string, unknown> = {},
  content?: unknown,
  children: unknown[] = []
) => ({
  id: id(),
  type,
  props,
  ...(content === undefined ? {} : { content }),
  children,
});
export const p = (t: string, children: unknown[] = []) => b('paragraph', {}, [text(t)], children);
export const h = (
  level: number,
  t: string,
  extra: Record<string, unknown> = {},
  children: unknown[] = []
) => b('heading', { level, ...extra }, [text(t)], children);
export const li = (
  type: string,
  t: string,
  children: unknown[] = [],
  props: Record<string, unknown> = {}
) => b(type, props, [text(t)], children);
export const code = (src: string) => b('codeBlock', { language: 'javascript' }, [text(src)]);
export const terminal = (src: string) => b('terminal', { code: src, title: 'Terminal' });
export const callout = (t: string) => b('callout', { emoji: '💡' }, [text(t)]);
export const quote = (t: string) => b('quote', {}, [text(t)]);
export const image = () =>
  b('image', {
    name: 'sample.png',
    url: 'https://cdn.example.com/sample.png',
    caption: 'A caption',
    showPreview: true,
    previewWidth: 360,
  });
export const table = () => ({
  id: id(),
  type: 'table',
  props: {},
  children: [],
  content: {
    type: 'tableContent',
    columnWidths: [null, null],
    headerRows: 1,
    rows: [
      {
        cells: [0, 1].map(i => ({
          type: 'tableCell',
          props: { colspan: 1 },
          content: [text('Head ' + i)],
        })),
      },
      {
        cells: [0, 1].map(i => ({
          type: 'tableCell',
          props: { colspan: 1 },
          content: [text('Cell ' + i)],
        })),
      },
    ],
  },
});
export const columns = (...cols: unknown[][]) =>
  b(
    'columnList',
    {},
    undefined,
    cols.map(c => b('column', { width: 1 }, undefined, c))
  );
export const locked = (title: string, children: unknown[]) =>
  b('lockedSection', { title }, undefined, children);

/** Every custom and default block, once, with its own heading. */
export function everyBlock(): unknown[] {
  resetIds();
  return [
    h(1, 'Heading 1'),
    h(2, 'Heading 2'),
    h(3, 'Heading 3'),
    h(4, 'Heading 4'),
    h(5, 'Heading 5'),
    h(6, 'Heading 6'),
    b('paragraph', {}, [
      text('Paragraph with '),
      text('bold', { bold: true }),
      text(', '),
      text('italic', { italic: true }),
      text(', '),
      text('strike', { strike: true }),
      text(', '),
      text('inline code', { code: true }),
      text(' and a '),
      { type: 'link', href: 'https://example.com', content: [text('link')] },
      text('.'),
    ]),
    h(2, 'Lists'),
    li('bulletListItem', 'Bullet one', [
      li('bulletListItem', 'Nested bullet', [li('bulletListItem', 'Third level')]),
    ]),
    li('bulletListItem', 'Bullet two'),
    li('numberedListItem', 'Numbered one', [
      li('numberedListItem', 'Nested numbered'),
      li('bulletListItem', 'Nested bullet under a number'),
    ]),
    li('numberedListItem', 'Numbered two'),
    li('checkListItem', 'Check item', [], { checked: false }),
    li('checkListItem', 'Checked item', [], { checked: true }),
    li('toggleListItem', 'Toggle list item (open below)', [p('Hidden child paragraph')]),
    h(2, 'Quote, divider, callout'),
    quote('A quote block.'),
    b('divider'),
    callout('A callout block with an emoji.'),
    h(2, 'Table'),
    table(),
    h(2, 'Code and terminal'),
    code('const a = 1;\nconsole.log(a);'),
    terminal('npm install\nnpm run dev'),
    h(2, 'Media'),
    image(),
    b('video', { url: 'https://example.com/video.mp4', caption: 'A video' }),
    b('audio', { url: 'https://cdn.example.com/a.mp3', name: 'clip.mp3', caption: 'Audio' }),
    b('file', { name: 'notes.pdf', url: 'https://cdn.example.com/notes.pdf', caption: 'A file' }),
    b('embed', { url: 'https://example.com/embed', type: 'generic' }),
    h(2, 'Profile, nav grid, page link'),
    b('profile', {
      name: 'Ada Lovelace',
      title: 'Instructor',
      imageUrl: 'https://cdn.example.com/sample.png',
      links: '',
    }),
    b('navGrid', {
      columns: 2,
      entries: JSON.stringify([
        { kind: 'external', url: 'https://example.com/a', label: 'Link A' },
        { kind: 'external', url: 'https://example.com/b', label: 'Link B' },
      ]),
    }),
    b('pageLink', { pageId: 'nope', pageTitle: 'A linked page' }),
    h(2, 'Locked section'),
    locked('Solution', [p('Locked body paragraph.')]),
    h(2, 'Columns'),
    columns(
      [h(3, 'Left column'), li('bulletListItem', 'A bullet'), code('x = 1')],
      [h(3, 'Right column'), p('Right paragraph.'), callout('A callout in a column')]
    ),
    h(2, 'Heading variants'),
    h(2, 'Toggle heading H2', { isToggleable: true }, [p('Toggle heading child.')]),
    h(3, 'Toggle heading H3', { isToggleable: true }, [p('Another child.')]),
    h(2, 'Colored heading', { backgroundColor: 'blue' }),
    h(3, 'Checkable heading', { checkable: true }),
    p('Checkable section body.'),
    h(
      2,
      'Checkable colored toggle',
      { checkable: true, backgroundColor: 'green', isToggleable: true },
      [p('Child.')]
    ),
  ];
}
