// @vitest-environment jsdom
/**
 * The quiz form's "Hint cost" and "Answers per question", MOUNTED in jsdom.
 *
 *   loader: quiz.hint_cost / max_answers → hintCost / maxAnswers (15 / 5 when absent)
 *   new:    15 and 5
 *   rules:  the quiz service's own checks (checkHintCost / checkMaxAnswers),
 *           so a field shows the message the server would answer with
 *   submit: numbers, for the owner and teachers; read-only for an assistant and
 *           left out of their save (QUIZ_AUTHOR_SETTING_KEYS)
 */

import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUIZ_AUTHOR_SETTING_KEYS } from '@classmoji/utils';

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  assertClassroomAccess: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
  quizFindById: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: { findByClassroomId: async () => [] },
    module: { findByClassroomSlug: async () => [] },
    quizSourceMaterial: { listSourceMaterialOptions: async () => ({ pages: [], decks: [] }) },
    quiz: { findById: (...a: unknown[]) => mocks.quizFindById(...a) },
  },
  getExamplePrompts: () => [],
}));
vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
}));
vi.mock('~/utils/classroomProFlag.server', () => ({
  quizzesVisibleOrThrow: (...a: unknown[]) => mocks.quizzesVisibleOrThrow(...a),
}));
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));
vi.mock('~/hooks', () => ({
  useRouteDrawer: () => ({ opened: true, close: vi.fn() }),
  useDarkMode: () => ({ isDarkMode: false }),
}));
vi.mock('react-router', () => ({
  useFetcher: () => ({ state: 'idle', data: undefined, submit: mocks.submit }),
  useLocation: () => ({ pathname: '/teacher/cs52-26f/quizzes/form' }),
  useNavigate: () => vi.fn(),
  useParams: () => ({ class: 'cs52-26f' }),
}));
// The Drawer's portal and motion are not what is under test.
vi.mock('antd', async () => {
  const antd = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...antd,
    Drawer: ({ children, footer }: { children: ReactNode; footer: ReactNode }) => (
      <div>
        {children}
        {footer}
      </div>
    ),
  };
});

// antd's Form.Item lays out with Row/Col, whose responsive observer needs it.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
// As in codeSandbox.test.tsx: jsdom's selector engine throws on antd's
// `:has(> .ant-switch:only-child)` rule against a Tailwind `lg:` class; layout
// is not under test, so such a read falls back to the body's style.
const realGetComputedStyle = window.getComputedStyle.bind(window);
window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
  try {
    return realGetComputedStyle(element, pseudo);
  } catch {
    return realGetComputedStyle(document.body);
  }
}) as typeof window.getComputedStyle;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: QuizFormDrawer, loader } = await import('../route');

const CLASS_SLUG = 'cs52-26f';
const HINT_EXTRA =
  'Points off each answer a student gives after a hint on that question. 0 makes hints free.';
const ANSWERS_EXTRA = 'After the last one the quiz explains the answer and moves on.';

/** The quiz as the loader hands it to the form. */
const formQuiz = (over: Record<string, unknown> = {}) => ({
  id: 'quiz-1',
  name: 'Landing page check-in',
  repositoryId: null,
  systemPrompt: null,
  rubricPrompt: 'Grade the answers.',
  subject: 'CSS',
  difficultyLevel: 'Beginner',
  questionCount: 5,
  maxAttempts: 1,
  gradingStrategy: 'HIGHEST',
  hintCost: 20,
  maxAnswers: 3,
  includeCodeContext: false,
  sourceMaterial: [],
  courseSearchEnabled: false,
  codeSandboxEnabled: false,
  excludedPaths: '',
  ...over,
});

let container: HTMLDivElement;
let root: Root;

const render = async (
  quiz: Record<string, unknown> | null,
  { canAuthor = true }: { canAuthor?: boolean } = {}
) => {
  await act(async () => {
    root.render(
      <QuizFormDrawer
        {...({
          loaderData: {
            org: CLASS_SLUG,
            quiz,
            isEditing: Boolean(quiz),
            assignments: [],
            examplePrompts: [],
            sourceMaterialOptions: { pages: [], decks: [] },
            canAuthor,
            isOwner: false,
            modules: [{ id: 'mod-1', title: 'Week 1' }],
            assignmentPanel: {
              moduleId: quiz ? 'mod-1' : null,
              moduleTitle: quiz ? 'Week 1' : null,
              releaseAt: null,
              dueDate: null,
              closesAt: null,
              weight: 0,
              isPublished: false,
            },
          },
        } as unknown as Parameters<typeof QuizFormDrawer>[0])}
      />
    );
  });
};

const hintCost = () => container.querySelector<HTMLInputElement>('input#hintCost')!;
const maxAnswers = () => container.querySelector<HTMLInputElement>('input#maxAnswers')!;
const updateButton = () =>
  [...container.querySelectorAll('button')].find(button => button.textContent === 'Update')!;
const errorsOf = (input: HTMLInputElement) =>
  [...input.closest('.ant-form-item')!.querySelectorAll('.ant-form-item-explain-error')].map(
    e => e.textContent
  );

/** Type into a field the way React sees a user do it. */
const type = async (input: HTMLInputElement, text: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const clickUpdate = async () => {
  await act(async () => {
    updateButton().click();
  });
};

beforeEach(() => {
  mocks.submit.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('Hint cost and Answers per question in the quiz form', () => {
  it('are shown with their labels, help text, ranges and saved values', async () => {
    await render(formQuiz());

    const hintItem = hintCost().closest('.ant-form-item')!;
    expect(hintItem.querySelector('label')?.textContent).toBe('Hint cost');
    expect(hintItem.querySelector('.ant-form-item-extra')?.textContent).toBe(HINT_EXTRA);
    expect(hintCost().getAttribute('data-testid')).toBe('quiz-hint-cost');
    expect(hintCost().type).toBe('number');
    expect([hintCost().min, hintCost().max]).toEqual(['0', '50']);
    expect(hintCost().value).toBe('20');

    const answersItem = maxAnswers().closest('.ant-form-item')!;
    expect(answersItem.querySelector('label')?.textContent).toBe('Answers per question');
    expect(answersItem.querySelector('.ant-form-item-extra')?.textContent).toBe(ANSWERS_EXTRA);
    expect(maxAnswers().getAttribute('data-testid')).toBe('quiz-max-answers');
    expect([maxAnswers().min, maxAnswers().max]).toEqual(['1', '20']);
    expect(maxAnswers().value).toBe('3');

    expect(hintCost().disabled).toBe(false);
    expect(maxAnswers().disabled).toBe(false);
  });

  it('start at 15 and 5 on a new quiz', async () => {
    await render(null);
    expect(hintCost().value).toBe('15');
    expect(maxAnswers().value).toBe('5');
  });

  it('post what was typed as numbers', async () => {
    await render(formQuiz());
    await type(hintCost(), '0');
    await type(maxAnswers(), '12');

    await clickUpdate();
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    const [payload] = mocks.submit.mock.calls[0];
    expect(payload).toMatchObject({ _action: 'updateQuiz', hintCost: 0, maxAnswers: 12 });
    expect(typeof payload.hintCost).toBe('number');
    expect(typeof payload.maxAnswers).toBe('number');
  });

  it('post the saved values unchanged as numbers', async () => {
    await render(formQuiz());

    await clickUpdate();
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0][0]).toMatchObject({ hintCost: 20, maxAnswers: 3 });
  });

  it.each([
    ['51', 'Hint cost must be a whole number from 0 to 50.'],
    ['-1', 'Hint cost must be a whole number from 0 to 50.'],
    ['2.5', 'Hint cost must be a whole number from 0 to 50.'],
    // A cleared field is refused, never saved as 0 (free hints).
    ['', 'Hint cost must be a whole number from 0 to 50.'],
  ])(
    'refuses a hint cost of %j with the server’s message, sending nothing',
    async (text, message) => {
      await render(formQuiz());
      await type(hintCost(), text);

      await clickUpdate();
      await vi.waitFor(() => expect(errorsOf(hintCost())).toEqual([message]));
      expect(mocks.submit).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['0', 'Answers per question must be a whole number from 1 to 20.'],
    ['21', 'Answers per question must be a whole number from 1 to 20.'],
    ['', 'Answers per question must be a whole number from 1 to 20.'],
  ])('refuses answers per question of %j with the server’s message', async (text, message) => {
    await render(formQuiz());
    await type(maxAnswers(), text);

    await clickUpdate();
    await vi.waitFor(() => expect(errorsOf(maxAnswers())).toEqual([message]));
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('are read-only for an assistant and left out of their save', async () => {
    expect(QUIZ_AUTHOR_SETTING_KEYS as readonly string[]).toEqual(
      expect.arrayContaining(['hintCost', 'maxAnswers'])
    );
    await render(formQuiz(), { canAuthor: false });
    expect(hintCost().disabled).toBe(true);
    expect(maxAnswers().disabled).toBe(true);

    await clickUpdate();
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    const [payload] = mocks.submit.mock.calls[0];
    expect(payload).not.toHaveProperty('hintCost');
    expect(payload).not.toHaveProperty('maxAnswers');
  });

  it('never block an assistant’s save, since they cannot change them', async () => {
    await render(formQuiz({ hintCost: undefined, maxAnswers: 99 }), { canAuthor: false });

    await clickUpdate();
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0][0]).not.toHaveProperty('maxAnswers');
  });
});

describe('the loader', () => {
  const load = async () =>
    (await loader({
      params: { class: CLASS_SLUG },
      request: new Request(`http://localhost/teacher/${CLASS_SLUG}/quizzes/form?quizId=quiz-1`),
    } as unknown as Parameters<typeof loader>[0])) as Awaited<ReturnType<typeof loader>>;

  const found = (over: Record<string, unknown>) => ({
    id: 'quiz-1',
    classroom_id: 'class-1',
    name: 'Q',
    source_material: [],
    excluded_paths: [],
    ...over,
  });

  beforeEach(() => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: 'teacher-1',
      classroom: { id: 'class-1', slug: CLASS_SLUG },
      membership: { role: 'TEACHER' },
    });
    mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  });

  it('hands the form the saved values, 0 included', async () => {
    mocks.quizFindById.mockResolvedValue(found({ hint_cost: 0, max_answers: 20 }));
    expect((await load()).quiz).toMatchObject({ hintCost: 0, maxAnswers: 20 });
  });

  it('falls back to 15 and 5 for a row without them', async () => {
    mocks.quizFindById.mockResolvedValue(found({}));
    expect((await load()).quiz).toMatchObject({ hintCost: 15, maxAnswers: 5 });
  });
});
