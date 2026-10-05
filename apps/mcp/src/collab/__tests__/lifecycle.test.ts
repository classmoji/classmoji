/**
 * Deleting a live-edited page or deck closes its collab document first
 * (`POST /internal/:kind/:id/close`), when the classroom edits live or a
 * collab_docs row is left over; an unreachable collab server stops the
 * delete. Unflagged classrooms with no row never call collab.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  classroomFindUnique: vi.fn(),
  collabDocFindUnique: vi.fn(),
  pageFindById: vi.fn(),
  deletePage: vi.fn(),
  auditCreate: vi.fn(),
  order: [] as string[],
}));

vi.mock('@classmoji/database', () => ({
  GIT_IDENTITY: {},
  default: () => ({
    classroom: { findUnique: (...a: unknown[]) => mocks.classroomFindUnique(...a) },
    collabDoc: { findUnique: (...a: unknown[]) => mocks.collabDocFindUnique(...a) },
  }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    page: {
      findById: (...a: unknown[]) => mocks.pageFindById(...a),
      deletePage: (...a: unknown[]) => {
        mocks.order.push('deletePage');
        return mocks.deletePage(...a);
      },
    },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

const { closeLiveDocBeforeDelete } = await import('../lifecycle.ts');
const { pageDeleteTool } = await import('../../tools/pages.ts');

const PAGE_ID = '11111111-1111-4111-8111-111111111111';

const CTX = {
  viewer: { userId: 'teacher-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'TEACHER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'TEACHER' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

let closeResponse: { status: number; body: unknown } | 'network-error';
const fakeFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
  mocks.order.push(`${init?.method} ${new URL(String(url)).pathname}`);
  if (closeResponse === 'network-error') throw new TypeError('fetch failed');
  return new Response(JSON.stringify(closeResponse.body), { status: closeResponse.status });
});

beforeEach(() => {
  for (const m of Object.values(mocks)) if (typeof m === 'function') m.mockReset();
  mocks.order = [];
  fakeFetch.mockClear();
  vi.stubGlobal('fetch', fakeFetch);
  closeResponse = { status: 200, body: { closed: 2 } };
  mocks.classroomFindUnique.mockResolvedValue({ collab_enabled: true });
  mocks.collabDocFindUnique.mockResolvedValue(null);
  mocks.pageFindById.mockResolvedValue({ id: PAGE_ID, classroom_id: 'class-1', title: 'Syllabus' });
  mocks.deletePage.mockResolvedValue(undefined);
  mocks.auditCreate.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('closeLiveDocBeforeDelete', () => {
  it('does nothing for an unflagged classroom with no collab_docs row', async () => {
    mocks.classroomFindUnique.mockResolvedValue({ collab_enabled: false });
    await closeLiveDocBeforeDelete('deck', 'slide-1', 'class-1');
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('closes a leftover row even after the flag was turned off', async () => {
    mocks.classroomFindUnique.mockResolvedValue({ collab_enabled: false });
    mocks.collabDocFindUnique.mockResolvedValue({ kind: 'deck' });
    await closeLiveDocBeforeDelete('deck', 'slide-1', 'class-1');
    expect(mocks.order).toEqual(['POST /internal/deck/slide-1/close']);
    expect(JSON.parse(String(fakeFetch.mock.calls[0][1]?.body))).toEqual({ reason: 'deleted' });
  });

  it('treats a 404 from collab as nothing to close', async () => {
    closeResponse = { status: 404, body: { error: 'not-found' } };
    await expect(closeLiveDocBeforeDelete('page', PAGE_ID, 'class-1')).resolves.toBeUndefined();
  });

  it('refuses when collab does not answer', async () => {
    closeResponse = 'network-error';
    await expect(closeLiveDocBeforeDelete('page', PAGE_ID, 'class-1')).rejects.toMatchObject({
      code: 'LIVE_UNAVAILABLE',
    });
  });
});

describe('page_delete', () => {
  it('closes the live document before deleting the page', async () => {
    await pageDeleteTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX);
    expect(mocks.order).toEqual([`POST /internal/page/${PAGE_ID}/close`, 'deletePage']);
  });

  it('deletes nothing when the close fails', async () => {
    closeResponse = 'network-error';
    await expect(
      pageDeleteTool.handler({ classroom: 'org/x', page_id: PAGE_ID }, CTX)
    ).rejects.toMatchObject({ code: 'LIVE_UNAVAILABLE' });
    expect(mocks.deletePage).not.toHaveBeenCalled();
  });
});
