import getPrisma from '@classmoji/database';
import {
  SURVEY_QUESTIONS,
  SURVEY_SKIPPED,
  findSurveyOption,
  getSurveyQuestion,
  randomizeSurveyOptions,
  type SurveyQuestion,
} from '@classmoji/utils';

export type SurveyContext = 'instructor' | 'student' | 'unknown';

const DETAIL_MAX = 500;

export class SurveyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SurveyValidationError';
  }
}

/**
 * Role signal for a user, read off their memberships on real classrooms. Any
 * staff membership wins over student: a TA who is also enrolled somewhere found
 * the product the way an instructor did. The example classroom is excluded
 * because everyone who signs in owns one.
 */
export const deriveSurveyContext = async (userId: string): Promise<SurveyContext> => {
  const memberships = await getPrisma().classroomMembership.findMany({
    where: { user_id: userId, classroom: { is_example: false } },
    select: { role: true },
  });
  if (memberships.some(m => m.role !== 'STUDENT')) return 'instructor';
  if (memberships.length > 0) return 'student';
  return 'unknown';
};

/**
 * Questions to put in front of this user now: in the catalog, aimed at their
 * audience, and without a stored answer (a skip counts as an answer, so a
 * dismissed prompt stays dismissed).
 */
export const pendingQuestions = async (userId: string): Promise<SurveyQuestion[]> => {
  if (SURVEY_QUESTIONS.length === 0) return [];

  const answered = await getPrisma().surveyResponse.findMany({
    where: { user_id: userId },
    select: { question_key: true },
  });
  const done = new Set(answered.map(a => a.question_key));
  const open = SURVEY_QUESTIONS.filter(q => !done.has(q.key));
  if (open.length === 0) return [];

  // Only pay for the membership lookup when a question actually targets a role.
  const context = open.some(q => q.audience !== 'all')
    ? await deriveSurveyContext(userId)
    : 'unknown';
  return open
    .filter(q => q.audience === 'all' || context === 'unknown' || q.audience === context)
    .map(q => randomizeSurveyOptions(q, userId));
};

interface RecordAnswerInput {
  userId: string;
  questionKey: string;
  /** An option value from the question, or SURVEY_SKIPPED. */
  answer: string;
  detail?: string | null;
}

/**
 * Store (or overwrite) one answer. The answer is checked against the catalog
 * so the table never holds values the question did not offer; `detail` is only
 * kept for an option that asks for it. `context` is derived here, not taken
 * from the client.
 */
export const recordAnswer = async ({ userId, questionKey, answer, detail }: RecordAnswerInput) => {
  const question = getSurveyQuestion(questionKey);
  if (!question) throw new SurveyValidationError(`Unknown survey question: ${questionKey}`);

  const skipped = answer === SURVEY_SKIPPED;
  const option = skipped ? undefined : findSurveyOption(question, answer);
  if (!skipped && !option) {
    throw new SurveyValidationError(`Unknown answer for ${questionKey}: ${answer}`);
  }

  const trimmed = (detail ?? '').trim();
  const keptDetail = option?.detailPrompt && trimmed ? trimmed.slice(0, DETAIL_MAX) : null;
  const context = await deriveSurveyContext(userId);

  return getPrisma().surveyResponse.upsert({
    where: { user_id_question_key: { user_id: userId, question_key: questionKey } },
    create: {
      user_id: userId,
      question_key: questionKey,
      answer,
      detail: keptDetail,
      context,
    },
    update: { answer, detail: keptDetail, context },
  });
};
