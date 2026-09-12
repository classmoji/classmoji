import { useMatches } from 'react-router';
import type { SurveyQuestion } from '@classmoji/utils';

/**
 * Whether any matched route's loader is currently holding unanswered survey
 * questions (exposed as `surveyQuestions` in its data). Read off route data
 * rather than the store so it is right on the very first render — the
 * onboarding tour uses it to hold off auto-starting until the prompt is done.
 */
export const useSurveyPending = (): boolean =>
  useMatches().some(m => {
    const questions = (m.data as { surveyQuestions?: SurveyQuestion[] } | undefined)
      ?.surveyQuestions;
    return Array.isArray(questions) && questions.length > 0;
  });
