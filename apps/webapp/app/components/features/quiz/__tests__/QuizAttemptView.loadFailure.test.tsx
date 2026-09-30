// @vitest-environment jsdom
/**
 * A chat attempt whose QuizChat module cannot be loaded (a chunk gone after a
 * release, a dropped connection) shows a short line with a Reload button in
 * the drawer, not the route's error page. A legacy attempt never loads the
 * module and is unaffected.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../QuizAttemptInterface', () => ({
  default: () => <div data-testid="legacy" />,
}));
vi.mock('../QuizChat', () => {
  throw new Error('Failed to fetch dynamically imported module');
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

const { default: QuizAttemptView } = await import('../QuizAttemptView');

const BASE = {
  quiz: { id: 'quiz-1', name: 'Quiz', question_count: 8 },
  messages: [],
  userLogin: 'ada',
  userImage: null,
  readOnly: false,
  showTimestamps: false,
  focusMetrics: null,
  isAdmin: false,
  transcript: null,
  viewerOwnsAttempt: true,
};

let container: HTMLDivElement;
let root: Root;
const reloadMock = vi.fn();

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  reloadMock.mockReset();
  // React reports an error its boundary caught.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Render, then let the lazy import settle. */
const render = async (attempt: Record<string, unknown>) => {
  await act(async () => {
    root.render(<QuizAttemptView {...BASE} attempt={attempt} />);
  });
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

describe('QuizAttemptView when the chat cannot be loaded', () => {
  it('shows a short line and a Reload button in place of the chat', async () => {
    await render({ id: 'attempt-1', agent_runtime: 'trigger_chat', completed_at: null });

    const failed = container.querySelector('[data-testid="quiz-chat-load-failed"]');
    expect(failed).not.toBeNull();
    expect(failed!.textContent).toContain("This quiz couldn't load.");
    expect(container.querySelector('[data-testid="quiz-chat-loading"]')).toBeNull();

    vi.stubGlobal('location', { ...window.location, reload: reloadMock });
    const reload = Array.from(failed!.querySelectorAll('button')).find(b =>
      b.textContent?.includes('Reload')
    );
    expect(reload).toBeDefined();
    await act(async () => reload!.click());
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a legacy attempt as it was', async () => {
    await render({ id: 'attempt-1', agent_runtime: 'ai_agent', completed_at: null });

    expect(container.querySelector('[data-testid="legacy"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="quiz-chat-load-failed"]')).toBeNull();
  });
});
