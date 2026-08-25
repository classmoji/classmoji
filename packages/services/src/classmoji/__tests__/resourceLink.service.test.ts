/**
 * Unit tests for resourceLink — the page/slide link management extracted from
 * the web admin.$class.resources action so the MCP resource-link tools share it.
 *
 * Prisma and the content manifest are mocked. The tests pin the invariants the
 * extraction exists to establish: both ends of a link are proven to be in the
 * caller's classroom BEFORE anything is written, reads drop a row whose target
 * resolves outside the classroom, a duplicate is refused by the service's own
 * pre-check rather than by the kanban's drop-time guard on loader data, a
 * remove that matched nothing leaves the manifest alone, and a manifest push
 * that fails is reported rather than turning a committed write into a failed
 * call.
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

/** The read path warns about every row it drops; keep it quiet AND assertable. */
const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
  saveManifest.mockResolvedValue(true);
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
      manifestSynced: true,
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
    // The unused target column is an explicit null in the duplicate lookup too.
    // `repository_id: undefined` would be DROPPED from the `where` by Prisma,
    // which would match this slide's link to ANY repository and report a
    // duplicate that is not one.
    expect(slideLinkFindFirst).toHaveBeenCalledExactlyOnceWith({
      where: { slide_id: 'slide-1', repository_id: null, assignment_id: 'assign-1' },
      select: { id: true },
    });
    expect(slideLinkCreate.mock.calls[0][0].data).toEqual({
      slide_id: 'slide-1',
      repository_id: null,
      assignment_id: 'assign-1',
    });
  });

  it.each([
    ['an empty resourceType', { resourceType: '' }, 'resource_not_found'],
    ['a miscased resourceType', { resourceType: 'Page' }, 'resource_not_found'],
    ['an empty targetType', { targetType: '' }, 'target_not_found'],
    ['a miscased targetType', { targetType: 'Assignment' }, 'target_not_found'],
  ])('refuses %s instead of writing a row that points nowhere', async (_l, override, expected) => {
    // The classroom check and the insert derive their columns from the SAME
    // switch, so a value that is neither literal is refused outright rather
    // than validated as one kind and written as the other.
    const args = { ...PAGE_TO_REPO, ...override } as Parameters<typeof addLink>[0];

    expect(await codeOf(addLink(args))).toBe(expected);
    expectNoWrites();
    expect(saveManifest).not.toHaveBeenCalled();
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
    // This pre-check is the whole guard: the kanban's drop-time check reads
    // loader data that may be stale, an API caller has no check at all, and the
    // nulls-distinct unique index would happily take a second row.
    pageLinkFindFirst.mockResolvedValue({ id: 'link-existing' });

    expect(await codeOf(addLink({ ...PAGE_TO_REPO }))).toBe('already_linked');
    expect(pageLinkFindFirst).toHaveBeenCalledWith({
      where: { page_id: 'page-1', repository_id: 'repo-1', assignment_id: null },
      select: { id: true },
    });
    expectNoWrites();
    expect(saveManifest).not.toHaveBeenCalled();
  });

  it('translates a unique violation into already_linked rather than a raw db error', async () => {
    // The nulls-distinct index cannot actually fire on these rows, so this is
    // not race coverage — it pins that IF a unique violation ever arrives (a
    // tightened index later), the caller gets the typed failure, not P2002.
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

  it('still succeeds when the manifest push fails, and says the push did not land', async () => {
    // The row is already committed; a git push that did not land must not be
    // reported to the caller as "nothing happened" — but it must not be
    // reported as a synced manifest either.
    saveManifest.mockRejectedValue(new Error('github is down'));

    await expect(addLink({ ...PAGE_TO_REPO })).resolves.toMatchObject({
      id: 'link-1',
      manifestSynced: false,
    });
  });

  it('relays a manifest push that was skipped rather than attempted', async () => {
    // saveManifest reports false when there is no git organization to push to.
    saveManifest.mockResolvedValue(false);

    await expect(addLink({ ...PAGE_TO_REPO })).resolves.toMatchObject({ manifestSynced: false });
  });
});

describe('removeLink', () => {
  it('deletes a page link through the classroom compound and refreshes the manifest', async () => {
    pageLinkDeleteMany.mockResolvedValue({ count: 1 });

    await expect(
      removeLink({ classroomId: CLASSROOM, resourceType: 'page', linkId: 'link-1' })
    ).resolves.toEqual({ id: 'link-1', resourceType: 'page', manifestSynced: true });

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

  it('still succeeds when the manifest push fails, and says the push did not land', async () => {
    pageLinkDeleteMany.mockResolvedValue({ count: 1 });
    saveManifest.mockRejectedValue(new Error('github is down'));

    await expect(
      removeLink({ classroomId: CLASSROOM, resourceType: 'page', linkId: 'link-1' })
    ).resolves.toEqual({ id: 'link-1', resourceType: 'page', manifestSynced: false });
  });

  it.each([
    ['an empty string', ''],
    ['a miscased literal', 'Page'],
  ])('refuses %s as a resourceType instead of deleting from the slide table', async (_l, kind) => {
    // resourceType picks the table, so an unrecognised value must not fall
    // through to slides and issue a delete against the wrong one.
    expect(
      await codeOf(
        removeLink({
          classroomId: CLASSROOM,
          resourceType: kind as 'page' | 'slide',
          linkId: 'link-1',
        })
      )
    ).toBe('link_not_found');
    expectNoWrites();
    expect(saveManifest).not.toHaveBeenCalled();
  });
});

describe('listLinks', () => {
  const pageRow = {
    id: 'link-1',
    order: 0,
    created_at: CREATED_AT,
    page: { id: 'page-1', title: 'Setup', slug: 'setup' },
    // classroom_id rides along on both repository selects: the `where` can only
    // scope the page/slide side, so the target side is checked per row.
    repository: { id: 'repo-1', title: 'Lab 1', slug: 'lab-1', classroom_id: CLASSROOM },
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
      repository: { id: 'repo-1', title: 'Lab 1', classroom_id: CLASSROOM },
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

  it('drops a row whose target is gone rather than reporting a hole, and says so', async () => {
    pageLinkFindMany.mockResolvedValue([{ ...pageRow, repository: null, assignment: null }]);
    slideLinkFindMany.mockResolvedValue([]);

    await expect(listLinks({ classroomId: CLASSROOM })).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('neither a repository'));
  });

  it.each([
    [
      'a repository',
      {
        repository: { id: 'repo-9', title: 'Other', slug: 'other', classroom_id: 'classroom-2' },
        assignment: null,
      },
    ],
    [
      'an assignment',
      {
        repository: null,
        assignment: {
          id: 'assign-9',
          title: 'Other',
          slug: 'other',
          repository: { id: 'repo-9', title: 'Other', classroom_id: 'classroom-2' },
        },
      },
    ],
  ])('drops a row pointing at %s in another classroom', async (_label, target) => {
    // The link tables carry no classroom, so the `where` scopes the page side
    // only and the target relations come back unfiltered. Not every writer of
    // these tables scopes its target, so the row is confirmed here.
    pageLinkFindMany.mockResolvedValue([{ ...pageRow, ...target }]);
    slideLinkFindMany.mockResolvedValue([]);

    await expect(listLinks({ classroomId: CLASSROOM })).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('another classroom'));
  });

  it('reports the repository half of a row that names both targets', async () => {
    // A row naming both does not describe one place; the repository is the
    // wider of the two, so it is what gets reported — loudly.
    pageLinkFindMany.mockResolvedValue([{ ...pageRow, assignment: slideRow.assignment }]);
    slideLinkFindMany.mockResolvedValue([]);

    await expect(listLinks({ classroomId: CLASSROOM })).resolves.toMatchObject([
      { id: 'link-1', targetType: 'repository' },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('both a repository and an assignment')
    );
  });
});
