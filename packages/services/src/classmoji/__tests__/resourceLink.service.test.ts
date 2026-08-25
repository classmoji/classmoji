/**
 * Unit tests for resourceLink — the page/slide link management extracted from
 * the web admin.$class.resources action so the MCP resource-link tools share it.
 *
 * Prisma and the content manifest are mocked. The tests pin the invariants the
 * extraction exists to establish: both ends of a link are proven to be in the
 * caller's classroom BEFORE anything is written, a duplicate is refused in SQL
 * rather than relying on the kanban's client-side guard, a remove that matched
 * nothing leaves the manifest alone, and a manifest push that fails never turns
 * a committed write into a failed call.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const pageFindFirst = vi.fn();
const slideFindFirst = vi.fn();
const repositoryFindFirst = vi.fn();
const assignmentFindFirst = vi.fn();
const pageLinkFindFirst = vi.fn();
const slideLinkFindFirst = vi.fn();
const pageLinkCreate = vi.fn();
const slideLinkCreate = vi.fn();
const pageLinkDeleteMany = vi.fn();
const slideLinkDeleteMany = vi.fn();
const pageLinkFindMany = vi.fn();
const slideLinkFindMany = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    page: { findFirst: (...a: unknown[]) => pageFindFirst(...a) },
    slide: { findFirst: (...a: unknown[]) => slideFindFirst(...a) },
    repository: { findFirst: (...a: unknown[]) => repositoryFindFirst(...a) },
    assignment: { findFirst: (...a: unknown[]) => assignmentFindFirst(...a) },
    pageLink: {
      findFirst: (...a: unknown[]) => pageLinkFindFirst(...a),
      create: (...a: unknown[]) => pageLinkCreate(...a),
      deleteMany: (...a: unknown[]) => pageLinkDeleteMany(...a),
      findMany: (...a: unknown[]) => pageLinkFindMany(...a),
    },
    slideLink: {
      findFirst: (...a: unknown[]) => slideLinkFindFirst(...a),
      create: (...a: unknown[]) => slideLinkCreate(...a),
      deleteMany: (...a: unknown[]) => slideLinkDeleteMany(...a),
      findMany: (...a: unknown[]) => slideLinkFindMany(...a),
    },
  }),
}));

const saveManifest = vi.fn();
vi.mock('../contentManifest.service.ts', () => ({
  saveManifest: (...a: unknown[]) => saveManifest(...a),
}));

const { addLink, removeLink, listLinks, ResourceLinkServiceError } =
  await import('../resourceLink.service.ts');

const CLASSROOM = 'classroom-1';
const CREATED_AT = new Date('2026-01-02T03:04:05Z');

/** Every write path the service can take — nothing may reach these on a rejection. */
const writeMocks = [pageLinkCreate, slideLinkCreate, pageLinkDeleteMany, slideLinkDeleteMany];
const expectNoWrites = () => {
  for (const m of writeMocks) expect(m).not.toHaveBeenCalled();
};

/** Grab the thrown ResourceLinkServiceError, or fail loudly if nothing threw. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(ResourceLinkServiceError);
  return (error as InstanceType<typeof ResourceLinkServiceError>).code;
}

beforeEach(() => {
  vi.clearAllMocks();
  saveManifest.mockResolvedValue(undefined);
  // Default: both ends resolve, no duplicate exists.
  pageFindFirst.mockResolvedValue({ id: 'page-1' });
  slideFindFirst.mockResolvedValue({ id: 'slide-1' });
  repositoryFindFirst.mockResolvedValue({ id: 'repo-1' });
  assignmentFindFirst.mockResolvedValue({ id: 'assign-1' });
  pageLinkFindFirst.mockResolvedValue(null);
  slideLinkFindFirst.mockResolvedValue(null);
  pageLinkCreate.mockResolvedValue({ id: 'link-1', order: 0, created_at: CREATED_AT });
  slideLinkCreate.mockResolvedValue({ id: 'link-2', order: 0, created_at: CREATED_AT });
});

describe('addLink', () => {
  const PAGE_TO_REPO = {
    classroomId: CLASSROOM,
    resourceType: 'page',
    resourceId: 'page-1',
    targetType: 'repository',
    targetId: 'repo-1',
  } as const;

  it('creates a page→repository link scoped to the classroom and refreshes the manifest', async () => {
    await expect(addLink({ ...PAGE_TO_REPO })).resolves.toEqual({
      id: 'link-1',
      resourceType: 'page',
      resourceId: 'page-1',
      targetType: 'repository',
      targetId: 'repo-1',
      order: 0,
      createdAt: CREATED_AT,
    });

    // Both ends were proven to be in THIS classroom before the insert.
    expect(pageFindFirst).toHaveBeenCalledWith({
      where: { id: 'page-1', classroom_id: CLASSROOM },
      select: { id: true },
    });
    expect(repositoryFindFirst).toHaveBeenCalledWith({
      where: { id: 'repo-1', classroom_id: CLASSROOM },
      select: { id: true },
    });
    // The unset target column is written as an explicit null.
    expect(pageLinkCreate.mock.calls[0][0].data).toEqual({
      page_id: 'page-1',
      repository_id: 'repo-1',
      assignment_id: null,
    });
    expect(saveManifest).toHaveBeenCalledExactlyOnceWith(CLASSROOM);
  });

  it('reaches an assignment target through its repository classroom chain', async () => {
    await addLink({
      classroomId: CLASSROOM,
      resourceType: 'slide',
      resourceId: 'slide-1',
      targetType: 'assignment',
      targetId: 'assign-1',
    });

    // Assignment has no classroom_id of its own.
    expect(assignmentFindFirst).toHaveBeenCalledWith({
      where: { id: 'assign-1', repository: { classroom_id: CLASSROOM } },
      select: { id: true },
    });
    expect(slideLinkCreate.mock.calls[0][0].data).toEqual({
      slide_id: 'slide-1',
      repository_id: null,
      assignment_id: 'assign-1',
    });
  });

  it('rejects a resource from another classroom without writing or touching the manifest', async () => {
    pageFindFirst.mockResolvedValue(null);

    expect(await codeOf(addLink({ ...PAGE_TO_REPO }))).toBe('resource_not_found');
    expectNoWrites();
    expect(saveManifest).not.toHaveBeenCalled();
  });

  it('rejects a target from another classroom without writing', async () => {
    repositoryFindFirst.mockResolvedValue(null);

    expect(await codeOf(addLink({ ...PAGE_TO_REPO }))).toBe('target_not_found');
    expectNoWrites();
    expect(saveManifest).not.toHaveBeenCalled();
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a StringFilter object', { not: '' }],
    ['a number', 7],
  ])('refuses %s as a resource id before any lookup runs', async (_label, resourceId) => {
    // A non-string id is DROPPED from a Prisma `where` rather than rejected, so
    // the classroom scope check would match an arbitrary row and pass.
    expect(
      await codeOf(addLink({ ...PAGE_TO_REPO, resourceId: resourceId as unknown as string }))
    ).toBe('resource_not_found');
    expect(pageFindFirst).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('refuses a non-string target id before any lookup runs', async () => {
    expect(
      await codeOf(addLink({ ...PAGE_TO_REPO, targetId: { not: '' } as unknown as string }))
    ).toBe('target_not_found');
    expect(repositoryFindFirst).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('reports an existing identical link as already_linked instead of duplicating it', async () => {
    // The kanban hides linked targets client-side; an API caller has no such
    // guard, and the nulls-distinct unique index would happily take a second row.
    pageLinkFindFirst.mockResolvedValue({ id: 'link-existing' });

    expect(await codeOf(addLink({ ...PAGE_TO_REPO }))).toBe('already_linked');
    expect(pageLinkFindFirst).toHaveBeenCalledWith({
      where: { page_id: 'page-1', repository_id: 'repo-1', assignment_id: null },
      select: { id: true },
    });
    expectNoWrites();
    expect(saveManifest).not.toHaveBeenCalled();
  });

  it('maps a P2002 unique violation to already_linked as a race backstop', async () => {
    pageLinkCreate.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    expect(await codeOf(addLink({ ...PAGE_TO_REPO }))).toBe('already_linked');
    expect(saveManifest).not.toHaveBeenCalled();
  });

  it('rethrows a non-unique database failure unchanged', async () => {
    pageLinkCreate.mockRejectedValue(
      Object.assign(new Error('connection lost'), { code: 'P1001' })
    );

    const error = await addLink({ ...PAGE_TO_REPO }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ResourceLinkServiceError);
    expect((error as Error).message).toBe('connection lost');
  });

  it('still succeeds when the manifest push fails', async () => {
    // The row is already committed; a git push that did not land must not be
    // reported to the caller as "nothing happened".
    saveManifest.mockRejectedValue(new Error('github is down'));

    await expect(addLink({ ...PAGE_TO_REPO })).resolves.toMatchObject({ id: 'link-1' });
  });
});

describe('removeLink', () => {
  it('deletes a page link through the classroom compound and refreshes the manifest', async () => {
    pageLinkDeleteMany.mockResolvedValue({ count: 1 });

    await expect(
      removeLink({ classroomId: CLASSROOM, resourceType: 'page', linkId: 'link-1' })
    ).resolves.toEqual({ id: 'link-1', resourceType: 'page' });

    expect(pageLinkDeleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'link-1', page: { classroom_id: CLASSROOM } },
    });
    expect(saveManifest).toHaveBeenCalledExactlyOnceWith(CLASSROOM);
  });

  it('deletes a slide link through the slide classroom compound', async () => {
    slideLinkDeleteMany.mockResolvedValue({ count: 1 });

    await removeLink({ classroomId: CLASSROOM, resourceType: 'slide', linkId: 'link-2' });

    expect(slideLinkDeleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'link-2', slide: { classroom_id: CLASSROOM } },
    });
  });

  it('leaves the manifest alone when the link was not this classroom', async () => {
    // `id` is the primary key past the guard, so count 0 means nothing was
    // deleted — the manifest cannot end up describing links that are still there.
    slideLinkDeleteMany.mockResolvedValue({ count: 0 });

    expect(
      await codeOf(removeLink({ classroomId: CLASSROOM, resourceType: 'slide', linkId: 'link-2' }))
    ).toBe('link_not_found');
    expect(saveManifest).not.toHaveBeenCalled();
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a StringFilter object', { not: '' }],
    ['a number', 7],
  ])('refuses %s as a link id without issuing the delete', async (_label, linkId) => {
    expect(
      await codeOf(
        removeLink({
          classroomId: CLASSROOM,
          resourceType: 'page',
          linkId: linkId as unknown as string,
        })
      )
    ).toBe('link_not_found');
    expectNoWrites();
  });

  it('still succeeds when the manifest push fails', async () => {
    pageLinkDeleteMany.mockResolvedValue({ count: 1 });
    saveManifest.mockRejectedValue(new Error('github is down'));

    await expect(
      removeLink({ classroomId: CLASSROOM, resourceType: 'page', linkId: 'link-1' })
    ).resolves.toEqual({ id: 'link-1', resourceType: 'page' });
  });
});

describe('listLinks', () => {
  const pageRow = {
    id: 'link-1',
    order: 0,
    created_at: CREATED_AT,
    page: { id: 'page-1', title: 'Setup', slug: 'setup' },
    repository: { id: 'repo-1', title: 'Lab 1', slug: 'lab-1' },
    assignment: null,
  };
  const slideRow = {
    id: 'link-2',
    order: 1,
    created_at: CREATED_AT,
    slide: { id: 'slide-1', title: 'Week 1', slug: 'week-1' },
    repository: null,
    assignment: {
      id: 'assign-1',
      title: 'Part A',
      slug: 'part-a',
      repository: { id: 'repo-1', title: 'Lab 1' },
    },
  };

  beforeEach(() => {
    pageLinkFindMany.mockResolvedValue([pageRow]);
    slideLinkFindMany.mockResolvedValue([slideRow]);
  });

  it('resolves both resource types to named resource and target shapes', async () => {
    await expect(listLinks({ classroomId: CLASSROOM })).resolves.toEqual([
      {
        id: 'link-1',
        resourceType: 'page',
        targetType: 'repository',
        order: 0,
        createdAt: CREATED_AT,
        resource: { id: 'page-1', title: 'Setup', slug: 'setup' },
        target: { id: 'repo-1', title: 'Lab 1', slug: 'lab-1' },
      },
      {
        id: 'link-2',
        resourceType: 'slide',
        targetType: 'assignment',
        order: 1,
        createdAt: CREATED_AT,
        resource: { id: 'slide-1', title: 'Week 1', slug: 'week-1' },
        // An assignment target also names the repository it sits in.
        target: {
          id: 'assign-1',
          title: 'Part A',
          slug: 'part-a',
          repositoryId: 'repo-1',
          repositoryTitle: 'Lab 1',
        },
      },
    ]);
  });

  it('scopes every query to the classroom through the parent resource', async () => {
    await listLinks({ classroomId: CLASSROOM });

    // Neither link table carries classroom_id, so the scope goes through page/slide.
    expect(pageLinkFindMany.mock.calls[0][0].where).toMatchObject({
      page: { classroom_id: CLASSROOM },
    });
    expect(slideLinkFindMany.mock.calls[0][0].where).toMatchObject({
      slide: { classroom_id: CLASSROOM },
    });
  });

  it('skips the other table entirely when resource_type narrows the read', async () => {
    await listLinks({ classroomId: CLASSROOM, resourceType: 'page' });
    expect(slideLinkFindMany).not.toHaveBeenCalled();

    vi.clearAllMocks();
    slideLinkFindMany.mockResolvedValue([]);
    await listLinks({ classroomId: CLASSROOM, resourceType: 'slide' });
    expect(pageLinkFindMany).not.toHaveBeenCalled();
  });

  it('narrows by resource id', async () => {
    await listLinks({ classroomId: CLASSROOM, resourceType: 'page', resourceId: 'page-1' });

    expect(pageLinkFindMany.mock.calls[0][0].where).toMatchObject({ page_id: 'page-1' });
  });

  it.each([
    ['repository', { repository_id: { not: null } }],
    ['assignment', { assignment_id: { not: null } }],
  ])('narrows to %s targets when no target id is given', async (targetType, expected) => {
    await listLinks({
      classroomId: CLASSROOM,
      resourceType: 'page',
      targetType: targetType as 'repository' | 'assignment',
    });

    expect(pageLinkFindMany.mock.calls[0][0].where).toMatchObject(expected);
  });

  it('narrows to a specific target when both type and id are given', async () => {
    await listLinks({
      classroomId: CLASSROOM,
      resourceType: 'page',
      targetType: 'assignment',
      targetId: 'assign-1',
    });

    expect(pageLinkFindMany.mock.calls[0][0].where).toMatchObject({ assignment_id: 'assign-1' });
  });

  it('matches either kind of target when an id is given without a type', async () => {
    await listLinks({ classroomId: CLASSROOM, resourceType: 'page', targetId: 'repo-1' });

    expect(pageLinkFindMany.mock.calls[0][0].where).toMatchObject({
      OR: [{ repository_id: 'repo-1' }, { assignment_id: 'repo-1' }],
    });
  });

  it('drops a row whose target is gone rather than reporting a hole', async () => {
    pageLinkFindMany.mockResolvedValue([{ ...pageRow, repository: null, assignment: null }]);
    slideLinkFindMany.mockResolvedValue([]);

    await expect(listLinks({ classroomId: CLASSROOM })).resolves.toEqual([]);
  });
});
