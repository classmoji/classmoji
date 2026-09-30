// @vitest-environment jsdom
/**
 * Which Try again / Next buttons can be clicked. The latest set stays usable
 * until something supersedes it: one of its buttons is clicked (or its text
 * typed, which the server takes as the click), a newer set arrives, a card or
 * a question's result arrives, or the quiz completes. A side question or an
 * argument the student types does not: the reply to it brings no buttons (Tim's
 * decision), so the set above stays the way on. A Try again click uses the set
 * up, so the hint turn shows no live buttons.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUTTON_TEXT, type QuizUIMessage } from '@classmoji/utils/quiz-agent';

vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
vi.mock('react-router', () => ({ useRevalidator: () => ({ revalidate: vi.fn() }) }));
vi.mock('@ai-sdk/react', () => ({ useChat: () => ({ messages: [], status: 'ready' }) }));
vi.mock('@trigger.dev/sdk/chat/react', () => ({
  useTriggerChatTransport: () => ({}),
  useChatActions: () => ({ sendAction: vi.fn() }),
}));
vi.mock('~/routes/student.$class.quizzes/ChatEditor', () => ({ default: () => null }));

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

const { QuizTranscript, liveOfferOf } = await import('../QuizChat');

const msg = (id: string, role: 'user' | 'assistant', parts: unknown[], metadata?: unknown) =>
  ({ id, role, parts, ...(metadata ? { metadata } : {}) }) as unknown as QuizUIMessage;
const text = (t: string) => ({ type: 'text', text: t });
const offer = (id: string, actions = ['try_again', 'next']) => ({
  type: 'tool-offer_next_step',
  toolCallId: id,
  state: 'output-available',
  input: { feedback: `Feedback ${id}`, actions },
  output: { actions, lead_in: 'Would you like to try again or move on?' },
});
const CARD = { total_questions: 8, question_text: 'Why flexbox?' };
const card = (n: number) => ({
  type: 'tool-present_question',
  toolCallId: `call-q${n}`,
  state: 'output-available',
  input: { ...CARD, question_number: n },
  output: { card: CARD, question_number: n, total_questions: 8 },
});
const divider = (n: number) => ({
  type: 'data-question-result',
  id: `question-result-${n}`,
  data: { question_num: n, emoji: 'heart', brief_feedback: `Feedback ${n}` },
});
const user = (id: string, t: string, metadata?: unknown) => msg(id, 'user', [text(t)], metadata);

// Q1 is out, the student answered, the agent gave feedback and buttons.
const answered = [
  msg('a1', 'assistant', [card(1)]),
  user('u1', 'Because it lines things up.'),
  msg('a2', 'assistant', [offer('o1')]),
];

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

const render = async (
  messages: QuizUIMessage[],
  extra: Partial<Parameters<typeof QuizTranscript>[0]> = {}
) => {
  await act(async () => {
    root.render(
      <QuizTranscript
        messages={messages}
        status="ready"
        busy={false}
        isDarkMode={false}
        onButton={vi.fn()}
        {...extra}
      />
    );
  });
};

/** Each button set on screen, top to bottom: whether its buttons can be clicked. */
const buttonSets = () =>
  [...container.querySelectorAll('[data-testid="quiz-next-step"]')].map(set =>
    [...set.querySelectorAll('button')].every(b => !(b as HTMLButtonElement).disabled)
  );

describe('the live button set', () => {
  it('is usable right after the feedback', async () => {
    await render(answered);
    expect(buttonSets()).toEqual([true]);
  });

  it('stays usable after a side question and its text-only reply', async () => {
    await render([
      ...answered,
      user('u2', "Why won't you grade that?"),
      msg('a3', 'assistant', [text('Because the question asks about layout, not colour.')]),
      user('u3', 'That seems unfair.'),
      msg('a4', 'assistant', [text('I hear you. The rubric asks for the layout reason.')]),
    ]);
    expect(buttonSets()).toEqual([true]);
  });

  it('stays usable while the student is typing a side question with no reply yet', async () => {
    await render([...answered, user('u2', 'Can you rephrase that?')]);
    expect(buttonSets()).toEqual([true]);
  });

  it('is used up by a click, and a Try again hint brings no live buttons', async () => {
    await render([
      ...answered,
      user('u2', BUTTON_TEXT.try_again),
      msg('a3', 'assistant', [
        text("Here's a hint: think about the main axis. What do you think?"),
      ]),
    ]);
    expect(buttonSets()).toEqual([false]);
  });

  it('is used up by the button text typed in any case, as the server takes it', async () => {
    await render([...answered, user('u2', '  NEXT ')]);
    expect(buttonSets()).toEqual([false]);
  });

  it('is used up by a saved click (its stored action)', async () => {
    await render([
      ...answered,
      user('u2', "I'd like to try answering this question again", { action: 'try_again' }),
    ]);
    expect(buttonSets()).toEqual([false]);
  });

  it('is superseded by a newer set after a new answer', async () => {
    await render([
      ...answered,
      user('u2', "Why won't you grade that?"),
      msg('a3', 'assistant', [text('The rubric asks for the layout reason.')]),
      user('u3', 'It aligns the items along the main axis.'),
      msg('a4', 'assistant', [offer('o2', ['next'])]),
    ]);
    expect(buttonSets()).toEqual([false, true]);
  });

  it('is superseded by a question card or a result row', async () => {
    await render([...answered, user('u2', 'next'), msg('a3', 'assistant', [divider(1), card(2)])]);
    expect(buttonSets()).toEqual([false]);

    // A later card or a result after the set supersedes it even without a click.
    await render([...answered, msg('a3', 'assistant', [card(2)])]);
    expect(buttonSets()).toEqual([false]);
    await render([...answered, msg('a3', 'assistant', [divider(1)])]);
    expect(buttonSets()).toEqual([false]);
  });

  it("stays usable when the question's card is shown again, or an earlier result is revised", async () => {
    await render([
      ...answered,
      user('u2', 'Can you show me the question again?'),
      msg('a3', 'assistant', [card(1)]),
    ]);
    expect(buttonSets()).toEqual([true]);

    const revised = { ...divider(1), id: 'question-result-1-revised' };
    revised.data = { ...revised.data, revised: true } as typeof revised.data;
    await render([
      msg('a0', 'assistant', [divider(1), card(2)]),
      user('u1', 'Because it lines things up.'),
      msg('a2', 'assistant', [offer('o1')]),
      user('u2', 'About question 1: I meant the cross axis.'),
      msg('a3', 'assistant', [revised, text('Noted, I updated question 1.')]),
    ]);
    expect(buttonSets()).toEqual([true]);
  });

  it('is disabled once the quiz completes, while a turn runs, and in a read-only view', async () => {
    await render(answered, { status: 'complete' });
    expect(buttonSets()).toEqual([false]);
    await render(answered, { busy: true });
    expect(buttonSets()).toEqual([false]);
    await render(answered, { onButton: null });
    expect(buttonSets()).toEqual([false]);
  });

  it('ignores hidden messages and a refused offer', async () => {
    const refused = { ...offer('o2'), state: 'output-error', errorText: 'An error occurred.' };
    expect(
      liveOfferOf([
        ...answered,
        msg('h1', 'user', [text('next')], { hidden: true }),
        msg('a3', 'assistant', [refused]),
      ])
    ).toEqual({ message: 2, part: 0 });
  });

  it("points at the offer's index among the visible parts", () => {
    expect(
      liveOfferOf([
        msg('a1', 'assistant', [text('Hidden status'), text('Not quite.'), offer('o1')], {
          hiddenPartIndexes: [0],
        }),
      ])
    ).toEqual({ message: 0, part: 1 });
  });
});
