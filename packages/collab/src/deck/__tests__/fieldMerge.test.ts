import { describe, expect, it } from 'vitest';

import { mergeSlideFields } from '../fieldMerge.ts';

describe('mergeSlideFields', () => {
  const base = { id: 's', html: '<p>a</p>', notes: 'n', attrs: { 'data-x': '1', 'data-y': '1' } };

  it('each side keeps what only it changed', () => {
    const ours = { ...base, notes: 'ours notes', attrs: { 'data-x': '2', 'data-y': '1' } };
    const theirs = { ...base, html: '<p>theirs</p>', attrs: { 'data-x': '1', 'data-y': '3' } };
    expect(mergeSlideFields(base, ours, theirs)).toEqual({
      id: 's',
      html: '<p>theirs</p>',
      notes: 'ours notes',
      attrs: { 'data-x': '2', 'data-y': '3' },
    });
  });

  it('both changed one field: the preferred side wins it', () => {
    const ours = { ...base, html: '<p>ours</p>', hidden: true };
    const theirs = { ...base, html: '<p>theirs</p>' };
    expect(mergeSlideFields(base, ours, theirs, 'theirs')).toMatchObject({
      html: '<p>theirs</p>',
      hidden: true,
    });
    expect(mergeSlideFields(base, ours, theirs, 'ours').html).toBe('<p>ours</p>');
  });

  it('removals merge too', () => {
    const ours = { ...base };
    const theirs = { id: 's', html: '<p>a</p>', attrs: { 'data-x': '1' } };
    expect(mergeSlideFields(base, ours, theirs)).toEqual({
      id: 's',
      html: '<p>a</p>',
      attrs: { 'data-x': '1' },
    });
  });
});
