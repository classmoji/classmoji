/**
 * The admin quiz action and quiz source material.
 *
 *   - Create and update forward `sourceMaterial` / `courseSearchEnabled` to the
 *     quiz service, which writes them in the quiz's own transaction. A
 *     malformed or foreign document comes back as a ResourceLinkServiceError;
 *     the action answers 404 and audits nothing (nothing was written). Its
 *     `conflict` code (another save of the same material committed first, and
 *     this one was rolled back) answers 409 with its own copy.
 *   - A save that leaves the quiz PUBLISHED while every linked document is
 *     still a draft succeeds WITH a warning: students cannot start it yet.
 *     Saving is allowed; the warning is the whole intervention.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  publish: vi.fn(),
  findById: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: vi.fn(),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));
vi.mock('~/utils/classroomProFlag.server', () => ({
  quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a),
}));
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: {
      create: (...a: unknown[]) => mocks.create(...a),
      update: (...a: unknown[]) => mocks.update(...a),
      publish: (...a: unknown[]) => mocks.publish(...a),
      findById: (...a: unknown[]) => mocks.findById(...a),
      delete: vi.fn(),
      findByClassroom: vi.fn(),
    },
    repository: { findById: vi.fn() },
    quizAttempt: { clearForUser: vi.fn() },
    user: { findById: vi.fn() },
  },
  QuizAccessError: class QuizAccessError extends Error {},
}));
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
  useLocation: () => ({ pathname: '/teacher/cs52-26f/quizzes' }),
  useNavigate: () => vi.fn(),
  useParams: () => ({ class: 'cs52-26f' }),
  Outlet: () => null,
}));

const route = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';
const WARNING = 'All source material is still draft; students will not be able to start this quiz.';

const submit = async (body: Record<string, unknown>) => {
  const response = (await route.action({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/teacher/${CLASS_SLUG}/quizzes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof route.action>[0])) as Response;
  return { status: response.status, body: await response.json() };
};

const draftDoc = { kind: 'page', id: 'p1', title: 'Next week', is_draft: true, order: 0 };
const liveDoc = { kind: 'slide', id: 's1', title: 'Forms', is_draft: false, order: 1 };

const refusal = () =>
  Object.assign(new Error('[quizSourceMaterial] not in classroom'), {
    name: 'ResourceLinkServiceError',
    code: 'resource_not_found',
  });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'teacher-1',
    classroom: { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' },
    membership: { id: 'm-1', role: 'TEACHER' },
  });
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  mocks.create.mockResolvedValue({ id: 'quiz-new', name: 'Q', status: 'DRAFT' });
  mocks.update.mockResolvedValue({});
  mocks.publish.mockResolvedValue({});
  mocks.findById.mockResolvedValue({
    id: 'quiz-1',
    classroom_id: 'class-1',
    name: 'Q',
    source_material: [draftDoc],
  });
});

describe('create and update forward the material to the service', () => {
  it('createQuiz passes sourceMaterial and courseSearchEnabled with the authorized classroom', async () => {
    const sourceMaterial = [
      { kind: 'slide', id: 's1' },
      { kind: 'page', id: 'p1' },
    ];

    const { status } = await submit({
      _action: 'createQuiz',
      name: 'Q',
      rubricPrompt: 'r',
      sourceMaterial,
      courseSearchEnabled: true,
    });

    expect(status).toBe(200);
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      classroomId: 'class-1',
      sourceMaterial,
      courseSearchEnabled: true,
    });
  });

  it('answers 404 and audits nothing when the service refuses the material', async () => {
    mocks.create.mockRejectedValue(refusal());

    const { status, body } = await submit({
      _action: 'createQuiz',
      name: 'Q',
      rubricPrompt: 'r',
      sourceMaterial: [{ kind: 'page', id: 'foreign' }],
    });

    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Some of the source material is not in this class' });
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('updateQuiz: the same refusal is a 404 too', async () => {
    mocks.update.mockRejectedValue(refusal());

    const { status } = await submit({
      _action: 'updateQuiz',
      id: 'quiz-1',
      sourceMaterial: 'not-a-list',
    });

    expect(status).toBe(404);
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('updateQuiz: a conflicting save is a 409 that says to save again, audited nothing', async () => {
    mocks.update.mockRejectedValue(
      Object.assign(new Error("[quizSourceMaterial] quiz quiz-1's source material was saved"), {
        name: 'ResourceLinkServiceError',
        code: 'conflict',
      })
    );

    const { status, body } = await submit({
      _action: 'updateQuiz',
      id: 'quiz-1',
      sourceMaterial: [{ kind: 'page', id: 'p1' }],
    });

    expect(status).toBe(409);
    expect(body).toEqual({
      error:
        "Someone else saved this quiz's source material at the same time. Reload and save again.",
    });
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('rethrows any other failure', async () => {
    mocks.update.mockRejectedValue(new Error('connection reset'));

    await expect(submit({ _action: 'updateQuiz', id: 'quiz-1', name: 'N' })).rejects.toThrow(
      'connection reset'
    );
  });
});

describe('the all-drafts publish warning', () => {
  it('publishQuiz: succeeds and warns when every linked document is a draft', async () => {
    const { status, body } = await submit({ _action: 'publishQuiz', id: 'quiz-1' });

    expect(status).toBe(200);
    expect(body).toEqual({ success: 'Quiz published successfully', warning: WARNING });
    expect(mocks.publish).toHaveBeenCalledWith('quiz-1');
  });

  it('publishQuiz: no warning once any linked document is published', async () => {
    mocks.findById.mockResolvedValue({
      id: 'quiz-1',
      classroom_id: 'class-1',
      source_material: [draftDoc, liveDoc],
    });

    const { body } = await submit({ _action: 'publishQuiz', id: 'quiz-1' });

    expect(body).toEqual({ success: 'Quiz published successfully' });
  });

  it('publishQuiz: no warning for a quiz with no linked material', async () => {
    mocks.findById.mockResolvedValue({
      id: 'quiz-1',
      classroom_id: 'class-1',
      source_material: [],
    });

    const { body } = await submit({ _action: 'publishQuiz', id: 'quiz-1' });

    expect(body).not.toHaveProperty('warning');
  });

  it('updateQuiz to PUBLISHED reads the material AFTER the write and warns', async () => {
    const { body } = await submit({
      _action: 'updateQuiz',
      id: 'quiz-1',
      status: 'PUBLISHED',
      sourceMaterial: [{ kind: 'page', id: 'p1' }],
    });

    expect(body).toEqual({ success: 'Quiz updated successfully', warning: WARNING });
    // One read to prove the classroom, one after the write for the warning.
    expect(mocks.findById).toHaveBeenCalledTimes(2);
    expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findById.mock.invocationCallOrder[1]
    );
  });

  it('updateQuiz that leaves the quiz a draft: no warning, no extra read', async () => {
    const { body } = await submit({ _action: 'updateQuiz', id: 'quiz-1', status: 'DRAFT' });

    expect(body).toEqual({ success: 'Quiz updated successfully' });
    expect(mocks.findById).toHaveBeenCalledTimes(1);
  });

  it('createQuiz straight to PUBLISHED warns the same way', async () => {
    mocks.create.mockResolvedValue({ id: 'quiz-1', name: 'Q', status: 'PUBLISHED' });

    const { body } = await submit({
      _action: 'createQuiz',
      name: 'Q',
      rubricPrompt: 'r',
      status: 'PUBLISHED',
    });

    expect(body).toMatchObject({ quizId: 'quiz-1', warning: WARNING });
  });
});
