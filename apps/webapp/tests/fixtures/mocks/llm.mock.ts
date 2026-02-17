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

  // Track message count for quiz progression
  let messageCount = 0;

  // Mock the main quiz API endpoint
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

    // Add artificial delay
    if (delay > 0) {
      await new Promise((r) => setTimeout(r, delay));
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
 * Mock prompt assistant endpoint
 */
export async function mockPromptAssistant(page: Page): Promise<void> {
  await page.route('**/api/quiz.prompt-assistant', async (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        suggestions: [
          'Try breaking down your explanation into smaller parts.',
          'Consider providing a specific example from the material.',
          'Think about how this concept connects to others we discussed.',
        ],
      }),
    });
  });
}

/**
 * Mock syllabus bot endpoint
 */
export async function mockSyllabusBot(page: Page): Promise<void> {
  await page.route('**/api/syllabus-bot.*', async (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        response:
          "Based on the syllabus, here's what I found: The course covers fundamental programming concepts including variables, functions, and data structures.",
      }),
    });
  });
}

/**
 * Clear all LLM-related mocks
 */
export async function clearLLMMocks(page: Page): Promise<void> {
  await page.unroute('**/api/quiz');
  await page.unroute('**/api/quiz.prompt-assistant');
  await page.unroute('**/api/syllabus-bot.*');
}
