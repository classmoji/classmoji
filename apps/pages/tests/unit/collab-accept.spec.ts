/**
 * Accepting a preview into a live page goes through the collab server's
 * `merge-preview`, which merges inside the live transaction. What the pages
 * app decides on its own: the chooser's picks it forwards, and what a refusal
 * means for the person (collabAccept.server.ts).
 */

import { test, expect } from '@playwright/test';

import { CollabRequestError } from '../../app/utils/collabEnv.server.ts';
import {
  mergePreviewFailure,
  orderUnitPreviews,
  resolutionList,
} from '../../app/utils/collabAccept.server.ts';

test.describe('resolutionList', () => {
  test('keeps one well-formed pick per id, in order', () => {
    expect(
      resolutionList([
        { id: 'a', choose: 'ours' },
        { id: 'b', choose: 'theirs' },
        { id: 'a', choose: 'theirs' },
        { id: 'c', choose: 'both' },
        { id: '', choose: 'ours' },
        { choose: 'ours' },
      ])
    ).toEqual([
      { id: 'a', choose: 'ours' },
      { id: 'b', choose: 'theirs' },
    ]);
  });

  test('nothing to forward', () => {
    expect(resolutionList(null)).toEqual([]);
    expect(resolutionList(undefined)).toEqual([]);
  });
});

test.describe('mergePreviewFailure', () => {
  test('409 conflicts become the chooser’s units; nothing was applied', () => {
    const units = [
      { id: 'b1', index: 0, reason: 'content', ours: { id: 'b1' }, theirs: { id: 'b1' } },
      { id: '__order__', index: -1, reason: 'order', ours: [], theirs: [] },
    ];
    const failure = mergePreviewFailure(
      new CollabRequestError('refused', 409, { error: 'conflicts', conflicts: [...units, null] })
    );
    expect(failure).toEqual({ kind: 'conflict', units });
  });

  test('an unreachable collab server is a try-again, not a merge error', () => {
    expect(mergePreviewFailure(new CollabRequestError('down', 0))).toEqual({
      kind: 'failed',
      status: 503,
      message: 'Couldn’t reach live editing. Try again.',
    });
  });

  test('a preview that adds a column layout is refused with what to do', () => {
    const failure = mergePreviewFailure(
      new CollabRequestError('refused', 422, { error: 'columns-not-allowed-live', ids: ['c'] })
    );
    expect(failure).toMatchObject({ kind: 'failed', status: 422 });
    if (failure.kind === 'failed') {
      expect(failure.message).toMatch(/column layout.*live version.*discard the preview/);
      expect(failure.message).not.toMatch(/Try again/);
    }
  });

  test('any other refusal is a failed merge with a sentence', () => {
    for (const [status, body] of [
      [409, { error: 'something-else' }],
      [400, { error: 'invalid-ops' }],
      [500, null],
    ] as const) {
      const failure = mergePreviewFailure(new CollabRequestError('x', status, body));
      expect(failure.kind).toBe('failed');
      if (failure.kind === 'failed') {
        expect(failure.status).toBe(502);
        expect(failure.message).toMatch(/Try again\.$/);
      }
    }
  });

  test('a bug is not swallowed as a refusal', () => {
    expect(() => mergePreviewFailure(new TypeError('boom'))).toThrow('boom');
  });
});

test.describe('orderUnitPreviews', () => {
  const p = (id: string, text: string, type = 'paragraph') => ({
    id,
    type,
    content: [{ type: 'text', text, styles: {} }],
  });

  test('an order conflict lists blocks as text, from live, then preview, then base', () => {
    const live = [p('a', 'Intro typed live'), p('b', 'Second')];
    const preview = [p('b', 'Second'), p('a', 'Intro'), p('c', 'New from the agent', 'heading')];
    const base = [p('a', 'Intro'), p('b', 'Second'), p('z', 'x'.repeat(200))];
    const previews = orderUnitPreviews(
      [
        {
          id: '__order__',
          reason: 'order',
          ours: ['a', 'b'],
          theirs: ['b', 'a', 'c'],
          base: ['a', 'b', 'z'],
        },
      ],
      [live, preview, base]
    );
    expect(previews?.a).toEqual({ index: 0, summary: 'paragraph: Intro typed live' });
    expect(previews?.c).toEqual({ index: 2, summary: 'heading: New from the agent' });
    expect(previews?.z.summary.length).toBeLessThanOrEqual('paragraph: '.length + 80);
    expect(previews?.z.summary.endsWith('…')).toBe(true);
  });

  test('no order conflict, no previews', () => {
    expect(orderUnitPreviews([{ id: 'a', reason: 'content' }], [[]])).toBeNull();
  });
});
