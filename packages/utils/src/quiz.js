/**
 * Quiz-related utility functions shared across the application
 */

/**
 * Detects and parses quiz completion JSON from message content.
 * Looks for JSON containing "quiz_complete": true in markdown code blocks or raw JSON.
 *
 * @param {string} messageContent - The message content to check
 * @returns {Object|null} - The parsed quiz completion object if found, null otherwise
 */
const QUESTION_HEADER_REGEX = /Question\s+(\d+)\s+of\s+(\d+)/gi;
const QUESTION_JSON_REGEX = /"question_number"\s*:\s*(\d+)[\s\S]*?"total_questions"\s*:\s*(\d+)/g;

/**
 * Extracts question progress metadata from an assistant message.
 * Supports both text format ("Question X of Y") and JSON format from present_question tool.
 *
 * @param {string} messageContent - Assistant message content
 * @returns {{ questionNumber: number, totalQuestions: number | null } | null}
 */
export const getQuestionProgressFromMessage = messageContent => {
  if (!messageContent || typeof messageContent !== 'string') {
    return null;
  }

  let match;
  let lastMatch = null;

  // Try text format: "Question X of Y"
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

  // Also try JSON format from present_question tool
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
 * Consistent with [QUESTION_CARD] pattern for question presentation.
 * Handles both code-block wrapped JSON (from tool) and raw JSON (model direct).
 *
 * @param {string} messageContent - The message content to check
 * @returns {Object|null} - The parsed quiz evaluation object if found, null otherwise
 */
export const checkForCompletion = messageContent => {
  if (!messageContent || typeof messageContent !== 'string') {
    return null;
  }

  if (!messageContent.includes('[QUIZ_EVALUATION]')) {
    return null;
  }

  // Try format 1: JSON wrapped in code block (from tool)
  let evalMatch = messageContent.match(/\[QUIZ_EVALUATION\]\s*```(?:json)?\s*([\s\S]*?)```/);

  // Fallback format 2: Raw JSON without code block (model wrote directly)
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
    console.error('[checkForCompletion] Failed to parse JSON:', parseError.message);
    return null;
  }
};

/**
 * Detects and parses question completion from [QUESTION_COMPLETE] marker.
 * Used for progressive grading - called after each question is answered.
 *
 * Returns: { question_num, emoji, brief_feedback }
 * Note: credit_earned and attempts are stored in DB but not returned to frontend.
 *
 * @param {string} messageContent - The message content to check
 * @returns {Object|null} - The parsed question complete object if found, null otherwise
 */
export const parseQuestionComplete = messageContent => {
  if (!messageContent || typeof messageContent !== 'string') {
    return null;
  }

  if (!messageContent.includes('[QUESTION_COMPLETE]')) {
    return null;
  }

  // Try format 1: JSON wrapped in code block (from tool)
  let match = messageContent.match(/\[QUESTION_COMPLETE\]\s*```(?:json)?\s*([\s\S]*?)```/);

  // Fallback format 2: Raw JSON without code block
  if (!match) {
    match = messageContent.match(/\[QUESTION_COMPLETE\]\s*(\{[\s\S]*?\})\s*(?:\n\n|$)/);
  }

  if (!match) {
    console.warn('[parseQuestionComplete] Found marker but could not extract JSON');
    return null;
  }

  try {
    const result = JSON.parse(match[1].trim());
    // Validate expected fields
    if (typeof result.question_num !== 'number' || !result.emoji) {
      console.warn('[parseQuestionComplete] Parsed JSON but missing required fields');
      return null;
    }
    return result;
  } catch (parseError) {
    console.error('[parseQuestionComplete] Failed to parse JSON:', parseError.message);
    return null;
  }
};
