/**
 * Unit tests pinning WHO sees unpublished repositories, assignments and
 * attached resources.
 *
 * There are two repository-fetching loaders whose Prisma calls look almost
 * identical:
 *
 *   - student.$class.modules — asks the module service for the published view
 *     (`includeUnpublished: false`), which drops unpublished modules, items and
 *     assignments, and REPO assignments whose repository is unpublished. This
 *     is what keeps drafts off the student surface. (The separate student
 *     repositories screen that used to do the same is gone; Modules is the
 *     student surface now.)
 *   - assistant.$class_.repos — filters NOTHING. The teaching team is meant to
 *     see the classroom as it actually is (a teacher prepping next term has
 *     nothing but drafts), with drafts badged in the view instead of hidden.
 *     It is re-exported by /teacher, so this one loader serves both staff roles.
 *
 * Because the two `where` clauses are a copy-paste apart, the failure mode is
 * silent in both directions: paste the student filter into the staff loader and
 * the teacher's page goes blank again; paste the staff one into the student
 * loader and every student sees unreleased coursework. These tests assert the
 * ABSENCE of a filter as carefully as its presence, so either direction fails.
 *
 * student.$class.modules serves BOTH audiences from one loader, so the flag it
 * hands the service is a function of that route's own `isStaff` — derived from
 * the membership its gate returned, never from the URL prefix. The last tests
 * here pin that specifically: role decides, prefix does not.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  requireClassroomTeachingTeam: vi.fn(),
  repositoryFindMany: vi.fn(),
  classroomFindUnique: vi.fn(),
  gitRepoFindMany: vi.fn(),
  listForClassroom: vi.fn(),
  findAllAssignmentsForStudent: vi.fn(),
  findLatestByGitRepoIds: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    repository: { findMany: mocks.repositoryFindMany },
    classroom: { findUnique: mocks.classroomFindUnique },
    gitRepo: { findMany: mocks.gitRepoFindMany },
  }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    helper: { findAllAssignmentsForStudent: mocks.findAllAssignmentsForStudent },
    autogradingResult: { findLatestByGitRepoIds: mocks.findLatestByGitRepoIds },
    module: { listForClassroom: mocks.listForClassroom },
  },
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  addAuditLog: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  assertProTier: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomTeachingTeam: (...a: unknown[]) => mocks.requireClassroomTeachingTeam(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));

// `~` is not aliased in vitest.config.ts, so every aliased specifier these route
// modules pull has to be stubbed for the import to resolve at all. The view
// layers only need to import; none of them runs in a loader test.
vi.mock('~/components/features/modules/ReadOnlyModulesTree', () => ({ default: () => null }));
vi.mock('~/components/features/modules/studentTree', () => ({
  buildRepositoryNode: () => ({}),
  buildAssignmentLeaf: () => ({}),
  resourceLeaves: () => [],
}));

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE', settings: {} };

const loaderArgs = (pathname: string) =>
  ({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost${pathname}`),
  }) as never;

const runLoader = async (routePath: string, pathname: string) => {
  const { loader } = await import(`../${routePath}/route.tsx`);
  await Promise.resolve(loader(loaderArgs(pathname)));
};

/** The `findMany` options the loader handed Prisma for the repository fetch. */
const repositoryQuery = (callIndex = 0) =>
  mocks.repositoryFindMany.mock.calls[callIndex][0] as {
    where: Record<string, unknown>;
    include: {
      assignments: {
        where?: unknown;
        include: { slides: { where?: unknown }; pages: { where?: unknown } };
      };
      slides: { where?: unknown };
      pages: { where?: unknown };
      quizzes: { where?: unknown };
    };
  };

const asTeacher = () =>
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'teacher-1',
    classroom: CLASSROOM,
    membership: { role: 'TEACHER' },
  });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();

  mocks.requireClassroomTeachingTeam.mockResolvedValue({
    userId: 'ta-1',
    classroom: CLASSROOM,
    membership: { role: 'ASSISTANT' },
  });
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'student-1',
    classroom: CLASSROOM,
    membership: { role: 'STUDENT' },
  });

  mocks.repositoryFindMany.mockResolvedValue([]);
  mocks.classroomFindUnique.mockResolvedValue(null);
  mocks.gitRepoFindMany.mockResolvedValue([]);
  mocks.findAllAssignmentsForStudent.mockResolvedValue([]);
  mocks.findLatestByGitRepoIds.mockResolvedValue(new Map());
  mocks.listForClassroom.mockResolvedValue([
    { id: 'm1', title: 'Week 1', is_published: true, items: [], assignments: [] },
  ]);
});

describe('the staff repos loader hides nothing', () => {
  // Asserting ABSENCE, not just a different value: a copy-paste of the student
  // filter must fail here, and `toBeUndefined` is what catches that.
  it('does not filter is_published at the repository level', async () => {
    await runLoader('assistant.$class_.repos', `/assistant/${CLASS_SLUG}/repos`);

    const query = repositoryQuery();
    expect(query.where).toEqual({ classroom_id: CLASSROOM.id });
    expect('is_published' in query.where).toBe(false);
  });

  it('does not filter is_published on the nested assignments', async () => {
    await runLoader('assistant.$class_.repos', `/assistant/${CLASS_SLUG}/repos`);

    expect(repositoryQuery().include.assignments.where).toBeUndefined();
  });

  it('does not filter draft slides, pages or quizzes either', async () => {
    await runLoader('assistant.$class_.repos', `/assistant/${CLASS_SLUG}/repos`);

    const { include } = repositoryQuery();
    expect(include.slides.where).toBeUndefined();
    expect(include.pages.where).toBeUndefined();
    expect(include.quizzes.where).toBeUndefined();
    expect(include.assignments.include.slides.where).toBeUndefined();
    expect(include.assignments.include.pages.where).toBeUndefined();
  });

  it('serves /teacher from the very same loader', async () => {
    const staff = await import('../teacher.$class_.repos/route');
    const assistant = await import('../assistant.$class_.repos/route');

    expect(staff.loader).toBe(assistant.loader);
  });
});

describe('the shared modules loader filters by ROLE, not by URL prefix', () => {
  // The draft policy for modules lives in module.service.listForClassroom; the
  // loader's whole job is to hand it the right flag. Asserted on the exact
  // options object so a second, unfiltered call cannot slip in beside it.
  const listOptions = () => mocks.listForClassroom.mock.calls[0][1];

  it('asks for the published view for a student', async () => {
    await runLoader('student.$class.modules', `/student/${CLASS_SLUG}/modules`);

    expect(mocks.listForClassroom).toHaveBeenCalledTimes(1);
    expect(listOptions()).toEqual({ includeUnpublished: false });
  });

  it('asks for everything for staff', async () => {
    asTeacher();

    await runLoader('student.$class.modules', `/teacher/${CLASS_SLUG}/modules`);

    expect(listOptions()).toEqual({ includeUnpublished: true });
  });

  // If `isStaff` were ever sniffed from the pathname rather than taken from the
  // membership the gate returned, the prefix alone would change what comes back.
  // These two pin that it cannot.
  it('gives a STUDENT the published view even under a staff prefix', async () => {
    await runLoader('student.$class.modules', `/teacher/${CLASS_SLUG}/modules`);

    expect(listOptions()).toEqual({ includeUnpublished: false });
  });

  it('gives a TEACHER everything even under the student prefix', async () => {
    asTeacher();

    await runLoader('student.$class.modules', `/student/${CLASS_SLUG}/modules`);

    expect(listOptions()).toEqual({ includeUnpublished: true });
  });

  it('never fetches repositories itself', async () => {
    await runLoader('student.$class.modules', `/student/${CLASS_SLUG}/modules`);

    expect(mocks.repositoryFindMany).not.toHaveBeenCalled();
  });
});
