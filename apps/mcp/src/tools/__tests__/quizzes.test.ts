/**
 * Unit tests for quiz_create / quiz_update / quiz_publish / quiz_delete.
 *
 * Security focus:
 *   - S1: every tool resolves its target (and any linked repository) against
 *     the ctx classroom, and refuses missing/foreign records with the uniform
 *     scopedNotFound BEFORE any service call.
 *   - The two in-handler gates the registry cannot apply — Pro tier and
 *     quizzes_enabled — deny before mutating.
 *   - The notification invariant: publishing is quiz.publish's job only, so
 *     the update schema must refuse PUBLISHED (and ARCHIVED, which is not even
 *     in the Prisma enum).
 * Only the service boundary is mocked — these tools fire no external effects.
 *
 * Schema-level rules (clamps, the status enum, confirm:true) are asserted
 * against `tool.inputSchema` itself: the registry/SDK validates arguments
 * BEFORE the handler runs, so a direct handler call bypasses zod entirely.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  quizCreate: vi.fn(),
  quizUpdate: vi.fn(),
  quizPublish: vi.fn(),
  quizDelete: vi.fn(),
  quizFindById: vi.fn(),
  repositoryFindById: vi.fn(),
  getProState: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    quiz: {
      create: (...a: unknown[]) => mocks.quizCreate(...a),
      update: (...a: unknown[]) => mocks.quizUpdate(...a),
      publish: (...a: unknown[]) => mocks.quizPublish(...a),
      delete: (...a: unknown[]) => mocks.quizDelete(...a),
      findById: (...a: unknown[]) => mocks.quizFindById(...a),
    },
    repository: { findById: (...a: unknown[]) => mocks.repositoryFindById(...a) },
    // Reached through the shared assertProTier helper exported by
    // resources/content.ts (one Pro-tier definition for reads AND writes).
    subscription: { getProStateForClassroomId: (...a: unknown[]) => mocks.getProState(...a) },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

const { quizCreateTool, quizUpdateTool, quizPublishTool, quizDeleteTool } =
  await import('../quizzes.ts');

/** Context with the quiz surface enabled (Pro + quizzes_enabled). */
function ctxWithSettings(settings: Record<string, unknown>): ToolContext {
  return {
    viewer: { userId: 'owner-1', clientId: 'c', scopes: new Set(['read', 'write']) },
    classroom: {
      classroomId: 'class-1',
      role: 'OWNER',
      status: 'ACTIVE',
      membership: { id: 'm-1', role: 'OWNER' },
      classroom: { settings },
    },
  } as unknown as ToolContext;
}

const CTX = ctxWithSettings({ quizzes_enabled: true });

const QUIZ_ROW = {
  id: 'quiz-1',
  classroom_id: 'class-1',
  name: 'Week 3 concepts',
  status: 'DRAFT',
  rubric_prompt: 'Ask about recursion',
  weight: 10,
  question_count: 5,
  max_attempts: 1,
  grading_strategy: 'HIGHEST',
  include_code_context: false,
  attempts: [{ id: 'att-1', user: { id: 'stu-1', name: 'Alice', email: 'a@x.edu' } }],
};

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.getProState.mockResolvedValue({ isPro: true });
});

describe('quiz_create', () => {
  const ARGS = {
    classroom: 'org/w26',
    name: 'Week 3 concepts',
    rubric_prompt: 'Ask about recursion',
    weight: 10,
    question_count: 5,
  };

  it('creates a DRAFT under the ctx classroom and audits CREATE', async () => {
    mocks.quizCreate.mockResolvedValue(QUIZ_ROW);

    const payload = parse(await quizCreateTool.handler(ARGS, CTX));
    expect(payload.success).toBe(true);
    expect(payload.quiz.id).toBe('quiz-1');

    const data = mocks.quizCreate.mock.calls[0][0] as Record<string, unknown>;
    // classroomId comes from ctx, never from args, and status is pinned DRAFT:
    // publishing must go through quiz_publish so students get notified.
    expect(data.classroomId).toBe('class-1');
    expect(data.status).toBe('DRAFT');
    expect(data.rubricPrompt).toBe('Ask about recursion');

    const audit = mocks.auditCreate.mock.calls[0][0] as { action: string; classroom_id: string };
    expect(audit.action).toBe('CREATE');
    expect(audit.classroom_id).toBe('class-1');
  });

  it('does not accept a status argument at all (always DRAFT)', () => {
    expect(quizCreateTool.inputSchema).not.toHaveProperty('status');
  });

  it('never echoes the attempts/user rows the service returns', async () => {
    mocks.quizCreate.mockResolvedValue(QUIZ_ROW);
    const payload = parse(await quizCreateTool.handler(ARGS, CTX));
    expect(payload.quiz).not.toHaveProperty('attempts');
    expect(JSON.stringify(payload)).not.toContain('a@x.edu');
  });

  it('links a repository only after verifying it is in this classroom', async () => {
    mocks.repositoryFindById.mockResolvedValue({ id: 'repo-1', classroom_id: 'class-1' });
    mocks.quizCreate.mockResolvedValue({ ...QUIZ_ROW, repository_id: 'repo-1' });

    await quizCreateTool.handler({ ...ARGS, repository_id: 'repo-1' }, CTX);
    expect((mocks.quizCreate.mock.calls[0][0] as { repositoryId: string }).repositoryId).toBe(
      'repo-1'
    );
  });

  it('refuses a repository from another classroom (S1) and never creates', async () => {
    mocks.repositoryFindById.mockResolvedValue({ id: 'repo-1', classroom_id: 'OTHER-class' });

    await expect(
      quizCreateTool.handler({ ...ARGS, repository_id: 'repo-1' }, CTX)
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.quizCreate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('denies a classroom without a Pro subscription before mutating', async () => {
    mocks.getProState.mockResolvedValue({ isPro: false });
    await expect(quizCreateTool.handler(ARGS, CTX)).rejects.toMatchObject({ kind: 'forbidden' });
    expect(mocks.quizCreate).not.toHaveBeenCalled();
  });

  it('denies when quizzes are disabled for the classroom (stricter than the web app)', async () => {
    const disabled = ctxWithSettings({ quizzes_enabled: false });
    await expect(quizCreateTool.handler(ARGS, disabled)).rejects.toMatchObject({
      kind: 'forbidden',
      message: 'Quizzes are disabled for this classroom',
    });
    expect(mocks.quizCreate).not.toHaveBeenCalled();
  });

  it('enforces the service clamps in the schema (question_count, max_attempts, weight)', () => {
    const schema = z.object(quizCreateTool.inputSchema);
    const base = { classroom: 'org/w26', name: 'Q', rubric_prompt: 'r' };

    expect(schema.safeParse({ ...base, question_count: 0 }).success).toBe(false);
    expect(schema.safeParse({ ...base, question_count: 21 }).success).toBe(false);
    expect(schema.safeParse({ ...base, question_count: 20 }).success).toBe(true);
    expect(schema.safeParse({ ...base, question_count: 2.5 }).success).toBe(false);

    // 0 is legal for max_attempts — it means unlimited.
    expect(schema.safeParse({ ...base, max_attempts: 0 }).success).toBe(true);
    expect(schema.safeParse({ ...base, max_attempts: -1 }).success).toBe(false);

    expect(schema.safeParse({ ...base, weight: 0 }).success).toBe(true);
    expect(schema.safeParse({ ...base, weight: 101 }).success).toBe(false);

    // rubric_prompt is required and non-empty.
    expect(schema.safeParse({ classroom: 'org/w26', name: 'Q' }).success).toBe(false);
    expect(schema.safeParse({ ...base, rubric_prompt: '' }).success).toBe(false);
  });
});

describe('quiz_update', () => {
  const ARGS = { classroom: 'org/w26', quiz_id: 'quiz-1', name: 'Renamed' };

  it('updates a quiz in this classroom and audits the changed fields', async () => {
    mocks.quizFindById.mockResolvedValue(QUIZ_ROW);
    mocks.quizUpdate.mockResolvedValue({ ...QUIZ_ROW, name: 'Renamed' });

    const payload = parse(await quizUpdateTool.handler(ARGS, CTX));
    expect(payload.quiz.name).toBe('Renamed');

    // Mapped explicitly into the service's camelCase vocabulary.
    expect(mocks.quizUpdate).toHaveBeenCalledWith('quiz-1', { name: 'Renamed' });

    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      classroom_id: string;
      data: { fields: string[] };
    };
    expect(audit.action).toBe('UPDATE');
    expect(audit.classroom_id).toBe('class-1');
    expect(audit.data.fields).toEqual(['name']);
  });

  it('requires at least one field', async () => {
    await expect(
      quizUpdateTool.handler({ classroom: 'org/w26', quiz_id: 'quiz-1' }, CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.quizFindById).not.toHaveBeenCalled();
    expect(mocks.quizUpdate).not.toHaveBeenCalled();
  });

  it('refuses a quiz in another classroom (S1) with zero service calls', async () => {
    mocks.quizFindById.mockResolvedValue({ ...QUIZ_ROW, classroom_id: 'OTHER-class' });

    await expect(quizUpdateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Quiz not found in this classroom',
    });
    expect(mocks.quizUpdate).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses an unknown quiz id with the identical error (no existence leak)', async () => {
    mocks.quizFindById.mockResolvedValue(null);
    await expect(quizUpdateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Quiz not found in this classroom',
    });
  });

  it('disconnects the repository on null and verifies a non-null one first', async () => {
    mocks.quizFindById.mockResolvedValue(QUIZ_ROW);
    mocks.quizUpdate.mockResolvedValue(QUIZ_ROW);

    await quizUpdateTool.handler(
      { classroom: 'org/w26', quiz_id: 'quiz-1', repository_id: null },
      CTX
    );
    expect(mocks.quizUpdate).toHaveBeenCalledWith('quiz-1', { repositoryId: null });
    expect(mocks.repositoryFindById).not.toHaveBeenCalled();

    mocks.repositoryFindById.mockResolvedValue({ id: 'repo-9', classroom_id: 'OTHER-class' });
    await expect(
      quizUpdateTool.handler(
        { classroom: 'org/w26', quiz_id: 'quiz-1', repository_id: 'repo-9' },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.quizUpdate).toHaveBeenCalledTimes(1); // only the null-disconnect call
  });

  it('rejects PUBLISHED and ARCHIVED in the status schema', () => {
    const status = quizUpdateTool.inputSchema.status;
    expect(status.safeParse('DRAFT').success).toBe(true);
    expect(status.safeParse('CLOSED').success).toBe(true);
    // PUBLISHED would skip the notification path; ARCHIVED is not in the enum.
    expect(status.safeParse('PUBLISHED').success).toBe(false);
    expect(status.safeParse('ARCHIVED').success).toBe(false);
  });

  it('applies the same clamps as create', () => {
    const schema = z.object(quizUpdateTool.inputSchema);
    const base = { classroom: 'org/w26', quiz_id: '11111111-1111-4111-8111-111111111111' };
    expect(schema.safeParse({ ...base, question_count: 21 }).success).toBe(false);
    expect(schema.safeParse({ ...base, max_attempts: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...base, weight: 101 }).success).toBe(false);
    expect(schema.safeParse({ ...base, rubric_prompt: '' }).success).toBe(false);
  });

  it('denies when the quiz surface is off (Pro / quizzes_enabled) before loading', async () => {
    mocks.getProState.mockResolvedValue({ isPro: false });
    await expect(quizUpdateTool.handler(ARGS, CTX)).rejects.toMatchObject({ kind: 'forbidden' });
    expect(mocks.quizFindById).not.toHaveBeenCalled();
  });
});

describe('quiz_publish', () => {
  const ARGS = { classroom: 'org/w26', quiz_id: 'quiz-1' };

  it('publishes a draft and reports that students were notified', async () => {
    mocks.quizFindById.mockResolvedValue(QUIZ_ROW); // status DRAFT
    mocks.quizPublish.mockResolvedValue({ ...QUIZ_ROW, status: 'PUBLISHED' });

    const payload = parse(await quizPublishTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({
      success: true,
      previous_status: 'DRAFT',
      students_notified: true,
    });
    expect(mocks.quizPublish).toHaveBeenCalledWith('quiz-1');

    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      data: { students_notified: boolean };
    };
    expect(audit.action).toBe('UPDATE');
    expect(audit.data.students_notified).toBe(true);
  });

  it('is idempotent: republishing reports that nobody was notified', async () => {
    mocks.quizFindById.mockResolvedValue({ ...QUIZ_ROW, status: 'PUBLISHED' });
    mocks.quizPublish.mockResolvedValue({ ...QUIZ_ROW, status: 'PUBLISHED' });

    const payload = parse(await quizPublishTool.handler(ARGS, CTX));
    expect(payload.students_notified).toBe(false);
    expect(payload.previous_status).toBe('PUBLISHED');
    expect(quizPublishTool.annotations?.idempotent).toBe(true);
  });

  it('refuses a quiz from another classroom (S1) and never publishes', async () => {
    mocks.quizFindById.mockResolvedValue({ ...QUIZ_ROW, classroom_id: 'OTHER-class' });
    await expect(quizPublishTool.handler(ARGS, CTX)).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.quizPublish).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('denies when quizzes are disabled for the classroom', async () => {
    const disabled = ctxWithSettings({ quizzes_enabled: false });
    await expect(quizPublishTool.handler(ARGS, disabled)).rejects.toMatchObject({
      kind: 'forbidden',
    });
    expect(mocks.quizPublish).not.toHaveBeenCalled();
  });
});

describe('quiz_delete', () => {
  const ARGS = { classroom: 'org/w26', quiz_id: 'quiz-1', confirm: true as const };

  it('deletes the quiz and records the cascade blast radius', async () => {
    mocks.quizFindById.mockResolvedValue(QUIZ_ROW);
    mocks.quizDelete.mockResolvedValue({ id: 'quiz-1' });

    const payload = parse(await quizDeleteTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({
      success: true,
      deleted_quiz_id: 'quiz-1',
      attempts_deleted: 1,
    });
    expect(mocks.quizDelete).toHaveBeenCalledWith('quiz-1');

    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      classroom_id: string;
      data: { attempts_deleted: number };
    };
    expect(audit.action).toBe('DELETE');
    expect(audit.classroom_id).toBe('class-1');
    // Student attempts cascade-delete with the quiz (schema: QuizAttempt.quiz
    // onDelete: Cascade) — the count is preserved in the audit trail.
    expect(audit.data.attempts_deleted).toBe(1);
  });

  it('requires confirm:true in the schema (destructive gate)', () => {
    const confirm = quizDeleteTool.inputSchema.confirm;
    expect(confirm.safeParse(true).success).toBe(true);
    expect(confirm.safeParse(false).success).toBe(false);
    expect(confirm.safeParse(undefined).success).toBe(false);
    expect(quizDeleteTool.annotations?.destructive).toBe(true);
  });

  it('refuses a quiz from another classroom (S1) and never deletes', async () => {
    mocks.quizFindById.mockResolvedValue({ ...QUIZ_ROW, classroom_id: 'OTHER-class' });
    await expect(quizDeleteTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Quiz not found in this classroom',
    });
    expect(mocks.quizDelete).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('denies without a Pro subscription before loading the quiz', async () => {
    mocks.getProState.mockResolvedValue({ isPro: false });
    await expect(quizDeleteTool.handler(ARGS, CTX)).rejects.toMatchObject({ kind: 'forbidden' });
    expect(mocks.quizFindById).not.toHaveBeenCalled();
    expect(mocks.quizDelete).not.toHaveBeenCalled();
  });
});
