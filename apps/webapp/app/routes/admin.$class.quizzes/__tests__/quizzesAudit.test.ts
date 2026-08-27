/**
 * Unit tests for the admin quiz action.
 *
 * Two properties, and they hold each other up:
 *
 * 1. Every branch here mutates and, until now, none of them recorded anything —
 *    while the MCP quiz tools have always audited theirs. The rows are shaped to
 *    match: resource_type 'QUIZ', the quiz id, and the AuditLogAction enum.
 *
 *    That enum has no PUBLISH, so publishing and re-weighting are both UPDATE
 *    with the intent carried in `data.tool`. `tool` is load-bearing beyond
 *    naming: the audit service dedups inside a 5-second window on (user,
 *    classroom, role, resource_type, resource_id, action) plus `data.tool`, so a
 *    publish followed immediately by a weight change would otherwise collapse to
 *    one row.
 *
 * 2. Each write is bound to a quiz IN THE AUTHORIZED CLASSROOM. Authorization
 *    binds to `params.class`, but the quiz id arrives in the JSON body and
 *    `quiz.service` resolves quizzes by id alone — so without the binding the
 *    two are unrelated, and an audit row naming the authorized classroom would
 *    be describing a write that landed somewhere else. Same invariant the MCP
 *    quiz tools get from `loadQuizInClassroom`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  assertProTier: vi.fn(),
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
  assertProTier: (...a: unknown[]) => mocks.assertProTier(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
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
    classroom: { getClassroomSettingsForServer: vi.fn() },
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

const route = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };
const OWN_QUIZ = 'quiz-1';
const FOREIGN_QUIZ = 'quiz-in-another-classroom';

const submit = (body: Record<string, unknown>) =>
  route.action({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/quizzes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof route.action>[0]);

/** The single audit entry the action wrote. */
const auditEntry = () =>
  mocks.addClassroomAuditLog.mock.calls[0][0] as {
    action: string;
    resourceType: string;
    resourceId: string;
    metadata: Record<string, unknown>;
  };

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'owner-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'TEACHER' },
  });
  mocks.create.mockResolvedValue({ id: 'quiz-new', name: 'Week 1', repository_id: 'repo-1' });
  mocks.update.mockResolvedValue({});
  mocks.remove.mockResolvedValue({});
  mocks.publish.mockResolvedValue({});
  // By default the named quiz lives in the authorized classroom.
  mocks.findById.mockResolvedValue({ id: OWN_QUIZ, classroom_id: 'class-1', name: 'Week 1' });
  mocks.repositoryFindById.mockResolvedValue({ id: 'repo-1', classroom_id: 'class-1' });
  mocks.clearForUser.mockResolvedValue({ deletedCount: 3 });
});

describe('admin quizzes action — audit rows', () => {
  it('audits createQuiz as CREATE against the new quiz', async () => {
    await submit({ _action: 'createQuiz', name: 'Week 1' });

    expect(mocks.addClassroomAuditLog).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      userId: 'owner-1',
      // The role the gate ENFORCED, matching what MCP's writeAudit records.
      role: 'TEACHER',
      action: 'CREATE',
      resourceType: 'QUIZ',
      resourceId: 'quiz-new',
      metadata: { tool: 'web:quizzes.create', name: 'Week 1', repository_id: 'repo-1' },
    });
  });

  it('audits updateQuiz with field NAMES only', async () => {
    // The body carries system and rubric prompts — long free text that has no
    // business in an audit payload.
    await submit({
      _action: 'updateQuiz',
      id: 'quiz-1',
      name: 'Renamed',
      system_prompt: 'x'.repeat(5000),
    });

    const entry = auditEntry();
    expect(entry).toMatchObject({ action: 'UPDATE', resourceType: 'QUIZ', resourceId: 'quiz-1' });
    expect(entry.metadata.fields).toEqual(['name', 'system_prompt']);
    expect(JSON.stringify(entry.metadata)).not.toContain('xxxxx');
  });

  it('audits deleteQuiz as DELETE against the quiz id', async () => {
    await submit({ _action: 'deleteQuiz', id: 'quiz-1' });

    expect(auditEntry()).toMatchObject({
      action: 'DELETE',
      resourceType: 'QUIZ',
      resourceId: 'quiz-1',
      metadata: { tool: 'web:quizzes.delete' },
    });
  });

  it('audits publishQuiz as UPDATE, since the enum has no PUBLISH', async () => {
    await submit({ _action: 'publishQuiz', id: 'quiz-1' });

    expect(auditEntry()).toMatchObject({
      action: 'UPDATE',
      resourceType: 'QUIZ',
      resourceId: 'quiz-1',
      metadata: { tool: 'web:quizzes.publish', published: true },
    });
  });

  it('audits updateWeight with the weight it set', async () => {
    await submit({ _action: 'updateWeight', id: 'quiz-1', weight: 25 });

    expect(auditEntry()).toMatchObject({
      action: 'UPDATE',
      resourceId: 'quiz-1',
      metadata: { tool: 'web:quizzes.update_weight', fields: ['weight'], weight: 25 },
    });
  });

  it('keeps publish and weight distinguishable so the dedup window cannot merge them', async () => {
    // Same user, classroom, role, resource and action — `tool` is the only
    // thing keeping these two rows apart.
    await submit({ _action: 'publishQuiz', id: 'quiz-1' });
    await submit({ _action: 'updateWeight', id: 'quiz-1', weight: 10 });

    const tools = mocks.addClassroomAuditLog.mock.calls.map(
      ([entry]) => (entry as { metadata: { tool: string } }).metadata.tool
    );
    expect(new Set(tools).size).toBe(2);
  });

  it('audits clearMyAttempts against the classroom, since it spans every quiz', async () => {
    await submit({ _action: 'clearMyAttempts' });

    expect(auditEntry()).toMatchObject({
      action: 'DELETE',
      resourceType: 'QUIZ',
      resourceId: 'class-1',
      metadata: { tool: 'web:quizzes.clear_my_attempts', scope: 'classroom', deleted_count: 3 },
    });
  });

  it('writes nothing when the authorization gate throws', async () => {
    mocks.assertClassroomAccess.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    await expect(submit({ _action: 'deleteQuiz', id: 'quiz-1' })).rejects.toBeInstanceOf(Response);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });
});

describe('admin quizzes action — writes stay inside the authorized classroom', () => {
  /** Every mutation that takes a quiz id from the request body. */
  const bodyIdMutations: Array<[string, Record<string, unknown>]> = [
    ['updateQuiz', { _action: 'updateQuiz', id: FOREIGN_QUIZ, name: 'Renamed' }],
    ['deleteQuiz', { _action: 'deleteQuiz', id: FOREIGN_QUIZ }],
    ['publishQuiz', { _action: 'publishQuiz', id: FOREIGN_QUIZ }],
    ['updateWeight', { _action: 'updateWeight', id: FOREIGN_QUIZ, weight: 40 }],
  ];

  it.each(bodyIdMutations)(
    '%s refuses a quiz belonging to another classroom, and audits nothing',
    async (_name, body) => {
      mocks.findById.mockResolvedValue({ id: FOREIGN_QUIZ, classroom_id: 'other-class' });

      const response = (await submit(body)) as Response;

      expect(response.status).toBe(404);
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(mocks.publish).not.toHaveBeenCalled();
      expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
    }
  );

  it.each(bodyIdMutations)('%s refuses a quiz id that does not exist', async (_name, body) => {
    mocks.findById.mockResolvedValue(null);

    const response = (await submit(body)) as Response;

    expect(response.status).toBe(404);
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('resolves the quiz before writing, not after', async () => {
    // The ordering is the point: a write that lands and is only then found to
    // be out of scope has already happened.
    await submit({ _action: 'publishQuiz', id: OWN_QUIZ });

    expect(mocks.findById).toHaveBeenCalledWith(OWN_QUIZ);
    expect(mocks.findById.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.publish.mock.invocationCallOrder[0]
    );
  });

  it('refuses to link a quiz to a repository from another classroom', async () => {
    // quiz.create/update connect the repository relation by id with no
    // classroom check of their own.
    mocks.repositoryFindById.mockResolvedValue({ id: 'repo-9', classroom_id: 'other-class' });

    const response = (await submit({
      _action: 'createQuiz',
      name: 'Week 1',
      repositoryId: 'repo-9',
    })) as Response;

    expect(response.status).toBe(404);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('allows an unlinked quiz, where no repository is named at all', async () => {
    await submit({ _action: 'createQuiz', name: 'Week 1' });

    expect(mocks.repositoryFindById).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalled();
  });

  it('clearMyAttempts is scoped by the caller and the classroom, not by a body id', async () => {
    await submit({ _action: 'clearMyAttempts', classroomId: 'other-class' });

    expect(mocks.clearForUser).toHaveBeenCalledWith('owner-1', 'class-1');
  });
});
