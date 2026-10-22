// @vitest-environment jsdom
/**
 * The regrade queue's effects and keyboard, in a browser-like DOM:
 *
 *   - `?resolve=<id>` (the attempt drawer's link) opens that open quiz
 *     request's resolve modal, and the param is dropped; a read-only
 *     classroom, a resolved request or an unknown id opens nothing;
 *   - Resolve answers Enter and Space, and Space does not scroll the page.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegradeRequestRowData } from '~/components/features/regrade/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const submit = vi.hoisted(() => vi.fn());
vi.mock('~/hooks', () => ({
  useRole: () => ({ role: 'ASSISTANT' }),
  useGlobalFetcher: () => ({ fetcher: { submit, state: 'idle' }, notify: vi.fn() }),
}));
vi.mock('~/hooks/useGitWeb', () => ({ useGitContext: () => ({}) }));
vi.mock('~/components/ui/display/Emoji', () => ({
  default: ({ emoji }: { emoji: string }) => <span data-emoji={emoji} />,
}));
vi.mock('~/components/features/grading/EmojiGrader', () => ({ default: () => null }));
vi.mock('~/components/features/grading/GradeBadges', () => ({ default: () => null }));
vi.mock('~/components/features/profile/UserThumbnailView', () => ({ default: () => null }));
// The modal under test is only "which request is it open on".
vi.mock('~/components/features/regrade/ResolveQuizRegradeModal', () => ({
  default: ({ request }: { request: { id: string } | null }) => (
    <div data-testid="resolve-modal" data-request={request?.id ?? ''} />
  ),
}));

const { default: RegradeRequestsTable } = await import('../RegradeRequestsTable');

const student = { name: 'Sam', login: 'sam', image: null, _count: { regrade_requests: 1 } };

const quizRow = (over: Partial<RegradeRequestRowData> = {}): RegradeRequestRowData => ({
  id: 'req-open',
  status: 'IN_REVIEW',
  student_id: 'student-1',
  student,
  git_repo_assignment: null,
  quiz: {
    attemptId: 'att-1',
    attemptNumber: 1,
    quizId: 'quiz-1',
    quizName: 'Recursion',
    originalEmoji: 'eyes',
    effectiveEmoji: 'eyes',
    adjusted: false,
    resolvedEmoji: null,
    lateHours: 0,
    countedEmoji: 'eyes',
  },
  previous_grade: ['eyes'],
  student_comment: 'Q2',
  grader_comment: null,
  created_at: '2026-10-13T10:00:00.000Z',
  updated_at: '2026-10-13T10:00:00.000Z',
  ...over,
});

const repoRow = (): RegradeRequestRowData => ({
  ...quizRow({ id: 'req-repo', quiz: null }),
  git_repo_assignment: {
    id: 'gra-1',
    assignment: { title: 'Lab' },
    git_repo: { name: 'lab-sam' },
    grades: [],
  },
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  submit.mockClear();
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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const mount = async (requests: RegradeRequestRowData[], path: string, canResolve = true) => {
  const router = createMemoryRouter(
    [
      {
        path: '/:prefix/:class/regrade-requests',
        element: (
          <RegradeRequestsTable
            requests={requests}
            emojiMappings={{ eyes: 80 }}
            canResolve={canResolve}
          />
        ),
      },
    ],
    { initialEntries: [path] }
  );
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  return router;
};

const modalRequest = () =>
  container.querySelector('[data-testid="resolve-modal"]')?.getAttribute('data-request') ?? null;

describe('?resolve=<id>', () => {
  it("opens that open quiz request's resolve modal and drops the param", async () => {
    const router = await mount(
      [quizRow(), quizRow({ id: 'req-other' })],
      '/admin/cs1/regrade-requests?resolve=req-open'
    );
    expect(modalRequest()).toBe('req-open');
    expect(router.state.location.search).toBe('');
  });

  it('opens nothing for a resolved request, an unknown id, or a read-only classroom', async () => {
    await mount([quizRow({ status: 'APPROVED' })], '/admin/cs1/regrade-requests?resolve=req-open');
    expect(modalRequest()).toBe('');
    act(() => root.unmount());
    root = createRoot(container);

    await mount([quizRow()], '/admin/cs1/regrade-requests?resolve=req-nope');
    expect(modalRequest()).toBe('');
    act(() => root.unmount());
    root = createRoot(container);

    await mount([quizRow()], '/admin/cs1/regrade-requests?resolve=req-open', false);
    // Read-only: no modal at all.
    expect(container.querySelector('[data-testid="resolve-modal"]')).toBeNull();
  });
});

describe('Resolve from the keyboard', () => {
  const press = async (el: Element, key: string) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    await act(async () => {
      el.dispatchEvent(event);
    });
    return event;
  };

  it('opens the quiz resolve modal on Space, without scrolling the page', async () => {
    await mount([quizRow()], '/admin/cs1/regrade-requests');
    const resolve = container.querySelector('[data-testid="regrade-quiz-resolve"]')!;
    expect(modalRequest()).toBe('');
    const space = await press(resolve, ' ');
    expect(space.defaultPrevented).toBe(true);
    expect(modalRequest()).toBe('req-open');
  });

  it('resolves a repo request on Enter', async () => {
    await mount([repoRow()], '/admin/cs1/regrade-requests');
    const resolve = container.querySelector('[data-testid="regrade-repo-resolve"]')!;
    const enter = await press(resolve, 'Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toMatchObject({
      request: { id: 'req-repo' },
      status: 'APPROVED',
    });
  });
});
