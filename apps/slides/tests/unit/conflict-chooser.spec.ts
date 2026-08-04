/**
 * Unit tests for the deck conflict-chooser helpers (plan §3b Phase 7).
 *
 * These run in the Playwright runner WITHOUT a browser or the dev stack —
 * the module under test is pure (no React, no network).
 */

import { test, expect } from '@playwright/test';
import {
  META_CONFLICT_ID,
  ORDER_CONFLICT_ID,
  allResolved,
  buildResolutions,
  buildSlideSrcdoc,
  chooserCopy,
  chooserSubtitle,
  formatMetaValue,
  isChildOrderId,
  metaFieldRows,
  reasonLabel,
  sideNotesDiffer,
  slideSideHtml,
} from '../../app/components/preview/conflictChooser.ts';

test.describe('reasonLabel', () => {
  test('maps every known deck reason to a human label', () => {
    expect(reasonLabel('content')).toBe('Edited in both versions');
    expect(reasonLabel('delete_vs_edit')).toBe('Deleted in one version, edited in the other');
    expect(reasonLabel('both_added')).toBe('Added in both versions');
    expect(reasonLabel('placement')).toBe('Moved differently in both versions');
    expect(reasonLabel('child_order')).toBe('Stack order changed in both versions');
    expect(reasonLabel('order')).toBe('Slide order changed in both versions');
    expect(reasonLabel('meta')).toBe('Deck settings changed in both versions');
  });

  test('falls back for unknown/missing reasons', () => {
    expect(reasonLabel(undefined)).toBe('Changed in both versions');
    expect(reasonLabel('mystery')).toBe('Changed in both versions');
  });
});

test.describe('sentinel ids', () => {
  test('isChildOrderId matches only the __order__:<stackId> form', () => {
    expect(isChildOrderId(`${ORDER_CONFLICT_ID}:abc123`)).toBe(true);
    expect(isChildOrderId(ORDER_CONFLICT_ID)).toBe(false);
    expect(isChildOrderId(META_CONFLICT_ID)).toBe(false);
    expect(isChildOrderId('slide-id')).toBe(false);
  });
});

test.describe('slideSideHtml', () => {
  test('returns the slide html directly', () => {
    expect(slideSideHtml({ id: 's1', html: '<h2>Title</h2>' })).toBe('<h2>Title</h2>');
  });

  test('joins a stack container children with a separator', () => {
    const html = slideSideHtml({
      id: 'stack',
      children: [
        { id: 'c1', html: '<p>one</p>' },
        { id: 'c2', html: '<p>two</p>' },
      ],
    });
    expect(html).toContain('<p>one</p>');
    expect(html).toContain('<p>two</p>');
    expect(html).toContain('<hr');
  });

  test('empty for null/absent sides', () => {
    expect(slideSideHtml(null)).toBe('');
    expect(slideSideHtml(undefined)).toBe('');
    expect(slideSideHtml({ id: 'x' })).toBe('');
  });
});

test.describe('buildSlideSrcdoc', () => {
  test('embeds the slide html in a self-contained scaled document', () => {
    const doc = buildSlideSrcdoc('<h2>Hello</h2>');
    expect(doc).toContain('<!doctype html>');
    expect(doc).toContain('<h2>Hello</h2>');
    expect(doc).toContain('transform:scale');
  });

  test('adds no script of its own (sandbox keeps embedded ones inert)', () => {
    expect(buildSlideSrcdoc('<p>x</p>')).not.toContain('<script');
  });
});

test.describe('metaFieldRows / formatMetaValue', () => {
  test('unions both sides and formats values compactly', () => {
    const rows = metaFieldRows(
      { theme: 'white', config: { center: false } },
      { theme: 'black', customCss: '.x{color:red}' }
    );
    expect(rows).toEqual([
      { field: 'theme', ours: 'white', theirs: 'black' },
      { field: 'config', ours: '{"center":false}', theirs: '(not set)' },
      { field: 'customCss', ours: '(not set)', theirs: '.x{color:red}' },
    ]);
  });

  test('formatMetaValue truncates long values and handles null', () => {
    expect(formatMetaValue(null)).toBe('(none)');
    expect(formatMetaValue(undefined)).toBe('(not set)');
    const long = 'x'.repeat(200);
    const shown = formatMetaValue(long);
    expect(shown.length).toBeLessThanOrEqual(80);
    expect(shown.endsWith('…')).toBe(true);
  });
});

test.describe('resolution bookkeeping', () => {
  const ids = ['slide1', `${ORDER_CONFLICT_ID}:stack1`, META_CONFLICT_ID, ORDER_CONFLICT_ID];

  test('allResolved requires a valid choice for EVERY id', () => {
    expect(allResolved(ids, {})).toBe(false);
    expect(allResolved(ids, { slide1: 'ours' })).toBe(false);
    expect(
      allResolved(ids, {
        slide1: 'ours',
        [`${ORDER_CONFLICT_ID}:stack1`]: 'theirs',
        [META_CONFLICT_ID]: 'ours',
        [ORDER_CONFLICT_ID]: 'theirs',
      })
    ).toBe(true);
  });

  test('allResolved is false for an empty conflict set', () => {
    expect(allResolved([], {})).toBe(false);
  });

  test('buildResolutions emits one {id, choose} per id, in order', () => {
    const choices = {
      slide1: 'theirs',
      [`${ORDER_CONFLICT_ID}:stack1`]: 'ours',
      [META_CONFLICT_ID]: 'theirs',
      [ORDER_CONFLICT_ID]: 'ours',
    } as const;
    expect(buildResolutions(ids, choices)).toEqual([
      { id: 'slide1', choose: 'theirs' },
      { id: `${ORDER_CONFLICT_ID}:stack1`, choose: 'ours' },
      { id: META_CONFLICT_ID, choose: 'theirs' },
      { id: ORDER_CONFLICT_ID, choose: 'ours' },
    ]);
  });
});

test.describe('chooser variants (save vs preview, Phase 7.5)', () => {
  test('preview copy keeps the accept-flow framing', () => {
    const copy = chooserCopy('preview');
    expect(copy.heading).toBe('Changes conflict with edits made on the live deck');
    expect(copy.sideTitle).toEqual({
      ours: 'Live version (yours)',
      theirs: "Preview version (agent's)",
    });
    expect(copy.sideAction).toEqual({ ours: 'Keep live', theirs: 'Take preview' });
    expect(copy.tombstone).toEqual({
      ours: 'Deleted in the live version',
      theirs: 'Deleted in the preview',
    });
    expect(copy.secondaryAction).toBe('Discard preview');
    expect(copy.busyLabel).toContain('Publishing your choices');
  });

  test('save copy flips the framing: ours = the server, theirs = the unsaved editor', () => {
    const copy = chooserCopy('save');
    expect(copy.heading).toBe('Your save collided with changes saved by someone else');
    expect(copy.sideTitle).toEqual({
      ours: 'Saved on the server',
      theirs: 'Your unsaved version',
    });
    expect(copy.sideAction).toEqual({ ours: "Keep server's", theirs: 'Keep yours' });
    expect(copy.tombstone).toEqual({
      ours: 'Deleted on the server',
      theirs: 'Deleted in your version',
    });
    expect(copy.secondaryAction).toBe('Reload latest');
    expect(copy.footerNote).toContain('discard your unsaved changes');
    expect(copy.busyLabel).toContain('Saving the merged version');
  });

  test('chooserSubtitle mentions the auto-merged count per variant', () => {
    expect(chooserSubtitle('preview', 0)).toBe('Choose which version to keep for each conflict:');
    expect(chooserSubtitle('save', 0)).toBe('Choose which version to keep for each conflict:');
    expect(chooserSubtitle('preview', 3)).toBe('3 changes merged automatically; these need you:');
    expect(chooserSubtitle('save', 1)).toBe('1 change merged automatically; choose per slide:');
    expect(chooserSubtitle('save', 2)).toBe('2 changes merged automatically; choose per slide:');
  });
});

test.describe('sideNotesDiffer', () => {
  test('identical notes on both sides carry no signal', () => {
    expect(sideNotesDiffer({ notes: 'same' }, { notes: 'same' })).toBe(false);
    expect(sideNotesDiffer({}, {})).toBe(false);
    expect(sideNotesDiffer({ html: '<p>a</p>' }, { html: '<p>b</p>' })).toBe(false);
  });

  test('differing notes (including one side missing them) do', () => {
    expect(sideNotesDiffer({ notes: 'mine' }, { notes: 'theirs' })).toBe(true);
    expect(sideNotesDiffer({ notes: 'mine' }, {})).toBe(true);
    expect(sideNotesDiffer(null, { notes: 'theirs' })).toBe(true);
  });

  test('a deleted side vs a note-less survivor stays quiet', () => {
    expect(sideNotesDiffer(null, { html: '<p>x</p>' })).toBe(false);
  });
});
