// @vitest-environment jsdom
/**
 * A reply that records a question and moves on renders as the legacy chat
 * did: the feedback in one bubble, the "completed question N" marker in its
 * own row with its own avatar (never inside a bubble), then the files read and
 * the next card in a new bubble. Live and saved alike, and without remounting
 * what is already on screen while the reply streams.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizUIMessage } from '@classmoji/utils/quiz-agent';

let darkMode = false;
vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: darkMode }) }));
vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate: vi.fn() }) }));
const chatState: { messages: QuizUIMessage[]; status: string } = { messages: [], status: 'ready' };
vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({ ...chatState, sendMessage: vi.fn() }),
}));
vi.mock('@trigger.dev/sdk/chat/react', () => ({
  useTriggerChatTransport: () => ({}),
  useChatActions: () => ({ sendAction: vi.fn() }),
}));
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({ default: () => null }));

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

const { default: QuizChat, QuizTranscript } = await import('../QuizChat');

const msg = (id: string, role: 'user' | 'assistant', parts: unknown[]) =>
  ({ id, role, parts }) as unknown as QuizUIMessage;

const CARD = {
  preamble: 'On to the next one.',
  total_questions: 8,
  question_text: 'Why does the header use flexbox?',
};
const card = (n: number, state = 'output-available') => ({
  type: 'tool-present_question',
  toolCallId: `call-q${n}`,
  state,
  input: { ...CARD, question_number: n },
  ...(state === 'output-available'
    ? { output: { card: CARD, question_number: n, total_questions: 8 } }
    : {}),
});
const divider = (n: number, revised = false) => ({
  type: 'data-question-result',
  id: `question-result-${n}${revised ? '-revised' : ''}`,
  data: {
    question_num: n,
    emoji: 'heart',
    brief_feedback: `Feedback ${n}`,
    ...(revised ? { revised: true } : {}),
  },
});
const recordCall = (n: number) => ({
  type: 'tool-record_question_result',
  toolCallId: `call-r${n}`,
  state: 'output-available',
  input: { question_num: n, answers: [], brief_feedback: `Feedback ${n}` },
  output: { question_num: n, emoji: 'heart', brief_feedback: `Feedback ${n}` },
});
const step = (path: string) => ({ type: 'data-step', data: { kind: 'read_file', path } });
const text = (t: string) => ({ type: 'text', text: t });

const FEEDBACK = 'Right, flexbox lines the items up.';

/** Static markup, parsed so its structure can be queried. */
const dom = (html: string) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
};
const renderStatic = (messages: QuizUIMessage[]) =>
  dom(
    renderToStaticMarkup(
      <QuizTranscript messages={messages} status="ready" busy={false} isDarkMode={darkMode} />
    )
  );

const bubbles = (root: ParentNode) =>
  Array.from(root.querySelectorAll<HTMLElement>('[data-testid="quiz-assistant-bubble"]'));
const rows = (root: ParentNode) =>
  Array.from(root.querySelectorAll<HTMLElement>('[data-testid="quiz-result-row"]'));
/** a comes before b in the document. */
const before = (a: Node, b: Node) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('QuizTranscript — the marker between bubbles', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`feedback, marker row, files read, then the next card in a new bubble (${theme})`, () => {
      darkMode = theme === 'dark';
      const root = renderStatic([
        msg('a1', 'assistant', [text(FEEDBACK), divider(1), step('src/App.tsx'), card(2)]),
      ]);

      const [first, second, ...more] = bubbles(root);
      expect(more).toHaveLength(0);
      expect(first.textContent).toContain(FEEDBACK);
      expect(first.textContent).not.toContain('Question 2 of 8');
      expect(second.textContent).toContain('Question 2 of 8');
      expect(second.textContent).not.toContain(FEEDBACK);

      // The marker has its own row and avatar, outside both bubbles.
      const [row] = rows(root);
      const marker = root.querySelector('[data-testid="quiz-question-result"]')!;
      expect(marker.textContent).toContain('completed question 1:');
      expect(row.contains(marker)).toBe(true);
      expect(marker.closest('[data-testid="quiz-assistant-bubble"]')).toBeNull();
      expect(row.querySelector('.ant-avatar')?.textContent).toBe('📝');
      expect(row.innerHTML).toContain('dark:bg-gray-800');

      // In order: feedback bubble, marker row, files read, card bubble.
      const steps = root.querySelector('[data-testid="quiz-steps"]')!;
      expect(steps.textContent).toContain('Code Analysis (1 step)');
      expect(first.contains(steps) || second.contains(steps)).toBe(false);
      expect(before(first, row)).toBe(true);
      expect(before(row, steps)).toBe(true);
      expect(before(steps, second)).toBe(true);
    });
  }

  it('moves files read before the marker landed below it, with the next card', () => {
    // Explored, then recorded and presented in one step: the marker arrives last.
    for (const parts of [
      [text(FEEDBACK), step('src/App.tsx'), recordCall(1), card(2), divider(1)],
      [step('src/App.tsx'), recordCall(1), card(2), divider(1)],
    ]) {
      const root = renderStatic([msg('a1', 'assistant', parts)]);
      const [row] = rows(root);
      const steps = root.querySelector('[data-testid="quiz-steps"]')!;
      const next = bubbles(root).at(-1)!;
      expect(next.textContent).toContain('Question 2 of 8');
      expect(before(row, steps)).toBe(true);
      expect(before(steps, next)).toBe(true);
    }
    // Files read before the feedback stay above it.
    const root = renderStatic([
      msg('a1', 'assistant', [step('src/App.tsx'), text(FEEDBACK), divider(1), card(2)]),
    ]);
    const steps = root.querySelector('[data-testid="quiz-steps"]')!;
    expect(before(steps, bubbles(root)[0])).toBe(true);
    expect(before(steps, rows(root)[0])).toBe(true);
  });

  it('keeps a later message without a marker as one bubble', () => {
    const root = renderStatic([
      msg('a0', 'assistant', [text('Welcome.'), card(1)]),
      msg('u1', 'user', [text('I would like a hint')]),
      msg('a1', 'assistant', [text('Look at line 3.'), step('src/App.tsx'), card(1)]),
    ]);
    const later = root.querySelectorAll('[data-message-role="assistant"]')[1];
    expect(bubbles(later)).toHaveLength(1);
    expect(rows(root)).toHaveLength(0);
    expect(bubbles(later)[0].textContent).toContain('Look at line 3.');
    expect(bubbles(later)[0].textContent).toContain('Question 1 of 8');
  });

  for (const theme of ['light', 'dark'] as const) {
    it(`gives the opening welcome its own bubble, then the files read, then question 1 (${theme})`, () => {
      darkMode = theme === 'dark';
      const root = renderStatic([
        msg('a1', 'assistant', [
          { type: 'step-start' },
          text('Welcome to the quiz.'),
          step('src/App.tsx'),
          step('src/index.css'),
          card(1),
        ]),
      ]);
      const [welcome, question, ...more] = bubbles(root);
      expect(more).toHaveLength(0);
      expect(welcome.textContent).toBe('Welcome to the quiz.');
      expect(question.textContent).toContain('Question 1 of 8');
      const steps = root.querySelector('[data-testid="quiz-steps"]')!;
      expect(steps.textContent).toContain('Code Analysis (2 steps)');
      expect(before(welcome, steps)).toBe(true);
      expect(before(steps, question)).toBe(true);
      expect(welcome.className).toContain('dark:bg-gray-800');
    });
  }

  it('splits only the opening message, and only when it starts with text', () => {
    // Opened by a notice, not a welcome: nothing to split.
    const notice = renderStatic([
      msg('a1', 'assistant', [{ type: 'data-notice', data: { code: 'reply_failed' } }, text('Hi')]),
    ]);
    expect(bubbles(notice)).toHaveLength(1);
    // A welcome with nothing after it is still one bubble.
    const alone = renderStatic([msg('a1', 'assistant', [text('Welcome to the quiz.')])]);
    expect(bubbles(alone)).toHaveLength(1);
  });

  it('gives a revised marker its own row the same way, one row per run of markers', () => {
    const revised = renderStatic([
      msg('a1', 'assistant', [text(FEEDBACK), divider(1, true), card(2)]),
    ]);
    expect(bubbles(revised)).toHaveLength(2);
    expect(rows(revised)).toHaveLength(1);
    expect(rows(revised)[0].textContent).toContain('question 1 revised:');

    const run = renderStatic([msg('a1', 'assistant', [divider(2), divider(1, true), card(3)])]);
    expect(rows(run)).toHaveLength(1);
    expect(rows(run)[0].querySelectorAll('[data-testid="quiz-question-result"]')).toHaveLength(2);
    expect(bubbles(run)).toHaveLength(1);
  });

  it('keeps the Try again / Next buttons in the bubble whose parts they are', () => {
    const buttons = {
      type: 'tool-offer_next_step',
      toolCallId: 'call-b',
      state: 'output-available',
      input: { actions: ['next'] },
      output: { actions: ['next'] },
    };
    const root = renderStatic([
      msg('a1', 'assistant', [divider(1), text('Question 2 is a warm-up.'), buttons]),
    ]);
    const [bubble] = bubbles(root);
    expect(bubbles(root)).toHaveLength(1);
    expect(bubble.querySelector('[data-testid="quiz-next"]')).not.toBeNull();
    expect(before(rows(root)[0], bubble)).toBe(true);
  });
});

describe('QuizTranscript — streaming into the second bubble', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    darkMode = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const stream = async (parts: unknown[], busy = true) => {
    await act(async () => {
      root.render(
        <QuizTranscript
          messages={[msg('a1', 'assistant', parts)]}
          status={busy ? 'streaming' : 'ready'}
          busy={busy}
          isDarkMode={false}
        />
      );
    });
  };

  it('puts parts arriving after the marker in a new bubble, remounting nothing', async () => {
    const typing = () => container.querySelector('[data-testid="quiz-typing"]');
    const parts: unknown[] = [text(FEEDBACK), recordCall(1), divider(1)];
    await stream(parts);
    const [feedback] = bubbles(container);
    const [row] = rows(container);
    expect(bubbles(container)).toHaveLength(1);
    // The reply goes on after the marker: the activity line stays under it.
    expect(typing()?.textContent).toContain('Thinking...');
    expect(before(row, typing()!)).toBe(true);

    parts.push(step('src/App.tsx'));
    await stream(parts);
    expect(bubbles(container)).toHaveLength(1);
    const stepsNode = container.querySelector('[data-testid="quiz-steps"]')!;
    expect(before(row, stepsNode)).toBe(true);
    expect(typing()?.textContent).toContain('Exploring code...');
    // Open while the files are read.
    expect(stepsNode.querySelector('.ant-collapse-item-active')).not.toBeNull();

    parts.push(card(2, 'input-streaming'));
    await stream(parts);
    // A card still arriving opens no bubble of its own: no empty bubble, the
    // activity line and the open files read stay until the card is in.
    expect(bubbles(container)).toHaveLength(1);
    expect(container.querySelector('.ant-skeleton')).toBeNull();
    expect(typing()?.textContent).toContain('Exploring code...');
    expect(stepsNode.querySelector('.ant-collapse-item-active')).not.toBeNull();

    parts[parts.length - 1] = card(2);
    await stream(parts);
    const cardNode = container.querySelector('[data-testid="quiz-question-card"]')!;
    expect(bubbles(container)).toHaveLength(2);
    expect(bubbles(container)[1].contains(cardNode)).toBe(true);
    // The card is in: the wait is over, and the files read fold away.
    expect(typing()).toBeNull();
    expect(container.querySelector('[data-testid="quiz-steps"]')).toBe(stepsNode);
    expect(stepsNode.querySelector('.ant-collapse-item-active')).toBeNull();

    parts.push(text('Take your time.'));
    await stream(parts);
    await stream(parts, false);
    const [first, second] = bubbles(container);
    expect(first).toBe(feedback);
    expect(rows(container)[0]).toBe(row);
    expect(container.querySelector('[data-testid="quiz-question-card"]')).toBe(cardNode);
    expect(second.contains(cardNode)).toBe(true);
    // Text after a card is not shown, as in the legacy chat.
    expect(container.textContent).not.toContain('Take your time.');
  });

  it('keeps the activity line up through the opening exploration, until question 1', async () => {
    const typing = () => container.querySelector('[data-testid="quiz-typing"]');
    await act(async () => {
      root.render(<QuizTranscript messages={[]} status="streaming" busy isDarkMode={false} />);
    });
    expect(typing()?.textContent).toContain('Thinking...');

    const parts: unknown[] = [text('Welcome to the quiz.')];
    await stream(parts);
    const [welcome] = bubbles(container);
    expect(typing()?.textContent).toContain('Thinking...');

    parts.push(step('src/App.tsx'));
    await stream(parts);
    expect(typing()?.textContent).toContain('Exploring code...');
    expect(before(welcome, container.querySelector('[data-testid="quiz-steps"]')!)).toBe(true);

    // Question 1 still arriving: still waiting, and no empty bubble.
    parts.push(card(1, 'input-streaming'));
    await stream(parts);
    expect(typing()?.textContent).toContain('Exploring code...');
    expect(bubbles(container)).toHaveLength(1);

    parts[parts.length - 1] = card(1);
    await stream(parts);
    expect(typing()).toBeNull();
    expect(bubbles(container)[0]).toBe(welcome);
    expect(bubbles(container)).toHaveLength(2);

    // Feedback with buttons: up until the buttons arrive; a notice ends it too.
    const buttons = {
      type: 'tool-offer_next_step',
      toolCallId: 'call-b',
      state: 'output-available',
      input: { actions: ['next'] },
      output: { actions: ['next'] },
    };
    await stream([text(FEEDBACK)]);
    expect(typing()?.textContent).toContain('Thinking...');
    await stream([text(FEEDBACK), buttons]);
    expect(typing()).toBeNull();
    await stream([text(FEEDBACK), { type: 'data-notice', data: { code: 'turn_stopped' } }]);
    expect(typing()).toBeNull();
  });

  it('lets the student open the files read once the reply is done', async () => {
    await stream([text('Welcome to the quiz.'), step('src/App.tsx'), card(1)], false);
    const stepsNode = container.querySelector('[data-testid="quiz-steps"]')!;
    expect(stepsNode.querySelector('.ant-collapse-item-active')).toBeNull();
    const header = stepsNode.querySelector<HTMLElement>('.ant-collapse-header')!;
    await act(async () => header.click());
    expect(stepsNode.querySelector('.ant-collapse-item-active')).not.toBeNull();
    expect(stepsNode.textContent).toContain('src/App.tsx');
  });

  it('keeps a card that arrived before its marker when the marker lands above it', async () => {
    // Record and present in one step: the card arrives first, its marker after.
    const parts: unknown[] = [recordCall(1), card(2)];
    await stream(parts);
    const cardNode = container.querySelector('[data-testid="quiz-question-card"]')!;
    expect(rows(container)).toHaveLength(0);

    parts.push(divider(1));
    await stream(parts);
    const [row] = rows(container);
    expect(before(row, cardNode)).toBe(true);
    expect(container.querySelector('[data-testid="quiz-question-card"]')).toBe(cardNode);
  });
});

describe('QuizChat — live and saved cut the same way', () => {
  const attempt = { id: 'attempt-1', completed_at: null, evaluation_json: null };
  const quiz = { id: 'quiz-1', question_count: 8 };
  const earlier = msg('a0', 'assistant', [text('Not quite.')]);
  const answer = msg('u1', 'user', [text('Next')]);

  beforeEach(() => {
    darkMode = false;
    chatState.messages = [];
    chatState.status = 'ready';
  });

  it("shows the owner's live chat and the saved transcript identically", () => {
    // Live the record call is in the message; the saved projection drops it.
    const live = [
      earlier,
      answer,
      msg('a1', 'assistant', [
        text(FEEDBACK),
        recordCall(1),
        step('src/App.tsx'),
        card(2),
        divider(1),
      ]),
    ];
    const saved = [
      earlier,
      answer,
      msg('a1', 'assistant', [text(FEEDBACK), step('src/App.tsx'), card(2), divider(1)]),
    ];

    const staff = dom(
      renderToStaticMarkup(
        <QuizChat quiz={quiz} attempt={attempt} transcript={saved} viewerOwnsAttempt={false} />
      )
    );
    chatState.messages = live;
    const owner = dom(
      renderToStaticMarkup(
        <QuizChat quiz={quiz} attempt={attempt} transcript={live} viewerOwnsAttempt />
      )
    );

    for (const view of [staff, owner]) {
      expect(bubbles(view)).toHaveLength(3);
      expect(rows(view)).toHaveLength(1);
      const [, feedback, next] = bubbles(view);
      const [row] = rows(view);
      expect(feedback.textContent).toContain(FEEDBACK);
      expect(next.textContent).toContain('Question 2 of 8');
      expect(before(feedback, row)).toBe(true);
      expect(before(row, view.querySelector('[data-testid="quiz-steps"]')!)).toBe(true);
      expect(before(view.querySelector('[data-testid="quiz-steps"]')!, next)).toBe(true);
    }
    const log = (view: HTMLElement) => view.querySelector('[role="log"]')!.innerHTML;
    expect(log(owner)).toBe(log(staff));
  });
});
