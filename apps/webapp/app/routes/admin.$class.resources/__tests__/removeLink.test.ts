import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * removeLink deletes by a `linkId` that arrives in an untyped JSON body, scoped
 * by a compound `where`. That compound only narrows the delete while `linkId` is
 * a real string: Prisma drops an `undefined` value from a `where`, and the id
 * field accepts a `StringFilter` object, either of which would leave
 * `deleteMany` matching every link in the classroom.
 *
 * Driven directly, like the api.quiz gating test: the auth seam and Prisma are
 * mocked, so the assertion is that the delete is never ISSUED.
 */

const pageLinkDeleteMany = vi.fn();
const slideLinkDeleteMany = vi.fn();
const saveManifest = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    pageLink: { deleteMany: pageLinkDeleteMany },
    slideLink: { deleteMany: slideLinkDeleteMany },
    page: { findFirst: vi.fn() },
    slide: { findFirst: vi.fn() },
    repository: { findFirst: vi.fn() },
    assignment: { findFirst: vi.fn() },
  }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    contentManifest: { saveManifest: (...a: unknown[]) => saveManifest(...a) },
  },
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: vi.fn(async () => ({
    classroom: { id: 'classroom-1', status: 'ACTIVE' },
    membership: { role: 'OWNER' },
  })),
  assertClassroomMutationAllowed: vi.fn(),
}));

const { action } = await import('../action.ts');

const removeLink = (body: unknown) =>
  action({
    request: new Request('http://localhost/admin/cs52/resources?/removeLink', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    params: { class: 'cs52' },
    context: {},
  } as never);

/** Values that survive `if (!linkId)` but widen the scoped `where`. */
const unusableIds: [string, unknown][] = [
  ['undefined', undefined],
  ['null', null],
  ['a StringFilter object', { not: '' }],
  ['a number', 7],
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('admin.$class.resources removeLink', () => {
  it.each(unusableIds)('rejects %s as a page linkId without deleting', async (_l, linkId) => {
    const res = (await removeLink({ linkId, resourceType: 'page' }).catch(
      (e: unknown) => e
    )) as Response;

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(400);
    expect(pageLinkDeleteMany).not.toHaveBeenCalled();
    expect(slideLinkDeleteMany).not.toHaveBeenCalled();
  });

  it.each(unusableIds)('rejects %s as a slide linkId without deleting', async (_l, linkId) => {
    const res = (await removeLink({ linkId, resourceType: 'slide' }).catch(
      (e: unknown) => e
    )) as Response;

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(400);
    expect(pageLinkDeleteMany).not.toHaveBeenCalled();
    expect(slideLinkDeleteMany).not.toHaveBeenCalled();
  });

  it('deletes a real page link scoped to the classroom and saves the manifest', async () => {
    pageLinkDeleteMany.mockResolvedValue({ count: 1 });

    await expect(removeLink({ linkId: 'link-1', resourceType: 'page' })).resolves.toEqual({
      success: true,
    });
    expect(pageLinkDeleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'link-1', page: { classroom_id: 'classroom-1' } },
    });
    expect(saveManifest).toHaveBeenCalledWith('classroom-1');
  });

  it('leaves the manifest alone when the link was not this classroom', async () => {
    slideLinkDeleteMany.mockResolvedValue({ count: 0 });

    const res = (await removeLink({ linkId: 'link-1', resourceType: 'slide' }).catch(
      (e: unknown) => e
    )) as Response;

    expect(res.status).toBe(404);
    // `id` is the primary key, so count 0 means nothing was deleted — the
    // manifest cannot end up describing links that are gone.
    expect(saveManifest).not.toHaveBeenCalled();
  });
});
