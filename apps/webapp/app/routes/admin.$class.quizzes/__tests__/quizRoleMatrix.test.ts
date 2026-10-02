/**
 * Who may do what with a quiz, through every prefix that serves the quiz list.
 *
 * /admin, /teacher and /assistant/:class/quizzes all post to ONE action: the
 * teacher and assistant routes re-export the admin route's. Its access gate
 * admits the teaching team (OWNER, TEACHER, ASSISTANT) and refuses a student;
 * past it, the action decides per intent:
 *
 *   - createQuiz, publishQuiz, updateWeight, deleteQuiz: the owner and
 *     teachers only. A teaching assistant gets 403 with fixed copy.
 *   - updateQuiz: everyone on the teaching team for the quiz's content and
 *     name; a save that carries any assignment field (module, opens, due,
 *     closes, weight, tokens per hour, published, or the old flat due date,
 *     weight and status) is the owner's and teachers' only, and an assistant's
 *     is refused whole.
 *   - clearMyAttempts: everyone on the teaching team (it clears the caller's
 *     own preview attempts).
 *
 * Every cell of prefix × role × intent is checked here, together with whether
 * the service write ran. A refused write reads nothing and audits nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'OWNER' as string,
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  publish: vi.fn(),
  findById: vi.fn(),
  repositoryFindById: vi.fn(),
  clearForUser: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));

vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));

vi.mock('~/utils/classroomProFlag.server', () => ({
  quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: {
      create: (...a: unknown[]) => mocks.create(...a),
      update: (...a: unknown[]) => mocks.update(...a),
      delete: (...a: unknown[]) => mocks.remove(...a),
      publish: (...a: unknown[]) => mocks.publish(...a),
      findById: (...a: unknown[]) => mocks.findById(...a),
      findByClassroom: vi.fn(),
    },
    repository: { findById: (...a: unknown[]) => mocks.repositoryFindById(...a) },
    quizAttempt: { clearForUser: (...a: unknown[]) => mocks.clearForUser(...a) },
    user: { findById: vi.fn() },
  },
  QuizAccessError: class QuizAccessError extends Error {},
}));

// The action is what is under test; the view layer only needs to import.
vi.mock('~/components', () => ({
  TableActionButtons: () => null,
  EditableCell: () => null,
  ButtonNew: () => null,
}));
vi.mock('antd', () => ({
  Table: () => null,
  Button: () => null,
  Typography: { Text: () => null },
  Tag: () => null,
  Space: () => null,
  Tooltip: () => null,
  Popconfirm: () => null,
}));
vi.mock('@tabler/icons-react', () => ({
  IconSend: () => null,
  IconBook: () => null,
  IconCalendar: () => null,
  IconTrash: () => null,
}));
vi.mock('react-router', () => ({
  useFetcher: () => ({ submit: vi.fn() }),
  useLocation: () => ({ pathname: '/admin/cs52-26f/quizzes' }),
  useNavigate: () => vi.fn(),
  useParams: () => ({ class: 'cs52-26f' }),
  Outlet: () => null,
}));

const adminRoute = await import('../route.tsx');
const teacherRoute = await import('../../teacher.$class_.quizzes/route.tsx');
const assistantRoute = await import('../../assistant.$class_.quizzes/route.tsx');
const { QUIZ_AUTHOR_ONLY } = await import('../quizList');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };
const TEAM = ['OWNER', 'TEACHER', 'ASSISTANT'];

type Action = typeof adminRoute.action;

const PREFIXES: Array<[string, Action]> = [
  ['admin', adminRoute.action],
  ['teacher', teacherRoute.action],
  ['assistant', assistantRoute.action],
];

/** What the quiz form's save sends for an assistant: the quiz's content and name, nothing else. */
const CONTENT_SAVE = {
  _action: 'updateQuiz',
  id: 'quiz-1',
  name: 'Recursion, revised',
  repositoryId: 'repo-1',
  systemPrompt: 'Ask about base cases first.',
  rubricPrompt: 'Full credit for a correct base case and recursive step.',
  subject: 'Recursion',
  difficultyLevel: 'Intermediate',
  questionCount: 6,
  maxAttempts: 2,
  gradingStrategy: 'HIGHEST',
  includeCodeContext: true,
  excludedPaths: ['tests/**'],
  sourceMaterial: [{ kind: 'page', id: 'p1' }],
  courseSearchEnabled: true,
};

/** One body per assignment field a quiz save may carry, each refused from an assistant. */
const ASSIGNMENT_FIELD_SAVES: Array<[string, Record<string, unknown>]> = [
  ['assignment', { assignment: { moduleId: 'mod-1', weight: 10, isPublished: true } }],
  ['assignment (null)', { assignment: null }],
  ['moduleId', { moduleId: 'mod-2' }],
  ['releaseAt', { releaseAt: '2026-10-05T13:00:00.000Z' }],
  ['dueDate', { dueDate: '2026-10-09T16:00:00.000Z' }],
  ['dueDate (null)', { dueDate: null }],
  ['closesAt', { closesAt: '2026-10-10T16:00:00.000Z' }],
  ['weight', { weight: 25 }],
  ['weight (0)', { weight: 0 }],
  ['tokensPerHour', { tokensPerHour: 4 }],
  ['isPublished', { isPublished: true }],
  ['isPublished (false)', { isPublished: false }],
  ['status', { status: 'PUBLISHED' }],
  ['status (CLOSED)', { status: 'CLOSED' }],
];

type Intent = {
  name: string;
  body: Record<string, unknown>;
  /** The service write this intent makes when it is allowed. */
  write: () => ReturnType<typeof vi.fn>;
  /** The roles past the access gate that may make it. */
  allowed: readonly string[];
};

const AUTHORS = ['OWNER', 'TEACHER'] as const;

const INTENTS: Intent[] = [
  {
    name: 'createQuiz',
    body: {
      _action: 'createQuiz',
      name: 'Week 1',
      rubricPrompt: 'r',
      assignment: { moduleId: 'mod-1', weight: 0, isPublished: false },
    },
    write: () => mocks.create,
    allowed: AUTHORS,
  },
  {
    name: 'updateQuiz, content and name only',
    body: CONTENT_SAVE,
    write: () => mocks.update,
    allowed: TEAM,
  },
  ...ASSIGNMENT_FIELD_SAVES.map(
    ([field, fields]): Intent => ({
      name: `updateQuiz carrying ${field}`,
      body: { ...CONTENT_SAVE, ...fields },
      write: () => mocks.update,
      allowed: AUTHORS,
    })
  ),
  {
    name: 'updateQuiz carrying only an assignment field',
    body: { _action: 'updateQuiz', id: 'quiz-1', weight: 30 },
    write: () => mocks.update,
    allowed: AUTHORS,
  },
  {
    name: 'publishQuiz',
    body: { _action: 'publishQuiz', id: 'quiz-1' },
    write: () => mocks.publish,
    allowed: AUTHORS,
  },
  {
    name: 'updateWeight',
    body: { _action: 'updateWeight', id: 'quiz-1', weight: 15 },
    write: () => mocks.update,
    allowed: AUTHORS,
  },
  {
    name: 'deleteQuiz',
    body: { _action: 'deleteQuiz', id: 'quiz-1' },
    write: () => mocks.remove,
    allowed: AUTHORS,
  },
  {
    name: 'clearMyAttempts',
    body: { _action: 'clearMyAttempts' },
    write: () => mocks.clearForUser,
    allowed: TEAM,
  },
];

const WRITES = () => [mocks.create, mocks.update, mocks.remove, mocks.publish, mocks.clearForUser];

const submit = (action: Action, prefix: string, body: Record<string, unknown>) =>
  action({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/${prefix}/${CLASS_SLUG}/quizzes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<Action>[0]);

beforeEach(() => {
  for (const [key, m] of Object.entries(mocks)) {
    if (key !== 'role') (m as ReturnType<typeof vi.fn>).mockReset();
  }
  // As the real helper does: a role outside `allowedRoles` is refused with a
  // 403 Response, thrown before the action reads anything.
  mocks.assertClassroomAccess.mockImplementation(
    async ({ allowedRoles }: { allowedRoles: string[] }) => {
      if (!allowedRoles.includes(mocks.role)) {
        throw new Response('Forbidden', { status: 403 });
      }
      return {
        userId: `${mocks.role.toLowerCase()}-1`,
        classroom: CLASSROOM,
        membership: { id: 'm-1', role: mocks.role },
      };
    }
  );
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  mocks.create.mockResolvedValue({
    id: 'quiz-new',
    name: 'Week 1',
    repository_id: null,
    assignment: { module_id: 'mod-1', is_published: false },
  });
  mocks.update.mockResolvedValue({});
  mocks.remove.mockResolvedValue({});
  mocks.publish.mockResolvedValue({});
  mocks.findById.mockResolvedValue({
    id: 'quiz-1',
    classroom_id: 'class-1',
    name: 'Recursion',
    source_material: [],
  });
  mocks.repositoryFindById.mockResolvedValue({ id: 'repo-1', classroom_id: 'class-1' });
  mocks.clearForUser.mockResolvedValue({ deletedCount: 2 });
});

describe('the teacher and assistant quiz lists re-export the admin route', () => {
  it.each([
    ['teacher', teacherRoute],
    ['assistant', assistantRoute],
  ])('/%s serves the same action, loader and screen', (_prefix, mod) => {
    expect(mod.action).toBe(adminRoute.action);
    expect(mod.loader).toBe(adminRoute.loader);
    expect(mod.default).toBe(adminRoute.default);
  });
});

describe.each(PREFIXES)('the quiz action under /%s', (prefix, action) => {
  describe.each(TEAM)('as %s', role => {
    beforeEach(() => {
      mocks.role = role;
    });

    it.each(INTENTS.map(intent => [intent.name, intent] as const))(
      '%s',
      async (_name, intent) => {
        const response = (await submit(action, prefix, intent.body)) as Response;
        const body = await response.json();

        // The gate admits the teaching team, under every prefix.
        expect(mocks.assertClassroomAccess.mock.calls[0][0]).toMatchObject({
          classroomSlug: CLASS_SLUG,
          allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
          resourceType: 'ADMIN_QUIZ_ACTION',
        });

        if (intent.allowed.includes(role)) {
          expect(response.status).toBe(200);
          expect(body.success).toEqual(expect.any(String));
          expect(intent.write()).toHaveBeenCalledTimes(1);
          for (const other of WRITES()) {
            if (other !== intent.write()) expect(other).not.toHaveBeenCalled();
          }
          expect(mocks.addClassroomAuditLog).toHaveBeenCalledTimes(1);
        } else {
          expect(response.status).toBe(403);
          expect(body).toEqual({ error: QUIZ_AUTHOR_ONLY });
          for (const write of WRITES()) expect(write).not.toHaveBeenCalled();
          // Refused before the quiz or repository is even looked up.
          expect(mocks.findById).not.toHaveBeenCalled();
          expect(mocks.repositoryFindById).not.toHaveBeenCalled();
          expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
        }
      }
    );
  });

  describe('as STUDENT', () => {
    beforeEach(() => {
      mocks.role = 'STUDENT';
    });

    it.each(INTENTS.map(intent => [intent.name, intent] as const))(
      '%s is refused at the gate',
      async (_name, intent) => {
        const thrown = await submit(action, prefix, intent.body).catch((e: unknown) => e);

        expect(thrown).toBeInstanceOf(Response);
        expect((thrown as Response).status).toBe(403);
        expect(mocks.assertClassroomAccess.mock.calls[0][0].allowedRoles).toEqual([
          'OWNER',
          'TEACHER',
          'ASSISTANT',
        ]);
        for (const write of WRITES()) expect(write).not.toHaveBeenCalled();
        expect(mocks.findById).not.toHaveBeenCalled();
        expect(mocks.quizzesVisibleOrThrow).not.toHaveBeenCalled();
        expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
      }
    );
  });
});

describe('what an allowed save passes on', () => {
  it.each(TEAM)('a content save from %s reaches the service as sent', async role => {
    mocks.role = role;

    await submit(assistantRoute.action, 'assistant', CONTENT_SAVE);

    expect(mocks.update).toHaveBeenCalledWith('quiz-1', CONTENT_SAVE);
  });

  it.each(AUTHORS)('an Assignment panel save from %s reaches the service as sent', async role => {
    mocks.role = role;
    const body = {
      ...CONTENT_SAVE,
      assignment: {
        moduleId: 'mod-1',
        releaseAt: null,
        dueDate: '2026-10-09T16:00:00.000Z',
        closesAt: null,
        weight: 10,
        isPublished: true,
      },
    };

    await submit(teacherRoute.action, 'teacher', body);

    expect(mocks.update).toHaveBeenCalledWith('quiz-1', body);
  });

  it("refuses an assistant's save that carries an empty assignment object", async () => {
    // The panel's fields travel inside `assignment`; the key alone decides,
    // whatever it holds.
    mocks.role = 'ASSISTANT';

    const response = (await submit(assistantRoute.action, 'assistant', {
      ...CONTENT_SAVE,
      assignment: {},
    })) as Response;

    expect(response.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
