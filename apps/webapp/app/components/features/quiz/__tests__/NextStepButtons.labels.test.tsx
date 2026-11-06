// @vitest-environment jsdom
/**
 * The hint and move-on buttons' labels (Tim's decisions):
 *
 *   - the hint button reads "Try again with hint", sends "Give me a hint",
 *     and on hover says what a hint costs on the question (the offer's
 *     `hint_cost`; 0 reads as free; a part saved before the cost was sent
 *     reads the old fixed cost, 15);
 *   - while the question is open (the offer has the hint button, or the
 *     buttons follow a hint) the move-on button skips it: "Skip to next
 *     question", or "Skip to results" on the last question, not primary;
 *   - once the question is finished (Next alone): "Next question →", or
 *     "See results →" on the last question, primary.
 *
 * Whether it is the last question: the offer's `last_question`; for a part
 * saved before it was sent, a results lead-in, or else the card it follows.
 */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUTTON_TEXT, NEXT_STEP_LEAD_IN, type QuizUIMessage } from '@classmoji/utils/quiz-agent';

vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate: vi.fn() }) }));
vi.mock('@ai-sdk/react', () => ({ useChat: () => ({ messages: [], status: 'ready' }) }));
vi.mock('@trigger.dev/sdk/chat/react', () => ({
  useTriggerChatTransport: () => ({}),
  useChatActions: () => ({ sendAction: vi.fn() }),
}));
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({ default: () => null }));
// The tooltip's text, on the element it wraps (antd draws it only on hover).
vi.mock('antd', async importOriginal => ({
  ...(await importOriginal<typeof import('antd')>()),
  Tooltip: ({ title, children }: { title: ReactNode; children: ReactNode }) => (
    <span data-testid="tooltip" data-title={String(title)}>
      {children}
    </span>
  ),
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

const { default: NextStepButtons } = await import('../NextStepButtons');
const { QuizTranscript } = await import('../QuizChat');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const mount = async (node: ReactNode) => {
  await act(async () => root.render(node));
};

const hintButton = () =>
  container.querySelector<HTMLButtonElement>('[data-testid="quiz-try-again"]');
const nextButton = () => container.querySelector<HTMLButtonElement>('[data-testid="quiz-next"]');
const isPrimary = (button: HTMLButtonElement | null) =>
  Boolean(button?.className.includes('ant-btn-primary'));
const tooltip = () =>
  container.querySelector('[data-testid="tooltip"]')?.getAttribute('data-title');

describe('NextStepButtons', () => {
  it('labels an open question: hint, and a skip that is not primary', async () => {
    await mount(
      <NextStepButtons actions={['try_again', 'next']} hintCost={10} onAction={vi.fn()} />
    );
    expect(hintButton()?.textContent).toBe('Try again with hint');
    expect(nextButton()?.textContent).toBe('Skip to next question');
    expect(isPrimary(nextButton())).toBe(false);

    await mount(
      <NextStepButtons actions={['try_again', 'next']} lastQuestion onAction={vi.fn()} />
    );
    expect(nextButton()?.textContent).toBe('Skip to results');
    expect(isPrimary(nextButton())).toBe(false);
  });

  it('labels a finished question: the primary way on', async () => {
    await mount(<NextStepButtons actions={['next']} onAction={vi.fn()} />);
    expect(hintButton()).toBeNull();
    expect(nextButton()?.textContent).toBe('Next question →');
    expect(isPrimary(nextButton())).toBe(true);

    await mount(<NextStepButtons actions={['next']} lastQuestion onAction={vi.fn()} />);
    expect(nextButton()?.textContent).toBe('See results →');
    expect(isPrimary(nextButton())).toBe(true);
  });

  it('labels Next alone after a hint as a skip: the question is still open', async () => {
    await mount(<NextStepButtons actions={['next']} open onAction={vi.fn()} />);
    expect(nextButton()?.textContent).toBe('Skip to next question');
    expect(isPrimary(nextButton())).toBe(false);
    await mount(<NextStepButtons actions={['next']} open lastQuestion onAction={vi.fn()} />);
    expect(nextButton()?.textContent).toBe('Skip to results');
  });

  it('says on hover what the hint costs, free at 0, and the old cost on a part without one', async () => {
    await mount(<NextStepButtons actions={['try_again', 'next']} hintCost={10} />);
    expect(tooltip()).toBe('This hint costs 10 points on this question.');
    await mount(<NextStepButtons actions={['try_again', 'next']} hintCost={0} />);
    expect(tooltip()).toBe('Hints are free on this quiz.');
    await mount(<NextStepButtons actions={['try_again', 'next']} />);
    expect(tooltip()).toBe('This hint costs 15 points on this question.');
  });

  it('sends "Give me a hint" for the hint, and "next" to move on', async () => {
    const onAction = vi.fn();
    await mount(<NextStepButtons actions={['try_again', 'next']} onAction={onAction} />);
    await act(async () => hintButton()!.click());
    expect(BUTTON_TEXT.try_again).toBe('Give me a hint');
    expect(onAction).toHaveBeenLastCalledWith('Give me a hint', 'try_again');
    await act(async () => nextButton()!.click());
    expect(onAction).toHaveBeenLastCalledWith('next', 'next');
  });
});

const msg = (id: string, role: 'user' | 'assistant', parts: unknown[]) =>
  ({ id, role, parts }) as unknown as QuizUIMessage;
const card = (n: number, total = 3) => ({
  type: 'tool-present_question',
  toolCallId: `call-q${n}`,
  state: 'output-available',
  input: {},
  output: { card: { question_text: `Question ${n}?` }, question_number: n, total_questions: total },
});
const offer = (id: string, output: Record<string, unknown>) => ({
  type: 'tool-offer_next_step',
  toolCallId: id,
  state: 'output-available',
  input: { feedback: `Feedback ${id}` },
  output,
});
const user = (id: string, t: string) => msg(id, 'user', [{ type: 'text', text: t }]);

const transcript = async (messages: QuizUIMessage[]) =>
  mount(
    <QuizTranscript
      messages={messages}
      status="ready"
      busy={false}
      isDarkMode={false}
      onButton={vi.fn()}
    />
  );

describe('the buttons in the transcript', () => {
  it("passes the offer's cost and last_question on", async () => {
    await transcript([
      msg('a1', 'assistant', [card(1)]),
      user('u1', 'An answer.'),
      msg('a2', 'assistant', [
        offer('o1', {
          actions: ['try_again', 'next'],
          lead_in: NEXT_STEP_LEAD_IN.try_again_or_next,
          answers_used: 1,
          max_answers: 3,
          hint_cost: 5,
          // The server's word wins over the card.
          last_question: true,
        }),
      ]),
    ]);
    expect(tooltip()).toBe('This hint costs 5 points on this question.');
    expect(nextButton()?.textContent).toBe('Skip to results');
  });

  it('reads a saved finished offer on the last question from its results lead-in', async () => {
    for (const lead_in of [NEXT_STEP_LEAD_IN.results, NEXT_STEP_LEAD_IN.last_answer_results]) {
      await transcript([msg('a2', 'assistant', [offer('o1', { actions: ['next'], lead_in })])]);
      expect(nextButton()?.textContent).toBe('See results →');
    }
    await transcript([
      msg('a2', 'assistant', [offer('o1', { actions: ['next'], lead_in: NEXT_STEP_LEAD_IN.next })]),
    ]);
    expect(nextButton()?.textContent).toBe('Next question →');
  });

  it('reads a saved open offer from the card it follows', async () => {
    const legacy = {
      actions: ['try_again', 'next'],
      lead_in: 'Would you like to try again or move on?',
    };
    await transcript([
      msg('a1', 'assistant', [card(3)]),
      user('u1', 'An answer.'),
      msg('a2', 'assistant', [offer('o1', legacy)]),
    ]);
    expect(nextButton()?.textContent).toBe('Skip to results');
    expect(tooltip()).toBe('This hint costs 15 points on this question.');

    await transcript([
      msg('a1', 'assistant', [card(2)]),
      user('u1', 'An answer.'),
      msg('a2', 'assistant', [offer('o1', legacy)]),
    ]);
    expect(nextButton()?.textContent).toBe('Skip to next question');
  });

  it('labels the Next after a hint as a skip, to results on the last question', async () => {
    const hinted = (n: number) => [
      msg('a1', 'assistant', [card(n)]),
      user('u1', 'An answer.'),
      msg('a2', 'assistant', [
        offer('o1', {
          actions: ['try_again', 'next'],
          lead_in: NEXT_STEP_LEAD_IN.try_again_or_next,
        }),
      ]),
      user('u2', BUTTON_TEXT.try_again),
      msg('a3', 'assistant', [{ type: 'text', text: "Here's a hint. What do you think?" }]),
    ];
    await transcript(hinted(1));
    const live = () =>
      [...container.querySelectorAll<HTMLButtonElement>('[data-testid="quiz-next"]')].at(-1)!;
    expect(live().textContent).toBe('Skip to next question');
    expect(isPrimary(live())).toBe(false);
    expect(live().disabled).toBe(false);

    await transcript(hinted(3));
    expect(live().textContent).toBe('Skip to results');
  });
});
