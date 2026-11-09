/**
 * The gradebook's submission panel loader.
 *
 *   - The gate is the gradebook's (OWNER + TEACHER): a refused caller reads
 *     nothing and nothing is audited.
 *   - The submission id comes from the URL, so it is matched against the gated
 *     classroom inside the query: classroom X's staff asking for classroom Y's
 *     submission get a 404, exactly as for an unknown id.
 *   - The payload is projected: no contact fields, no other User columns.
 *   - Each open is one VIEW audit row naming the surface.
 *   - The instructions link is shown only for a page of this classroom.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomStaff: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  findFirstLinkedByAssignmentIds: vi.fn(),
  findForSubmission: vi.fn(),
  findOpenByAssignmentId: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomStaff: (...a: unknown[]) => mocks.requireClassroomStaff(...a),
}));
vi.mock('~/utils/helpers', () => ({
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));
vi.mock('~/utils/mutationRefusal.server', () => ({
  canMutate: (classroom: { status?: string }, role?: string) =>
    Boolean(role) && (classroom.status === 'ACTIVE' || role === 'OWNER'),
}));
vi.mock('react-router', () => ({ useOutletContext: vi.fn() }));
vi.mock('../SubmissionPanel', () => ({ default: () => null }));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    page: {
      findFirstLinkedByAssignmentIds: (...a: unknown[]) =>
        mocks.findFirstLinkedByAssignmentIds(...a),
    },
    autogradingResult: {
      findForSubmission: (...a: unknown[]) => mocks.findForSubmission(...a),
    },
    regradeRequest: {
      findOpenByAssignmentId: (...a: unknown[]) => mocks.findOpenByAssignmentId(...a),
    },
  },
}));

const DEADLINE = new Date('2026-10-01T23:59:00Z');
const HOUR = 3_600_000;

/** A user row with everything that must not reach the page. */
const user = (id: string, name: string, login: string) => ({
  id,
  name,
  image: `https://example.test/${id}.png`,
  email: `${id}@school.test`,
  school_id: `SID-${id}`,
  stripe_customer_id: 'cus_1',
  accounts: [
    { provider_id: 'github', account_id: '1', username: login, image: null, email: 'gh@x.test' },
  ],
});

/** Two classrooms' submissions, as the database holds them. */
const ROWS = [
  {
    id: 'sub-x',
    classroom_id: 'class-x',
    status: 'CLOSED',
    closed_at: new Date(DEADLINE.getTime() - HOUR),
    provider_issue_number: null,
    is_late_override: false,
    is_late: false,
    num_late_hours: 0,
    extension_hours: 0,
    token_transactions: [],
    assignment: {
      id: 'asg-1',
      title: 'Lab 1',
      weight: 10,
      is_extra_credit: false,
      submission_mode: 'REPO',
      student_deadline: DEADLINE,
      module: { title: 'Week 1' },
    },
    grades: [{ id: 'g-1', emoji: 'star', grader_id: 'ta-1', grader: { id: 'ta-1', name: 'TA' } }],
    graders: [{ grader: { id: 'ta-1', name: 'TA' } }],
    git_repo: {
      id: 'repo-x',
      name: 'lab1-ada',
      student_id: 'ada',
      team_id: null,
      created_at: new Date(DEADLINE.getTime() - 72 * HOUR),
      student: user('ada', 'Ada Lovelace', 'ada-gh'),
      team: null,
    },
    analytics_snapshot: {
      total_commits: 2,
      total_additions: 10,
      total_deletions: 1,
      last_commit_at: new Date(DEADLINE.getTime() + HOUR),
      commits: [
        {
          sha: 'aaa1111',
          ts: new Date(DEADLINE.getTime() - 2 * HOUR).toISOString(),
          message: 'start',
        },
        { sha: 'bbb2222', ts: new Date(DEADLINE.getTime() + HOUR).toISOString(), message: 'late' },
      ],
      contributors: [
        { login: 'ada-gh', user_id: 'ada', commits: 2, email: 'a@x.test' },
        // Github fills an author it cannot match with their email.
        { login: 'mystery@home.test', user_id: null, commits: 1 },
      ],
    },
  },
  {
    id: 'sub-y',
    classroom_id: 'class-y',
    status: 'CLOSED',
    git_repo: { id: 'repo-y', name: 'lab1-bob' },
  },
];

/** `findFirst` honouring the where clause the loader sends: id + classroom. */
const gitRepoAssignmentFindFirst = vi.fn(
  async ({ where }: { where: { id: string; git_repo: { classroom_id: string } } }) =>
    ROWS.find(r => r.id === where.id && r.classroom_id === where.git_repo.classroom_id) ?? null
);

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<object>('@classmoji/database/gitIdentity')),
  default: () => ({
    gitRepoAssignment: { findFirst: gitRepoAssignmentFindFirst },
  }),
}));

const route = await import('../route.tsx');
const teacherRoute =
  await import('../../teacher.$class_.grades.submissions.$submissionId/route.tsx');

const loaderArgs = (submissionId: string, prefix = 'admin') =>
  ({
    params: { class: 'intro', submissionId },
    request: new Request(`http://localhost/${prefix}/intro/grades/submissions/${submissionId}`),
  }) as unknown as Parameters<typeof route.loader>[0];

const grant = (classroomId: string, role: 'OWNER' | 'TEACHER' = 'TEACHER') =>
  mocks.requireClassroomStaff.mockResolvedValue({
    userId: `${role.toLowerCase()}-1`,
    classroom: {
      id: classroomId,
      slug: 'intro',
      status: 'ACTIVE',
      git_organization: { provider: 'GITHUB', login: 'org' },
    },
    membership: { id: 'm-1', role },
  });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  gitRepoAssignmentFindFirst.mockClear();
  grant('class-x');
  mocks.findFirstLinkedByAssignmentIds.mockResolvedValue({});
  mocks.findForSubmission.mockResolvedValue(null);
  mocks.findOpenByAssignmentId.mockResolvedValue(null);
});

describe('submission panel loader — who may open it', () => {
  it('passes the gradebook gate (OWNER + TEACHER) with its own action name', async () => {
    await route.loader(loaderArgs('sub-x'));

    expect(mocks.requireClassroomStaff).toHaveBeenCalledWith(expect.any(Request), 'intro', {
      resourceType: 'GRADES',
      action: 'view_submission_panel',
    });
  });

  it.each([['STUDENT'], ['ASSISTANT'], ['a non-member']])(
    'refuses %s before reading or auditing anything',
    async () => {
      mocks.requireClassroomStaff.mockRejectedValue(new Response('Forbidden', { status: 403 }));

      await expect(route.loader(loaderArgs('sub-x'))).rejects.toMatchObject({ status: 403 });
      expect(gitRepoAssignmentFindFirst).not.toHaveBeenCalled();
      expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
    }
  );

  it('serves the same loader under /teacher', () => {
    expect(teacherRoute.loader).toBe(route.loader);
    expect(teacherRoute.default).toBe(route.default);
    expect('action' in teacherRoute).toBe(false);
  });
});

describe('submission panel loader — classroom scoping', () => {
  it("gives classroom X's staff a 404 for classroom Y's submission, auditing nothing", async () => {
    grant('class-x');

    const thrown = await route.loader(loaderArgs('sub-y')).catch(e => e);

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
    expect(gitRepoAssignmentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sub-y', git_repo: { classroom_id: 'class-x' } } })
    );
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it("and classroom Y's staff a 404 for classroom X's", async () => {
    grant('class-y');

    const thrown = await route.loader(loaderArgs('sub-x')).catch(e => e);

    expect((thrown as Response).status).toBe(404);
  });

  it('opens a submission of the gated classroom', async () => {
    const data = await route.loader(loaderArgs('sub-x'));
    expect(data.submission.id).toBe('sub-x');
  });
});

describe('submission panel loader — the payload', () => {
  it('carries no contact field and no other User column', async () => {
    const data = await route.loader(loaderArgs('sub-x'));

    const json = JSON.stringify(data);
    for (const leaked of [
      'school.test',
      'SID-',
      'cus_1',
      'gh@x.test',
      'a@x.test',
      'home.test',
      'accounts',
    ]) {
      expect(json).not.toContain(leaked);
    }
    expect(data.who).toEqual({
      kind: 'student',
      id: 'ada',
      name: 'Ada Lovelace',
      login: 'ada-gh',
      avatar_url: 'https://example.test/ada.png',
    });
    expect(data.analytics!.contributors).toEqual([
      { login: 'ada-gh', user_id: 'ada', commits: 2 },
      { login: null, user_id: null, commits: 1 },
    ]);
  });

  it('names the submitted commit (the newest by the submission time) and asks for its run', async () => {
    mocks.findForSubmission.mockResolvedValue({
      id: 'ag-1',
      git_repo_id: 'repo-x',
      commit_sha: 'aaa1111',
      run_id: '42',
      conclusion: 'success',
      total_tests: 4,
      passed_tests: 3,
      details: { secret: 'per-test output' },
    });

    const data = await route.loader(loaderArgs('sub-x'));

    expect(data.submitted_commit).toMatchObject({ sha: 'aaa1111', message: 'start' });
    // Bounded by the submission time (closed_at), the fallback's cutoff too.
    expect(mocks.findForSubmission).toHaveBeenCalledWith('repo-x', {
      sha: 'aaa1111',
      cutoff: new Date(DEADLINE.getTime() - HOUR),
    });
    expect(data.autograding).toEqual({
      conclusion: 'success',
      passed_tests: 3,
      total_tests: 4,
      run_id: '42',
      commit_sha: 'aaa1111',
    });
  });

  it('carries the open regrade request on this submission', async () => {
    mocks.findOpenByAssignmentId.mockResolvedValue({
      id: 'req-1',
      student_id: 'ada',
      classroom_id: 'class-x',
      student_comment: 'Please look again',
      grader_comment: null,
      previous_grade: ['star'],
      created_at: new Date('2026-10-03T00:00:00Z'),
    });

    const data = await route.loader(loaderArgs('sub-x'));

    expect(mocks.findOpenByAssignmentId).toHaveBeenCalledWith('sub-x');
    expect(data.open_regrade).toEqual({
      id: 'req-1',
      student_comment: 'Please look again',
      previous_grade: ['star'],
      created_at: new Date('2026-10-03T00:00:00Z'),
    });
  });

  it("asks for the first linked page among this classroom's pages", async () => {
    mocks.findFirstLinkedByAssignmentIds.mockResolvedValue({
      'asg-1': { id: 'page-1', title: 'Lab 1 instructions' },
    });

    const data = await route.loader(loaderArgs('sub-x'));

    expect(mocks.findFirstLinkedByAssignmentIds).toHaveBeenCalledWith(['asg-1'], {
      classroomId: 'class-x',
    });
    expect(data.assignment.instructions).toEqual({ id: 'page-1', title: 'Lab 1 instructions' });
  });

  it('hides the grade controls where the classroom takes no changes', async () => {
    mocks.requireClassroomStaff.mockResolvedValue({
      userId: 'teacher-1',
      classroom: { id: 'class-x', status: 'LOCKED', git_organization: null },
      membership: { id: 'm-1', role: 'TEACHER' },
    });

    expect((await route.loader(loaderArgs('sub-x'))).canMutate).toBe(false);
  });
});

describe('submission panel loader — audit', () => {
  it('writes one VIEW row naming the surface, on the gated classroom', async () => {
    await route.loader(loaderArgs('sub-x'));

    expect(mocks.addClassroomAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledWith({
      classroomId: 'class-x',
      userId: 'teacher-1',
      role: 'TEACHER',
      action: 'VIEW',
      resourceType: 'GIT_REPO_ASSIGNMENT',
      resourceId: 'sub-x',
      metadata: { tool: 'web:grades.submission_panel', assignment_id: 'asg-1', student_id: 'ada' },
    });
  });
});

describe('submission panel loader — push-mode submissions read at their submission time', () => {
  const late = new Date(DEADLINE.getTime() + 5 * HOUR);
  const template = {
    sha: 'tpl0000',
    ts: new Date(DEADLINE.getTime() - 96 * HOUR).toISOString(),
    message: 'Initial commit',
    author_login: 'classmoji-bot',
    author_email: 'hello@classmoji.com',
  };

  it('picks a late first push, not the template commit', async () => {
    const row = ROWS[0];
    const saved = { closed_at: row.closed_at, snapshot: row.analytics_snapshot };
    row.closed_at = late;
    row.analytics_snapshot = {
      ...saved.snapshot,
      commits: [template, { sha: 'late555', ts: late.toISOString(), message: 'first push' }],
    } as typeof saved.snapshot;
    try {
      const data = await route.loader(loaderArgs('sub-x'));
      expect(data.submitted_commit).toMatchObject({ sha: 'late555' });
    } finally {
      row.closed_at = saved.closed_at;
      row.analytics_snapshot = saved.snapshot;
    }
  });

  it('keeps a graded submission at its frozen time, past later pushes', async () => {
    // sub-x: closed (and graded) an hour before the deadline; bbb2222 came after.
    const data = await route.loader(loaderArgs('sub-x'));
    expect(data.submitted_commit).toMatchObject({ sha: 'aaa1111' });
  });
});
