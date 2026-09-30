// @vitest-environment jsdom
/**
 * The opening turn of a new attempt renders live, under React's StrictMode
 * (the webapp's client entry), with the real useChat and useChatActions.
 *
 * StrictMode mounts every effect twice in development: mount, simulated
 * unmount, mount. useChat stops its chat on unmount, which aborts whatever
 * request is in flight. A `begin` sent straight from the first mount effect
 * was aborted that way: the server still ran the turn, but nothing streamed
 * into the drawer until a reload. The transport here behaves as Trigger's
 * does on abort (the stream ends without the reply).
 */

import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import type { QuizUIMessage } from '@classmoji/utils/quiz-agent';

vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate: vi.fn() }) }));
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({
  default: ({ sendButtonTestId }: { sendButtonTestId?: string }) => (
    <button data-testid={sendButtonTestId}>Send</button>
  ),
}));
const snapshot = () => ({ totalMs: 0, unfocusedMs: 0 });
vi.mock('~/components/features/quiz/useQuizFocusMetrics', () => ({
  useQuizFocusMetrics: () => ({ getMetricsSnapshot: snapshot, finalizeCurrentSession: snapshot }),
}));

type SendOptions = { body?: { action?: unknown }; abortSignal?: AbortSignal };
const sends: SendOptions[] = [];

/** The opening reply, one chunk per tick; ends early (no reply) once aborted. */
const OPENING: UIMessageChunk[] = [
  { type: 'start', messageId: 'reply-1' },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: 'Question one: why flexbox?' },
  { type: 'text-end', id: 't1' },
  { type: 'finish' },
];

const fakeTransport = {
  sendMessages: async (options: SendOptions) => {
    sends.push(options);
    // The real transport fetches a session token and appends the action
    // before it subscribes: the action reaches the server either way.
    await new Promise(resolve => setTimeout(resolve, 20));
    const signal = options.abortSignal;
    return new ReadableStream<UIMessageChunk>({
      async start(controller) {
        for (const chunk of OPENING) {
          if (signal?.aborted) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
          await new Promise(resolve => setTimeout(resolve, 1));
        }
        controller.close();
      },
    });
  },
  reconnectToStream: async () => null,
  sessionStatus: () => 'open',
};

vi.mock('@trigger.dev/sdk/chat/react', async () => {
  const actual = await vi.importActual<typeof import('@trigger.dev/sdk/chat/react')>(
    '@trigger.dev/sdk/chat/react'
  );
  return { ...actual, useTriggerChatTransport: () => fakeTransport };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

const { default: QuizChat } = await import('../QuizChat');

const ATTEMPT = { id: 'attempt-begin', completed_at: null, evaluation_json: null };
const QUIZ = { id: 'quiz-1', question_count: 8 };

let container: HTMLDivElement;
let root: Root;

const settle = async (ms: number) => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, ms));
  });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  sends.length = 0;
  window.sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }))
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('QuizChat begin under StrictMode', () => {
  it('streams the opening reply into the drawer, sending begin once', async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <QuizChat
            quiz={QUIZ}
            attempt={ATTEMPT}
            transcript={[] as QuizUIMessage[]}
            viewerOwnsAttempt
          />
        </StrictMode>
      );
    });
    await settle(120);

    expect(sends).toHaveLength(1);
    expect(sends[0].body).toEqual({ action: { type: 'begin' } });
    expect(sends[0].abortSignal?.aborted).toBe(false);
    expect(container.textContent).toContain('Question one: why flexbox?');
    expect(
      container.querySelector('[data-testid="quiz-chat"]')?.getAttribute('data-quiz-status')
    ).toBe('ready');
  });

  it('shows the typing indicator from the moment begin is sent', async () => {
    await act(async () => {
      root.render(
        <StrictMode>
          <QuizChat
            quiz={QUIZ}
            attempt={ATTEMPT}
            transcript={[] as QuizUIMessage[]}
            viewerOwnsAttempt
          />
        </StrictMode>
      );
    });
    // The send happens a microtask after the mount; its status render with it.
    await act(async () => {});

    // Still waiting on the session (the transport has not answered yet).
    expect(sends).toHaveLength(1);
    expect(container.querySelector('[data-testid="quiz-typing"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="quiz-chat"]')?.getAttribute('data-quiz-status')
    ).toBe('streaming');
    await settle(120);
  });
});
