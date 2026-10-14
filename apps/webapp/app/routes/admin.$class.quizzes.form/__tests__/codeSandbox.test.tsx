// @vitest-environment jsdom
/**
 * The quiz form's "Code sandbox questions" switch, MOUNTED in jsdom.
 *
 *   loader: quiz.code_sandbox_enabled → codeSandboxEnabled
 *   shown:  while new attempts of the quiz, as the form has it, run on the
 *           chat runtime (the message limit's rule: runsOnChatRuntime), the
 *           only runtime that offers sandboxes
 *   submit: its value, for the owner and teachers and for an assistant alike
 *           (a content setting, not in QUIZ_AUTHOR_SETTING_KEYS)
 *   hidden: nothing is sent, so the saved value is left as it is
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
vi.mock('~/components/quiz/PromptAssistant', () => ({ PromptAssistant: () => null }));
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
// As in messageLimit.test.tsx: jsdom's selector engine throws on antd's
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
const EXTRA =
  'Lets the quiz ask questions the student answers in an editable code sandbox ' +
  '(HTML/CSS/JS, TypeScript or React).';

type ChatRuntime = { codeAware: boolean; other: boolean };
const EVERY_QUIZ: ChatRuntime = { codeAware: true, other: true };
const CODE_AWARE_ONLY: ChatRuntime = { codeAware: true, other: false };
const NONE: ChatRuntime = { codeAware: false, other: false };

/** The quiz as the loader hands it to the form: a regular (not code-aware) quiz. */
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
  chatRuntime: ChatRuntime | undefined,
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
            assignments: [{ id: 'repo-1', title: 'Landing page' }],
            examplePrompts: [],
            sourceMaterialOptions: { pages: [], decks: [] },
            // A teacher (or an assistant) editing a quiz in Week 1.
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
            ...(chatRuntime ? { chatRuntime } : {}),
          },
        } as unknown as Parameters<typeof QuizFormDrawer>[0])}
      />
    );
  });
};

const sandboxSwitch = () => container.querySelector<HTMLButtonElement>('button#codeSandboxEnabled');
const codeAwareSwitch = () => container.querySelector<HTMLButtonElement>('#includeCodeContext')!;
const updateButton = () =>
  [...container.querySelectorAll('button')].find(button => button.textContent === 'Update')!;

const clickUpdate = async () => {
  await act(async () => {
    updateButton().click();
  });
};

const remount = async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
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

describe('Code sandbox questions in the quiz form', () => {
  it('is shown with its label and help text when every quiz runs on the chat runtime', async () => {
    await render(formQuiz(), EVERY_QUIZ);

    const item = sandboxSwitch()!.closest('.ant-form-item')!;
    expect(item.querySelector('label')?.textContent).toBe('Code sandbox questions');
    expect(item.querySelector('.ant-form-item-extra')?.textContent).toBe(EXTRA);
    expect(sandboxSwitch()!.getAttribute('aria-checked')).toBe('false');
    expect(sandboxSwitch()!.disabled).toBe(false);
  });

  it('sits with the content settings, right after whole-course search', async () => {
    await render(formQuiz(), EVERY_QUIZ);

    const labels = [...container.querySelectorAll('.ant-form-item-label label')].map(
      label => label.textContent
    );
    const search = labels.indexOf('Allow whole-course search');
    expect(search).toBeGreaterThanOrEqual(0);
    expect(labels[search + 1]).toBe('Code sandbox questions');
  });

  it('starts off on a new quiz', async () => {
    await render(null, EVERY_QUIZ);
    expect(sandboxSwitch()!.getAttribute('aria-checked')).toBe('false');
  });

  it('follows the Code-Aware switch when only code-aware quizzes run on the chat runtime', async () => {
    await render(formQuiz({ repositoryId: 'repo-1' }), CODE_AWARE_ONLY);
    expect(sandboxSwitch()).toBeNull();

    await act(async () => {
      codeAwareSwitch().click();
    });
    expect(sandboxSwitch()).not.toBeNull();

    await act(async () => {
      codeAwareSwitch().click();
    });
    expect(sandboxSwitch()).toBeNull();
  });

  it('is hidden when no quiz runs on the chat runtime, or the loader sent no reading', async () => {
    await render(formQuiz({ codeSandboxEnabled: true }), NONE);
    expect(sandboxSwitch()).toBeNull();
    expect(container.textContent).not.toContain('Code sandbox questions');

    await remount();
    await render(formQuiz({ codeSandboxEnabled: true }), undefined);
    expect(sandboxSwitch()).toBeNull();
  });

  it('round-trips: shows the saved value, and the save carries it, then the change', async () => {
    await render(formQuiz({ codeSandboxEnabled: true }), EVERY_QUIZ);
    expect(sandboxSwitch()!.getAttribute('aria-checked')).toBe('true');

    await clickUpdate();
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    const [payload, options] = mocks.submit.mock.calls[0];
    expect(payload).toMatchObject({
      _action: 'updateQuiz',
      id: 'quiz-1',
      codeSandboxEnabled: true,
    });
    expect(options).toMatchObject({ action: `/teacher/${CLASS_SLUG}/quizzes` });

    mocks.submit.mockReset();
    await act(async () => {
      sandboxSwitch()!.click();
    });
    expect(sandboxSwitch()!.getAttribute('aria-checked')).toBe('false');
    await clickUpdate();
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0][0].codeSandboxEnabled).toBe(false);
  });

  it('sends nothing while hidden, so the saved value stays', async () => {
    await render(formQuiz({ codeSandboxEnabled: true }), NONE);
    await clickUpdate();

    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0][0]).not.toHaveProperty('codeSandboxEnabled');
  });

  it("is an assistant's to change: enabled, and carried in their save", async () => {
    expect(QUIZ_AUTHOR_SETTING_KEYS as readonly string[]).not.toContain('codeSandboxEnabled');

    await render(formQuiz(), EVERY_QUIZ, { canAuthor: false });
    expect(sandboxSwitch()!.disabled).toBe(false);

    await act(async () => {
      sandboxSwitch()!.click();
    });
    await clickUpdate();
    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    const [payload] = mocks.submit.mock.calls[0];
    expect(payload.codeSandboxEnabled).toBe(true);
    // The author settings are still left out of an assistant's save.
    for (const key of QUIZ_AUTHOR_SETTING_KEYS) expect(payload).not.toHaveProperty(key);
  });
});

describe('the loader', () => {
  const load = async () =>
    (await loader({
      params: { class: CLASS_SLUG },
      request: new Request(`http://localhost/teacher/${CLASS_SLUG}/quizzes/form?quizId=quiz-1`),
    } as unknown as Parameters<typeof loader>[0])) as Awaited<ReturnType<typeof loader>>;

  beforeEach(() => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: 'teacher-1',
      classroom: { id: 'class-1', slug: CLASS_SLUG },
      membership: { role: 'TEACHER' },
    });
    mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  });

  it.each([true, false])('hands the form the saved switch (%s)', async value => {
    mocks.quizFindById.mockResolvedValue({
      id: 'quiz-1',
      classroom_id: 'class-1',
      name: 'Q',
      source_material: [],
      excluded_paths: [],
      code_sandbox_enabled: value,
    });
    expect((await load()).quiz!.codeSandboxEnabled).toBe(value);
  });
});
