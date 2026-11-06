// @vitest-environment jsdom
/**
 * The answer rules in the student's live chat:
 *
 *   - the rules line at the top of the chat (`answerRulesLine` of the rules
 *     the server computed), from before the first card on; never in the saved
 *     transcript (staff, a completed attempt);
 *   - the answer counter beside the composer while a question is open: answer
 *     k of N from the offers' `answers_used` (a saved offer without it counts
 *     one more), amber on the last, "No answers left" after it until the next
 *     card. A hint uses no answer. None before the first card, between a
 *     result and the next card, once complete, or with no server limit;
 *   - the composer's placeholder: "Type your answer…" while a question is open
 *     (also with no limit), the last-answer line on the last, else the default.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANSWER_PLACEHOLDER, BUTTON_TEXT, type QuizUIMessage } from '@classmoji/utils/quiz-agent';

vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate: vi.fn() }) }));
const editorProps: Array<{ placeholder?: string }> = [];
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({
  default: (props: { placeholder?: string }) => {
    editorProps.push(props);
    return <div data-testid="chat-editor" data-placeholder={props.placeholder} />;
  },
}));
const snapshot = () => ({ totalMs: 0, unfocusedMs: 0 });
vi.mock('~/components/features/quiz/useQuizFocusMetrics', () => ({
  useQuizFocusMetrics: () => ({ getMetricsSnapshot: snapshot, finalizeCurrentSession: snapshot }),
}));
const chatState: { messages: QuizUIMessage[]; status: string } = { messages: [], status: 'ready' };
vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    ...chatState,
    sendMessage: vi.fn(),
    setMessages: vi.fn(),
    clearError: vi.fn(),
  }),
}));
vi.mock('@trigger.dev/sdk/chat/react', () => ({
  useTriggerChatTransport: () => ({}),
  useChatActions: () => ({ sendAction: vi.fn().mockResolvedValue(undefined) }),
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

const { default: QuizChat, answerCounterOf, openQuestionOf } = await import('../QuizChat');
const { default: QuizResults } = await import('../QuizResults');

const msg = (id: string, role: 'user' | 'assistant', parts: unknown[], metadata?: unknown) =>
  ({ id, role, parts, ...(metadata ? { metadata } : {}) }) as unknown as QuizUIMessage;
const text = (t: string) => ({ type: 'text', text: t });
const user = (id: string, t: string) => msg(id, 'user', [text(t)]);
const card = (n: number) => ({
  type: 'tool-present_question',
  toolCallId: `call-q${n}`,
  state: 'output-available',
  input: {},
  output: { card: { question_text: `Question ${n}?` }, question_number: n, total_questions: 3 },
});
/** An accepted offer: `used` is its answers_used; undefined, a part saved without it. */
const offer = (id: string, used?: number, actions = ['try_again', 'next']) => ({
  type: 'tool-offer_next_step',
  toolCallId: id,
  state: 'output-available',
  input: { feedback: `Feedback ${id}` },
  output: {
    actions,
    lead_in: 'Answer again below, or try again with a hint.',
    ...(used !== undefined ? { answers_used: used, max_answers: 3, hint_cost: 15 } : {}),
  },
});
const result = (n: number, revised = false) => ({
  type: 'data-question-result',
  id: `question-result-${n}${revised ? '-revised' : ''}`,
  data: {
    question_num: n,
    emoji: 'heart',
    brief_feedback: 'Ok.',
    ...(revised ? { revised: true } : {}),
  },
});

const q1 = msg('a1', 'assistant', [text('Welcome.'), card(1)]);
const answered = (n: number) => [
  user(`u${n}`, `Answer ${n}.`),
  msg(`a-o${n}`, 'assistant', [offer(`o${n}`, n)]),
];

describe('openQuestionOf / answerCounterOf', () => {
  it('has no counter before the first card', () => {
    expect(openQuestionOf([])).toBeNull();
    expect(answerCounterOf([msg('a0', 'assistant', [text('Welcome.')])], 3)).toBeNull();
  });

  it('counts answer k of N from the offers, the last in amber, then none left', () => {
    expect(answerCounterOf([q1], 3)).toEqual({
      state: 'answer',
      label: 'Answer 1 of 3',
      placeholder: ANSWER_PLACEHOLDER.open,
    });
    expect(answerCounterOf([q1, ...answered(1)], 3)?.label).toBe('Answer 2 of 3');
    expect(answerCounterOf([q1, ...answered(1), ...answered(2)], 3)).toEqual({
      state: 'last',
      label: 'Answer 3 of 3 · last',
      placeholder: ANSWER_PLACEHOLDER.last,
    });
    expect(answerCounterOf([q1, ...answered(1), ...answered(2), ...answered(3)], 3)).toEqual({
      state: 'none',
      label: 'No answers left',
      placeholder: null,
    });
    // One answer per question: the first is the last.
    expect(answerCounterOf([q1], 1)?.label).toBe('Answer 1 of 1 · last');
  });

  it('starts again at the next card, and has none between a result and that card', () => {
    const chat = [q1, ...answered(1), ...answered(2), ...answered(3), user('u4', BUTTON_TEXT.next)];
    expect(answerCounterOf([...chat, msg('a4', 'assistant', [result(1)])], 3)).toBeNull();
    expect(answerCounterOf([...chat, msg('a4', 'assistant', [result(1), card(2)])], 3)?.label).toBe(
      'Answer 1 of 3'
    );
    // A revised earlier result closes nothing.
    expect(
      answerCounterOf(
        [msg('a0', 'assistant', [result(1), card(2)]), msg('a1', 'assistant', [result(1, true)])],
        3
      )?.label
    ).toBe('Answer 1 of 3');
  });

  it('is not advanced by a hint, a card shown again or a refused offer', () => {
    const hinted = [
      q1,
      ...answered(1),
      user('u2', BUTTON_TEXT.try_again),
      msg('a2', 'assistant', [text("Here's a hint. What do you think?")]),
    ];
    expect(answerCounterOf(hinted, 3)?.label).toBe('Answer 2 of 3');
    const refused = { ...offer('o9', 5), state: 'output-error', errorText: 'An error occurred.' };
    expect(answerCounterOf([...hinted, msg('a3', 'assistant', [refused, card(1)])], 3)?.label).toBe(
      'Answer 2 of 3'
    );
  });

  it('counts a saved offer without answers_used as one more answer', () => {
    const legacy = [
      q1,
      user('u1', 'A.'),
      msg('a2', 'assistant', [offer('o1')]),
      user('u2', 'B.'),
      msg('a3', 'assistant', [offer('o2')]),
    ];
    expect(openQuestionOf(legacy)).toEqual({ question: 1, used: 2 });
    expect(answerCounterOf(legacy, 3)?.state).toBe('last');
  });

  it('has no counter with no server limit, but the answer placeholder while a question is open', () => {
    expect(answerCounterOf([q1, ...answered(1)], null)).toEqual({
      state: 'open',
      label: null,
      placeholder: ANSWER_PLACEHOLDER.open,
    });
  });

  it('has none once the evaluation is in', () => {
    const evaluation = { type: 'data-evaluation', id: 'evaluation', data: {} };
    expect(answerCounterOf([q1, msg('a9', 'assistant', [evaluation])], 3)).toBeNull();
  });
});

const QUIZ = { id: 'quiz-1', question_count: 3 };
const OPEN = { id: 'attempt-1', completed_at: null, evaluation_json: null };
const RULES = { hintCost: 10, maxAnswers: 3 };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  chatState.messages = [];
  chatState.status = 'ready';
  editorProps.length = 0;
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

const render = async (
  messages: QuizUIMessage[],
  props: Partial<Parameters<typeof QuizChat>[0]> = {}
) => {
  chatState.messages = messages;
  await act(async () => {
    root.render(
      <QuizChat
        quiz={QUIZ}
        attempt={OPEN as never}
        transcript={messages}
        viewerOwnsAttempt
        chatStarted={messages.length > 0}
        answerRules={RULES}
        {...props}
      />
    );
  });
};

const rulesLine = () =>
  container.querySelector('[data-testid="quiz-answer-rules"]')?.textContent ?? null;
const counter = () => container.querySelector('[data-testid="quiz-answer-counter"]');
const placeholder = () =>
  container.querySelector('[data-testid="chat-editor"]')?.getAttribute('data-placeholder');

describe('the live chat', () => {
  it('opens with the rules line, before the first card, and keeps it at the top', async () => {
    await render([msg('a0', 'assistant', [text('Welcome.')])]);
    expect(rulesLine()).toBe(
      'Up to 3 answers per question. Each hint costs 10 points on that question.'
    );
    expect(counter()).toBeNull();

    await render([q1, ...answered(1)]);
    const line = container.querySelector('[data-testid="quiz-answer-rules"]')!;
    const firstRow = container.querySelector('[data-message-role]')!;
    expect(line.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('reads the rules for one answer, free hints, and an attempt with no limit', async () => {
    await render([q1], { answerRules: { hintCost: 0, maxAnswers: 1 } });
    expect(rulesLine()).toBe('One answer per question. Hints are free.');
    await render([q1], { answerRules: { hintCost: 15, maxAnswers: null } });
    expect(rulesLine()).toBe('Each hint costs 15 points on that question.');
  });

  it('shows the counter and placeholder by state', async () => {
    await render([q1]);
    expect(counter()?.textContent).toBe('Answer 1 of 3');
    expect(counter()?.className).not.toContain('amber');
    expect(placeholder()).toBe('Type your answer…');

    await render([q1, ...answered(1), ...answered(2)]);
    expect(counter()?.textContent).toBe('Answer 3 of 3 · last');
    expect(counter()?.className).toContain('text-amber-600');
    expect(counter()?.className).toContain('dark:text-amber-400');
    expect(placeholder()).toBe(ANSWER_PLACEHOLDER.last);

    await render([q1, ...answered(1), ...answered(2), ...answered(3)]);
    expect(counter()?.textContent).toBe('No answers left');
    expect(placeholder()).not.toBe('Type your answer…');
  });

  it('has no counter with no server limit, still the answer placeholder', async () => {
    await render([q1, ...answered(1)], { answerRules: { hintCost: 15, maxAnswers: null } });
    expect(counter()).toBeNull();
    expect(placeholder()).toBe('Type your answer…');
  });

  it('has no counter or answer placeholder with no question open', async () => {
    await render([msg('a0', 'assistant', [text('Welcome.')])]);
    expect(counter()).toBeNull();
    expect(placeholder()).not.toBe('Type your answer…');
  });

  it('shows neither the line nor the counter in the saved transcript', async () => {
    await render([q1], { viewerOwnsAttempt: false });
    expect(rulesLine()).toBeNull();
    expect(counter()).toBeNull();
    // The view is chosen once, at mount: mount afresh for the completed attempt.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render([q1], {
      attempt: { ...OPEN, completed_at: '2026-11-05T12:00:00Z' } as never,
    });
    expect(rulesLine()).toBeNull();
    expect(counter()).toBeNull();
  });
});

describe('the results panel', () => {
  const record = (extra: Record<string, unknown>) =>
    ({
      v: 2,
      source: 'server',
      question_results: [
        { question_num: 1, attempts: 2, tries: 2, emoji: 'heart', brief_feedback: 'Ok.', ...extra },
      ],
    }) as never;

  it("shows staff each question's answers given, messages and hints used", async () => {
    await act(async () =>
      root.render(
        <QuizResults evaluation={record({ answers_given: 3, messages_sent: 5, hints_used: 2 })} />
      )
    );
    expect(
      container.querySelector('[data-testid="quiz-result-question-counts"]')?.textContent
    ).toBe('Answers given 3 · Messages 5 · Hints used 2');
  });

  it("shows none on a student's record, or a result recorded before they were counted", async () => {
    await act(async () => root.render(<QuizResults evaluation={record({})} />));
    expect(container.querySelector('[data-testid="quiz-result-question"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="quiz-result-question-counts"]')).toBeNull();
  });
});
