/**
 * The editor's slash menu: which page-specific items it offers and where they
 * are listed. The checkable headings sit right after the plain heading of the
 * same level; `/check` lists all three, `/h1` both kinds of Heading 1.
 */
import { test, expect } from '@playwright/test';
import { filterSuggestionItems } from '@blocknote/core/extensions';

import { customSlashMenuItems } from '~/components/editor/blocks/index.tsx';
import { arrangeSlashMenuItems } from '~/components/editor/slashMenuOrder.ts';

/** BlockNote's default items as the editor sees them (titles, keys, aliases). */
const defaults = [
  { key: 'heading', title: 'Heading 1', aliases: ['h', 'heading1', 'h1'], group: 'Headings' },
  { key: 'heading_2', title: 'Heading 2', aliases: ['h2', 'heading2'], group: 'Headings' },
  { key: 'heading_3', title: 'Heading 3', aliases: ['h3', 'heading3'], group: 'Headings' },
  { key: 'quote', title: 'Quote', aliases: ['quotation'], group: 'Basic blocks' },
  { key: 'check_list', title: 'Check List', aliases: ['checkbox'], group: 'Lists' },
  { key: 'paragraph', title: 'Paragraph', aliases: ['p'], group: 'Basic blocks' },
  {
    key: 'toggle_heading',
    title: 'Toggle Heading 1',
    aliases: ['h1', 'collapsable'],
    group: 'Subheadings',
  },
  { key: 'heading_4', title: 'Heading 4', aliases: ['h4'], group: 'Headings' },
  { key: 'emoji', title: 'Emoji', aliases: ['emoji'], group: 'Others' },
  { key: 'zz', title: 'Unlisted', aliases: [], group: 'Zeta' },
  { key: 'yy', title: 'Also unlisted', aliases: [], group: 'Alpha' },
];

const items = () =>
  arrangeSlashMenuItems([
    ...defaults,
    ...customSlashMenuItems.map(({ title, aliases, group, placeAfter }) => ({
      title,
      aliases,
      group,
      placeAfter,
    })),
  ]);

const titles = (list: Array<{ title: string }>) => list.map(item => item.title);

test.describe('slash menu', () => {
  test('one checkable heading per level 1-3, no H2-only item', () => {
    const checkable = customSlashMenuItems.filter(item => item.title.startsWith('Checkable'));
    expect(titles(checkable)).toEqual([
      'Checkable heading 1',
      'Checkable heading 2',
      'Checkable heading 3',
    ]);
    expect(checkable.map(item => item.placeAfter)).toEqual(['heading', 'heading_2', 'heading_3']);
    expect(titles(customSlashMenuItems)).not.toContain('Checkable heading');
  });

  test('each checkable heading follows its plain counterpart', () => {
    const headings = items().filter(item => item.group === 'Headings');
    expect(titles(headings)).toEqual([
      'Heading 1',
      'Checkable heading 1',
      'Heading 2',
      'Checkable heading 2',
      'Heading 3',
      'Checkable heading 3',
      'Heading 4',
    ]);
  });

  test('groups stay together in the fixed order, unlisted groups last by name', () => {
    const groups = items().map(item => item.group);
    const order = groups.filter((group, i) => groups.indexOf(group) === i);
    expect(order).toEqual([
      'Headings',
      'Basic blocks',
      'Code',
      'Lists',
      'Media',
      'Advanced',
      'Subheadings',
      'Others',
      'Alpha',
      'Zeta',
    ]);
  });

  test('/check and /checkable list all three; /h1 lists both Heading 1s', () => {
    const list = items();
    for (const query of ['check', 'checkable']) {
      const found = titles(filterSuggestionItems(list, query));
      for (const level of [1, 2, 3]) expect(found).toContain(`Checkable heading ${level}`);
    }
    const h1 = titles(filterSuggestionItems(list, 'h1'));
    expect(h1).toContain('Heading 1');
    expect(h1).toContain('Checkable heading 1');
    expect(h1).not.toContain('Checkable heading 2');
  });

  test('locked sections are not called hints', () => {
    const locked = customSlashMenuItems.find(item => item.title === 'Locked section');
    expect(locked?.aliases).not.toContain('hint');
    expect(titles(filterSuggestionItems(items(), 'hint'))).toEqual([]);
  });

  test('a missing anchor leaves the item where the sort put it', () => {
    const out = arrangeSlashMenuItems([
      { title: 'A', group: 'Headings', placeAfter: 'nowhere' },
      { title: 'B', group: 'Headings' },
    ]);
    expect(titles(out)).toEqual(['A', 'B']);
  });
});
