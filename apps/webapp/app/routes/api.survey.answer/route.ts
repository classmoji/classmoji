/**
 * Record the current user's answer to one survey question.
 *
 * POST /api/survey/answer   { question_key, answer, detail? }
 *
 * `answer` is an option value from the question's catalog entry, or "skipped"
 * when the user dismissed the prompt. Either way a row is written, which is
 * what stops the prompt from coming back on the next login. The role context
 * stored with the answer is derived server-side from memberships.
 *
 * Auth: any signed-in user — scoped to their own row only.
 */

import { requireAuth } from '@classmoji/auth/server';
import { recordSurveyAnswer, SurveyValidationError } from '@classmoji/services';
import type { Route } from './+types/route';

interface AnswerBody {
  question_key?: unknown;
  answer?: unknown;
  detail?: unknown;
}

export const action = async ({ request }: Route.ActionArgs) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const { userId } = await requireAuth(request);

  let body: AnswerBody;
  try {
    body = (await request.json()) as AnswerBody;
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { question_key, answer, detail } = body;
  if (typeof question_key !== 'string' || typeof answer !== 'string') {
    return Response.json({ error: 'question_key and answer are required' }, { status: 400 });
  }
  if (detail != null && typeof detail !== 'string') {
    return Response.json({ error: 'detail must be a string' }, { status: 400 });
  }

  try {
    await recordSurveyAnswer({ userId, questionKey: question_key, answer, detail });
  } catch (error) {
    if (error instanceof SurveyValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  return Response.json({ ok: true });
};
