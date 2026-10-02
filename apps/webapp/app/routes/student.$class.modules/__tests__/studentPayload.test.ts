import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * What the Modules page sends a student, by allowlist. The module service
 * returns whole rows (every column of every module, item, assignment, quiz,
 * form, page, deck and submission); the loader sends each object as exactly
 * the keys the page renders. Each object type below has its expected key set,
 * and every object of that type in the payload must match it exactly.
 *
 * It also lists an assignment's attached pages and decks only once they are
 * published, and a submission's grades only once they are released.
 */

const listForClassroomMock = vi.fn();
const findAllAssignmentsMock = vi.fn();
const assertAccessMock = vi.fn();
const loadQuizzesVisibleMock = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    module: { listForClassroom: (...a: unknown[]) => listForClassroomMock(...a) },
    helper: { findAllAssignmentsForStudent: (...a: unknown[]) => findAllAssignmentsMock(...a) },
    repository: { findByClassroomId: vi.fn().mockResolvedValue([]) },
    organizationTag: { findByClassroomIdAndName: vi.fn() },
    team: { findUserTeamByTag: vi.fn() },
  },
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => assertAccessMock(...a),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  loadQuizzesVisible: (...a: unknown[]) => loadQuizzesVisibleMock(...a),
}));

vi.mock('~/components/features/modules/StudentModuleCard', () => ({ default: () => null }));
vi.mock('~/components/features/modules/studentTree', () => ({
  buildAssignmentLeaf: () => ({}),
  resourceLeaves: () => [],
}));
vi.mock('react-router', () => ({ useLocation: () => ({ pathname: '/student/cs52-26f/modules' }) }));
vi.mock('antd', () => ({ Button: () => null }));

const { loader } = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';
const T0 = new Date('2026-09-01T00:00:00Z');

// ─── The key set each object type is sent with ────────────────────────────────

const KEYS = {
  payload: [
    'enabled',
    'isStaff',
    'modules',
    'raByAssignmentId',
    'slidesUrl',
    'pagesUrl',
    'classSlug',
    'selfFormedByRepositoryId',
  ],
  module: ['id', 'title', 'description', 'is_published', 'assignments', 'items'],
  assignment: [
    'id',
    'type',
    'title',
    'is_published',
    'grades_released',
    'student_deadline',
    'repository_id',
    'repository',
    'quiz',
    'form',
    'pages',
    'slides',
  ],
  assignmentRepository: ['id', 'type'],
  assignmentQuiz: ['id', 'status'],
  assignmentForm: ['id', 'slug', 'status'],
  pageLink: ['page'],
  slideLink: ['slide'],
  document: ['id', 'title', 'is_draft'],
  item: ['id', 'item_type', 'page', 'slide', 'quiz', 'form'],
  itemQuiz: ['id', 'name', 'status'],
  itemForm: ['id', 'title', 'slug', 'status', 'access', 'closes_at'],
  submission: ['status', 'provider_issue_number', 'git_repo', 'grades'],
  submissionRepo: ['name', 'classroom'],
  submissionClassroom: ['git_organization'],
  submissionOrganization: ['login'],
  grade: ['id', 'emoji'],
};

const keysOf = (value: unknown) => Object.keys(value as object).sort();
const expectKeys = (value: unknown, expected: string[]) =>
  expect(keysOf(value)).toEqual([...expected].sort());

// ─── Rows as the services return them: every column ──────────────────────────

const pageRow = (id: string, title: string, isDraft: boolean) => ({
  id,
  classroom_id: 'class-1',
  title,
  slug: id,
  is_draft: isDraft,
  is_public: false,
  content_path: `pages/${id}`,
  created_by: 'owner-1',
  created_at: T0,
  updated_at: T0,
});

const slideRow = (id: string, title: string, isDraft: boolean) => ({
  id,
  classroom_id: 'class-1',
  title,
  slug: id,
  is_draft: isDraft,
  is_public: false,
  content_path: `slides/${id}`,
  created_by: 'owner-1',
  created_at: T0,
  updated_at: T0,
});

const quizRow = {
  id: 'quiz-1',
  classroom_id: 'class-1',
  repository_id: null,
  name: 'Recursion check',
  status: 'PUBLISHED',
  weight: 10,
  question_count: 5,
  difficulty_level: 'Beginner',
  subject: 'Recursion',
  include_code_context: false,
  grading_strategy: 'HIGHEST',
  max_attempts: 2,
  created_at: T0,
  updated_at: T0,
};

const formRow = {
  id: 'form-1',
  classroom_id: 'class-1',
  title: 'Check-in',
  slug: 'check-in',
  description: 'Weekly check-in',
  access: 'CLASSROOM',
  status: 'OPEN',
  current_revision_id: 'rev-1',
  response_cap: null,
  closes_at: null,
  allow_multiple: false,
  save_partials: true,
  created_by: 'owner-1',
  created_at: T0,
  updated_at: T0,
};

const assignmentRow = (over: Record<string, unknown>) => ({
  module_id: 'module-1',
  submission_mode: 'ISSUE',
  slug: null,
  position: 0,
  weight: 40,
  is_extra_credit: false,
  is_published: true,
  description: 'Instructions',
  grader_deadline: null,
  tokens_per_hour: 2,
  release_at: null,
  grades_released: false,
  student_deadline: new Date('2026-10-05T23:59:00Z'),
  repository_id: null,
  quiz_id: null,
  form_id: null,
  repository: null,
  quiz: null,
  form: null,
  pages: [],
  slides: [],
  _count: { git_repo_assignments: 12 },
  created_at: T0,
  updated_at: T0,
  ...over,
});

const MODULE = {
  id: 'module-1',
  classroom_id: 'class-1',
  title: 'Week 1',
  slug: 'week-1',
  description: 'Intro',
  is_published: true,
  position: 0,
  created_at: T0,
  updated_at: T0,
  assignments: [
    assignmentRow({
      id: 'asg-repo',
      type: 'REPO',
      title: 'Lab 1',
      repository_id: 'repo-1',
      repository: {
        id: 'repo-1',
        title: 'Lab',
        slug: 'lab',
        type: 'INDIVIDUAL',
        is_published: true,
      },
      pages: [
        { order: 0, created_at: T0, page: pageRow('page-live', 'Lab handout', false) },
        { order: 1, created_at: T0, page: pageRow('page-draft', 'Lab answers', true) },
      ],
      slides: [{ order: 0, created_at: T0, slide: slideRow('deck-live', 'Lab intro', false) }],
    }),
    assignmentRow({
      id: 'asg-quiz',
      type: 'QUIZ',
      title: 'Recursion check',
      quiz_id: 'quiz-1',
      quiz: { id: 'quiz-1', name: 'Recursion check', status: 'PUBLISHED' },
    }),
    assignmentRow({
      id: 'asg-form',
      type: 'FORM',
      title: 'Check-in',
      form_id: 'form-1',
      form: { id: 'form-1', title: 'Check-in', slug: 'check-in', status: 'OPEN' },
    }),
  ],
  items: [
    {
      id: 'item-page',
      module_id: 'module-1',
      item_type: 'PAGE',
      position: 0,
      page: pageRow('page-read', 'Reading', false),
    },
    {
      id: 'item-slide',
      module_id: 'module-1',
      item_type: 'SLIDE',
      position: 1,
      slide: slideRow('deck-read', 'Lecture 1', false),
    },
    { id: 'item-quiz', module_id: 'module-1', item_type: 'QUIZ', position: 2, quiz: quizRow },
    { id: 'item-form', module_id: 'module-1', item_type: 'FORM', position: 3, form: formRow },
  ],
};

/** A submission row as helper.findAllAssignmentsForStudent returns it. */
const submissionRow = (gradesReleased: boolean) => ({
  id: 'ra-1',
  assignment_id: 'asg-repo',
  git_repo_id: 'gr-1',
  status: 'OPEN',
  provider_issue_number: 7,
  provider_issue_id: 'issue-77',
  closed_at: null,
  is_late_override: false,
  token_transactions: [{ id: 'tx-1', type: 'PURCHASE', amount: -2, hours_purchased: 1 }],
  analytics_snapshot: { total_commits: 12 },
  assignment: { id: 'asg-repo', title: 'Lab 1', grades_released: gradesReleased },
  git_repo: {
    id: 'gr-1',
    name: 'lab-ada',
    student_id: 'student-1',
    student: { id: 'student-1', name: 'Ada' },
    repository: { id: 'repo-1', title: 'Lab' },
    classroom: { id: 'class-1', git_organization: { id: 'org-1', login: 'cs52-org' } },
  },
  graders: [{ grader: { id: 'g-1', name: 'Grace' } }],
  grades: [{ id: 'grade-1', emoji: 'heart', grader: { id: 'g-1', name: 'Grace' } }],
});

const load = async () =>
  (await loader({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/student/${CLASS_SLUG}/modules`),
  } as unknown as Parameters<typeof loader>[0])) as Extract<
    Awaited<ReturnType<typeof loader>>,
    { enabled: true }
  >;

/** The payload as the browser receives it. */
const loadSerialized = async () => JSON.parse(JSON.stringify(await load()));

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => {
  vi.clearAllMocks();
  assertAccessMock.mockResolvedValue({
    userId: 'student-1',
    classroom: { id: 'class-1', slug: CLASS_SLUG, settings: {} },
    membership: { role: 'STUDENT' },
  });
  loadQuizzesVisibleMock.mockResolvedValue(true);
  listForClassroomMock.mockResolvedValue([MODULE]);
  findAllAssignmentsMock.mockResolvedValue([submissionRow(false)]);
});

describe('student modules loader — each object is sent with exactly its keys', () => {
  it('sends the payload, modules, assignments and items with their key sets', async () => {
    const data = await loadSerialized();

    expectKeys(data, KEYS.payload);
    for (const module of data.modules as Json[]) {
      expectKeys(module, KEYS.module);
      for (const a of module.assignments as Json[]) {
        expectKeys(a, KEYS.assignment);
        if (a.repository) expectKeys(a.repository, KEYS.assignmentRepository);
        if (a.quiz) expectKeys(a.quiz, KEYS.assignmentQuiz);
        if (a.form) expectKeys(a.form, KEYS.assignmentForm);
        for (const link of a.pages as Json[]) {
          expectKeys(link, KEYS.pageLink);
          expectKeys(link.page, KEYS.document);
        }
        for (const link of a.slides as Json[]) {
          expectKeys(link, KEYS.slideLink);
          expectKeys(link.slide, KEYS.document);
        }
      }
      for (const item of module.items as Json[]) {
        expectKeys(item, KEYS.item);
        if (item.page) expectKeys(item.page, KEYS.document);
        if (item.slide) expectKeys(item.slide, KEYS.document);
        if (item.quiz) expectKeys(item.quiz, KEYS.itemQuiz);
        if (item.form) expectKeys(item.form, KEYS.itemForm);
      }
    }

    // Every object type above was present to check.
    const [module] = data.modules as Json[];
    expect((module.items as Json[]).map(i => i.item_type)).toEqual([
      'PAGE',
      'SLIDE',
      'QUIZ',
      'FORM',
    ]);
    expect((module.assignments as Json[]).map(a => a.type)).toEqual(['REPO', 'QUIZ', 'FORM']);
  });

  it('sends the viewer’s submissions with their key sets', async () => {
    findAllAssignmentsMock.mockResolvedValue([submissionRow(true)]);

    const data = await loadSerialized();
    const submissions = Object.values(data.raByAssignmentId) as Json[];

    expect(submissions).toHaveLength(1);
    for (const submission of submissions) {
      expectKeys(submission, KEYS.submission);
      expectKeys(submission.git_repo, KEYS.submissionRepo);
      expectKeys(submission.git_repo.classroom, KEYS.submissionClassroom);
      expectKeys(submission.git_repo.classroom.git_organization, KEYS.submissionOrganization);
      expect(submission.grades.length).toBeGreaterThan(0);
      for (const grade of submission.grades as Json[]) expectKeys(grade, KEYS.grade);
    }
  });

  it('still sends the values the page renders', async () => {
    const data = await load();
    const [module] = data.modules;

    expect(module.items.find(i => i.id === 'item-quiz')?.quiz).toEqual({
      id: 'quiz-1',
      name: 'Recursion check',
      status: 'PUBLISHED',
    });
    expect(module.items.find(i => i.id === 'item-form')?.form).toEqual({
      id: 'form-1',
      title: 'Check-in',
      slug: 'check-in',
      status: 'OPEN',
      access: 'CLASSROOM',
      closes_at: null,
    });
    expect(data.raByAssignmentId['asg-repo']).toMatchObject({
      status: 'OPEN',
      provider_issue_number: 7,
      git_repo: { name: 'lab-ada', classroom: { git_organization: { login: 'cs52-org' } } },
    });
  });
});

describe('student modules loader — drafts and grades', () => {
  it('lists an assignment’s attached pages and decks once published', async () => {
    const data = await load();
    const repo = data.modules[0].assignments.find(a => a.id === 'asg-repo')!;

    expect(repo.pages).toEqual([
      { page: { id: 'page-live', title: 'Lab handout', is_draft: false } },
    ]);
    expect(repo.slides).toEqual([
      { slide: { id: 'deck-live', title: 'Lab intro', is_draft: false } },
    ]);
    expect(JSON.stringify(data)).not.toContain('page-draft');
  });

  it('keeps attached draft pages in the teaching team’s preview, flagged', async () => {
    assertAccessMock.mockResolvedValue({
      userId: 'teacher-1',
      classroom: { id: 'class-1', slug: CLASS_SLUG, settings: {} },
      membership: { role: 'TEACHER' },
    });

    const data = await load();
    const repo = data.modules[0].assignments.find(a => a.id === 'asg-repo')!;

    expect(repo.pages.map(p => [p.page.id, p.page.is_draft])).toEqual([
      ['page-live', false],
      ['page-draft', true],
    ]);
  });

  it('sends a submission’s grades only once they are released', async () => {
    const before = await load();
    expect(before.raByAssignmentId['asg-repo'].grades).toEqual([]);

    findAllAssignmentsMock.mockResolvedValue([submissionRow(true)]);
    const after = await load();
    expect(after.raByAssignmentId['asg-repo'].grades).toEqual([{ id: 'grade-1', emoji: 'heart' }]);
  });
});
