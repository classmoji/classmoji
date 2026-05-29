import { Page, Route } from '@playwright/test';

export interface LLMMockOptions {
  /** Custom responses for specific question numbers */
  responses?: Record<string, string>;
  /** Artificial delay to simulate real API (ms) */
  delay?: number;
  /** Simulate API failure */
  shouldFail?: boolean;
  /** Number of questions in the quiz */
  questionCount?: number;
  /** Final score to return */
  finalScore?: number;
}

/**
 * Mock the quiz API responses
 *
 * The webapp calls /api/quiz for quiz actions.
 * Quiz updates are loaded from DB via revalidation (no SSE).
 */
export async function mockQuizAPI(page: Page, options: LLMMockOptions = {}): Promise<void> {
  const {
    responses = {},
    delay = 100,
    shouldFail = false,
    questionCount = 5,
    finalScore = 85,
  } = options;

  let messageCount = 0;

  await page.route('**/api/quiz', async (route: Route) => {
    const request = route.request();
    const postData = request.postDataJSON?.() || {};

    if (shouldFail) {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'LLM service unavailable' }),
      });
    }

    if (delay > 0) {
      await new Promise(r => setTimeout(r, delay));
    }

    const action = postData?._action;

    switch (action) {
      case 'startQuiz':
        messageCount = 0;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            attemptId: `test-attempt-${Date.now()}`,
            success: true,
          }),
        });

      case 'resumeQuiz':
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            messages: [],
          }),
        });

      case 'sendMessage':
        messageCount++;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });

      case 'completeQuiz':
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            score: finalScore,
          }),
        });

      case 'restartQuiz':
        messageCount = 0;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            attemptId: `test-attempt-${Date.now()}`,
          }),
        });

      default:
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });
    }
  });
}

/**
 * Mock prompt assistant endpoint.
 *
 * The flow is SSE: the POST returns a session id, then the client opens an
 * EventSource on the stream path. Mocks both the initiating POST and the
 * text/event-stream endpoint.
 */
export async function mockPromptAssistant(page: Page): Promise<void> {
  const suggestions = [
    'Try breaking down your explanation into smaller parts.',
    'Consider providing a specific example from the material.',
    'Think about how this concept connects to others we discussed.',
  ];

  // Stream endpoint must be registered first so the more specific path wins.
  await page.route('**/api/quiz/prompt-assistant/stream/**', async route => {
    const sse = suggestions.map(s => `data: ${JSON.stringify({ delta: s })}\n\n`).join('') + 'data: [DONE]\n\n';
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
      body: sse,
    });
  });

  await page.route('**/api/quiz/prompt-assistant', async route => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sessionId: `test-pa-${Date.now()}`, suggestions }),
    });
  });
}

/**
 * Mock syllabus bot endpoint.
 *
 * The hook streams via EventSource on the stream path. Mocks both the
 * initiating request and the text/event-stream endpoint.
 */
export async function mockSyllabusBot(page: Page): Promise<void> {
  const answer =
    "Based on the syllabus, here's what I found: The course covers fundamental programming concepts including variables, functions, and data structures.";

  // Stream endpoint must be registered first so the more specific path wins.
  await page.route('**/api/syllabus-bot/stream/**', async route => {
    const sse = `data: ${JSON.stringify({ delta: answer })}\n\n` + 'data: [DONE]\n\n';
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
      body: sse,
    });
  });

  await page.route('**/api/syllabus-bot/**', async route => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ conversationId: `test-syl-${Date.now()}`, response: answer }),
    });
  });
}

/**
 * Clear all LLM-related mocks
 */
export async function clearLLMMocks(page: Page): Promise<void> {
  await page.unroute('**/api/quiz');
  await page.unroute('**/api/quiz/prompt-assistant/stream/**');
  await page.unroute('**/api/quiz/prompt-assistant');
  await page.unroute('**/api/syllabus-bot/stream/**');
  await page.unroute('**/api/syllabus-bot/**');
}
