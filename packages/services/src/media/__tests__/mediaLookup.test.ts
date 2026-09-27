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

const {
  billedBytes,
  downloadVariant,
  listReadyMedia,
  liveRowsWhere,
  posterVariantOf,
  reservationCutoff,
  servedVariant,
} = await import('../mediaLookup.ts');
const { mediaObjectPrefix, storedPosterVariant, storedRenditionVariant } =
  await import('../mediaKeys.ts');
const { RESERVATION_WINDOW_MS } = await import('../mediaQuota.ts');

const C = '11111111-2222-4333-8444-555555555555';
const M = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const WEB = 'web-0123456789ab.mp4';
const POSTER = 'poster-0123456789ab.jpg';

describe('servedVariant', () => {
  it('serves the original until a rendition is recorded', () => {
    expect(servedVariant({ ext: 'mov', renditionKey: null })).toBe('orig.mov');
    expect(servedVariant({ ext: 'mov' })).toBe('orig.mov');
  });

  it('serves the rendition the row names — full key or bare variant', () => {
    expect(servedVariant({ ext: 'mov', renditionKey: `m/${C}/${M}/${WEB}` })).toBe(WEB);
    expect(servedVariant({ ext: 'mov', renditionKey: WEB })).toBe(WEB);
  });

  it('falls back to the original when the key does not name a rendition', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const key of ['web.mp4', 'web', `m/${C}/${M}/${POSTER}`, `m/${C}/${M}/orig.mov`]) {
      expect(servedVariant({ ext: 'mov', renditionKey: key })).toBe('orig.mov');
    }
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });
});

describe('downloadVariant', () => {
  it('is the original while it is kept, rendition or not', () => {
    expect(downloadVariant({ ext: 'mov', renditionKey: WEB, originalDeletedAt: null })).toBe(
      'orig.mov'
    );
  });

  it('is the rendition once the original is dropped', () => {
    expect(
      downloadVariant({
        ext: 'mov',
        renditionKey: `m/${C}/${M}/${WEB}`,
        originalDeletedAt: new Date(),
      })
    ).toBe(WEB);
  });

  it('is null when the original is gone and no rendition parses', () => {
    expect(
      downloadVariant({ ext: 'mov', renditionKey: null, originalDeletedAt: new Date() })
    ).toBeNull();
    expect(
      downloadVariant({ ext: 'mov', renditionKey: 'web.mp4', originalDeletedAt: new Date() })
    ).toBeNull();
  });
});

describe('posterVariantOf / stored variants / mediaObjectPrefix', () => {
  it('reads a poster only when it parses as one', () => {
    expect(posterVariantOf({ posterKey: `m/${C}/${M}/${POSTER}` })).toBe(POSTER);
    expect(posterVariantOf({ posterKey: 'poster.webp' })).toBeNull();
    expect(posterVariantOf({ posterKey: null })).toBeNull();
    expect(storedPosterVariant(WEB)).toBeNull();
    expect(storedRenditionVariant(POSTER)).toBeNull();
    expect(storedRenditionVariant('')).toBeNull();
  });

  it('builds a per-object prefix only from whole ids', () => {
    expect(mediaObjectPrefix(C, M)).toBe(`m/${C}/${M}/`);
    expect(() => mediaObjectPrefix(C, '')).toThrow(TypeError);
    expect(() => mediaObjectPrefix(C, M.slice(0, 8))).toThrow(TypeError);
    expect(() => mediaObjectPrefix('', M)).toThrow(TypeError);
  });
});

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
      {
        id: 'm-1',
        filename: 'intro.mp4',
        kind: 'VIDEO',
        size_bytes: 2048n,
        rendition_bytes: null,
        original_deleted_at: null,
        created_at: created,
        processing: 'FAILED',
        processing_error: 'The video could not be read.',
      },
      {
        id: 'm-2',
        filename: 'b.mp4',
        kind: 'VIDEO',
        size_bytes: 1n,
        rendition_bytes: null,
        original_deleted_at: null,
        created_at: created,
        processing: 'DONE',
        processing_error: 'stale',
      },
      {
        id: 'm-3',
        filename: 'dropped.mp4',
        kind: 'VIDEO',
        size_bytes: 5000n,
        // Kept original: the rendition does not count yet.
        rendition_bytes: 800n,
        original_deleted_at: null,
        created_at: created,
        processing: 'DONE',
        processing_error: null,
      },
      {
        id: 'm-4',
        filename: 'gone.mp4',
        kind: 'VIDEO',
        size_bytes: 5000n,
        rendition_bytes: 800n,
        original_deleted_at: created,
        created_at: created,
        processing: 'DONE',
        processing_error: null,
      },
    ]);

    await expect(listReadyMedia('class-1', { kind: 'VIDEO' })).resolves.toEqual([
      {
        id: 'm-1',
        filename: 'intro.mp4',
        kind: 'VIDEO',
        sizeBytes: 2048,
        ref: 'media://m-1',
        createdAt: created,
        processing: 'FAILED',
        processingError: 'The video could not be read.',
      },
      {
        id: 'm-2',
        filename: 'b.mp4',
        kind: 'VIDEO',
        sizeBytes: 1,
        ref: 'media://m-2',
        createdAt: created,
        processing: 'DONE',
        // A reason is only ever reported beside FAILED.
        processingError: null,
      },
      {
        id: 'm-3',
        filename: 'dropped.mp4',
        kind: 'VIDEO',
        sizeBytes: 5000,
        ref: 'media://m-3',
        createdAt: created,
        processing: 'DONE',
        processingError: null,
      },
      {
        id: 'm-4',
        filename: 'gone.mp4',
        kind: 'VIDEO',
        // The billed size: the rendition, once the original is dropped.
        sizeBytes: 800,
        ref: 'media://m-4',
        createdAt: created,
        processing: 'DONE',
        processingError: null,
      },
    ]);
    const query = findMany.mock.calls[0][0];
    expect(query.where).toEqual({ classroom_id: 'class-1', status: 'READY', kind: 'VIDEO' });
    expect(query.orderBy).toEqual({ created_at: 'desc' });
    // Bounded: the newest 200, never every row a classroom ever kept. READY
    // only, so a STAGING agent upload never appears in a picker.
    expect(query.take).toBe(200);
    expect(query.select).toMatchObject({ rendition_bytes: true, original_deleted_at: true });
  });

  it('does not narrow by kind unless asked', async () => {
    findMany.mockReset().mockResolvedValue([]);
    await listReadyMedia('class-1');
    expect(findMany.mock.calls[0][0].where).toEqual({ classroom_id: 'class-1', status: 'READY' });
  });
});
