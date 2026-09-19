/**
 * Unit tests pinning the repository query sent by two loaders: the student
 * repositories view (`student.$class.repos`) and the student dashboard
 * (`student.$class.dashboard`). Nothing else is covered here.
 *
 * Attached pages and attached slides are the same kind of resource to those
 * views: both render as a leaf under a repository or an assignment, and both
 * carry an `is_draft` flag the author flips when the resource is ready. The
 * slide side has always been narrowed in the query; the page side is narrowed
 * so the two relations stay in step.
 *
 * Pinning the query rather than the rendered output is deliberate. The tree
 * components take whatever the loader hands them, so the only place the
 * distinction lives is the include — and an include is easy to copy between
 * routes without noticing which filters came along. Each assertion covers the
 * whole relation node, so a dropped `include` or `orderBy` fails too.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  repositoryFindMany: vi.fn(),
  gitRepoFindMany: vi.fn(),
  classroomFindUnique: vi.fn(),
  findAllAssignmentsForStudent: vi.fn(),
  findLatestByGitRepoIds: vi.fn(),
  getClassroomCalendar: vi.fn(),
  regradeRequestFindMany: vi.fn(),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    repository: { findMany: (...a: unknown[]) => mocks.repositoryFindMany(...a) },
    gitRepo: { findMany: (...a: unknown[]) => mocks.gitRepoFindMany(...a) },
    classroom: { findUnique: (...a: unknown[]) => mocks.classroomFindUnique(...a) },
  }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    helper: {
      findAllAssignmentsForStudent: (...a: unknown[]) => mocks.findAllAssignmentsForStudent(...a),
    },
    autogradingResult: {
      findLatestByGitRepoIds: (...a: unknown[]) => mocks.findLatestByGitRepoIds(...a),
    },
    calendar: { getClassroomCalendar: (...a: unknown[]) => mocks.getClassroomCalendar(...a) },
    regradeRequest: { findMany: (...a: unknown[]) => mocks.regradeRequestFindMany(...a) },
    organizationTag: { findByClassroomIdAndName: vi.fn() },
    team: { findUserTeamByTag: vi.fn() },
    token: { updateExtension: vi.fn() },
  },
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: vi.fn(),
  addAuditLog: vi.fn(),
  addClassroomAuditLog: vi.fn(),
}));

// `~` is not aliased in vitest.config.ts, so every aliased specifier these
// routes pull has to be stubbed for the import to resolve at all. The view
// layer is irrelevant here — only the loader's query is under test.
vi.mock('~/components/features/modules/ReadOnlyModulesTree', () => ({ default: () => null }));
vi.mock('~/components/features/modules/studentTree', () => ({
  buildRepositoryNode: () => ({}),
}));
vi.mock('../student.$class.dashboard/WeeklyCalendarCard', () => ({ default: () => null }));
vi.mock('../student.$class.dashboard/ModuleSpotlightCard', () => ({ default: () => null }));
vi.mock('../student.$class.dashboard/RetroTabsCard', () => ({ default: () => null }));

const CLASS_SLUG = 'cs52-26f';

const loaderArgs = (pathname: string) =>
  ({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost${pathname}`),
  }) as never;

/** The `include` the loader handed to `repository.findMany`. */
const repositoryInclude = () => mocks.repositoryFindMany.mock.calls[0][0].include;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'student-1',
    classroom: { id: 'class-1', slug: CLASS_SLUG, settings: {}, git_organization: null },
    membership: { role: 'STUDENT' },
  });
  mocks.repositoryFindMany.mockResolvedValue([]);
  mocks.gitRepoFindMany.mockResolvedValue([]);
  mocks.classroomFindUnique.mockResolvedValue({ git_organization: { login: 'cs52' } });
  mocks.findAllAssignmentsForStudent.mockResolvedValue([]);
  mocks.findLatestByGitRepoIds.mockResolvedValue(new Map());
  mocks.getClassroomCalendar.mockResolvedValue([]);
  mocks.regradeRequestFindMany.mockResolvedValue([]);
});

/**
 * The whole relation node a loader should send. `include` varies by route —
 * the repositories view takes the full row, the dashboard selects two columns
 * — so it is supplied per call while the filter and ordering stay fixed.
 */
const publishedPages = (include: unknown) => ({
  where: { page: { is_draft: false } },
  include,
  orderBy: { order: 'asc' },
});
const publishedSlides = (include: unknown) => ({
  where: { slide: { is_draft: false } },
  include,
  orderBy: { order: 'asc' },
});

describe('the repositories view asks for published pages and slides alike', () => {
  beforeEach(async () => {
    const { loader } = await import('../student.$class.repos/route.tsx');
    await loader(loaderArgs(`/student/${CLASS_SLUG}/repos`));
  });

  it('narrows the pages attached to a repository', () => {
    expect(repositoryInclude().pages).toEqual(publishedPages({ page: true }));
  });

  it('narrows the pages attached to an assignment', () => {
    expect(repositoryInclude().assignments.include.pages).toEqual(publishedPages({ page: true }));
  });

  it('leaves the slide relations narrowed exactly as before', () => {
    expect(repositoryInclude().slides).toEqual(publishedSlides({ slide: true }));
    expect(repositoryInclude().assignments.include.slides).toEqual(
      publishedSlides({ slide: true })
    );
  });
});

describe('the dashboard spotlight counts the same set', () => {
  beforeEach(async () => {
    const { loader } = await import('../student.$class.dashboard/route.tsx');
    // The loader returns its query behind a deferred `data` promise, so the
    // query only runs once that promise is awaited.
    const { data } = await loader(loaderArgs(`/student/${CLASS_SLUG}/dashboard`));
    await data;
  });

  it('narrows the pages attached to a repository', () => {
    expect(repositoryInclude().pages).toEqual(
      publishedPages({ page: { select: { id: true, title: true } } })
    );
  });
});
