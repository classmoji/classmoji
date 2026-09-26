/**
 * The repositories pages carry the assignment editor's context: every
 * assignment in the classroom, the quizzes it could bind, and which are bound
 * already. Where the classroom's quizzes are hidden (not Pro, switched off, or
 * no AI agent) none of that names a quiz — no QUIZ assignment row, no quiz
 * candidate, no bound quiz id.
 *
 * Three loaders: the list under /admin, the list under /assistant (and
 * /teacher, which re-exports it), and the repository page shared by /admin
 * and /assistant.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  requireClassroomTeachingTeam: vi.fn(),
  loadQuizzesVisible: vi.fn(),
  listForClassroom: vi.fn(),
  getCandidateContent: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
  requireClassroomTeachingTeam: (...a: unknown[]) => mocks.requireClassroomTeachingTeam(...a),
  assertClassroomMutationAllowed: vi.fn(),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  loadQuizzesVisible: (...a: unknown[]) => mocks.loadQuizzesVisible(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    assignment: { listForClassroom: (...a: unknown[]) => mocks.listForClassroom(...a) },
    module: {
      findByClassroomSlug: vi.fn(async () => []),
      getCandidateContent: (...a: unknown[]) => mocks.getCandidateContent(...a),
    },
    repository: {
      findByClassroomSlug: vi.fn(async () => []),
      findByClassroomId: vi.fn(async () => []),
      findBySlugAndTitle: vi.fn(async () => ({ id: 'repo-1', pages: [], assignments: [] })),
    },
    gitRepo: { findByRepository: vi.fn(async () => []) },
    autogradingResult: { findLatestByGitRepoIds: vi.fn(async () => new Map()) },
    autogradingTest: { findByRepositoryId: vi.fn(async () => []) },
    classroomMembership: { findUsersByRoles: vi.fn(async () => []) },
    emojiMapping: { findByClassroomId: vi.fn(async () => []) },
  },
}));

// The loaders are under test; the list view only needs to import.
vi.mock('~/components/features/repositories/RepositoriesTable', () => ({ default: () => null }));
vi.mock('~/components', () => ({
  SearchInput: () => null,
  ButtonNew: () => null,
  RequireRole: () => null,
}));

const adminList = await import('../route.tsx');
const assistantList = await import('../../assistant.$class_.repos/route.tsx');
const repositoryPage = await import('../../admin.$class.repos_.$title/loader.server.ts');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };

const CANDIDATES = {
  quizzes: [{ id: 'quiz-9', name: 'Recursion quiz', status: 'PUBLISHED' }],
  forms: [{ id: 'form-9', title: 'Exit ticket' }],
  pages: [],
  slides: [],
};

const ASSIGNMENTS = [
  { id: 'asg-repo', type: 'REPO', repository_id: 'repo-1', quiz_id: null, form_id: null },
  { id: 'asg-quiz', type: 'QUIZ', repository_id: null, quiz_id: 'quiz-9', form_id: null },
  { id: 'asg-form', type: 'FORM', repository_id: null, quiz_id: null, form_id: 'form-9' },
];

const args = (pathname: string) =>
  ({
    params: { class: CLASS_SLUG, title: 'lab-1' },
    request: new Request(`http://localhost${pathname}`),
  }) as never;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  const gate = { userId: 'owner-1', classroom: CLASSROOM, membership: { role: 'OWNER' } };
  mocks.requireClassroomAdmin.mockResolvedValue(gate);
  mocks.requireClassroomTeachingTeam.mockResolvedValue(gate);
  mocks.loadQuizzesVisible.mockResolvedValue(true);
  mocks.listForClassroom.mockResolvedValue(ASSIGNMENTS);
  mocks.getCandidateContent.mockResolvedValue(CANDIDATES);
});

describe.each([
  ['/admin', () => adminList.loader(args(`/admin/${CLASS_SLUG}/repos`))],
  ['/assistant', () => assistantList.loader(args(`/assistant/${CLASS_SLUG}/repos`))],
])('the repositories list under %s', (_prefix, load) => {
  it('sends no quiz assignment and no quiz candidate where quizzes are hidden', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);

    const { editor } = await load();

    expect(mocks.loadQuizzesVisible).toHaveBeenCalledWith('class-1');
    expect(editor.assignments.map(a => a.id)).toEqual(['asg-repo', 'asg-form']);
    expect(editor.quizzes).toEqual([]);
    expect(editor.forms).toEqual(CANDIDATES.forms);
    expect(JSON.stringify(editor)).not.toContain('quiz-9');
  });

  it('sends them all where quizzes show', async () => {
    const { editor } = await load();

    expect(editor.assignments.map(a => a.id)).toEqual(['asg-repo', 'asg-quiz', 'asg-form']);
    expect(editor.quizzes).toEqual(CANDIDATES.quizzes);
  });
});

describe.each([
  ['/admin', () => repositoryPage.adminLoader(args(`/admin/${CLASS_SLUG}/repos/lab-1`))],
  [
    '/assistant',
    () => repositoryPage.teachingTeamLoader(args(`/assistant/${CLASS_SLUG}/repos/lab-1`)),
  ],
])('the repository page under %s', (_prefix, load) => {
  it('offers no quiz and names none as bound where quizzes are hidden', async () => {
    mocks.loadQuizzesVisible.mockResolvedValue(false);

    const payload = await load();

    expect(payload.candidates.quizzes).toEqual([]);
    expect(payload.candidates.forms).toEqual(CANDIDATES.forms);
    expect(payload.boundQuizIds).toEqual([]);
    expect(payload.boundFormIds).toEqual(['form-9']);
    // Its own rows are the repository's assignments, which a quiz never is.
    expect(payload.assignments.map(a => a.id)).toEqual(['asg-repo']);
    expect(JSON.stringify(payload)).not.toContain('quiz-9');
  });

  it('carries the quizzes where they show', async () => {
    const payload = await load();

    expect(payload.candidates.quizzes).toEqual(CANDIDATES.quizzes);
    expect(payload.boundQuizIds).toEqual(['quiz-9']);
  });
});
