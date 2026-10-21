/**
 * Regrade workflows and quiz requests.
 *
 * Held here:
 *   - `quiz_regrade_resolved` emails the student of a resolved QUIZ request,
 *     from the database (only the request id travels): it names the quiz and
 *     the attempt, says "Score adjusted X → Y" or "Score kept X" with emoji
 *     (a `score-N` badge as its number, never a percentage), carries the
 *     staff reply escaped, and sends nothing for a repo request, an open one,
 *     or a student with no email.
 *   - `update_regrade_request` refuses a quiz request (resolveQuiz owns its
 *     status and adjustment) and still resolves a repo request, with an
 *     email that tolerates a missing submission title.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  classroomFindById: vi.fn(),
  findScaleByClassroomId: vi.fn(),
  sendEmail: vi.fn(),
  sendBatch: vi.fn(),
}));

// `task()` normally returns a trigger handle; return the config so the test
// can call `run` / `onSuccess` directly.
vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@classmoji/services', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/services')>('@classmoji/services')),
  ClassmojiService: {
    regradeRequest: {
      findMany: (...a: unknown[]) => mocks.findMany(...a),
      update: (...a: unknown[]) => mocks.update(...a),
    },
    classroom: { findById: (...a: unknown[]) => mocks.classroomFindById(...a) },
    emojiMapping: {
      findScaleByClassroomId: (...a: unknown[]) => mocks.findScaleByClassroomId(...a),
    },
  },
}));

vi.mock('../email.ts', () => ({
  sendEmailTask: { trigger: (...a: unknown[]) => mocks.sendEmail(...a) },
  sendBatchEmailTask: { trigger: (...a: unknown[]) => mocks.sendBatch(...a) },
}));

const { quizRegradeResolvedTask, updateRegradeRequestTask, renderQuizRegradeResolvedEmail } =
  await import('../regrades.ts');

type Runnable<P> = { run: (payload: P) => Promise<unknown> };
const quizTask = quizRegradeResolvedTask as unknown as Runnable<{ request_id: string }>;
const updateTask = updateRegradeRequestTask as unknown as Runnable<unknown> & {
  onSuccess: (args: { payload: unknown }) => Promise<void>;
};

const SCALE = { rocket: 100, '+1': 90, eyes: 80, '-1': 60, sob: 0 };

const quizRequest = (over: Record<string, unknown> = {}) => ({
  id: 'rr-1',
  classroom_id: 'class-1',
  status: 'APPROVED',
  quiz_attempt_id: 'att-2',
  previous_grade: ['-1'],
  grader_comment: 'Fair <point>, adjusted.',
  student: { id: 'stu-1', name: 'Ada', email: 'ada@school.edu' },
  quiz_attempt: {
    id: 'att-2',
    attempt_number: 2,
    partial_credit_percentage: 62,
    adjusted_emoji: 'rocket',
    quiz: { id: 'quiz-1', name: 'Quiz 1', assignment: { id: 'asg-1', title: 'Week 3 quiz' } },
  },
  git_repo_assignment: null,
  ...over,
});

type SentEmail = {
  to: string;
  template: { id: string; variables: Record<string, string> };
};
const sent = () => mocks.sendEmail.mock.calls[0][0] as SentEmail;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.classroomFindById.mockResolvedValue({ id: 'class-1', name: 'CS 52' });
  mocks.findScaleByClassroomId.mockResolvedValue(SCALE);
  mocks.sendEmail.mockResolvedValue({ id: 'run-email' });
});

describe('quiz_regrade_resolved', () => {
  it('emails "Score adjusted X → Y", the quiz, the attempt and the escaped reply', async () => {
    mocks.findMany.mockResolvedValue([quizRequest()]);

    await expect(quizTask.run({ request_id: 'rr-1' })).resolves.toEqual({ sent: true });

    expect(mocks.findMany).toHaveBeenCalledWith({ id: 'rr-1' });
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const email = sent();
    expect(email.to).toBe('ada@school.edu');
    expect(email.template.id).toBe('notification');
    const v = email.template.variables;
    expect(v.SUBJECT).toBe('[Classmoji] CS 52 - Regrade request resolved');
    expect(v.MESSAGE_TEXT).toContain('Week 3 quiz (attempt 2) in CS 52');
    expect(v.MESSAGE_TEXT).toContain('Score adjusted 👎 → 🚀');
    expect(v.MESSAGE_TEXT).toContain('Fair <point>, adjusted.');
    // The HTML carries the reply escaped, never as markup.
    expect(v.MESSAGE_HTML).toContain('Fair &lt;point&gt;, adjusted.');
    expect(v.MESSAGE_HTML).not.toContain('<point>');
    // No percentage anywhere.
    expect(JSON.stringify(v)).not.toMatch(/\d+(\.\d+)?\s?%/);
  });

  it('says "Score kept" for a denied request', async () => {
    mocks.findMany.mockResolvedValue([
      quizRequest({
        status: 'DENIED',
        grader_comment: 'The rubric holds.',
        quiz_attempt: { ...quizRequest().quiz_attempt, adjusted_emoji: null },
      }),
    ]);

    await quizTask.run({ request_id: 'rr-1' });

    expect(sent().template.variables.MESSAGE_TEXT).toContain('Score kept 👎');
    expect(sent().template.variables.MESSAGE_TEXT).not.toContain('Score adjusted');
  });

  it('sends nothing for a repo request, an open one, or a student with no email', async () => {
    for (const request of [
      quizRequest({ quiz_attempt_id: null, quiz_attempt: null }),
      quizRequest({ status: 'IN_REVIEW' }),
      quizRequest({ student: { id: 'stu-1', name: 'Ada', email: null } }),
    ]) {
      mocks.findMany.mockResolvedValue([request]);
      await expect(quizTask.run({ request_id: 'rr-1' })).resolves.toEqual({ sent: false });
    }
    mocks.findMany.mockResolvedValue([]);
    await expect(quizTask.run({ request_id: 'rr-gone' })).resolves.toEqual({ sent: false });
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('renders a score-N badge as its number, never as a percentage', () => {
    const template = renderQuizRegradeResolvedEmail({
      classroomName: null,
      studentName: null,
      quizName: 'Quiz 1',
      attemptNumber: null,
      status: 'APPROVED',
      previousEmoji: 'score-60',
      currentEmoji: 'score-90',
      reply: null,
    });
    expect(template.variables.MESSAGE_TEXT).toBe(
      'Your regrade request for Quiz 1 in your classroom has been reviewed.\n\nScore adjusted 60 → 90'
    );
    expect(template.variables.SUBJECT).toBe('[Classmoji] - Regrade request resolved');
  });
});

describe('update_regrade_request', () => {
  it('refuses a quiz request, writing nothing', async () => {
    mocks.findMany.mockResolvedValue([quizRequest({ status: 'IN_REVIEW' })]);
    await expect(
      updateTask.run({
        request: { id: 'rr-1', student: { email: 'ada@school.edu' } },
        data: { status: 'APPROVED' },
      })
    ).rejects.toThrow(/does not resolve quiz regrade requests/);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('still resolves a repo request', async () => {
    mocks.findMany.mockResolvedValue([quizRequest({ quiz_attempt_id: null, quiz_attempt: null })]);
    mocks.update.mockResolvedValue({ id: 'rr-1', status: 'DENIED' });
    await updateTask.run({
      request: { id: 'rr-1', student: { email: 'ada@school.edu' } },
      data: { status: 'DENIED', grader_comment: 'See the rubric.' },
    });
    expect(mocks.update).toHaveBeenCalledWith({
      id: 'rr-1',
      data: { status: 'DENIED', grader_comment: 'See the rubric.' },
    });
  });

  it('emails a repo resolution even without a submission title', async () => {
    await updateTask.onSuccess({
      payload: { request: { id: 'rr-1', student: { email: 'ada@school.edu' } }, data: {} },
    });
    expect(sent().template.id).toBe('regrade-resolved');
    expect(sent().template.variables.ASSIGNMENT_TITLE).toBe('your assignment');
  });
});
