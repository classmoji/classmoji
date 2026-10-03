// @vitest-environment jsdom
/**
 * The quiz form's "Paths to exclude", MOUNTED in jsdom.
 *
 *   loader: quiz.excluded_paths → the textarea's text, one pattern per line
 *   shown:  only while Code-Aware Quiz is on
 *   submit: the text → a list, trimmed, blank lines dropped; a pattern the
 *           quiz service would refuse is refused here first, with its reason
 *   hidden: nothing is sent, so the saved list is left as it is
 */

import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
// A Form.Item showing a message reads its computed margin. jsdom's selector
// engine throws matching antd's `:has(> .ant-switch:only-child)` rule against
// an element whose class holds a colon (the drawer's Tailwind `lg:` classes);
// a browser does not. Layout is not under test, so such a read falls back to
// the body's style instead of failing the render.
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

/** The quiz as the loader hands it to the form. */
const formQuiz = (over: Record<string, unknown> = {}) => ({
  id: 'quiz-1',
  name: 'Landing page check-in',
  repositoryId: 'repo-1',
  systemPrompt: null,
  rubricPrompt: 'Grade the answers.',
  subject: 'CSS',
  difficultyLevel: 'Beginner',
  questionCount: 5,
  maxAttempts: 1,
  gradingStrategy: 'HIGHEST',
  includeCodeContext: true,
  sourceMaterial: [],
  courseSearchEnabled: false,
  excludedPaths: 'tests/**\n**/*.spec.js',
  ...over,
});

let container: HTMLDivElement;
let root: Root;

const render = async (quiz: Record<string, unknown>) => {
  await act(async () => {
    root.render(
      <QuizFormDrawer
        {...({
          loaderData: {
            org: CLASS_SLUG,
            quiz,
            isEditing: true,
            assignments: [{ id: 'repo-1', title: 'Landing page' }],
            examplePrompts: [],
            sourceMaterialOptions: { pages: [], decks: [] },
            // A teacher editing a quiz in Week 1: the Assignment panel is
            // theirs, and the module is chosen, so Update is enabled.
            canAuthor: true,
            isOwner: false,
            modules: [{ id: 'mod-1', title: 'Week 1' }],
            assignmentPanel: {
              moduleId: 'mod-1',
              moduleTitle: 'Week 1',
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

const textarea = () => container.querySelector<HTMLTextAreaElement>('textarea#excludedPaths');
const codeAwareSwitch = () => container.querySelector<HTMLButtonElement>('#includeCodeContext')!;
const updateButton = () =>
  [...container.querySelectorAll('button')].find(button => button.textContent === 'Update')!;

/** Type into the textarea the way React sees a user do it. */
const type = async (text: string) => {
  const input = textarea()!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
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

describe('Paths to exclude in the quiz form', () => {
  it('shows the saved patterns, one per line, on a code-aware quiz', async () => {
    await render(formQuiz());

    expect(textarea()?.value).toBe('tests/**\n**/*.spec.js');
    expect(textarea()?.placeholder).toBe('tests/**\n**/*.spec.js\nplaywright.config.*');
    expect(container.textContent).toContain('Paths to exclude');
    expect(container.textContent).toContain(
      'One pattern per line, like .gitignore. The quiz never reads or quotes files that match.'
    );
  });

  it('is hidden while the quiz is not code-aware, and shown once it is', async () => {
    await render(formQuiz({ includeCodeContext: false, excludedPaths: '' }));
    expect(textarea()).toBeNull();
    expect(container.textContent).not.toContain('Paths to exclude');

    await act(async () => {
      codeAwareSwitch().click();
    });
    expect(textarea()).not.toBeNull();
  });

  it('saves the text as a list: trimmed, blank lines dropped', async () => {
    await render(formQuiz());
    await type('  tests/**\n\n   playwright.config.* \r\n\n');
    await clickUpdate();

    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    const [payload, options] = mocks.submit.mock.calls[0];
    expect(payload).toMatchObject({
      _action: 'updateQuiz',
      id: 'quiz-1',
      includeCodeContext: true,
      excludedPaths: ['tests/**', 'playwright.config.*'],
    });
    expect(options).toMatchObject({ action: `/teacher/${CLASS_SLUG}/quizzes` });
  });

  it('saves an emptied textarea as no paths', async () => {
    await render(formQuiz());
    await type('\n  \n');
    await clickUpdate();

    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0][0].excludedPaths).toEqual([]);
  });

  it.each([
    ['/src/tests/**', 'is an absolute path'],
    ['../other-repo/**', 'uses "..". Paths to exclude stay inside the repository.'],
    ['!tests/**', 'List only the paths to exclude.'],
  ])('refuses %s with its reason and sends nothing', async (pattern, reason) => {
    await render(formQuiz());
    await type(`tests/**\n${pattern}`);
    await clickUpdate();

    await vi.waitFor(() => expect(container.textContent).toContain(reason));
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('refuses more than 50 patterns', async () => {
    await render(formQuiz());
    await type(Array.from({ length: 51 }, (_, i) => `dir${i}/**`).join('\n'));
    await clickUpdate();

    await vi.waitFor(() =>
      expect(container.textContent).toContain('At most 50 paths to exclude; this lists 51.')
    );
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('sends no paths while the quiz is not code-aware, so the saved ones stay', async () => {
    await render(formQuiz({ includeCodeContext: false }));
    await clickUpdate();

    await vi.waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(1));
    expect(mocks.submit.mock.calls[0][0]).not.toHaveProperty('excludedPaths');
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

  it('hands the form the saved patterns as text, one per line', async () => {
    mocks.quizFindById.mockResolvedValue({
      id: 'quiz-1',
      classroom_id: 'class-1',
      name: 'Q',
      include_code_context: true,
      source_material: [],
      excluded_paths: ['tests/**', '**/*.spec.js', 'playwright.config.*'],
    });
    const data = await load();
    expect(data.quiz!.excludedPaths).toBe('tests/**\n**/*.spec.js\nplaywright.config.*');
  });

  it('hands an empty text for a quiz without any', async () => {
    mocks.quizFindById.mockResolvedValue({
      id: 'quiz-1',
      classroom_id: 'class-1',
      name: 'Q',
      source_material: [],
      excluded_paths: [],
    });
    expect((await load()).quiz!.excludedPaths).toBe('');
  });
});
