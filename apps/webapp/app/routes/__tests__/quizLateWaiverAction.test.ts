/**
 * The quiz late shield's action (#813), api.quizLateWaiver.$class: who may
 * set it, that the classroom comes from the URL and never the body, the
 * service's refusals as 404/400, impersonation (allowed and recorded, as the
 * quiz grade adjustment is), and one audit row per actual change.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'OWNER' as string,
  assertClassroomAccess: vi.fn(),
  status: 'ACTIVE' as string,
  addClassroomAuditLog: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  impersonationAuditFields: vi.fn(),
  setQuizLateWaiver: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));

vi.mock('~/utils/classroomProFlag.server', () => ({
  quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a),
}));

vi.mock('~/routes/admin.$class.ask-moji/impersonation.server', () => ({
  impersonationAuditFields: (...a: unknown[]) => mocks.impersonationAuditFields(...a),
}));

vi.mock('@classmoji/services', () => {
  class QuizLateWaiverError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'QuizLateWaiverError';
      this.code = code;
    }
  }
  return {
    QuizLateWaiverError,
    ClassmojiService: {
      quizLateWaiver: {
        setQuizLateWaiver: (...a: unknown[]) => mocks.setQuizLateWaiver(...a),
      },
    },
  };
});

const { QuizLateWaiverError } = (await import('@classmoji/services')) as unknown as {
  QuizLateWaiverError: new (code: string, message: string) => Error;
};
const route = await import('../api.quizLateWaiver.$class/route.ts');

const CLASS_X = { id: 'class-x', slug: 'cs52-26f' };

const post = (body: Record<string, unknown>, slug = CLASS_X.slug) =>
  route.action({
    params: { class: slug },
    request: new Request(`http://localhost/api/quizLateWaiver/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as unknown as Parameters<typeof route.action>[0]);

/** A react-router `data()` result: its payload and status. */
const unwrap = (result: unknown) => {
  const r = result as { type?: string; data?: unknown; init?: { status?: number } };
  return r?.type === 'DataWithResponseInit'
    ? { body: r.data as Record<string, unknown>, status: r.init?.status ?? 200 }
    : { body: result as Record<string, unknown>, status: 200 };
};

const BODY = { assignment_id: 'asg-quiz', student_id: 'student-a', waived: true };

beforeEach(() => {
  for (const m of Object.values(mocks)) if (typeof m === 'function') m.mockReset();
  mocks.role = 'OWNER';
  mocks.status = 'ACTIVE';
  // The gate as the real one behaves: the caller's role must be allowed.
  mocks.assertClassroomAccess.mockImplementation(
    async ({ allowedRoles }: { allowedRoles: string[] }) => {
      if (!allowedRoles.includes(mocks.role)) {
        throw new Response('Forbidden', { status: 403 });
      }
      return {
        userId: 'staff-1',
        classroom: { ...CLASS_X, status: mocks.status },
        membership: { id: 'm-1', role: mocks.role },
      };
    }
  );
  mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  mocks.impersonationAuditFields.mockResolvedValue({});
  mocks.setQuizLateWaiver.mockResolvedValue({ changed: true, waived: true, quizId: 'quiz-1' });
});

describe('api.quizLateWaiver — gate', () => {
  it.each(['OWNER', 'TEACHER'])('lets %s set the waiver', async role => {
    mocks.role = role;
    const { body, status } = unwrap(await post(BODY));
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: 'Late penalty waived', waived: true });
    expect(mocks.setQuizLateWaiver).toHaveBeenCalledOnce();
  });

  it.each(['ASSISTANT', 'STUDENT'])('refuses %s with 403 and writes nothing', async role => {
    mocks.role = role;
    await expect(post(BODY)).rejects.toMatchObject({ status: 403 });
    expect(mocks.setQuizLateWaiver).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('asks the gate for OWNER and TEACHER only, for the classroom in the URL', async () => {
    await post(BODY);
    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        classroomSlug: CLASS_X.slug,
        allowedRoles: ['OWNER', 'TEACHER'],
        resourceType: 'QUIZ_LATE_WAIVER',
      })
    );
  });

  it('returns the classroom mutation refusal as data (a fetcher keeps its page), writing nothing', async () => {
    mocks.role = 'TEACHER';
    mocks.status = 'LOCKED';
    const { status, body } = unwrap(await post(BODY));
    expect(status).toBe(403);
    expect(body).toMatchObject({
      action: 'update-quiz-late-waiver',
      code: 'CLASSROOM_LOCKED',
      error: expect.any(String),
    });
    expect(mocks.setQuizLateWaiver).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('lets the owner write in a LOCKED classroom, as the mutation rule does', async () => {
    mocks.status = 'LOCKED';
    expect(unwrap(await post(BODY)).status).toBe(200);
  });

  it('answers 404 as data where the classroom shows no quizzes', async () => {
    mocks.quizzesVisibleOrThrow.mockResolvedValue(false);
    const { status, body } = unwrap(await post(BODY));
    expect(status).toBe(404);
    expect(body).toMatchObject({ action: 'update-quiz-late-waiver', error: expect.any(String) });
    expect(mocks.setQuizLateWaiver).not.toHaveBeenCalled();
  });

  it("refuses a waiver on the caller's own late penalty with 403, as data", async () => {
    mocks.setQuizLateWaiver.mockRejectedValue(
      new QuizLateWaiverError('self', 'You cannot waive your own late penalty')
    );
    const { status, body } = unwrap(await post({ ...BODY, student_id: 'staff-1' }));
    expect(status).toBe(403);
    expect(body.error).toBe('You cannot waive your own late penalty.');
    // The actor is the session's user, for the service's own check.
    expect(mocks.setQuizLateWaiver).toHaveBeenCalledWith(
      expect.objectContaining({ studentId: 'staff-1', actorId: 'staff-1' })
    );
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('refuses a malformed body with 400', async () => {
    for (const bad of [
      { ...BODY, waived: 'yes' },
      { ...BODY, assignment_id: '' },
      { student_id: 'student-a', waived: true },
      { assignment_id: 'asg-quiz', waived: true },
    ]) {
      expect(unwrap(await post(bad)).status).toBe(400);
    }
    expect(mocks.setQuizLateWaiver).not.toHaveBeenCalled();
  });
});

describe('api.quizLateWaiver — scope', () => {
  it("writes in the URL's classroom, never one named in the body", async () => {
    await post({ ...BODY, classroom_id: 'class-y', classroomId: 'class-y' });
    expect(mocks.setQuizLateWaiver).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-x',
      assignmentId: 'asg-quiz',
      studentId: 'student-a',
      waived: true,
      actorId: 'staff-1',
    });
  });

  it("answers another classroom's quiz assignment (the service's not_found) with 404", async () => {
    mocks.setQuizLateWaiver.mockRejectedValue(
      new QuizLateWaiverError('not_found', 'Assignment not found')
    );
    const { status, body } = unwrap(await post({ ...BODY, assignment_id: 'asg-in-class-y' }));
    expect(status).toBe(404);
    expect(body.error).toBe('Quiz not found for this classroom.');
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('answers a student who is not a STUDENT here (B) with 404, and A still works', async () => {
    mocks.setQuizLateWaiver.mockImplementation(async ({ studentId }: { studentId: string }) => {
      if (studentId === 'student-b') {
        throw new QuizLateWaiverError('not_student', 'Not a student in this classroom');
      }
      return { changed: true, waived: true, quizId: 'quiz-1' };
    });

    expect(unwrap(await post({ ...BODY, student_id: 'student-b' })).status).toBe(404);
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();

    expect(unwrap(await post(BODY)).status).toBe(200);
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledOnce();
    expect(mocks.addClassroomAuditLog.mock.calls[0][0].metadata.student_id).toBe('student-a');
  });

  it('answers a non-quiz assignment with 400', async () => {
    mocks.setQuizLateWaiver.mockRejectedValue(new QuizLateWaiverError('not_quiz', 'not a quiz'));
    expect(unwrap(await post(BODY)).status).toBe(400);
  });

  it('lets any other error through', async () => {
    mocks.setQuizLateWaiver.mockRejectedValue(new Error('db down'));
    await expect(post(BODY)).rejects.toThrow('db down');
  });
});

describe('api.quizLateWaiver — audit', () => {
  it('writes one row per change, in the MCP shape, never deduped', async () => {
    await post(BODY);
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-x',
      userId: 'staff-1',
      role: 'OWNER',
      action: 'UPDATE',
      resourceType: 'QUIZ_LATE_WAIVER',
      resourceId: 'asg-quiz',
      metadata: {
        tool: 'web:quiz_late_waiver',
        kind: 'quiz',
        field: 'quiz_late_waiver',
        value: true,
        assignment_id: 'asg-quiz',
        quiz_id: 'quiz-1',
        student_id: 'student-a',
      },
      dedupe: false,
    });
  });

  it('records clearing as value false', async () => {
    mocks.setQuizLateWaiver.mockResolvedValue({ changed: true, waived: false, quizId: 'quiz-1' });
    const { body } = unwrap(await post({ ...BODY, waived: false }));
    expect(body).toMatchObject({ success: 'Late penalty restored', waived: false });
    expect(mocks.addClassroomAuditLog.mock.calls[0][0].metadata.value).toBe(false);
  });

  it('is idempotent: a repeat that changes nothing writes no row', async () => {
    mocks.setQuizLateWaiver.mockResolvedValue({ changed: false, waived: true, quizId: 'quiz-1' });
    const { status } = unwrap(await post(BODY));
    expect(status).toBe(200);
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('allows a write while impersonated and records the admin behind it', async () => {
    mocks.impersonationAuditFields.mockResolvedValue({ impersonated_by: 'platform-admin-1' });
    expect(unwrap(await post(BODY)).status).toBe(200);
    expect(mocks.addClassroomAuditLog.mock.calls[0][0].metadata).toMatchObject({
      impersonated_by: 'platform-admin-1',
    });
  });
});
