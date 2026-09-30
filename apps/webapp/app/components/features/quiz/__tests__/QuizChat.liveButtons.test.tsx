// @vitest-environment jsdom
/**
 * Which Try again / Next buttons can be clicked. The latest set stays usable
 * until something supersedes it: one of its buttons is clicked (or its text
 * typed, which the server takes as the click), a newer set arrives, a card or
 * a question's result arrives, or the quiz completes. A side question or an
 * argument the student types does not: the reply to it brings no buttons (Tim's
 * decision), so the set above stays the way on. A Try again click uses the set
 * up, and the hint that answers it ends with a set of its own: Next alone
 * (Tim's decision), under the same rules.
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

const { QuizTranscript, buttonSetsOf, liveButtonsOf } = await import('../QuizChat');

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

  it('is used up by a click, and a Try again hint brings a live Next of its own', async () => {
    await render([
      ...answered,
      user('u2', BUTTON_TEXT.try_again),
      msg('a3', 'assistant', [
        text("Here's a hint: think about the main axis. What do you think?"),
      ]),
    ]);
    expect(buttonSets()).toEqual([false, true]);
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
      liveButtonsOf([
        ...answered,
        msg('h1', 'user', [text('next')], { hidden: true }),
        msg('a3', 'assistant', [refused]),
      ])
    ).toEqual({ message: 2, part: 0 });
  });

  it("points at the offer's index among the visible parts", () => {
    expect(
      liveButtonsOf([
        msg('a1', 'assistant', [text('Hidden status'), text('Not quite.'), offer('o1')], {
          hiddenPartIndexes: [0],
        }),
      ])
    ).toEqual({ message: 0, part: 1 });
  });
});

describe('the Next after a hint', () => {
  const hint = (id = 'a3', parts: unknown[] = [text("Here's a hint. What do you think?")]) =>
    msg(id, 'assistant', parts);
  // The feedback and buttons, a Try again click, and the hint that answers it.
  const hinted = [...answered, user('u2', BUTTON_TEXT.try_again), hint()];

  /** The bubbles of an assistant message, by its id. */
  const bubblesOf = (id: string) => {
    const index = hinted.findIndex(m => m.id === id);
    const row = container.querySelectorAll('[data-message-role]')[index];
    return [...row.querySelectorAll('[data-testid="quiz-assistant-bubble"]')];
  };

  it('ends the hint with Next alone, no Try again and no lead-in, and a click sends Next', async () => {
    const onButton = vi.fn();
    await render(hinted, { onButton });
    expect(buttonSets()).toEqual([false, true]);

    const bubble = bubblesOf('a3').at(-1)!;
    const set = bubble.querySelector('[data-testid="quiz-next-step"]')!;
    expect(set).not.toBeNull();
    // The set comes after the hint's text, at the end of the bubble.
    expect(bubble.lastElementChild).toBe(set);
    expect(bubble.querySelector('[data-testid="quiz-try-again"]')).toBeNull();
    expect(bubble.querySelector('[data-testid="quiz-next-step-lead-in"]')).toBeNull();

    const next = set.querySelector('[data-testid="quiz-next"]') as HTMLButtonElement;
    await act(async () => next.click());
    expect(onButton).toHaveBeenCalledTimes(1);
    expect(onButton).toHaveBeenCalledWith(BUTTON_TEXT.next, 'next');
  });

  it('comes from the saved click on reload, and from the button text typed in any case', async () => {
    const saved = [...answered, user('u2', BUTTON_TEXT.try_again, { action: 'try_again' }), hint()];
    expect(buttonSetsOf(saved)).toEqual({
      live: { message: 4, hint: true },
      hintReplies: new Set([4]),
    });
    await render(saved);
    expect(buttonSets()).toEqual([false, true]);

    const typed = [...answered, user('u2', `  ${BUTTON_TEXT.try_again.toUpperCase()} `), hint()];
    expect(liveButtonsOf(typed)).toEqual({ message: 4, hint: true });
  });

  it('ends a hint that carries a refused offer ahead of its text', async () => {
    const refused = { ...offer('o2'), state: 'output-error', errorText: 'An error occurred.' };
    await render([
      ...answered,
      user('u2', BUTTON_TEXT.try_again),
      hint('a3', [refused, text("Here's a hint. What do you think?")]),
    ]);
    expect(buttonSets()).toEqual([false, true]);
  });

  it('stays usable after a side question and its text-only reply, and while one is typed', async () => {
    await render([
      ...hinted,
      user('u3', 'Can you rephrase the hint?'),
      msg('a4', 'assistant', [text('It is about which rule wins.')]),
    ]);
    // The side reply brings no set of its own; the hint's Next stays the way on.
    expect(buttonSets()).toEqual([false, true]);

    await render([...hinted, user('u3', 'Can you rephrase the hint?')]);
    expect(buttonSets()).toEqual([false, true]);
  });

  it('is used up by a click on it, or its text typed', async () => {
    await render([...hinted, user('u3', BUTTON_TEXT.next)]);
    expect(buttonSets()).toEqual([false, false]);
    await render([...hinted, user('u3', ' Next ')]);
    expect(buttonSets()).toEqual([false, false]);
  });

  it('is superseded by the new set an answer brings, by a card and by a result row', async () => {
    await render([
      ...hinted,
      user('u3', 'It aligns the items along the main axis.'),
      msg('a4', 'assistant', [offer('o2')]),
    ]);
    expect(buttonSets()).toEqual([false, false, true]);

    // The next question's card or the question's result, even without a click.
    expect(liveButtonsOf([...hinted, msg('a4', 'assistant', [card(2)])])).toBeNull();
    expect(liveButtonsOf([...hinted, msg('a4', 'assistant', [divider(1)])])).toBeNull();
    expect(
      liveButtonsOf([
        ...hinted,
        user('u3', BUTTON_TEXT.next),
        msg('a4', 'assistant', [divider(1), card(2)]),
      ])
    ).toBeNull();
    await render([
      ...hinted,
      user('u3', BUTTON_TEXT.next),
      msg('a4', 'assistant', [divider(1), card(2)]),
    ]);
    expect(buttonSets()).toEqual([false, false]);
  });

  it('is superseded by the evaluation', () => {
    const evaluation = { type: 'data-evaluation', id: 'evaluation', data: {} };
    expect(liveButtonsOf([...hinted, msg('a4', 'assistant', [evaluation])])).toBeNull();
  });

  it('keeps an earlier hint on screen, disabled, once a later set is live', async () => {
    await render([
      ...hinted,
      user('u3', 'It aligns them on the main axis.'),
      msg('a4', 'assistant', [offer('o2')]),
      user('u4', BUTTON_TEXT.try_again),
      hint('a5'),
    ]);
    expect(buttonSets()).toEqual([false, false, false, true]);
  });

  it('is not added to a reply that brings buttons, a card or a result of its own', async () => {
    for (const parts of [[offer('o2', ['next'])], [card(1)], [divider(1)]]) {
      const set = buttonSetsOf([...answered, user('u2', BUTTON_TEXT.try_again), hint('a3', parts)]);
      expect(set.hintReplies.size).toBe(0);
    }
  });

  it('is not added to a reply to anything but a Try again click', async () => {
    await render([...answered, user('u2', 'Give me a hint'), hint()]);
    expect(buttonSets()).toEqual([true]);
    await render([msg('a1', 'assistant', [card(1)]), user('u1', 'Is it flexbox?'), hint('a2')]);
    expect(buttonSets()).toEqual([]);
  });

  it('shows no Next while the hint is still streaming', async () => {
    await render(hinted, { busy: true });
    expect(buttonSets()).toEqual([false]);
  });

  it('is disabled once the quiz completes, while a turn runs, and in a read-only view', async () => {
    await render(hinted, { status: 'complete' });
    expect(buttonSets()).toEqual([false, false]);
    await render([...hinted, user('u3', 'side question')], { busy: true });
    expect(buttonSets()).toEqual([false, false]);
    await render(hinted, { onButton: null });
    expect(buttonSets()).toEqual([false, false]);
  });
});
