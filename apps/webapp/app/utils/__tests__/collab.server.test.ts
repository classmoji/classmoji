/**
 * The webapp's calls to the collab server's internal API: the classroom flag
 * (`/internal/classroom/:id/flag`) and closing a page's live room before the
 * page is deleted (`/internal/page/:id/close`).
 *
 * Pinned here: the URL, method, secret header and body each call sends; that
 * neither ever throws (the callers decide what a failure means); and the
 * delete rule — close when the classroom is flagged OR a buffered document
 * exists, a 404 is fine, anything else (including no answer) is a refusal.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock('@classmoji/database', () => ({
  default: () => ({ collabDoc: { findUnique: (...a: unknown[]) => mocks.findUnique(...a) } }),
}));

const {
  closeBeforeDelete,
  closeLivePageForDelete,
  classroomCollabEnabled,
  collabServerEnv,
  notifyCollabFlag,
} = await import('../collab.server.ts');

const ENV = { httpUrl: 'http://collab.test', wsUrl: 'ws://collab.test', secret: 's3cret' };

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const okFetch = (body: unknown = {}) => vi.fn(async () => jsonResponse(200, body));

const sent = (fetchImpl: ReturnType<typeof vi.fn>) => {
  const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(String(init.body)),
  };
};

beforeEach(() => {
  mocks.findUnique.mockReset();
  mocks.findUnique.mockResolvedValue(null);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('classroomCollabEnabled', () => {
  it('is true only for an explicit true', () => {
    expect(classroomCollabEnabled({ collab_enabled: true })).toBe(true);
    expect(classroomCollabEnabled({ collab_enabled: false })).toBe(false);
    expect(classroomCollabEnabled({})).toBe(false);
    expect(classroomCollabEnabled(null)).toBe(false);
    expect(classroomCollabEnabled({ collab_enabled: 'true' })).toBe(false);
  });
});

describe('collabServerEnv', () => {
  it('is null in production without a collab server configured', () => {
    expect(collabServerEnv({ NODE_ENV: 'production' })).toBeNull();
  });

  it('resolves the configured server in production', () => {
    expect(
      collabServerEnv({
        NODE_ENV: 'production',
        COLLAB_URL: 'https://collab.internal/',
        COLLAB_INTERNAL_SECRET: 'prod-secret',
      })
    ).toMatchObject({ httpUrl: 'https://collab.internal', secret: 'prod-secret' });
  });
});

describe('notifyCollabFlag', () => {
  it('POSTs { enabled } to the classroom flag endpoint with the secret', async () => {
    const fetchImpl = okFetch({ closed: 2, reseeded: 1 });

    const result = await notifyCollabFlag('class 1', false, { env: ENV, fetchImpl });

    expect(result).toEqual({ ok: true });
    const call = sent(fetchImpl);
    expect(call.url).toBe('http://collab.test/internal/classroom/class%201/flag');
    expect(call.method).toBe('POST');
    expect(call.headers['x-collab-secret']).toBe('s3cret');
    expect(call.body).toEqual({ enabled: false });
  });

  it('reports ok: false, without throwing, when the server cannot be reached', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(notifyCollabFlag('class-1', true, { env: ENV, fetchImpl })).resolves.toEqual({
      ok: false,
    });
  });

  it('reports ok: false when the server refuses', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: 'boom' }));
    await expect(notifyCollabFlag('class-1', true, { env: ENV, fetchImpl })).resolves.toEqual({
      ok: false,
    });
  });

  it('reports ok: false when no collab server is configured', async () => {
    const fetchImpl = okFetch();
    await expect(notifyCollabFlag('class-1', false, { env: null, fetchImpl })).resolves.toEqual({
      ok: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('closeBeforeDelete', () => {
  it('closes when the classroom is flagged or a buffered document exists', () => {
    expect(closeBeforeDelete({ classroomFlagged: false, hasCollabDoc: false })).toBe(false);
    expect(closeBeforeDelete({ classroomFlagged: true, hasCollabDoc: false })).toBe(true);
    expect(closeBeforeDelete({ classroomFlagged: false, hasCollabDoc: true })).toBe(true);
  });
});

describe('closeLivePageForDelete', () => {
  const unflagged = { collab_enabled: false };
  const flagged = { collab_enabled: true };

  it('makes no call for an unflagged classroom with no live document', async () => {
    const fetchImpl = okFetch();
    const result = await closeLivePageForDelete(
      { pageId: 'page-1', classroom: unflagged },
      { env: ENV, fetchImpl }
    );
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mocks.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { kind_doc_id: { kind: 'page', doc_id: 'page-1' } } })
    );
  });

  it('closes the room with reason "deleted" when the classroom is flagged', async () => {
    const fetchImpl = okFetch({ closed: 1 });
    const result = await closeLivePageForDelete(
      { pageId: 'page-1', classroom: flagged },
      { env: ENV, fetchImpl }
    );
    expect(result).toEqual({ ok: true });
    const call = sent(fetchImpl);
    expect(call.url).toBe('http://collab.test/internal/page/page-1/close');
    expect(call.method).toBe('POST');
    expect(call.headers['x-collab-secret']).toBe('s3cret');
    expect(call.body).toEqual({ reason: 'deleted' });
  });

  it('closes the room when a live document exists even though the flag is off', async () => {
    mocks.findUnique.mockResolvedValue({ epoch: 3 });
    const fetchImpl = okFetch({ closed: 0 });
    const result = await closeLivePageForDelete(
      { pageId: 'page-1', classroom: unflagged },
      { env: ENV, fetchImpl }
    );
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('treats a 404 (no room, no document) as closed', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: 'not-found' }));
    await expect(
      closeLivePageForDelete({ pageId: 'page-1', classroom: flagged }, { env: ENV, fetchImpl })
    ).resolves.toEqual({ ok: true });
  });

  it('refuses when the collab server cannot be reached', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      closeLivePageForDelete({ pageId: 'page-1', classroom: flagged }, { env: ENV, fetchImpl })
    ).resolves.toEqual({ ok: false });
  });

  it('refuses when the collab server answers with an error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, { error: 'unavailable' }));
    await expect(
      closeLivePageForDelete({ pageId: 'page-1', classroom: flagged }, { env: ENV, fetchImpl })
    ).resolves.toEqual({ ok: false });
  });

  it('refuses for a flagged classroom when no collab server is configured', async () => {
    const fetchImpl = okFetch();
    await expect(
      closeLivePageForDelete({ pageId: 'page-1', classroom: flagged }, { env: null, fetchImpl })
    ).resolves.toEqual({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
