/**
 * Which rows cost a classroom something, and what each one costs.
 *
 * `liveRowsWhere` is the one definition the usage meter, the media list and the
 * quota's check-and-insert all read, so what it admits IS the reservation rule:
 * a STAGING row (an agent upload waiting to be placed) must hold its bytes
 * exactly like an UPLOADING one, and stop holding them at the same moment.
 */

import { describe, expect, it, vi } from 'vitest';

const findMany = vi.hoisted(() => vi.fn());
vi.mock('@classmoji/database', () => ({
  default: () => ({ mediaObject: { findMany: (...a: unknown[]) => findMany(...a) } }),
}));

const { billedBytes, listReadyMedia, liveRowsWhere, reservationCutoff } =
  await import('../mediaLookup.ts');
const { RESERVATION_WINDOW_MS } = await import('../mediaQuota.ts');

describe('liveRowsWhere', () => {
  it('counts READY rows, and UPLOADING and STAGING rows inside the window', () => {
    const before = Date.now();
    const where = liveRowsWhere('class-1');
    const after = Date.now();

    expect(where.classroom_id).toBe('class-1');
    expect(where.OR[0]).toEqual({ status: 'READY' });

    const reservation = where.OR[1] as {
      status: { in: string[] };
      created_at: { gte: Date };
    };
    expect(reservation.status.in.sort()).toEqual(['STAGING', 'UPLOADING']);

    // The window is the same 24 h for both, measured from this call.
    const cutoff = reservation.created_at.gte.getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before - RESERVATION_WINDOW_MS);
    expect(cutoff).toBeLessThanOrEqual(after - RESERVATION_WINDOW_MS);
  });

  it('never counts DELETED rows', () => {
    expect(JSON.stringify(liveRowsWhere('class-1'))).not.toContain('DELETED');
  });

  it('uses the same cutoff reservationCutoff reports', () => {
    const now = 1_800_000_000_000;
    expect(reservationCutoff(now).getTime()).toBe(now - RESERVATION_WINDOW_MS);
  });
});

describe('billedBytes', () => {
  it('bills the original while it is there', () => {
    expect(billedBytes({ size_bytes: 100n, rendition_bytes: 40n, original_deleted_at: null })).toBe(
      100
    );
  });

  it('bills the rendition once the original is gone', () => {
    expect(
      billedBytes({ size_bytes: 100n, rendition_bytes: 40n, original_deleted_at: new Date() })
    ).toBe(40);
  });

  it('never bills a rendition-only row as free', () => {
    expect(
      billedBytes({ size_bytes: 100n, rendition_bytes: null, original_deleted_at: new Date() })
    ).toBe(100);
  });
});

describe('listReadyMedia', () => {
  it('asks for READY rows of the one classroom, newest first, as picker items', async () => {
    const created = new Date('2026-09-26T12:00:00Z');
    findMany.mockResolvedValue([
      { id: 'm-1', filename: 'intro.mp4', kind: 'VIDEO', size_bytes: 2048n, created_at: created },
    ]);

    await expect(listReadyMedia('class-1', { kind: 'VIDEO' })).resolves.toEqual([
      {
        id: 'm-1',
        filename: 'intro.mp4',
        kind: 'VIDEO',
        sizeBytes: 2048,
        ref: 'media://m-1',
        createdAt: created,
      },
    ]);
    const query = findMany.mock.calls[0][0];
    expect(query.where).toEqual({ classroom_id: 'class-1', status: 'READY', kind: 'VIDEO' });
    expect(query.orderBy).toEqual({ created_at: 'desc' });
  });

  it('does not narrow by kind unless asked', async () => {
    findMany.mockReset().mockResolvedValue([]);
    await listReadyMedia('class-1');
    expect(findMany.mock.calls[0][0].where).toEqual({ classroom_id: 'class-1', status: 'READY' });
  });
});
