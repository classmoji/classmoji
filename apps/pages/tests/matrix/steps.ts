import {
  b,
  callout,
  code,
  columns,
  h,
  image,
  li,
  locked,
  p,
  quote,
  resetIds,
  table,
  terminal,
} from './blocks.ts';

/** Steps holding each kind of block, plus the awkward heading shapes. */
export function stepsMatrix(on: boolean): unknown[] {
  resetIds();
  const s = (
    level: number,
    t: string,
    extra: Record<string, unknown> = {},
    children: unknown[] = []
  ) => h(level, t, { ...(on ? { step: true } : {}), ...extra }, children);
  return [
    p('Every kind of content inside steps.'),
    s(1, 'Text step'),
    p('A paragraph.'),
    li('bulletListItem', 'A bullet', [li('bulletListItem', 'Nested')]),
    li('numberedListItem', 'Numbered'),
    quote('A quote.'),
    s(1, 'Table and callout'),
    table(),
    callout('A callout inside a step.'),
    b('divider'),
    s(1, 'Code and terminal'),
    code('git switch main'),
    terminal('npm install'),
    s(1, 'Media'),
    image(),
    b('file', { name: 'notes.pdf', url: 'https://cdn.example.com/notes.pdf', caption: 'A file' }),
    s(1, 'Columns'),
    columns([h(3, 'Left'), p('Left text.')], [h(3, 'Right'), li('bulletListItem', 'A bullet')]),
    s(1, 'Locked section and page link'),
    locked('Hint', [p('Locked body.')]),
    b('pageLink', { pageId: 'nope', pageTitle: 'A linked page' }),
    s(1, 'Nested steps'),
    p('H2 steps inside an H1 step.'),
    s(2, 'Inner one'),
    p('First inner step.'),
    s(2, 'Inner two'),
    p('Second inner step.'),
    s(1, 'Toggle heading step', { isToggleable: true }, [p('Child of a toggle heading step.')]),
    p('After the toggle heading.'),
    s(1, 'Checkable step', { checkable: true }),
    p('A checkable step body.'),
    s(1, 'Colored step', { backgroundColor: 'blue' }),
    p('A colored step body.'),
    s(1, 'Step in a column'),
    columns(
      [s(2, 'Column step one'), p('Text.'), s(2, 'Column step two'), p('More text.')],
      [p('Neighbour column.')]
    ),
    h(2, 'A plain H2 after the steps'),
    p('Closing text.'),
    s(1, 'Last step'),
    p('The end.'),
  ];
}
