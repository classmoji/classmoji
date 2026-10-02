// @vitest-environment jsdom
/**
 * The quiz form states the per-attempt message limit for a quiz whose new
 * attempts run on the chat runtime, MOUNTED in jsdom:
 *
 *   loader: reads the runtime switch (QUIZ_TRIGGER_RUNTIME) through
 *           runtimeFor, for a code-aware quiz and for any other
 *   shown:  under Max Attempts, with N from the shared constant, only while
 *           the quiz as the form has it would run on the chat runtime
 */

import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_STUDENT_TURNS } from '@classmoji/utils/quiz-agent/limits';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  quizzesVisibleOrThrow: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: { findByClassroomId: async () => [] },
    quizSourceMaterial: { listSourceMaterialOptions: async () => ({ pages: [], decks: [] }) },
    quiz: { findById: async () => null },
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
  useFetcher: () => ({ state: 'idle', data: undefined, submit: vi.fn() }),
  useLocation: () => ({ pathname: '/admin/cs52-26f/quizzes/form' }),
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
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: QuizFormDrawer, loader } = await import('../route');

const CLASS_SLUG = 'cs52-26f';
const LINE =
  `Students can send up to ${MAX_STUDENT_TURNS} messages per attempt. At ${MAX_STUDENT_TURNS} ` +
  'the attempt is submitted, and unanswered questions count as skipped.';

/** The quiz as the loader hands it to the form. */
const formQuiz = (over: Record<string, unknown> = {}) => ({
  id: 'quiz-1',
  name: 'Landing page check-in',
  repositoryId: 'repo-1',
  systemPrompt: null,
  rubricPrompt: 'Grade the answers.',
  subject: 'CSS',
  difficultyLevel: 'Beginner',
  dueDate: null,
  status: 'DRAFT',
  weight: 0,
  questionCount: 5,
  maxAttempts: 1,
  gradingStrategy: 'HIGHEST',
  includeCodeContext: true,
  sourceMaterial: [],
  courseSearchEnabled: false,
  excludedPaths: '',
  ...over,
});

let container: HTMLDivElement;
let root: Root;

const render = async (
  quiz: Record<string, unknown> | null,
  chatRuntime: { codeAware: boolean; other: boolean } | undefined
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
            ...(chatRuntime ? { chatRuntime } : {}),
          },
        } as unknown as Parameters<typeof QuizFormDrawer>[0])}
      />
    );
  });
};

const line = () =>
  container.querySelector('[data-testid="quiz-form-message-limit"]')?.textContent ?? null;
const codeAwareSwitch = () => container.querySelector<HTMLButtonElement>('#includeCodeContext')!;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('the message limit in the quiz form', () => {
  it('states N from the shared constant, under Max Attempts, for a quiz on the chat runtime', async () => {
    await render(formQuiz(), { codeAware: true, other: false });
    expect(line()).toBe(LINE);
    expect(line()).toContain(`up to ${MAX_STUDENT_TURNS} messages`);
    // As Max Attempts' help text.
    const item = container.querySelector('#maxAttempts')!.closest('.ant-form-item')!;
    expect(item.querySelector('.ant-form-item-extra')?.textContent).toBe(LINE);
  });

  it('follows the Code-Aware switch when only code-aware quizzes run on the chat runtime', async () => {
    await render(formQuiz({ includeCodeContext: false }), { codeAware: true, other: false });
    expect(line()).toBeNull();

    await act(async () => {
      codeAwareSwitch().click();
    });
    expect(line()).toBe(LINE);

    await act(async () => {
      codeAwareSwitch().click();
    });
    expect(line()).toBeNull();
  });

  it('needs a linked repository for a quiz to count as code-aware', async () => {
    await render(formQuiz({ repositoryId: null }), { codeAware: true, other: false });
    expect(line()).toBeNull();
  });

  it('shows it for every quiz when every quiz runs on the chat runtime, a new one included', async () => {
    await render(formQuiz({ includeCodeContext: false, repositoryId: null }), {
      codeAware: true,
      other: true,
    });
    expect(line()).toBe(LINE);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(null, { codeAware: true, other: true });
    expect(line()).toBe(LINE);
  });

  it('shows nothing when no quiz runs on the chat runtime, or the loader sent no reading', async () => {
    await render(formQuiz(), { codeAware: false, other: false });
    expect(line()).toBeNull();

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(formQuiz(), undefined);
    expect(line()).toBeNull();
  });
});

describe('the loader: which quizzes run on the chat runtime', () => {
  const load = async () =>
    (await loader({
      params: { class: CLASS_SLUG },
      request: new Request(`http://localhost/admin/${CLASS_SLUG}/quizzes/form`),
    } as unknown as Parameters<typeof loader>[0])) as Awaited<ReturnType<typeof loader>>;

  beforeEach(() => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: 'teacher-1',
      classroom: { id: 'class-1', slug: CLASS_SLUG },
    });
    mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['', { codeAware: false, other: false }],
    ['off', { codeAware: false, other: false }],
    ['code_aware', { codeAware: true, other: false }],
    ['all', { codeAware: true, other: true }],
  ])('QUIZ_TRIGGER_RUNTIME=%j', async (value, expected) => {
    vi.stubEnv('QUIZ_TRIGGER_RUNTIME', value);
    expect((await load()).chatRuntime).toEqual(expected);
  });
});
