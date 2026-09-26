/**
 * The quiz management list, as each prefix that serves it renders it.
 *
 * The list is served at /admin, /teacher and /assistant from this one route
 * module, and its action admits the whole teaching team. The screen now gives
 * every one of those prefixes the same authoring surface: New quiz, Edit,
 * Delete, the editable weight, and Publish on a draft. These render the real
 * component (react-dom/server, as the other render tests here do — the webapp
 * has no @testing-library) and assert the controls are PRESENT under each
 * prefix, so a prefix check reintroduced into the component would fail here.
 *
 * The loader half pins the one per-quiz object it used to pass through whole:
 * the viewer's own attempt, joined to their user row.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertProTier: vi.fn(),
  findByClassroom: vi.fn(),
  getClassroomSettingsForServer: vi.fn(),
  userFindById: vi.fn(),
}));

vi.mock('react-router', async importOriginal => ({
  ...(await importOriginal<typeof import('react-router')>()),
  // The component posts through a fetcher, which needs a data router; the
  // markup does not depend on it.
  useFetcher: () => ({ submit: vi.fn(), state: 'idle', data: undefined }),
}));

// Real action buttons (they carry the data-testids asserted on); the editable
// cell and the New button reduced to markers.
vi.mock('~/components', async () => ({
  TableActionButtons: (await import('../../../components/ui/buttons/TableActionButtons')).default,
  EditableCell: () => createElement('span', { 'data-testid': 'weight-editable' }),
  ButtonNew: ({ children }: { children?: React.ReactNode }) =>
    createElement('button', { type: 'button', 'data-testid': 'new-quiz' }, children),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertProTier: (...a: unknown[]) => mocks.assertProTier(...a),
  assertClassroomMutationAllowed: vi.fn(),
  addClassroomAuditLog: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findByClassroom: (...a: unknown[]) => mocks.findByClassroom(...a) },
    classroom: {
      getClassroomSettingsForServer: (...a: unknown[]) => mocks.getClassroomSettingsForServer(...a),
    },
    user: { findById: (...a: unknown[]) => mocks.userFindById(...a) },
  },
  QuizAccessError: class QuizAccessError extends Error {},
}));

const route = await import('../route.tsx');
const AdminQuizzes = route.default;

const CLASS_SLUG = 'cs52-26f';

const quizRow = (over: Record<string, unknown>) => ({
  id: 'quiz-1',
  name: 'Recursion',
  moduleId: null,
  moduleTitle: 'Unlinked',
  systemPrompt: null,
  rubricPrompt: null,
  subject: '',
  difficultyLevel: 'Beginner',
  dueDate: null,
  status: 'DRAFT',
  weight: 10,
  questionCount: 5,
  maxAttempts: 1,
  gradingStrategy: 'HIGHEST',
  includeCodeContext: false,
  attemptsCount: 0,
  avgScore: null,
  attemptStatus: null,
  score: null,
  userAttempt: null,
  ...over,
});

const QUIZZES = [
  quizRow({ id: 'quiz-draft', name: 'Draft quiz', status: 'DRAFT' }),
  quizRow({ id: 'quiz-live', name: 'Live quiz', status: 'PUBLISHED', attemptsCount: 3 }),
];

const renderAt = (prefix: string) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [`/${prefix}/${CLASS_SLUG}/quizzes`] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: '/:role/:class/quizzes',
          element: createElement(AdminQuizzes, {
            loaderData: {
              org: CLASS_SLUG,
              classroomId: 'class-1',
              quizzes: QUIZZES,
              userLogin: 'grace',
            },
          } as never),
        })
      )
    )
  );

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe.each(['admin', 'teacher', 'assistant'])('the quiz list under /%s', prefix => {
  const html = renderAt(prefix);

  it('offers New quiz', () => {
    expect(html).toContain('data-testid="new-quiz"');
    expect(html).toContain('New quiz');
  });

  it('offers View, Edit and Delete on every quiz', () => {
    expect(count(html, 'data-testid="table-action-view"')).toBe(QUIZZES.length);
    expect(count(html, 'data-testid="table-action-edit"')).toBe(QUIZZES.length);
    expect(count(html, 'data-testid="table-action-delete"')).toBe(QUIZZES.length);
  });

  it('makes every weight editable', () => {
    expect(count(html, 'data-testid="weight-editable"')).toBe(QUIZZES.length);
  });

  it('offers Publish on the draft only', () => {
    expect(count(html, 'tabler-icon-send')).toBe(1);
  });
});

// ─── The loader ─────────────────────────────────────────────────────────────

describe('quiz list loader — the viewer’s own attempt', () => {
  const SENTINELS = ['SENTINEL-EMAIL', 'cus_SENTINEL', 'SENTINEL-REPO', 'SENTINEL-SCHOOL-ID'];

  const viewer = {
    id: 'ta-1',
    login: 'grace',
    name: 'Grace Hopper',
    email: 'SENTINEL-EMAIL',
    stripe_customer_id: 'cus_SENTINEL',
    school_id: 'SENTINEL-SCHOOL-ID',
  };

  const ownAttempt = {
    id: 'attempt-own',
    user_id: viewer.id,
    completed_at: null,
    partial_credit_percentage: null,
    agent_config: { instructorRepoName: 'SENTINEL-REPO' },
    user: viewer,
  };

  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: viewer.id,
      classroom: { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' },
      membership: { role: 'ASSISTANT' },
    });
    mocks.assertProTier.mockResolvedValue(undefined);
    mocks.getClassroomSettingsForServer.mockResolvedValue({ quizzes_enabled: true });
    mocks.userFindById.mockResolvedValue(viewer);
    mocks.findByClassroom.mockResolvedValue([
      {
        id: 'quiz-1',
        name: 'Recursion',
        repository_id: null,
        repository: null,
        system_prompt: null,
        rubric_prompt: 'Grade it',
        status: 'DRAFT',
        weight: 10,
        attempts: [ownAttempt],
        attemptsCount: 1,
        avgScore: null,
      },
    ]);
  });

  it('sends it as the fields a preview needs, not the joined row', async () => {
    const payload = await route.loader({
      params: { class: CLASS_SLUG },
      request: new Request(`http://localhost/assistant/${CLASS_SLUG}/quizzes`),
    } as never);

    expect(payload.quizzes[0].userAttempt).toEqual({ id: 'attempt-own', completed_at: null });
    expect(payload.quizzes[0].attemptStatus).toBe('in_progress');
    const serialized = JSON.stringify(payload);
    for (const sentinel of SENTINELS) expect(serialized).not.toContain(sentinel);
  });
});
