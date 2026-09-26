/**
 * The four states the media table shows, and the meter behind them.
 *
 * `status` and `processing` are independent columns and the table has one
 * badge, so the mapping between them is a truth table — worth writing down
 * once, because "READY but still encoding" and "READY after encoding failed"
 * are both rows an owner will see and both are easy to draw as plain "ready".
 */

import { describe, expect, it } from 'vitest';
import {
  MEDIA_STATE_CHIP,
  isActionable,
  mediaState,
  meterReading,
  orderForDisplay,
} from '../mediaState';

describe('mediaState', () => {
  it.each([
    ['UPLOADING', 'NONE', 'uploading'],
    ['UPLOADING', 'PENDING', 'uploading'],
    ['READY', 'NONE', 'ready'],
    ['READY', 'DONE', 'ready'],
    ['READY', 'PENDING', 'optimising'],
    ['READY', 'FAILED', 'failed'],
  ] as const)('reads %s + %s as %s', (status, processing, expected) => {
    expect(mediaState({ status, processing })).toBe(expected);
  });

  it('calls a row uploading whatever the job says, because it is not there yet', () => {
    // The rendition job cannot have run on an object that has not finished
    // arriving, so the upload is the only fact worth showing.
    expect(mediaState({ status: 'UPLOADING', processing: 'FAILED' })).toBe('uploading');
  });

  it('has a chip for every state', () => {
    for (const state of ['uploading', 'optimising', 'ready', 'failed'] as const) {
      expect(MEDIA_STATE_CHIP[state]).toMatch(/bg-\w+-bg/);
      // The border needs the important marker to beat unlayered `.chip` CSS.
      expect(MEDIA_STATE_CHIP[state]).toContain('!border-');
    }
  });

  it('offers actions only on a finished object', () => {
    expect(isActionable({ status: 'READY' })).toBe(true);
    expect(isActionable({ status: 'UPLOADING' })).toBe(false);
  });
});

describe('meterReading', () => {
  const GiB = 1024 ** 3;

  it('is a plain percentage below the line', () => {
    expect(meterReading(5 * GiB, 10 * GiB)).toEqual({ percent: 50, isFull: false });
  });

  it('turns red at 90 %, not at 100', () => {
    expect(meterReading(8.9 * GiB, 10 * GiB).isFull).toBe(false);
    expect(meterReading(9 * GiB, 10 * GiB).isFull).toBe(true);
  });

  it('clamps an over-quota classroom rather than overflowing the bar', () => {
    // Reachable: a Pro subscription can lapse with files already stored.
    expect(meterReading(12 * GiB, 10 * GiB)).toEqual({ percent: 100, isFull: true });
  });

  it('reads a free classroom as empty, not as full and not as NaN', () => {
    // Zero quota is the free tier. A red bar would be telling them off for
    // storage they never had, and used/0 is not a number.
    expect(meterReading(0, 0)).toEqual({ percent: 0, isFull: false });
    expect(meterReading(5, 0)).toEqual({ percent: 0, isFull: false });
  });
});

describe('orderForDisplay', () => {
  const row = (id: string, status: 'READY' | 'UPLOADING', createdAt: string) => ({
    id,
    status,
    createdAt,
  });

  it('puts anything still arriving first, then newest', () => {
    const ordered = orderForDisplay([
      row('old', 'READY', '2026-09-01T00:00:00.000Z'),
      row('new', 'READY', '2026-09-18T00:00:00.000Z'),
      row('arriving', 'UPLOADING', '2026-08-01T00:00:00.000Z'),
    ]);

    // The upload in flight is the one with a progress bar attached to it, so it
    // goes to the top even though it is the oldest row here.
    expect(ordered.map(r => r.id)).toEqual(['arriving', 'new', 'old']);
  });

  it('does not mutate what it was given', () => {
    const input = [
      row('a', 'READY', '2026-09-01T00:00:00.000Z'),
      row('b', 'UPLOADING', '2026-08-01T00:00:00.000Z'),
    ];
    orderForDisplay(input);
    expect(input.map(r => r.id)).toEqual(['a', 'b']);
  });

  it('sorts a Date the same way it sorts an ISO string', () => {
    const ordered = orderForDisplay([
      { status: 'READY' as const, createdAt: new Date('2026-01-01T00:00:00.000Z'), id: 'old' },
      { status: 'READY' as const, createdAt: new Date('2026-09-01T00:00:00.000Z'), id: 'new' },
    ]);
    expect(ordered.map(r => r.id)).toEqual(['new', 'old']);
  });
});
