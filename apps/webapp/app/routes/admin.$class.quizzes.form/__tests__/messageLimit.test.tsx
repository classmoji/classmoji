// @vitest-environment jsdom
/**
 * The quiz form states the per-attempt message limit, MOUNTED in jsdom:
 * under Max Attempts, with N from the shared constant, for every quiz (every
 * attempt runs on the chat runtime).
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
    module: { findByClassroomSlug: async () => [] },
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
  questionCount: 5,
  maxAttempts: 1,
  gradingStrategy: 'HIGHEST',
  hintCost: 15,
  maxAnswers: 5,
  includeCodeContext: true,
  sourceMaterial: [],
  courseSearchEnabled: false,
  excludedPaths: '',
  ...over,
});

let container: HTMLDivElement;
let root: Root;

const render = async (quiz: Record<string, unknown> | null) => {
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
            // The owner, in a class with one module.
            canAuthor: true,
            isOwner: true,
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
  it('states N from the shared constant, under Max Attempts', async () => {
    await render(formQuiz());
    expect(line()).toBe(LINE);
    expect(line()).toContain(`up to ${MAX_STUDENT_TURNS} messages`);
    // As Max Attempts' help text.
    const item = container.querySelector('#maxAttempts')!.closest('.ant-form-item')!;
    expect(item.querySelector('.ant-form-item-extra')?.textContent).toBe(LINE);
  });

  it('shows it whatever the Code-Aware switch says', async () => {
    await render(formQuiz({ includeCodeContext: false }));
    expect(line()).toBe(LINE);

    await act(async () => {
      codeAwareSwitch().click();
    });
    expect(line()).toBe(LINE);
  });

  it('shows it for a quiz with no repository, and for a new quiz', async () => {
    await render(formQuiz({ includeCodeContext: false, repositoryId: null }));
    expect(line()).toBe(LINE);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(null);
    expect(line()).toBe(LINE);
  });
});

describe('the loader', () => {
  const load = async () =>
    (await loader({
      params: { class: CLASS_SLUG },
      request: new Request(`http://localhost/admin/${CLASS_SLUG}/quizzes/form`),
    } as unknown as Parameters<typeof loader>[0])) as Awaited<ReturnType<typeof loader>>;

  beforeEach(() => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: 'teacher-1',
      classroom: { id: 'class-1', slug: CLASS_SLUG },
      membership: { role: 'TEACHER' },
    });
    mocks.quizzesVisibleOrThrow.mockResolvedValue(true);
  });

  it('sends no runtime reading: there is one runtime', async () => {
    expect(await load()).not.toHaveProperty('chatRuntime');
  });
});
