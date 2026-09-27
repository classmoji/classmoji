/**
 * repositoryImport.cloneQuiz — the quiz settings a clone carries into the
 * target classroom. Prisma is replaced by the transaction client the function
 * takes as its last argument.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

const { cloneQuiz } = await import('../repositoryImport.service.ts');

const SOURCE = {
  id: 'quiz-src',
  classroom_id: 'classroom-src',
  repository_id: 'repo-src',
  name: 'Week 3 check-in',
  system_prompt: 'sys',
  rubric_prompt: 'rubric',
  weight: 10,
  question_count: 5,
  difficulty_level: 'medium',
  subject: 'recursion',
  include_code_context: true,
  course_search_enabled: true,
  grading_strategy: 'HIGHEST',
  max_attempts: 2,
  status: 'PUBLISHED',
  due_date: new Date('2026-10-01T00:00:00Z'),
};

const makeTx = () => ({
  quiz: {
    findUnique: vi.fn(async () => SOURCE),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'quiz-new',
      ...data,
    })),
  },
});

describe('cloneQuiz', () => {
  it('carries course search into the clone', async () => {
    const tx = makeTx();
    await cloneQuiz('quiz-src', 'classroom-dst', 'repo-dst', {}, tx as never);

    expect(tx.quiz.create.mock.calls[0][0].data).toMatchObject({
      classroom_id: 'classroom-dst',
      repository_id: 'repo-dst',
      include_code_context: true,
      course_search_enabled: true,
      // Defaults: a clone starts as a draft with no deadline.
      status: 'DRAFT',
      due_date: null,
    });
  });

  it('keeps course search off when the source has it off', async () => {
    const tx = makeTx();
    tx.quiz.findUnique.mockResolvedValue({ ...SOURCE, course_search_enabled: false });

    await cloneQuiz('quiz-src', 'classroom-dst', null, {}, tx as never);

    expect(tx.quiz.create.mock.calls[0][0].data.course_search_enabled).toBe(false);
  });
});
