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

// ─── Legacy (ai_agent) chat messages, as the quiz chat renders them ─────────

// Extract a complete JSON object from a string starting at a given position
// Uses bracket counting to handle nested braces properly
export const extractJsonObject = (
  str: string,
  startIndex: number
): { json: string; endIndex: number } | null => {
  if (str[startIndex] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = startIndex; i < str.length; i++) {
    const char = str[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          return {
            json: str.substring(startIndex, i + 1),
            endIndex: i,
          };
        }
      }
    }
  }

  return null; // Unbalanced braces
};

// Parse message content to extract question card data
// Format 1 (from tool): {preamble}\n\n[QUESTION_CARD]\n```json\n{...}\n```
// Format 2 (direct): {preamble}\n\n[QUESTION_CARD]\n{...}
export const parseQuestionCard = (content: string) => {
  if (!content || !content.includes('[QUESTION_CARD]')) {
    return {
      hasQuestionCard: false,
      questionData: null,
      preamble: null,
      remainingContent: content,
    };
  }

  const markerIndex = content.indexOf('[QUESTION_CARD]');
  const afterMarker = content.substring(markerIndex + '[QUESTION_CARD]'.length);

  let jsonString = null;
  let jsonEndIndex = markerIndex; // Will be updated to actual end position

  // Find the first '{' after the marker (could be inside code block or raw)
  const firstBraceInAfterMarker = afterMarker.indexOf('{');

  if (firstBraceInAfterMarker !== -1) {
    const absoluteJsonStart = markerIndex + '[QUESTION_CARD]'.length + firstBraceInAfterMarker;
    const extracted = extractJsonObject(content, absoluteJsonStart);

    if (extracted) {
      jsonString = extracted.json;

      // Check if there's a closing code fence after the JSON
      const afterJson = content.substring(extracted.endIndex + 1);
      const closingFenceMatch = afterJson.match(/^\s*```/);

      if (closingFenceMatch) {
        // Include the closing fence in what we skip
        jsonEndIndex = extracted.endIndex + 1 + closingFenceMatch[0].length;
      } else {
        jsonEndIndex = extracted.endIndex + 1;
      }
    }
  }

  if (!jsonString) {
    return {
      hasQuestionCard: false,
      questionData: null,
      preamble: null,
      remainingContent: content,
    };
  }

  try {
    const questionData = JSON.parse(jsonString);

    // Extract preamble (text before [QUESTION_CARD] marker)
    const preamble = markerIndex > 0 ? content.substring(0, markerIndex).trim() : null;

    // Extract remaining content (text after the JSON block)
    const remainingContent = content.substring(jsonEndIndex).trim();

    return {
      hasQuestionCard: true,
      questionData,
      preamble,
      remainingContent,
    };
  } catch (error: unknown) {
    console.error(
      '[parseQuestionCard] JSON.parse FAILED:',
      error instanceof Error ? error.message : String(error)
    );
    console.error('[parseQuestionCard] JSON string was:', jsonString?.substring(0, 200));
    return {
      hasQuestionCard: false,
      questionData: null,
      preamble: null,
      remainingContent: content,
    };
  }
};

// Parse message content to extract button markers
export const parseMessageButtons = (content: string) => {
  const buttons = [];
  if (content.includes('[BUTTON:TRY_AGAIN]')) buttons.push('TRY_AGAIN');
  if (content.includes('[BUTTON:NEXT]')) buttons.push('NEXT');

  return {
    cleanContent: content.replace(/\[BUTTON:(TRY_AGAIN|NEXT)\]\s*/g, '').trim(),
    buttons,
  };
};

/**
 * What a legacy quiz chat shows of an assistant message that may carry the
 * [QUIZ_EVALUATION] block: the text before the evaluation JSON, else its
 * final_acknowledgment, else a fixed line when it is the last message, else
 * nothing (`shouldHide`). A message with no evaluation shows as it is.
 */
export const completionMessageDisplay = (
  messageContent: string,
  isLastMessage: boolean
): { shouldHide: true; content?: undefined } | { shouldHide: false; content: string } => {
  const completionData = checkForCompletion(messageContent);

  // If no completion data, show the full message
  if (!completionData) {
    return { shouldHide: false, content: messageContent };
  }

  // Message contains completion data - always extract text before JSON
  // Extract text before the JSON code block (agent's natural response)
  const quizCompleteBlockMatch = messageContent.match(/```(?:[a-z]*\n|\n|)([\s\S]*?)```/gi);
  let textBeforeJson = '';

  if (quizCompleteBlockMatch) {
    // Find the block that contains quiz_complete
    for (const block of quizCompleteBlockMatch) {
      if (block.includes('quiz_complete')) {
        const blockStartIndex = messageContent.indexOf(block);
        if (blockStartIndex > 0) {
          textBeforeJson = messageContent.substring(0, blockStartIndex).trim();
        }
        break;
      }
    }
  }

  // If we couldn't find it in code blocks, try to find raw JSON
  if (!textBeforeJson) {
    const jsonStartMatch = messageContent.match(/\{[^{}]*"quiz_complete"/);
    if (jsonStartMatch) {
      const jsonStartIndex = messageContent.indexOf(jsonStartMatch[0]);
      if (jsonStartIndex > 0) {
        textBeforeJson = messageContent.substring(0, jsonStartIndex).trim();
      }
    }
  }

  // Priority 1: Use extracted text before JSON if it exists
  if (textBeforeJson) {
    // Strip the [QUIZ_EVALUATION] marker - it's for parsing, not display
    const cleanedText = textBeforeJson.replace(/\[QUIZ_EVALUATION\]\s*/g, '').trim();
    if (cleanedText) {
      return { shouldHide: false, content: cleanedText };
    }
    // If only the marker was there (no actual text), fall through to other priorities
  }

  // Priority 2: Use final_acknowledgment from completion data
  if (
    typeof completionData.final_acknowledgment === 'string' &&
    completionData.final_acknowledgment
  ) {
    return { shouldHide: false, content: completionData.final_acknowledgment };
  }

  // Priority 3: If this is the last message, show a generic completion message
  if (isLastMessage) {
    return { shouldHide: false, content: 'Quiz completed! See your evaluation below.' };
  }

  // Priority 4: Hide the message entirely (JSON only, no displayable text)
  return { shouldHide: true };
};

/** The [QUESTION_COMPLETE] block removed from a legacy assistant message. */
export const stripQuestionComplete = (messageContent: string): string =>
  messageContent
    .replace(/\[QUESTION_COMPLETE\]\s*```(?:json)?\s*[\s\S]*?```/g, '')
    .replace(/\[QUESTION_COMPLETE\]\s*\{[\s\S]*?\}\s*(?:\n\n|$)/g, '')
    .trim();
