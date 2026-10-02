/**
 * The quiz management list, as each role sees it.
 *
 * The list is served at /admin, /teacher and /assistant from this one route
 * module, and its action admits the whole teaching team. What the screen
 * offers follows the viewer's ROLE, not the prefix: the owner and teachers get
 * New quiz, Edit, Delete, the editable weight (on a quiz in a module) and
 * Publish on a draft; a teaching assistant gets View and Edit (an assistant's
 * edit saves content only). These run the real loader for each role and render
 * the real component with what it returns (react-dom/server, as the other
 * render tests here do — the webapp has no @testing-library), under every
 * prefix, so a prefix check reintroduced into the component would fail here.
 *
 * The loader half pins where each row's module, due date, weight and status
 * come from (the quiz's assignment), the one per-quiz object it used to pass
 * through whole (the viewer's own attempt, joined to their user row), and that
 * a classroom whose quizzes are hidden gets a 404 rather than the list.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  findByClassroom: vi.fn(),
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

// The draft-material warning shows through the app's callout, whose provider
// sits at the app root; the markup under test does not depend on it.
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: vi.fn(),
  addClassroomAuditLog: vi.fn(),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: { findByClassroom: (...a: unknown[]) => mocks.findByClassroom(...a) },
    user: { findById: (...a: unknown[]) => mocks.userFindById(...a) },
  },
  QuizAccessError: class QuizAccessError extends Error {},
}));

const route = await import('../route.tsx');
const AdminQuizzes = route.default;

const CLASS_SLUG = 'cs52-26f';
const HOUR = 60 * 60 * 1000;
const DUE = new Date('2026-10-09T16:00:00.000Z');
const LEGACY_DUE = new Date('2026-10-20T16:00:00.000Z');

const WEEK_1 = { id: 'mod-1', title: 'Week 1' };

/** A quiz as quiz.findByClassroom returns it. */
const serviceQuiz = (over: Record<string, unknown>) => ({
  id: 'quiz-1',
  name: 'Recursion',
  repository_id: null,
  system_prompt: null,
  rubric_prompt: 'Grade it',
  subject: 'Recursion',
  difficulty_level: 'Beginner',
  status: 'DRAFT',
  due_date: null,
  weight: 0,
  attempts: [],
  attemptsCount: 0,
  avgScore: null,
  assignment: null,
  ...over,
});

/** Four quizzes: a draft, a live one and a closed one in Week 1, and one in no module. */
const serviceQuizzes = () => [
  serviceQuiz({
    id: 'quiz-draft',
    name: 'Draft quiz',
    // Flat columns that disagree with the assignment, which wins.
    status: 'PUBLISHED',
    weight: 99,
    due_date: LEGACY_DUE,
    assignment: {
      module: WEEK_1,
      student_deadline: DUE,
      weight: 10,
      is_published: false,
      closes_at: null,
    },
  }),
  serviceQuiz({
    id: 'quiz-live',
    name: 'Live quiz',
    status: 'PUBLISHED',
    attemptsCount: 3,
    assignment: {
      module: WEEK_1,
      student_deadline: null,
      weight: 20,
      is_published: true,
      closes_at: new Date(Date.now() + 24 * HOUR),
    },
  }),
  serviceQuiz({
    id: 'quiz-closed',
    name: 'Closed quiz',
    status: 'PUBLISHED',
    assignment: {
      module: WEEK_1,
      student_deadline: null,
      weight: 0,
      is_published: true,
      closes_at: new Date(Date.now() - HOUR),
    },
  }),
  serviceQuiz({
    id: 'quiz-loose',
    name: 'Loose quiz',
    status: 'PUBLISHED',
    weight: 5,
    due_date: LEGACY_DUE,
    assignment: null,
  }),
];

const ROWS_WITH_A_MODULE = 3;

const loadAs = async (role: string, prefix = 'admin') => {
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'viewer-1',
    classroom: { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' },
    membership: { role },
  });
  return route.loader({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/${prefix}/${CLASS_SLUG}/quizzes`),
  } as never);
};

const renderAt = (prefix: string, loaderData: unknown) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [`/${prefix}/${CLASS_SLUG}/quizzes`] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: '/:role/:class/quizzes',
          element: createElement(AdminQuizzes, { loaderData } as never),
        })
      )
    )
  );

const count = (html: string, needle: string) => html.split(needle).length - 1;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  mocks.userFindById.mockResolvedValue({ id: 'viewer-1', login: 'grace' });
  mocks.findByClassroom.mockResolvedValue(serviceQuizzes());
});

describe.each(['OWNER', 'TEACHER'])('the quiz list for the %s', role => {
  describe.each(['admin', 'teacher', 'assistant'])('under /%s', prefix => {
    let html = '';
    beforeEach(async () => {
      html = renderAt(prefix, await loadAs(role, prefix));
    });

    it('offers New quiz and Clear My Attempts', () => {
      expect(html).toContain('data-testid="new-quiz"');
      expect(html).toContain('New quiz');
      expect(html).toContain('Clear My Attempts');
    });

    it('offers View, Edit and Delete on every quiz', () => {
      const rows = serviceQuizzes().length;
      expect(count(html, 'data-testid="table-action-view"')).toBe(rows);
      expect(count(html, 'data-testid="table-action-edit"')).toBe(rows);
      expect(count(html, 'data-testid="table-action-delete"')).toBe(rows);
    });

    it('makes the weight editable on every quiz in a module, and not on the one in none', () => {
      expect(count(html, 'data-testid="weight-editable"')).toBe(ROWS_WITH_A_MODULE);
    });

    it('offers Publish on the draft only', () => {
      expect(count(html, 'tabler-icon-send')).toBe(1);
    });
  });
});

describe('the quiz list for a teaching assistant', () => {
  describe.each(['admin', 'teacher', 'assistant'])('under /%s', prefix => {
    let html = '';
    beforeEach(async () => {
      html = renderAt(prefix, await loadAs('ASSISTANT', prefix));
    });

    it('offers View and Edit on every quiz', () => {
      const rows = serviceQuizzes().length;
      expect(count(html, 'data-testid="table-action-view"')).toBe(rows);
      expect(count(html, 'data-testid="table-action-edit"')).toBe(rows);
    });

    it('offers no New quiz, Delete, editable weight or Publish', () => {
      expect(html).not.toContain('data-testid="new-quiz"');
      expect(html).not.toContain('New quiz');
      expect(count(html, 'data-testid="table-action-delete"')).toBe(0);
      expect(count(html, 'data-testid="weight-editable"')).toBe(0);
      expect(count(html, 'tabler-icon-send')).toBe(0);
    });

    it('still shows each weight, and Clear My Attempts', () => {
      expect(html).toContain('Clear My Attempts');
      // The weights as text: 10, 20, 0 from the assignments, 5 from the loose quiz.
      for (const weight of ['>10<', '>20<', '>0<', '>5<']) expect(html).toContain(weight);
    });
  });
});

describe('the status column', () => {
  it('reads Draft, Published, Closed and No module from the assignment', async () => {
    const html = renderAt('admin', await loadAs('OWNER'));

    for (const label of ['Draft', 'Published', 'Closed', 'No module']) {
      expect(html).toContain(`>${label}<`);
    }
  });
});

// ─── The loader ─────────────────────────────────────────────────────────────

describe('quiz list loader — who may author', () => {
  it.each([
    ['OWNER', true],
    ['TEACHER', true],
    ['ASSISTANT', false],
  ])('%s: canAuthor is %s', async (role, canAuthor) => {
    expect((await loadAs(role)).canAuthor).toBe(canAuthor);
  });

  it('admits the teaching team and nobody else', async () => {
    await loadAs('OWNER');

    expect(mocks.assertClassroomAccess.mock.calls[0][0]).toMatchObject({
      classroomSlug: CLASS_SLUG,
      allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    });
  });
});

describe('quiz list loader — rows from the assignment', () => {
  const rowsById = async () => {
    const payload = await loadAs('OWNER');
    return Object.fromEntries(payload.quizzes.map(q => [q.id, q]));
  };

  it('takes the module, due date, weight and status of a quiz with an assignment from it', async () => {
    const rows = await rowsById();

    expect(rows['quiz-draft']).toMatchObject({
      moduleId: 'mod-1',
      moduleTitle: 'Week 1',
      dueDate: DUE,
      weight: 10,
      status: 'DRAFT',
    });
    expect(rows['quiz-live']).toMatchObject({
      moduleId: 'mod-1',
      dueDate: null,
      weight: 20,
      status: 'PUBLISHED',
    });
    // Published, but its close date has passed.
    expect(rows['quiz-closed']).toMatchObject({ status: 'CLOSED', weight: 0 });
  });

  it('puts a quiz with no assignment in no module, with its own due date and weight', async () => {
    const rows = await rowsById();

    expect(rows['quiz-loose']).toMatchObject({
      moduleId: null,
      moduleTitle: null,
      dueDate: LEGACY_DUE,
      weight: 5,
      status: 'NO_MODULE',
    });
  });
});

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
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: viewer.id,
      classroom: { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' },
      membership: { role: 'ASSISTANT' },
    });
    mocks.userFindById.mockResolvedValue(viewer);
    mocks.findByClassroom.mockResolvedValue([
      serviceQuiz({ attempts: [ownAttempt], attemptsCount: 1 }),
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

  it('answers 404 where the classroom’s quizzes are hidden, and lists nothing', async () => {
    mocks.quizzesVisibleOrThrow.mockResolvedValue(false);

    const thrown = await route
      .loader({
        params: { class: CLASS_SLUG },
        request: new Request(`http://localhost/assistant/${CLASS_SLUG}/quizzes`),
      } as never)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
    expect(mocks.quizzesVisibleOrThrow).toHaveBeenCalledWith('class-1');
    expect(mocks.findByClassroom).not.toHaveBeenCalled();
  });

  it('lets a failed visibility lookup surface as an error, not as a 404', async () => {
    mocks.quizzesVisibleOrThrow.mockRejectedValue(new Error('db down'));

    await expect(
      route.loader({
        params: { class: CLASS_SLUG },
        request: new Request(`http://localhost/assistant/${CLASS_SLUG}/quizzes`),
      } as never)
    ).rejects.toThrow('db down');
  });
});
