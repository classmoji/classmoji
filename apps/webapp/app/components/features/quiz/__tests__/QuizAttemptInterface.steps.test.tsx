// @vitest-environment jsdom
/**
 * QuizAttemptInterface derives the live exploration steps from the SYSTEM
 * rows the ai-agent saves while it works, which the chat picks up by polling.
 * A course-material step's `title` (the document content_get opened) must
 * survive that derivation, or the chat can only say "Checking course material".
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seenSteps: unknown[][] = [];

vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate: vi.fn() }) }));
vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({ default: () => null }));
vi.mock('~/components/features/quiz/QuizMessageList', () => ({
  default: ({ explorationSteps }: { explorationSteps: unknown[] }) => {
    seenSteps.push(explorationSteps);
    return null;
  },
}));
const snapshot = () => ({ totalMs: 0, unfocusedMs: 0 });
vi.mock('~/components/features/quiz/useQuizFocusMetrics', () => ({
  useQuizFocusMetrics: () => ({ getMetricsSnapshot: snapshot, finalizeCurrentSession: snapshot }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: QuizAttemptInterface } = await import('../QuizAttemptInterface');

const WELCOME = {
  id: 'msg-0',
  role: 'assistant',
  content: 'Welcome!',
  metadata: { isWelcomeMessage: true },
};
const step = (id: string, action: string, metadata: Record<string, unknown>) => ({
  id,
  role: 'system',
  content: action,
  metadata: { isExplorationStep: true, ...metadata },
  timestamp: '2026-09-26T12:00:00.000Z',
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  seenSteps.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('QuizAttemptInterface — polled exploration steps', () => {
  it("carries a course-material step's title through, and adds none to a code step", async () => {
    await act(async () => {
      root.render(
        <QuizAttemptInterface
          quiz={{ id: 'quiz-1', question_count: 5 }}
          attempt={{ id: 'attempt-1' }}
          messages={[
            WELCOME,
            step('s1', 'Checking course material', {
              toolName: 'mcp__classmoji__content_get',
              toolInput: { kind: 'page', id: 'p1' },
              title: 'Semantic HTML',
            }),
            step('s2', 'Reading src/App.jsx', {
              toolName: 'github_read',
              toolInput: { path: 'src/App.jsx' },
            }),
          ]}
          userLogin="ada"
        />
      );
    });

    // Waiting for question 1 after the welcome, so the live steps are shown.
    const steps = seenSteps.at(-1) as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      action: 'Checking course material',
      toolName: 'mcp__classmoji__content_get',
      title: 'Semantic HTML',
    });
    expect(steps[1]).not.toHaveProperty('title');
  });
});
