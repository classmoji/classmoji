import { describe, it, expect, vi, beforeEach } from 'vitest';

const selfFormedMock = vi.fn();
const findForStudentMock = vi.fn();
const calendarMock = vi.fn();
const findAllAssignmentsMock = vi.fn();
const regradeRequestsMock = vi.fn();
const assertAccessMock = vi.fn();
const loadQuizzesVisibleMock = vi.fn();
const listForStudentMock = vi.fn();
const listPublishedAssignmentsMock = vi.fn();
const upNextMock = vi.fn();
const summaryMock = vi.fn();
const emojiMappingFindManyMock = vi.fn();
const letterGradeMappingFindManyMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    // The grade line's reads, for the test that runs the real entry point.
    emojiMapping: { findMany: (...a: unknown[]) => emojiMappingFindManyMock(...a) },
    letterGradeMapping: { findMany: (...a: unknown[]) => letterGradeMappingFindManyMock(...a) },
  }),
}));

// The real grade-line entry point, below the mocked barrel. Its quiz gate is a
// read too: answered here, so no quiz items are loaded.
vi.mock('../../../../../../packages/services/src/classmoji/entitlement.service.ts', () => ({
  quizzesVisibleOrThrow: async () => false,
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    calendar: {
      getClassroomCalendar: (...a: unknown[]) => calendarMock(...a),
    },
    helper: {
      findAllAssignmentsForStudent: (...a: unknown[]) => findAllAssignmentsMock(...a),
      gradeSummaryForStudent: (...a: unknown[]) => summaryMock(...a),
      showsGradeSummary: (
        role: string | undefined,
        settings: Record<string, unknown> | null | undefined
      ) =>
        role === 'STUDENT' &&
        (settings?.final_grades_released === true || settings?.show_grades_to_students === true),
    },
    regradeRequest: {
      findMany: (...a: unknown[]) => regradeRequestsMock(...a),
    },
    organizationTag: {
      findByClassroomIdAndName: vi.fn(),
    },
    team: {
      findSelfFormedForStudent: (...a: unknown[]) => selfFormedMock(...a),
    },
    gitRepo: {
      findForStudent: (...a: unknown[]) => findForStudentMock(...a),
    },
    token: {
      updateExtension: vi.fn(),
    },
    studentCoursework: {
      listForStudent: (...a: unknown[]) => listForStudentMock(...a),
      listPublishedAssignments: (...a: unknown[]) => listPublishedAssignmentsMock(...a),
      upNext: (...a: unknown[]) => upNextMock(...a),
    },
  },
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertAccessMock(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  loadQuizzesVisible: (...a: unknown[]) => loadQuizzesVisibleMock(...a),
}));

vi.mock('../WeeklyCalendarCard', () => ({ default: () => null }));
vi.mock('../UpNextCard', () => ({ default: () => null }));
vi.mock('../RetroTabsCard', () => ({ default: () => null }));

const { loader } = await import('../route.tsx');
const { gradeSummaryForStudent } =
  await import('../../../../../../packages/services/src/classmoji/helper.service.ts');

const loaderArgs = () =>
  ({
    params: { class: 'test-class' },
    request: new Request('http://localhost/student/test-class/dashboard'),
  }) as unknown as Parameters<typeof loader>[0];

/** A coursework row as studentCoursework.listForStudent returns it (fields the loader reads). */
const courseworkRow = (over: Record<string, unknown>) => ({
  assignmentId: 'a-1',
  type: 'REPO',
  title: 'Row',
  done: false,
  score: null,
  scoredAt: null,
  href: null,
  extensionHours: 0,
  ...over,
});

const grant = (
  role = 'STUDENT',
  settings: Record<string, unknown> | null = null,
  letterGrade: string | null = null
) =>
  assertAccessMock.mockResolvedValue({
    userId: 'student-1',
    classroom: {
      id: 'class-1',
      name: 'Test Class',
      git_organization: { login: 'test-org' },
      settings,
    },
    membership: { role, letter_grade: letterGrade },
  });

beforeEach(() => {
  vi.clearAllMocks();
  grant();
  calendarMock.mockResolvedValue([]);
  selfFormedMock.mockResolvedValue([]);
  findForStudentMock.mockResolvedValue([]);
  regradeRequestsMock.mockResolvedValue([]);
  findAllAssignmentsMock.mockResolvedValue([]);
  loadQuizzesVisibleMock.mockResolvedValue(true);
  listForStudentMock.mockResolvedValue([]);
  listPublishedAssignmentsMock.mockResolvedValue([{ id: 'listed' }]);
  upNextMock.mockImplementation((rows: Array<{ done: boolean }>) => rows.filter(r => !r.done));
  summaryMock.mockResolvedValue({ kind: 'letter', letter: 'B', count: 3 });
});

describe('student dashboard loader — assignment lookup guard', () => {
  it('resolves dashboard data when the student assignment lookup rejects', async () => {
    findAllAssignmentsMock.mockRejectedValue(new Error('git_repo relation missing'));

    const result = await loader(loaderArgs());
    const data = await result.data;

    expect(data.feedback).toEqual([]);
    expect(data.team).toBeNull();
    expect(data.needsTeam).toBeNull();
    expect(data.resubmits).toEqual([]);
    expect(data.upNext).toEqual([]);
  });

  it('still resolves when the coursework read rejects, and logs it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    listForStudentMock.mockRejectedValue(new Error('connection timeout'));

    const data = await (await loader(loaderArgs())).data;

    expect(data.upNext).toEqual([]);
    expect(data.feedback).toEqual([]);
    expect(logged).toHaveBeenCalledWith(
      '[student dashboard] coursework read failed',
      { classroomId: 'class-1', userId: 'student-1' },
      expect.any(Error)
    );
    logged.mockRestore();
  });

  it('still resolves when the assignment listing rejects, and logs it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    listPublishedAssignmentsMock.mockRejectedValue(new Error('connection timeout'));

    const data = await (await loader(loaderArgs())).data;

    expect(data.upNext).toEqual([]);
    expect(listForStudentMock).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      '[student dashboard] assignment listing failed',
      { classroomId: 'class-1', userId: 'student-1' },
      expect.any(Error)
    );
    logged.mockRestore();
  });

  it('sends the week start as a plain date and fetches events beyond it on both sides', async () => {
    const data = await (await loader(loaderArgs())).data;

    expect(data.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const [, from, to] = calendarMock.mock.calls[0] as [string, Date, Date];
    const weekStart = new Date(`${data.weekStart}T00:00:00`).getTime();
    expect(from.getTime()).toBeLessThan(weekStart);
    expect(to.getTime()).toBeGreaterThan(weekStart + 7 * 86_400_000);
  });
});

describe('student dashboard loader — Up next', () => {
  it("reads the student's coursework with the quiz answer and the submissions already read", async () => {
    const submissions = [{ id: 'ra-1', assignment_id: 'a-1' }];
    findAllAssignmentsMock.mockResolvedValue(submissions);
    loadQuizzesVisibleMock.mockResolvedValue(false);

    await (
      await loader(loaderArgs())
    ).data;

    expect(listPublishedAssignmentsMock).toHaveBeenCalledWith('class-1');
    expect(listForStudentMock).toHaveBeenCalledWith({
      classroomId: 'class-1',
      classroomSlug: 'test-class',
      userId: 'student-1',
      quizzesVisible: false,
      gitOrgLogin: 'test-org',
      git: expect.objectContaining({ login: 'test-org' }),
      repoSubmissions: submissions,
      assignments: [{ id: 'listed' }],
    });
    // One read of the submissions, shared with the coursework rows.
    expect(findAllAssignmentsMock).toHaveBeenCalledTimes(1);
  });

  it('hands the card what upNext picks from the coursework', async () => {
    const open = courseworkRow({ assignmentId: 'open', type: 'QUIZ' });
    const done = courseworkRow({ assignmentId: 'done', done: true });
    listForStudentMock.mockResolvedValue([open, done]);

    const data = await (await loader(loaderArgs())).data;

    expect(upNextMock).toHaveBeenCalledWith([open, done]);
    expect(data.upNext).toEqual([open]);
    expect(data.viewerIsStudent).toBe(true);
  });

  it('sends Up next rows without the repo details the card never shows', async () => {
    const repoRow = courseworkRow({
      assignmentId: 'lab',
      repo: { gitRepoAssignmentId: 'ra-1', grades: [], graders: [{ id: 'g', name: 'Grace' }] },
    });
    listForStudentMock.mockResolvedValue([repoRow]);

    const data = await (await loader(loaderArgs())).data;

    expect(data.upNext.map(r => r.assignmentId)).toEqual(['lab']);
    expect('repo' in data.upNext[0]).toBe(false);
    expect(data.upNext[0].extensionHours).toBe(0);
    expect(JSON.stringify(data.upNext)).not.toContain('Grace');
  });

  it('keeps the hours bought on a quiz row, so the card reads it inside its window', async () => {
    const quiz = courseworkRow({ assignmentId: 'q', type: 'QUIZ', extensionHours: 3 });
    listForStudentMock.mockResolvedValue([quiz]);

    const data = await (await loader(loaderArgs())).data;

    expect(data.upNext[0].extensionHours).toBe(3);
  });

  it('tells the card when the viewer is staff', async () => {
    grant('TEACHER');

    const data = await (await loader(loaderArgs())).data;

    expect(data.viewerIsStudent).toBe(false);
  });
});

describe('student dashboard loader — recent grades', () => {
  /** A REPO coursework row with a released grade. */
  const gradedRepo = (over: Record<string, unknown> = {}) =>
    courseworkRow({
      assignmentId: 'a-lab',
      title: 'Lab 1',
      done: true,
      repo: {
        gitRepoAssignmentId: 'ra-old',
        closedAt: '2026-09-01T12:00:00.000Z',
        graders: [{ id: 'g-1', name: 'Grace' }],
        grades: [{ id: 'grade-1', emoji: 'heart' }],
        gradesReleased: true,
        issueUrl: null,
        repoUrl: 'https://github.com/test-org/lab-1-ada',
      },
      ...over,
    });

  it('adds quiz scores beside released repo grades, newest first', async () => {
    listForStudentMock.mockResolvedValue([
      gradedRepo(),
      courseworkRow({
        assignmentId: 'a-quiz',
        type: 'QUIZ',
        title: 'Recursion',
        done: true,
        score: 0,
        scoredAt: '2026-09-20T12:00:00.000Z',
        href: '/student/test-class/quizzes?quiz=q-1',
      }),
      // A quiz with no counting score yet is no grade.
      courseworkRow({ assignmentId: 'a-unscored', type: 'QUIZ', score: null }),
    ]);

    const data = await (await loader(loaderArgs())).data;

    expect(data.feedback).toEqual([
      {
        id: 'quiz-a-quiz',
        assignmentTitle: 'Recursion',
        closedAt: '2026-09-20T12:00:00.000Z',
        graders: [],
        grades: [],
        issueUrl: null,
        score: 0,
        href: '/student/test-class/quizzes?quiz=q-1',
      },
      {
        id: 'ra-old',
        assignmentTitle: 'Lab 1',
        closedAt: '2026-09-01T12:00:00.000Z',
        graders: [{ id: 'g-1', name: 'Grace' }],
        grades: [{ id: 'grade-1', emoji: 'heart' }],
        issueUrl: 'https://github.com/test-org/lab-1-ada',
      },
    ]);
  });

  it('shows a repo grade only for an assignment the Assignments page shows', async () => {
    // A released grade on a submission whose assignment the student cannot
    // see (its repository unpublished, say): listForStudent gives it no row.
    findAllAssignmentsMock.mockResolvedValue([
      {
        id: 'ra-hidden',
        assignment_id: 'a-hidden',
        closed_at: new Date('2026-09-10T12:00:00Z'),
        provider_issue_number: 3,
        assignment: { title: 'Hidden lab', grades_released: true },
        git_repo: { name: 'hidden-lab-ada' },
        graders: [],
        grades: [{ id: 'g-9', emoji: 'tada' }],
      },
    ]);
    listForStudentMock.mockResolvedValue([gradedRepo()]);

    const data = await (await loader(loaderArgs())).data;

    expect(data.feedback.map(f => f.id)).toEqual(['ra-old']);
    expect(JSON.stringify(data.feedback)).not.toContain('Hidden lab');
  });

  it('shows no repo grade before it is released', async () => {
    listForStudentMock.mockResolvedValue([
      gradedRepo({
        repo: {
          gitRepoAssignmentId: 'ra-old',
          closedAt: null,
          graders: [],
          grades: [],
          gradesReleased: false,
          issueUrl: null,
          repoUrl: null,
        },
      }),
    ]);

    const data = await (await loader(loaderArgs())).data;

    expect(data.feedback).toEqual([]);
  });
});

describe('student dashboard loader — team card', () => {
  /** A row as team.findSelfFormedForStudent returns it. */
  const selfFormed = (slug: string, team: string | null, over: Record<string, unknown> = {}) => ({
    repository: { id: `r-${slug}`, slug, title: slug, team_formation_deadline: null },
    team: team
      ? {
          name: team,
          memberships: [{ user: { id: 'student-1', name: 'Ada', login: 'ada', image: null } }],
        }
      : null,
    gitRepoName: team ? `${slug}-${team}` : null,
    formationOpen: true,
    ...over,
  });

  it('reads the self-formed repositories for this student and classroom', async () => {
    await (
      await loader(loaderArgs())
    ).data;

    expect(selfFormedMock).toHaveBeenCalledWith('class-1', 'student-1');
  });

  it('prompts for a later repository even when the student has a team for an earlier one', async () => {
    selfFormedMock.mockResolvedValue([selfFormed('hw1', 'pair'), selfFormed('hw3', null)]);

    const data = await (await loader(loaderArgs())).data;

    expect(data.needsTeam).toEqual({ moduleTitle: 'hw3', moduleSlug: 'hw3' });
    expect(data.team?.teamName).toBe('pair');
  });

  it('links the team repo from the repository itself, with no assignment needed', async () => {
    selfFormedMock.mockResolvedValue([selfFormed('hw3', 'pair')]);

    const data = await (await loader(loaderArgs())).data;

    expect(data.needsTeam).toBeNull();
    expect(data.team?.repoUrl).toContain('hw3-pair');
  });

  it('does not prompt once team formation has closed', async () => {
    selfFormedMock.mockResolvedValue([selfFormed('hw3', null, { formationOpen: false })]);

    const data = await (await loader(loaderArgs())).data;

    expect(data.needsTeam).toBeNull();
  });
});

describe('student dashboard loader — grade line', () => {
  const ON = { show_grades_to_students: true, late_penalty_points_per_hour: 2 };
  const RELEASED = { final_grades_released: true, late_penalty_points_per_hour: 2 };

  it('reads nothing for it and sends none when both settings are off', async () => {
    grant('STUDENT', { show_grades_to_students: false, final_grades_released: false });

    const data = await (await loader(loaderArgs())).data;

    expect(data.gradeSummary).toBeNull();
    expect(summaryMock).not.toHaveBeenCalled();
  });

  it('reads nothing for it when the classroom has no settings row', async () => {
    grant('STUDENT', null);

    const data = await (await loader(loaderArgs())).data;

    expect(data.gradeSummary).toBeNull();
    expect(summaryMock).not.toHaveBeenCalled();
  });

  it('sends staff previewing the dashboard none', async () => {
    grant('TEACHER', { ...ON, ...RELEASED });

    const data = await (await loader(loaderArgs())).data;

    expect(data.gradeSummary).toBeNull();
    expect(summaryMock).not.toHaveBeenCalled();
  });

  it.each([
    ['the estimate is on', ON],
    ['final grades are released', RELEASED],
  ])(
    'asks the shared entry point when %s, with the submissions already read',
    async (_, settings) => {
      grant('STUDENT', settings, 'A-');
      const submissions = [{ id: 'ra-1', assignment: { grades_released: true } }];
      findAllAssignmentsMock.mockResolvedValue(submissions);

      const data = await (await loader(loaderArgs())).data;

      expect(summaryMock).toHaveBeenCalledWith({
        role: 'STUDENT',
        classroomId: 'class-1',
        userId: 'student-1',
        submissions,
        letterOverride: 'A-',
        settings,
      });
      expect(data.gradeSummary).toEqual({ kind: 'letter', letter: 'B', count: 3 });
      expect(findAllAssignmentsMock).toHaveBeenCalledTimes(1);
    }
  );

  it('sends the final grade the entry point returns', async () => {
    grant('STUDENT', RELEASED, 'A-');
    summaryMock.mockResolvedValue({ kind: 'final', letter: 'A-' });

    const data = await (await loader(loaderArgs())).data;

    expect(data.gradeSummary).toEqual({ kind: 'final', letter: 'A-' });
  });

  it('never sends the letter override before release (real entry point, reads stubbed)', async () => {
    grant('STUDENT', { show_grades_to_students: true, final_grades_released: false }, 'C+');
    summaryMock.mockImplementation(gradeSummaryForStudent);
    emojiMappingFindManyMock.mockResolvedValue([
      { emoji: 'heart', grade: 100 },
      { emoji: 'eyes', grade: 80 },
    ]);
    letterGradeMappingFindManyMock.mockResolvedValue([
      { letter_grade: 'A', min_grade: 90 },
      { letter_grade: 'B', min_grade: 80 },
      { letter_grade: 'C', min_grade: 70 },
    ]);
    const submission = (id: string, emoji: string, released: boolean) => ({
      id,
      grades: [{ emoji }],
      num_late_hours: 0,
      is_late_override: false,
      assignment: { weight: 50, is_extra_credit: false, type: 'REPO', grades_released: released },
    });
    findAllAssignmentsMock.mockResolvedValue([
      submission('ra-1', 'eyes', true),
      submission('ra-2', 'heart', false),
    ]);

    const data = await (await loader(loaderArgs())).data;

    // The estimate over released work, computed, not the override.
    expect(data.gradeSummary).toEqual({ kind: 'letter', letter: 'B', count: 1 });
    expect(emojiMappingFindManyMock).toHaveBeenCalled();
    expect(JSON.stringify(data)).not.toContain('C+');
  });

  it('sends none when the submissions read failed, rather than a quiz-only grade', async () => {
    grant('STUDENT', ON);
    findAllAssignmentsMock.mockRejectedValue(new Error('timeout'));

    const data = await (await loader(loaderArgs())).data;

    expect(data.gradeSummary).toBeNull();
    expect(summaryMock).not.toHaveBeenCalled();
  });

  it('sends none, and logs, when the grade read fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    grant('STUDENT', ON);
    summaryMock.mockRejectedValue(new Error('connection timeout'));

    const data = await (await loader(loaderArgs())).data;

    expect(data.gradeSummary).toBeNull();
    expect(data.feedback).toEqual([]);
    expect(logged).toHaveBeenCalledWith(
      '[student dashboard] grade summary failed',
      { classroomId: 'class-1', userId: 'student-1' },
      expect.any(Error)
    );
    logged.mockRestore();
  });
});

describe('student dashboard loader — assignments link', () => {
  it('hides it when the class has no published assignment', async () => {
    listPublishedAssignmentsMock.mockResolvedValue([]);

    const data = await (await loader(loaderArgs())).data;

    expect(data.hasAssignments).toBe(false);
  });

  it('keeps it when the class has one, and when the listing failed', async () => {
    expect((await (await loader(loaderArgs())).data).hasAssignments).toBe(true);

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    listPublishedAssignmentsMock.mockRejectedValue(new Error('down'));
    expect((await (await loader(loaderArgs())).data).hasAssignments).toBe(true);
    logged.mockRestore();
  });
});

describe('student dashboard loader — repositories in place of Up next', () => {
  const owned = (title: string, name: string, created: string) => ({
    id: `g-${name}`,
    name,
    last_push_at: null,
    repository: { id: `r-${title}`, title, type: 'INDIVIDUAL', created_at: new Date(created) },
  });

  it('lists the student’s repositories and teams to join, newest repository first', async () => {
    listPublishedAssignmentsMock.mockResolvedValue([]);
    findForStudentMock.mockResolvedValue([
      owned('hw0', 'hw0-ada', '2026-08-24'),
      owned('hw2', 'hw2-pair', '2026-09-23'),
    ]);
    selfFormedMock.mockResolvedValue([
      {
        repository: { id: 'r-hw3', slug: 'hw3', title: 'hw3', created_at: new Date('2026-10-07') },
        team: null,
        gitRepoName: null,
        formationOpen: true,
      },
    ]);

    const data = await (await loader(loaderArgs())).data;

    expect(data.repositories?.map(r => r.title)).toEqual(['hw3', 'hw2', 'hw0']);
    expect(data.repositories?.[0].joinHref).toBe('/student/test-class/repos/hw3/team');
    expect(data.repositories?.[1].url).toContain('hw2-pair');
    expect(findForStudentMock).toHaveBeenCalledWith('class-1', 'student-1');
  });

  it('keeps Up next, and reads no repositories, when the class has assignments', async () => {
    const data = await (await loader(loaderArgs())).data;

    expect(data.repositories).toBeNull();
    expect(findForStudentMock).not.toHaveBeenCalled();
  });
});
