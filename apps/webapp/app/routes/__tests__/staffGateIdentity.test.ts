/**
 * Unit tests pinning WHAT each staff-facing gate calls itself.
 *
 * `assertClassroomAccess` writes an audit row on denial, and the row is only
 * useful if it says which resource was refused. Several of these loaders called
 * their gate with no options, so every denial across the whole teaching-team
 * surface landed on the same default 'TEACHING_RESOURCE'/'access' — and the
 * pages editor, passing nothing at all, landed on the even broader
 * 'CLASSROOM_ACCESS'.
 *
 * These loaders are re-exported by the /teacher prefix, so the fix belongs in
 * the UNDERLYING route where it is correct for every consumer. That is exactly
 * what makes it worth pinning: the names are shared, so a change made for one
 * prefix silently changes the other.
 *
 * The modules case is the one that is NOT shared. That loader serves students
 * and staff from the same code, and 'STUDENT_REPOSITORIES' misdescribes the
 * staff view (which shows unpublished modules and draft items), so it varies by
 * prefix — narrowing the staff description without touching the student one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  requireClassroomTeachingTeam: vi.fn(),
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

// Data layers the loaders touch; each returns something harmlessly empty.
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    gitRepoAssignmentGrader: { findAssignedByGrader: vi.fn(async () => []) },
    regradeRequest: { findMany: vi.fn(async () => []) },
    module: {
      findByClassroomSlug: vi.fn(async () => []),
      hasModulesForClassroom: vi.fn(async () => false),
    },
    resourceView: {
      getRecentViewersForPaths: vi.fn(async () => new Map()),
      getRecentViewers: vi.fn(async () => []),
      normalizePath: vi.fn(() => '/x'),
      recordView: vi.fn(),
    },
  },
}));
vi.mock('@classmoji/database', () => ({
  default: () => ({ repository: { findMany: vi.fn(async () => []) } }),
}));

// The loaders are what is under test; the view layers only need to import.
// `~` is not aliased in vitest.config.ts, so every aliased specifier these
// modules pull has to be stubbed for the import to resolve at all.
vi.mock('~/components', () => ({
  CommonLayout: () => null,
  RequireRole: () => null,
  RegradeRequestsTable: () => null,
}));
vi.mock('~/components/features/pages', () => ({ PagePeekProvider: () => null }));
vi.mock('~/components/features/dashboard', () => ({
  CockpitPanel: () => null,
  StaffCockpit: () => null,
}));
vi.mock('~/components/features/modules/studentTree', () => ({ buildStudentTree: () => [] }));
vi.mock('~/components/features/modules/ReadOnlyModulesTree', () => ({ default: () => null }));
vi.mock('../student.$class.repos/ModuleAccordion', () => ({ default: () => null }));
vi.mock('../assistant.$class_.repos/RepositoryAssignmentsTable', () => ({ default: () => null }));
vi.mock('../assistant.$class_.grading/RepositoryAssignmentsTable', () => ({
  default: () => null,
}));
vi.mock('../admin.$class.dashboard/GradingTabsCard', () => ({ default: () => null }));
vi.mock('~/utils/navVisibility', () => ({
  DEFAULT_NAV_VISIBILITY: {},
  navVisibilityFromSettings: () => ({}),
}));
vi.mock('~/utils/pagesNav.server', () => ({
  EMPTY_PAGES_NAV: { hasPages: false, siteSlugByPageId: {}, siteOrigin: null },
  loadPagesNav: vi.fn(async () => ({
    hasPages: false,
    siteSlugByPageId: {},
    siteOrigin: null,
  })),
}));

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE', settings: {} };

const loaderArgs = (pathname: string) =>
  ({
    params: { class: CLASS_SLUG, pageId: 'page-1' },
    request: new Request(`http://localhost${pathname}`),
  }) as never;

/**
 * Run a loader far enough to observe its gate call.
 *
 * The gate is the FIRST thing every one of these loaders does, so whatever the
 * loader goes on to fetch (or redirect to) afterwards is irrelevant here and is
 * deliberately not stubbed — pinning the gate's name should not require
 * re-stubbing every data call a loader happens to make today.
 */
const runLoader = async (routePath: string, pathname: string) => {
  const { loader } = await import(`../${routePath}/route.tsx`);
  await Promise.resolve(loader(loaderArgs(pathname))).catch(() => {});
};

/** Options the gate was called with. */
const teachingTeamOptions = () => mocks.requireClassroomTeachingTeam.mock.calls[0][2];
const accessOptions = () => mocks.assertClassroomAccess.mock.calls[0][0];

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.requireClassroomTeachingTeam.mockResolvedValue({
    userId: 'ta-1',
    classroom: CLASSROOM,
    membership: { role: 'ASSISTANT' },
  });
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'teacher-1',
    classroom: CLASSROOM,
    membership: { role: 'TEACHER' },
  });
});

describe('teaching-team gates name the resource they guard', () => {
  it.each([
    ['assistant.$class_.dashboard', 'STAFF_DASHBOARD', 'view_dashboard'],
    ['assistant.$class_.grading', 'GRADING_QUEUE', 'view_grading_queue'],
    ['assistant.$class_.regrade-requests', 'REGRADE_REQUEST', 'view_regrade_requests'],
    ['assistant.$class_.repos', 'REPOSITORIES', 'view_repos'],
  ])('%s logs %s/%s rather than the shared default', async (route, resourceType, action) => {
    await runLoader(route, `/assistant/${CLASS_SLUG}/x`);

    expect(teachingTeamOptions()).toEqual({ resourceType, action });
  });

  it('the /teacher layout names the shell a non-staff user was refused', async () => {
    await runLoader('teacher', `/teacher/${CLASS_SLUG}/dashboard`);

    expect(teachingTeamOptions()).toEqual({
      resourceType: 'TEACHER_LAYOUT',
      action: 'enter_teacher_prefix',
    });
  });
});

describe('the pages editor hand-off names PAGES', () => {
  it('no longer falls back to the CLASSROOM_ACCESS catch-all', async () => {
    await runLoader('admin.$class.pages.$pageId', `/teacher/${CLASS_SLUG}/pages/page-1`);

    expect(accessOptions()).toMatchObject({
      resourceType: 'PAGES',
      attemptedAction: 'open_page_editor',
      allowedRoles: ['OWNER', 'TEACHER'],
    });
  });
});

describe('the shared modules loader describes staff and students differently', () => {
  it.each([['teacher'], ['assistant']])(
    'names the /%s view MODULES, since it shows unpublished content',
    async prefix => {
      await runLoader('student.$class.modules', `/${prefix}/${CLASS_SLUG}/modules`);

      expect(accessOptions()).toMatchObject({
        resourceType: 'MODULES',
        attemptedAction: 'view_modules',
      });
    }
  );

  it('leaves the student view logging STUDENT_REPOSITORIES exactly as before', async () => {
    await runLoader('student.$class.modules', `/student/${CLASS_SLUG}/modules`);

    expect(accessOptions()).toMatchObject({
      resourceType: 'STUDENT_REPOSITORIES',
      attemptedAction: 'view_modules',
    });
  });

  it('keeps admitting the same four roles whichever prefix served it', async () => {
    // The gate's DESCRIPTION changed; who it lets through did not.
    await runLoader('student.$class.modules', `/teacher/${CLASS_SLUG}/modules`);

    expect(accessOptions().allowedRoles).toEqual(['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT']);
  });
});
