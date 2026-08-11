/**
 * Unit tests for the conflict-chooser helpers (plan §3b Phase 7).
 *
 * These run in the Playwright runner WITHOUT a browser or the dev stack —
 * the module under test is pure (no React, no network).
 */

import { test, expect } from '@playwright/test';
import {
  ORDER_CONFLICT_ID,
  allResolved,
  blockSummary,
  buildResolutions,
  chooserCopy,
  chooserSubtitle,
  conflictIds,
  orderDiffIds,
  reasonLabel,
  type ConflictUnit,
} from '../../app/components/preview/conflictChooser.ts';

test.describe('reasonLabel', () => {
  test('maps every known reason to a human label', () => {
    expect(reasonLabel('content')).toBe('Edited in both versions');
    expect(reasonLabel('delete_vs_edit')).toBe('Deleted in one version, edited in the other');
    expect(reasonLabel('both_added')).toBe('Added in both versions');
    expect(reasonLabel('order')).toBe('Blocks reordered differently in both versions');
  });

  test('falls back for unknown/missing reasons', () => {
    expect(reasonLabel(undefined)).toBe('Changed in both versions');
    expect(reasonLabel('some_future_reason')).toBe('Changed in both versions');
  });
});

test.describe('blockSummary', () => {
  test('extracts type, flattened text, and child count from a BlockNote block', () => {
    const block = {
      id: 'abc12345',
      type: 'paragraph',
      props: {},
      content: [
        { type: 'text', text: 'Hello ', styles: {} },
        { type: 'text', text: 'world', styles: { bold: true } },
        { type: 'link', href: 'https://x.test', content: [{ type: 'text', text: ' link' }] },
      ],
      children: [{ type: 'paragraph' }, { type: 'paragraph' }],
    };
    expect(blockSummary(block)).toEqual({
      type: 'paragraph',
      text: 'Hello world link',
      childCount: 2,
    });
  });

  test('flattens table content rows and cells', () => {
    const block = {
      type: 'table',
      content: {
        type: 'tableContent',
        rows: [
          { cells: [[{ type: 'text', text: 'A1' }], [{ type: 'text', text: 'B1' }]] },
          { cells: [[{ type: 'text', text: 'A2' }], [{ type: 'text', text: 'B2' }]] },
        ],
      },
    };
    const summary = blockSummary(block);
    expect(summary.type).toBe('table');
    expect(summary.text).toContain('A1 · B1');
    expect(summary.text).toContain('A2 · B2');
  });

  test('tolerates null, garbage, and content-less blocks', () => {
    expect(blockSummary(null)).toEqual({ type: 'block', text: '', childCount: 0 });
    expect(blockSummary('not a block')).toEqual({ type: 'block', text: '', childCount: 0 });
    expect(blockSummary({ type: 'image', props: { url: 'x.png' } })).toEqual({
      type: 'image',
      text: '',
      childCount: 0,
    });
  });
});

test.describe('orderDiffIds (moved-block highlight)', () => {
  test('flags every block whose position differs between the two orderings', () => {
    const moved = orderDiffIds(['b', 'a', 'c'], ['a', 'c', 'b']);
    expect(moved).toEqual(new Set(['a', 'b', 'c']));
  });

  test('a block that keeps its position is NOT flagged', () => {
    const moved = orderDiffIds(['a', 'b', 'c'], ['a', 'c', 'b']);
    expect(moved.has('a')).toBe(false);
    expect(moved.has('b')).toBe(true);
    expect(moved.has('c')).toBe(true);
  });

  test('identical orderings flag nothing', () => {
    expect(orderDiffIds(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual(new Set());
  });

  test('a block present in only one ordering counts as moved', () => {
    expect(orderDiffIds(['a', 'b'], ['a', 'b', 'c'])).toEqual(new Set(['c']));
  });
});

test.describe('resolution bookkeeping', () => {
  const units: ConflictUnit[] = [
    { id: 'blk1', index: 0, reason: 'content', ours: {}, theirs: {} },
    { id: 'blk2', index: 3, reason: 'delete_vs_edit', ours: {} },
    { id: ORDER_CONFLICT_ID, index: -1, reason: 'order', ours: ['a'], theirs: ['b'] },
  ];

  test('conflictIds lists every unit id including sentinels', () => {
    expect(conflictIds(units)).toEqual(['blk1', 'blk2', ORDER_CONFLICT_ID]);
  });

  test('allResolved requires a valid choice for EVERY id', () => {
    const ids = conflictIds(units);
    expect(allResolved(ids, {})).toBe(false);
    expect(allResolved(ids, { blk1: 'ours' })).toBe(false);
    expect(allResolved(ids, { blk1: 'ours', blk2: 'theirs' })).toBe(false);
    expect(allResolved(ids, { blk1: 'ours', blk2: 'theirs', [ORDER_CONFLICT_ID]: 'ours' })).toBe(
      true
    );
  });

  test('allResolved is false for an empty conflict set', () => {
    expect(allResolved([], {})).toBe(false);
  });

  test('buildResolutions emits one {id, choose} per id, in order', () => {
    const ids = conflictIds(units);
    const choices = { blk1: 'ours', blk2: 'theirs', [ORDER_CONFLICT_ID]: 'theirs' } as const;
    expect(buildResolutions(ids, choices)).toEqual([
      { id: 'blk1', choose: 'ours' },
      { id: 'blk2', choose: 'theirs' },
      { id: ORDER_CONFLICT_ID, choose: 'theirs' },
    ]);
  });
});

test.describe('chooser variants (save vs preview, Phase 7.5)', () => {
  test('preview copy keeps the accept-flow framing', () => {
    const copy = chooserCopy('preview');
    expect(copy.heading).toBe('Changes conflict with edits made on the live page');
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
    expect(chooserSubtitle('save', 1)).toBe('1 change merged automatically; choose per block:');
    expect(chooserSubtitle('save', 2)).toBe('2 changes merged automatically; choose per block:');
  });
});
