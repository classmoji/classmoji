// @vitest-environment jsdom
/**
 * A reply stream that reads the last finished reply again (the session's
 * reply stream keeps about one reply, and a tab without a good resume cursor
 * reads it from there) must not show that reply twice. Seen on prod after a
 * reload: the next answer showed the previous turn's result row, files read
 * and card again, once or twice, ahead of the new reply.
 *
 * This runs the real useChat over a fake transport whose stream carries the
 * previous reply (same message id as the transcript's) and then the new one,
 * as the Trigger transport delivers it from a missing cursor.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import type { QuizUIMessage } from '@classmoji/utils/quiz-agent';

vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate: vi.fn() }) }));
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({
  default: ({ onSubmit }: { onSubmit: (t: string) => void }) => (
    <button data-testid="quiz-send" onClick={() => onSubmit('It aligns items on the main axis.')}>
      Send
    </button>
  ),
}));
vi.mock('~/components/features/quiz/useQuizFocusMetrics', () => ({
  useQuizFocusMetrics: () => ({
    getMetricsSnapshot: () => null,
    finalizeCurrentSession: () => null,
  }),
}));

const streamOf = (chunks: unknown[]) =>
  new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk as UIMessageChunk);
      controller.close();
    },
  });

let replyChunks: unknown[] = [];
const sendMessagesMock = vi.fn(async (_options: { messages: QuizUIMessage[] }) =>
  streamOf(replyChunks)
);
const fakeTransport = {
  sendMessages: sendMessagesMock,
  reconnectToStream: vi.fn(async () => null),
  sessionStatus: () => 'open' as const,
};
vi.mock('@trigger.dev/sdk/chat/react', () => ({
  useTriggerChatTransport: () => fakeTransport,
  useChatActions: () => ({ sendAction: vi.fn() }),
}));

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

const {
  default: QuizChat,
  dropReplayedMessages,
  withoutReplayedMessages,
} = await import('../QuizChat');

const CARD_1 = { total_questions: 8, question_text: 'Why does the header use flexbox?' };
const CARD_2 = { total_questions: 8, question_text: 'What does justify-content do?' };
const FEEDBACK = 'Close: it does align them, but say which axis justify-content works on.';

// The saved transcript after a reload: question 1, the student moved on, and
// the reply that recorded it, read a file and presented question 2.
const transcript = [
  {
    id: 'a1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-present_question',
        toolCallId: 'call-q1',
        state: 'output-available',
        input: { ...CARD_1, question_number: 1 },
        output: { card: CARD_1, question_number: 1, total_questions: 8 },
      },
    ],
  },
  { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'next' }], metadata: { action: 'next' } },
  {
    id: 'a2',
    role: 'assistant',
    parts: [
      { type: 'data-step', data: { kind: 'read_file', path: 'src/header.css' } },
      {
        type: 'data-question-result',
        id: 'question-result-1',
        data: { question_num: 1, emoji: 'rocket', brief_feedback: 'Nailed it!' },
      },
      {
        type: 'tool-present_question',
        toolCallId: 'call-q2',
        state: 'output-available',
        input: { ...CARD_2, question_number: 2 },
        output: { card: CARD_2, question_number: 2, total_questions: 8 },
      },
    ],
  },
] as unknown as QuizUIMessage[];

// The previous reply as its stream carried it (message id a2), then the turn-
// complete the transport skips, then the reply to the new answer.
const previousReply = [
  { type: 'start', messageId: 'a2' },
  { type: 'data-step', data: { kind: 'read_file', path: 'src/header.css' } },
  {
    type: 'data-question-result',
    id: 'question-result-1',
    data: { question_num: 1, emoji: 'rocket', brief_feedback: 'Nailed it!' },
  },
  {
    type: 'tool-input-available',
    toolCallId: 'call-q2',
    toolName: 'present_question',
    input: { ...CARD_2, question_number: 2 },
  },
  {
    type: 'tool-output-available',
    toolCallId: 'call-q2',
    output: { card: CARD_2, question_number: 2, total_questions: 8 },
  },
  { type: 'finish' },
];
const newReply = [
  { type: 'start', messageId: 'a3' },
  { type: 'tool-input-start', toolCallId: 'call-o', toolName: 'offer_next_step' },
  {
    type: 'tool-input-available',
    toolCallId: 'call-o',
    toolName: 'offer_next_step',
    input: { feedback: FEEDBACK, actions: ['try_again', 'next'] },
  },
  {
    type: 'tool-output-available',
    toolCallId: 'call-o',
    output: { actions: ['try_again', 'next'], lead_in: 'Would you like to try again or move on?' },
  },
  { type: 'finish' },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  sendMessagesMock.mockClear();
  window.sessionStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 }))
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const status = () =>
  container.querySelector('[data-testid="quiz-chat"]')?.getAttribute('data-quiz-status');
const count = (testId: string) => container.querySelectorAll(`[data-testid="${testId}"]`).length;

/** Mount the reloaded drawer, send the next answer, and let its reply finish. */
const answerAfterReload = async () => {
  await act(async () => {
    root.render(
      <QuizChat
        quiz={{ id: 'quiz-1', question_count: 8 }}
        attempt={{ id: 'attempt-1', completed_at: null, evaluation_json: null }}
        transcript={transcript}
        viewerOwnsAttempt
      />
    );
  });
  expect(count('quiz-question-card')).toBe(2);
  const send = container.querySelector('[data-testid="quiz-send"]') as HTMLButtonElement;
  await act(async () => send.click());
  for (
    let i = 0;
    i < 50 && (sendMessagesMock.mock.calls.length === 0 || status() !== 'ready');
    i++
  ) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
    });
  }
  expect(sendMessagesMock).toHaveBeenCalledTimes(1);
  expect(status()).toBe('ready');
};

describe('a reply stream that reads the last reply again', () => {
  it('shows the previous turn once and the new reply after it', async () => {
    replyChunks = [...previousReply, ...newReply];
    await answerAfterReload();

    expect(count('quiz-question-card')).toBe(2);
    expect(count('quiz-result-row')).toBe(1);
    expect(container.querySelectorAll('[data-message-role="assistant"]')).toHaveLength(3);
    expect(container.textContent?.split(FEEDBACK)).toHaveLength(2);
    const next = container.querySelector('[data-testid="quiz-next"]') as HTMLButtonElement;
    expect(next.disabled).toBe(false);
  });

  it('shows a stream without a replay exactly as before', async () => {
    replyChunks = newReply;
    await answerAfterReload();

    expect(count('quiz-question-card')).toBe(2);
    expect(count('quiz-result-row')).toBe(1);
    expect(container.textContent?.split(FEEDBACK)).toHaveLength(2);
  });
});

describe('dropReplayedMessages', () => {
  const read = async (stream: ReadableStream<UIMessageChunk>) => {
    const out: unknown[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return out;
      out.push(value);
    }
  };

  it('drops each reply the chat already holds, up to the next start', async () => {
    const older = [{ type: 'start', messageId: 'a1' }, { type: 'finish' }];
    const out = await read(
      dropReplayedMessages(
        streamOf([...older, ...previousReply, ...newReply]),
        new Set(['a1', 'u1', 'a2'])
      )
    );
    expect(out).toEqual(newReply);
  });

  it('passes everything when no id is known, and chunks before any start', async () => {
    const error = { type: 'error', errorText: "This quiz can't continue right now." };
    expect(await read(dropReplayedMessages(streamOf(newReply), new Set()))).toEqual(newReply);
    expect(await read(dropReplayedMessages(streamOf([error]), new Set(['a2'])))).toEqual([error]);
  });

  it("keeps a new turn's error that follows the replayed reply without a start of its own", async () => {
    const error = { type: 'error', errorText: "This quiz can't continue right now." };
    expect(
      await read(dropReplayedMessages(streamOf([...previousReply, error]), new Set(['a2'])))
    ).toEqual([error]);
    // A replayed reply cut short (no finish) ends at the next start.
    const cutShort = previousReply.slice(0, -1);
    expect(
      await read(dropReplayedMessages(streamOf([...cutShort, ...newReply]), new Set(['a2'])))
    ).toEqual(newReply);
  });

  it('filters a resumed reply against the chat as it is then', async () => {
    const transport = {
      sendMessages: vi.fn(),
      reconnectToStream: vi.fn(async () => streamOf([...previousReply, ...newReply])),
    };
    const guarded = withoutReplayedMessages(transport as never, () => transcript);
    const resumed = await guarded.reconnectToStream({ chatId: 'attempt-1' } as never);
    expect(await read(resumed!)).toEqual(newReply);

    transport.reconnectToStream.mockResolvedValueOnce(null as never);
    expect(await guarded.reconnectToStream({ chatId: 'attempt-1' } as never)).toBeNull();
  });
});
