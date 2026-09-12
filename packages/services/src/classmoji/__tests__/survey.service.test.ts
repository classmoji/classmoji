/**
 * Unit tests for survey.service — the one-off product questions asked on
 * the classroom picker. Prisma is mocked; the tests pin the role signal that
 * `context` records, the audience filter, the catalog validation on write,
 * and that a skip is stored like any other answer (so the prompt stays gone).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const membershipFindMany = vi.fn();
const responseFindMany = vi.fn();
const responseUpsert = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroomMembership: { findMany: (...a: unknown[]) => membershipFindMany(...a) },
    surveyResponse: {
      findMany: (...a: unknown[]) => responseFindMany(...a),
      upsert: (...a: unknown[]) => responseUpsert(...a),
    },
  }),
}));

const survey = await import('../survey.service.ts');

beforeEach(() => {
  membershipFindMany.mockReset();
  responseFindMany.mockReset();
  responseUpsert.mockReset();
  responseUpsert.mockImplementation(async (args: { create: unknown }) => args.create);
});

describe('deriveSurveyContext', () => {
  it('excludes the example classroom everyone owns', async () => {
    membershipFindMany.mockResolvedValue([]);
    await survey.deriveSurveyContext('u1');
    expect(membershipFindMany.mock.calls[0][0].where).toEqual({
      user_id: 'u1',
      classroom: { is_example: false },
    });
  });

  it('is unknown with no real memberships', async () => {
    membershipFindMany.mockResolvedValue([]);
    expect(await survey.deriveSurveyContext('u1')).toBe('unknown');
  });

  it('is student when every membership is a student one', async () => {
    membershipFindMany.mockResolvedValue([{ role: 'STUDENT' }, { role: 'STUDENT' }]);
    expect(await survey.deriveSurveyContext('u1')).toBe('student');
  });

  it('lets any staff role win over a student enrollment', async () => {
    membershipFindMany.mockResolvedValue([{ role: 'STUDENT' }, { role: 'ASSISTANT' }]);
    expect(await survey.deriveSurveyContext('u1')).toBe('instructor');
  });
});

describe('pendingQuestions', () => {
  it('returns the catalog question when nothing is answered', async () => {
    responseFindMany.mockResolvedValue([]);
    const pending = await survey.pendingQuestions('u1');
    expect(pending.map(q => q.key)).toEqual(['referral_source']);
  });

  it('treats a skip as answered', async () => {
    responseFindMany.mockResolvedValue([{ question_key: 'referral_source' }]);
    expect(await survey.pendingQuestions('u1')).toEqual([]);
  });

  it('shuffles options per user, keeps the catch-all last, and is stable for a user', async () => {
    responseFindMany.mockResolvedValue([]);
    const [a1] = await survey.pendingQuestions('user-a');
    const [a2] = await survey.pendingQuestions('user-a');
    const [b] = await survey.pendingQuestions('user-b');

    const values = (q: { options: { value: string }[] }) => q.options.map(o => o.value);
    expect(values(a1)).toEqual(values(a2));
    expect(values(a1)).not.toEqual(values(b));
    expect(values(a1).at(-1)).toBe('other');
    expect(values(b).at(-1)).toBe('other');
    expect([...values(a1)].sort()).toEqual([...values(b)].sort());
  });

  it('does not look up memberships when no open question targets a role', async () => {
    responseFindMany.mockResolvedValue([]);
    await survey.pendingQuestions('u1');
    expect(membershipFindMany).not.toHaveBeenCalled();
  });
});

describe('recordAnswer', () => {
  it('rejects a question that is not in the catalog', async () => {
    await expect(
      survey.recordAnswer({ userId: 'u1', questionKey: 'nope', answer: 'x' })
    ).rejects.toBeInstanceOf(survey.SurveyValidationError);
    expect(responseUpsert).not.toHaveBeenCalled();
  });

  it('rejects an answer the question did not offer', async () => {
    await expect(
      survey.recordAnswer({ userId: 'u1', questionKey: 'referral_source', answer: 'tiktok' })
    ).rejects.toBeInstanceOf(survey.SurveyValidationError);
    expect(responseUpsert).not.toHaveBeenCalled();
  });

  it('stores a valid answer with the derived context, keyed per user and question', async () => {
    membershipFindMany.mockResolvedValue([{ role: 'OWNER' }]);
    await survey.recordAnswer({ userId: 'u1', questionKey: 'referral_source', answer: 'github' });

    const args = responseUpsert.mock.calls[0][0];
    expect(args.where).toEqual({
      user_id_question_key: { user_id: 'u1', question_key: 'referral_source' },
    });
    expect(args.create).toEqual({
      user_id: 'u1',
      question_key: 'referral_source',
      answer: 'github',
      detail: null,
      context: 'instructor',
    });
    expect(args.update).toEqual({ answer: 'github', detail: null, context: 'instructor' });
  });

  it('keeps detail only for an option that asks for it', async () => {
    membershipFindMany.mockResolvedValue([]);
    await survey.recordAnswer({
      userId: 'u1',
      questionKey: 'referral_source',
      answer: 'conference',
      detail: '  SIGCSE  ',
    });
    expect(responseUpsert.mock.calls[0][0].create.detail).toBe('SIGCSE');

    await survey.recordAnswer({
      userId: 'u1',
      questionKey: 'referral_source',
      answer: 'social',
      detail: 'Reddit',
    });
    expect(responseUpsert.mock.calls[1][0].create.detail).toBe('Reddit');

    await survey.recordAnswer({
      userId: 'u1',
      questionKey: 'referral_source',
      answer: 'search',
      detail: 'should be dropped',
    });
    expect(responseUpsert.mock.calls[2][0].create.detail).toBeNull();
  });

  it('records a skip as a row so the prompt does not return', async () => {
    membershipFindMany.mockResolvedValue([{ role: 'STUDENT' }]);
    await survey.recordAnswer({
      userId: 'u1',
      questionKey: 'referral_source',
      answer: 'skipped',
      detail: 'ignored',
    });
    expect(responseUpsert.mock.calls[0][0].create).toMatchObject({
      answer: 'skipped',
      detail: null,
      context: 'student',
    });
  });
});
