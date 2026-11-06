// @vitest-environment jsdom
/**
 * An attempt from the retired ai-agent runtime (`agent_runtime: 'ai_agent'`,
 * or no stamp at all), MOUNTED through QuizAttemptView as the drawers mount
 * it: read-only whether it was completed or not, and whatever `readOnly` the
 * drawer passes (an unfinished attempt's loader sends `readOnly: false`).
 *
 * Read-only means: the saved transcript only, no message box, no buttons that
 * send, and no request of any kind (no start, no message, no completion, no
 * time tracking, no polling), on mount, over time, on leaving the tab or on
 * unmount. An unfinished attempt says it can no longer be continued; a
 * completed one shows its evaluation card.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../QuizChat', () => {
  throw new Error('a legacy attempt never loads the chat');
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// antd reads media queries; jsdom has none.
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;
Element.prototype.scrollIntoView ??= () => {};

const { default: QuizAttemptView } = await import('../QuizAttemptView');
const { LEGACY_ATTEMPT_CLOSED_LINE } = await import('../LegacyQuizTranscript');

const EVALUATION =
  'Well done.\n\n[QUIZ_EVALUATION]\n```json\n' +
  '{"quiz_complete": true, "evaluation": "GOOD", "numeric_score": 3, "final_acknowledgment": "Thanks!"}\n```';

const MESSAGES = [
  { id: 1, role: 'assistant', content: 'Question 1 of 2: What does `<nav>` mark up?' },
  { id: 2, role: 'user', content: 'Navigation links' },
  { id: 3, role: 'system', content: 'Reading src/App.jsx', metadata: { isExplorationStep: true } },
  { id: 4, role: 'assistant', content: 'Not quite.\n\n[BUTTON:TRY_AGAIN] [BUTTON:NEXT]' },
];

const BASE = {
  quiz: { id: 'quiz-1', name: 'Quiz', question_count: 2 },
  userLogin: 'ada',
  userImage: null,
  showTimestamps: false,
  focusMetrics: null,
  isAdmin: false,
  transcript: null,
  viewerOwnsAttempt: true,
  isVisible: true,
};

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
let beaconMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetchMock);
  beaconMock = vi.fn(() => true);
  Object.defineProperty(navigator, 'sendBeacon', { value: beaconMock, configurable: true });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mount = async (attempt: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  await act(async () => {
    root.render(<QuizAttemptView {...BASE} {...extra} attempt={attempt} messages={MESSAGES} />);
  });
};

/** Everything that used to send something: time passing, hiding the tab, leaving, closing. */
const liveAWhileThenLeave = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('beforeunload'));
  });
  await act(async () => {
    root.render(
      <QuizAttemptView
        {...BASE}
        isVisible={false}
        attempt={{ id: 'a', agent_runtime: 'ai_agent' }}
        messages={MESSAGES}
      />
    );
  });
  act(() => root.unmount());
  root = createRoot(container);
};

const expectNoWayToSend = () => {
  expect(container.querySelector('[data-testid="legacy-quiz-transcript"]')).not.toBeNull();
  expect(container.querySelector('textarea, input, [contenteditable="true"]')).toBeNull();
  expect(container.querySelector('button')).toBeNull();
  expect(container.textContent).not.toContain('Try Again');
  expect(container.textContent).not.toContain('Next →');
  expect(container.textContent).not.toContain('[BUTTON:');
  expect(container.querySelector('[data-testid="quiz-chat-loading"]')).toBeNull();
};

describe('an unfinished ai_agent attempt', () => {
  const attempt = { id: 'a', agent_runtime: 'ai_agent', completed_at: null };

  it('shows its transcript read-only, with the closed line, even when the drawer says readOnly: false', async () => {
    await mount(attempt, { readOnly: false });

    expectNoWayToSend();
    expect(container.textContent).toContain('Question 1 of 2');
    expect(container.textContent).toContain('Navigation links');
    expect(container.textContent).toContain('Not quite.');
    // The exploration step row is not a message.
    expect(container.textContent).not.toContain('Reading src/App.jsx');
    expect(container.querySelector('[data-testid="legacy-quiz-closed"]')?.textContent).toBe(
      LEGACY_ATTEMPT_CLOSED_LINE
    );
    expect(container.textContent).not.toContain('Quiz Complete!');
  });

  it('sends nothing: no start, no message, no time, no polling', async () => {
    await mount(attempt, { readOnly: false });
    await liveAWhileThenLeave();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(beaconMock).not.toHaveBeenCalled();
  });

  it('is the same for a row with no stamp (the column default)', async () => {
    await mount({ id: 'a', completed_at: null }, { readOnly: false });

    expectNoWayToSend();
    expect(container.querySelector('[data-testid="legacy-quiz-closed"]')).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a completed ai_agent attempt', () => {
  const attempt = {
    id: 'a',
    agent_runtime: 'ai_agent',
    completed_at: '2026-09-20T12:00:00.000Z',
    question_results: [],
  };
  const messages = [...MESSAGES, { id: 5, role: 'assistant', content: EVALUATION }];

  it('shows its transcript and evaluation card, read-only, with no closed line', async () => {
    await act(async () => {
      root.render(<QuizAttemptView {...BASE} readOnly attempt={attempt} messages={messages} />);
    });

    expectNoWayToSend();
    expect(container.textContent).toContain('Quiz Complete!');
    expect(container.querySelector('[data-testid="legacy-quiz-closed"]')).toBeNull();
  });

  it('sends nothing', async () => {
    await act(async () => {
      root.render(<QuizAttemptView {...BASE} readOnly attempt={attempt} messages={messages} />);
    });
    await liveAWhileThenLeave();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(beaconMock).not.toHaveBeenCalled();
  });
});
