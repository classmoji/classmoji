// @vitest-environment jsdom
/**
 * The per-attempt message limit in the chat:
 *
 *   - under the latest reply, once 20 or fewer messages are left, a muted line
 *     counts them down to 1, from the server's count only: the loader's (so a
 *     reload shows it) and each reply's `data-messages-left` part;
 *   - the reply to the last message never leaves "0 messages left" under an
 *     open composer: the session closes with that turn (the server submitted
 *     the attempt), and the drawer refreshes into the results;
 *   - an attempt the server submitted at the limit says so above its results,
 *     for the student and for staff reading it, and the refusal's own line is
 *     not repeated above them.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_STUDENT_TURNS,
  MESSAGES_LEFT_NOTICE_AT,
  QUIZ_MESSAGE_LIMIT_COPY,
  QUIZ_REFUSAL_COPY,
  type QuizUIMessage,
} from '@classmoji/utils/quiz-agent';

vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
const revalidateMock = vi.fn();
vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate: revalidateMock }) }));
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({
  default: ({ sendButtonTestId, disabled }: { sendButtonTestId?: string; disabled?: boolean }) => (
    <button data-testid={sendButtonTestId} disabled={disabled}>
      Send
    </button>
  ),
}));
const snapshot = () => ({ totalMs: 0, unfocusedMs: 0 });
vi.mock('~/components/features/quiz/useQuizFocusMetrics', () => ({
  useQuizFocusMetrics: () => ({ getMetricsSnapshot: snapshot, finalizeCurrentSession: snapshot }),
}));

const chatState: { messages: QuizUIMessage[]; status: string; error?: unknown } = {
  messages: [],
  status: 'ready',
};
const useChatOptions: Array<Record<string, unknown>> = [];
vi.mock('@ai-sdk/react', () => ({
  useChat: (options: Record<string, unknown>) => {
    useChatOptions.push(options);
    return { ...chatState, sendMessage: vi.fn(), setMessages: vi.fn(), clearError: vi.fn() };
  },
}));
let transportOptions: { onSessionChange: (chatId: string, state: unknown) => void } | null = null;
vi.mock('@trigger.dev/sdk/chat/react', () => ({
  useTriggerChatTransport: (options: NonNullable<typeof transportOptions>) => {
    transportOptions = options;
    return {};
  },
  useChatActions: () => ({ sendAction: vi.fn().mockResolvedValue(undefined) }),
}));

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

const { default: QuizChat } = await import('../QuizChat');

const QUIZ = { id: 'quiz-1', question_count: 3 };
const OPEN = { id: 'attempt-1', completed_at: null, evaluation_json: null };
const RECORD = {
  v: 2,
  source: 'server',
  partial_credit_percentage: 40,
  first_attempt_percentage: 0,
  question_results: [],
};
const COMPLETED = { ...OPEN, completed_at: '2026-09-30T12:00:00Z', evaluation_json: RECORD };

const reply = {
  id: 'a1',
  role: 'assistant',
  parts: [{ type: 'text', text: 'Close. What does the second line do?' }],
} as unknown as QuizUIMessage;

let container: HTMLDivElement;
let root: Root;

const render = async (
  props: {
    attempt?: Record<string, unknown>;
    messagesLeft?: number | null;
    viewerOwnsAttempt?: boolean;
    readOnly?: boolean;
  } = {}
) => {
  await act(async () => {
    root.render(
      <QuizChat
        quiz={QUIZ}
        attempt={(props.attempt ?? OPEN) as never}
        transcript={[reply]}
        viewerOwnsAttempt={props.viewerOwnsAttempt ?? true}
        readOnly={props.readOnly ?? false}
        messagesLeft={props.messagesLeft ?? null}
      />
    );
  });
};

/** A reply's count arriving on the stream. */
const streamLeft = async (remaining: number) => {
  const onData = useChatOptions.at(-1)!.onData as (part: unknown) => void;
  await act(async () => onData({ type: 'data-messages-left', data: { remaining } }));
};

const notice = () =>
  container.querySelector('[data-testid="quiz-messages-left"]')?.textContent ?? null;
const limitNotice = () => container.querySelector('[data-testid="quiz-results-limit"]');
/** The composer takes a message: rendered, not inert, its send not disabled. */
const composerOpen = () => {
  const editor = container.querySelector('[data-testid="quiz-editor"]');
  const sendButton = container.querySelector<HTMLButtonElement>('[data-testid="quiz-send"]');
  return Boolean(
    editor && !editor.className.includes('pointer-events-none') && !sendButton?.disabled
  );
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  chatState.messages = [reply];
  chatState.status = 'ready';
  chatState.error = undefined;
  useChatOptions.length = 0;
  transportOptions = null;
  revalidateMock.mockReset();
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

describe('QuizChat: messages left', () => {
  it('is 20 at the threshold and the limit is the shared one', () => {
    expect(MESSAGES_LEFT_NOTICE_AT).toBe(20);
    expect(MAX_STUDENT_TURNS).toBe(200);
  });

  it("shows the loader's count under the latest reply at 20 left, as after a reload", async () => {
    await render({ messagesLeft: 20 });
    expect(notice()).toBe('20 messages left in this attempt.');
    // Under the reply, after it.
    const replyRow = container.querySelector('[data-message-role="assistant"]')!;
    const line = container.querySelector('[data-testid="quiz-messages-left"]')!;
    expect(replyRow.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows nothing above 20 left', async () => {
    await render({ messagesLeft: 21 });
    expect(notice()).toBeNull();
    await render({ messagesLeft: MAX_STUDENT_TURNS });
    expect(notice()).toBeNull();
    await render({ messagesLeft: null });
    expect(notice()).toBeNull();
  });

  it("counts down with each reply's count from the server, to the singular", async () => {
    await render({ messagesLeft: 21 });
    expect(notice()).toBeNull();

    await streamLeft(20);
    expect(notice()).toBe('20 messages left in this attempt.');
    await streamLeft(19);
    expect(notice()).toBe('19 messages left in this attempt.');
    await streamLeft(2);
    expect(notice()).toBe('2 messages left in this attempt.');
    await streamLeft(1);
    expect(notice()).toBe('1 message left in this attempt.');
    // None at 0: the reply to the last message ends the attempt.
    await streamLeft(0);
    expect(notice()).toBeNull();
  });

  it('keeps the lower of the two counts: neither ever goes up', async () => {
    await render({ messagesLeft: 12 });
    // An older reply replayed with a higher count does not raise it.
    await streamLeft(15);
    expect(notice()).toBe('12 messages left in this attempt.');
    // A refreshed loader with a lower count lowers it.
    await render({ messagesLeft: 11 });
    expect(notice()).toBe('11 messages left in this attempt.');
  });

  it('ignores any other data part', async () => {
    await render({ messagesLeft: 21 });
    const onData = useChatOptions.at(-1)!.onData as (part: unknown) => void;
    await act(async () => onData({ type: 'data-notice', data: { code: 'reply_failed' } }));
    expect(notice()).toBeNull();
  });

  it('is hidden while a reply is running, and back once it is in', async () => {
    await render({ messagesLeft: 5 });
    chatState.status = 'streaming';
    await render({ messagesLeft: 5 });
    expect(notice()).toBeNull();
    chatState.status = 'ready';
    await render({ messagesLeft: 5 });
    expect(notice()).toBe('5 messages left in this attempt.');
  });

  it('is gone once nothing can be sent', async () => {
    chatState.status = 'error';
    chatState.error = new Error(QUIZ_REFUSAL_COPY.turn_limit);
    await render({ messagesLeft: 0 });
    expect(notice()).toBeNull();
  });

  it('is never shown on a transcript read by staff', async () => {
    await render({ messagesLeft: 3, viewerOwnsAttempt: false, readOnly: true });
    expect(notice()).toBeNull();
  });
});

describe('QuizChat: the reply to the last message', () => {
  it('never shows 0 left under an open composer, and refreshes into the results', async () => {
    await render({ messagesLeft: 1 });
    expect(notice()).toBe('1 message left in this attempt.');
    expect(composerOpen()).toBe(true);

    // The last message is sent: its reply streams, opening with 0 left.
    chatState.status = 'streaming';
    await render({ messagesLeft: 1 });
    await streamLeft(0);
    expect(notice()).toBeNull();
    expect(revalidateMock).not.toHaveBeenCalled();

    // The turn ends. The server submitted the attempt, and the session's close
    // rides on the turn's final record, read before the reply is in.
    await act(async () => {
      transportOptions!.onSessionChange('attempt-1', { publicAccessToken: 'pat', closed: true });
    });
    expect(notice()).toBeNull();
    chatState.status = 'ready';
    await render({ messagesLeft: 1 });
    expect(notice()).toBeNull();
    expect(composerOpen()).toBe(false);
    expect(container.querySelector('[data-testid="quiz-error"]')).toBeNull();
    expect(revalidateMock).toHaveBeenCalledTimes(1);

    // The refresh brings the submitted attempt: its results, saying why it ended.
    await render({ attempt: { ...COMPLETED, ended_by: 'turn_limit' }, messagesLeft: null });
    expect(container.querySelector('[data-testid="quiz-editor"]')).toBeNull();
    expect(notice()).toBeNull();
    expect(container.querySelector('[data-testid="quiz-results"]')).not.toBeNull();
    expect(limitNotice()?.textContent).toBe(QUIZ_MESSAGE_LIMIT_COPY.submittedAtLimit);
    expect(
      container.querySelector('[data-testid="quiz-chat"]')!.getAttribute('data-quiz-status')
    ).toBe('complete');
    expect(revalidateMock).toHaveBeenCalledTimes(1);
  });

  it("shows no 0 for an open attempt the loader counts none left, and leaves sending to the server's answer", async () => {
    // The server could not submit it: the next message reaches admission,
    // which refuses it and completes the attempt.
    await render({ messagesLeft: 0 });
    expect(notice()).toBeNull();
    expect(composerOpen()).toBe(true);
  });
});

describe('QuizChat: an attempt submitted at the message limit', () => {
  it('says so above the results of a saved attempt, for the student and for staff', async () => {
    for (const viewerOwnsAttempt of [true, false]) {
      await render({
        attempt: { ...COMPLETED, ended_by: 'turn_limit' },
        viewerOwnsAttempt,
        readOnly: true,
      });
      expect(limitNotice()?.textContent).toBe(QUIZ_MESSAGE_LIMIT_COPY.submittedAtLimit);
      expect(limitNotice()?.textContent).toBe(
        'This quiz reached its message limit and was submitted.'
      );
      // Above the results.
      const results = container.querySelector('[data-testid="quiz-results"]')!;
      expect(results.firstElementChild).toBe(limitNotice());
    }
  });

  it('says nothing of the kind for an attempt that ended otherwise', async () => {
    for (const attempt of [COMPLETED, { ...COMPLETED, ended_by: null }]) {
      await render({ attempt, readOnly: true });
      expect(container.querySelector('[data-testid="quiz-results"]')).not.toBeNull();
      expect(limitNotice()).toBeNull();
    }
  });

  it('replaces the refusal line in the live chat once the refreshed attempt says so', async () => {
    await render();
    chatState.status = 'error';
    chatState.error = new Error(QUIZ_REFUSAL_COPY.turn_limit);
    await render();
    // Before the refresh: the refusal says why the quiz ended.
    expect(container.querySelector('[data-testid="quiz-error"]')?.textContent).toContain(
      QUIZ_REFUSAL_COPY.turn_limit
    );
    expect(revalidateMock).toHaveBeenCalledTimes(1);

    // The refresh brings the completed attempt: its results say it, once.
    await render({ attempt: { ...COMPLETED, ended_by: 'turn_limit' } });
    expect(container.querySelector('[data-testid="quiz-error"]')).toBeNull();
    expect(limitNotice()?.textContent).toBe(QUIZ_MESSAGE_LIMIT_COPY.submittedAtLimit);
  });
});
