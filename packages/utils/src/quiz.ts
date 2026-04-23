/**
 * Quiz-related utility functions shared across the application
 */

export interface QuestionProgress {
  questionNumber: number;
  totalQuestions: number | null;
}

export interface QuizEvaluation {
  quiz_complete: boolean;
  [key: string]: unknown;
}

export interface QuestionComplete {
  question_num: number;
  emoji: string;
  brief_feedback?: string;
  [key: string]: unknown;
}

const QUESTION_HEADER_REGEX = /Question\s+(\d+)\s+of\s+(\d+)/gi;
const QUESTION_JSON_REGEX = /"question_number"\s*:\s*(\d+)[\s\S]*?"total_questions"\s*:\s*(\d+)/g;

/**
 * Extracts question progress metadata from an assistant message.
 * Supports both text format ("Question X of Y") and JSON format from present_question tool.
 */
export const getQuestionProgressFromMessage = (messageContent: string): QuestionProgress | null => {
  if (!messageContent || typeof messageContent !== 'string') {
    return null;
  }

  let match;
  let lastMatch: QuestionProgress | null = null;

  while ((match = QUESTION_HEADER_REGEX.exec(messageContent)) !== null) {
    const questionNumber = Number.parseInt(match[1], 10);
    const totalQuestions = Number.parseInt(match[2], 10);

    if (!Number.isFinite(questionNumber) || questionNumber <= 0) {
      continue;
    }

    lastMatch = {
      questionNumber,
      totalQuestions: Number.isFinite(totalQuestions) ? totalQuestions : null,
    };
  }

  while ((match = QUESTION_JSON_REGEX.exec(messageContent)) !== null) {
    const questionNumber = Number.parseInt(match[1], 10);
    const totalQuestions = Number.parseInt(match[2], 10);

    if (!Number.isFinite(questionNumber) || questionNumber <= 0) {
      continue;
    }

    if (!lastMatch || questionNumber > lastMatch.questionNumber) {
      lastMatch = {
        questionNumber,
        totalQuestions: Number.isFinite(totalQuestions) ? totalQuestions : null,
      };
    }
  }

  return lastMatch;
};

/**
 * Detects and parses quiz completion from [QUIZ_EVALUATION] marker.
 * Handles both code-block wrapped JSON (from tool) and raw JSON (model direct).
 */
export const checkForCompletion = (messageContent: string): QuizEvaluation | null => {
  if (!messageContent || typeof messageContent !== 'string') {
    return null;
  }

  if (!messageContent.includes('[QUIZ_EVALUATION]')) {
    return null;
  }

  let evalMatch = messageContent.match(/\[QUIZ_EVALUATION\]\s*```(?:json)?\s*([\s\S]*?)```/);

  if (!evalMatch) {
    evalMatch = messageContent.match(/\[QUIZ_EVALUATION\]\s*(\{[\s\S]*?\})\s*(?:\n\n|$)/);
  }

  if (!evalMatch) {
    console.warn('[checkForCompletion] Found marker but could not extract JSON');
    return null;
  }

  try {
    const evaluation = JSON.parse(evalMatch[1].trim());
    if (evaluation.quiz_complete === true) {
      return evaluation;
    }
    console.warn('[checkForCompletion] Parsed JSON but quiz_complete is not true');
    return null;
  } catch (parseError) {
    console.error('[checkForCompletion] Failed to parse JSON:', (parseError as Error).message);
    return null;
  }
};

/**
 * Detects and parses question completion from [QUESTION_COMPLETE] marker.
 * Used for progressive grading - called after each question is answered.
 */
export const parseQuestionComplete = (messageContent: string): QuestionComplete | null => {
  if (!messageContent || typeof messageContent !== 'string') {
    return null;
  }

  if (!messageContent.includes('[QUESTION_COMPLETE]')) {
    return null;
  }

  let match = messageContent.match(/\[QUESTION_COMPLETE\]\s*```(?:json)?\s*([\s\S]*?)```/);

  if (!match) {
    match = messageContent.match(/\[QUESTION_COMPLETE\]\s*(\{[\s\S]*?\})\s*(?:\n\n|$)/);
  }

  if (!match) {
    console.warn('[parseQuestionComplete] Found marker but could not extract JSON');
    return null;
  }

  try {
    const result = JSON.parse(match[1].trim());
    if (typeof result.question_num !== 'number' || !result.emoji) {
      console.warn('[parseQuestionComplete] Parsed JSON but missing required fields');
      return null;
    }
    return result;
  } catch (parseError) {
    console.error('[parseQuestionComplete] Failed to parse JSON:', (parseError as Error).message);
    return null;
  }
};
