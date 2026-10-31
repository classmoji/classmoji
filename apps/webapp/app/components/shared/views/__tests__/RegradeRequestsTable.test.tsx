/**
 * The regrade/resubmit requests table with quiz requests in it. Rendered on
 * the server.
 *
 *   - A quiz row (no `git_repo_assignment`) renders without crashing: a QUIZ
 *     chip (a repo row gets a REPOSITORY chip), "<quiz name> · Attempt N", the previous grade's emoji, the new one
 *     once resolved, View (the attempt drawer under the viewer's prefix) and,
 *     for staff on an open request, Resolve, with no Grade picker.
 *   - The student variant shows the staff reply under their comment, signed
 *     with who resolved the request and when (the request's own
 *     `resolved_by_name` / `resolved_at`; no name on rows resolved before
 *     that was recorded), and the
 *     "Request regrade/resubmit" button; no Resolve.
 *   - A repo row keeps its title, picker and Resolve.
 *   - A resolved quiz row reads Approved / Denied with "Score adjusted A → B"
 *     or "Score kept A", B the resolution's own grade (`resolvedEmoji`), not
 *     the attempt's grade now.
 *   - A read-only classroom (`canResolve` false) shows no Resolve or picker.
 *
 * `?resolve=<id>` and the keyboard on Resolve need effects and events:
 * RegradeRequestsTable.interactive.test.tsx (jsdom).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegradeRequestRowData } from '~/components/features/regrade/types';

const role = vi.hoisted(() => ({ current: 'ASSISTANT' }));

vi.mock('~/hooks', () => ({
  useRole: () => ({ role: role.current }),
  useGlobalFetcher: () => ({ fetcher: { submit: vi.fn() }, notify: vi.fn() }),
}));
vi.mock('~/hooks/useGitWeb', () => ({ useGitContext: () => ({}) }));
vi.mock('~/components/ui/display/Emoji', () => ({
  default: ({ emoji }: { emoji: string }) => <span data-emoji={emoji} />,
}));
vi.mock('~/components/features/grading/EmojiGrader', () => ({
  default: () => <span data-testid="emoji-grade-trigger">Grade</span>,
}));
vi.mock('~/components/features/profile/UserThumbnailView', () => ({
  default: ({ user }: { user: { name: string | null } }) => <span>{user.name}</span>,
}));
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));

const { default: RegradeRequestsTable } = await import('../RegradeRequestsTable');

const student = {
  name: 'Sam Chen',
  login: 'samchen',
  image: null,
  _count: { regrade_requests: 2 },
};

const quizRow = (over: Partial<RegradeRequestRowData> = {}): RegradeRequestRowData => ({
  id: 'req-quiz-open',
  status: 'IN_REVIEW',
  student_id: 'student-1',
  student,
  git_repo_assignment: null,
  quiz: {
    attemptId: 'att-1',
    attemptNumber: 2,
    quizId: 'quiz-1',
    quizName: 'Recursion check-in',
    originalEmoji: 'score-60',
    effectiveEmoji: 'score-60',
    adjusted: false,
    resolvedEmoji: null,
    lateHours: 0,
    countedEmoji: 'score-60',
  },
  previous_grade: ['score-60'],
  student_comment: 'Question 2: the recursive case returns the sum.',
  grader_comment: null,
  created_at: '2026-10-13T10:00:00.000Z',
  updated_at: '2026-10-13T10:00:00.000Z',
  ...over,
});

const resolvedQuizRow = () =>
  quizRow({
    id: 'req-quiz-done',
    status: 'APPROVED',
    quiz: {
      ...quizRow().quiz!,
      attemptNumber: 1,
      effectiveEmoji: 'score-90',
      resolvedEmoji: 'score-90',
      adjusted: true,
    },
    grader_comment: 'Q3 now has full credit.',
    resolved_by_name: 'Jordan Lee',
    resolved_at: '2026-10-14T10:00:00.000Z',
    updated_at: '2026-10-16T10:00:00.000Z',
  });

const repoRow = (): RegradeRequestRowData => ({
  id: 'req-repo',
  status: 'IN_REVIEW',
  student_id: 'student-2',
  student: { ...student, name: 'Maya Johnson', login: 'mayaj' },
  git_repo_assignment: {
    id: 'gra-1',
    assignment: { title: 'Linked lists' },
    git_repo: { name: 'linked-lists-mayaj' },
    grades: [{ id: 'g-1', emoji: 'score-60' }],
  },
  quiz: null,
  previous_grade: ['score-60'],
  student_comment: 'Pushed the fix for remove().',
  grader_comment: null,
  created_at: '2026-10-12T10:00:00.000Z',
  updated_at: '2026-10-12T10:00:00.000Z',
});

// A data router: the resolve modal posts through `useFetcher`.
const render = (requests: RegradeRequestRowData[], path: string, canResolve = true) =>
  renderToStaticMarkup(
    <RouterProvider
      router={createMemoryRouter(
        [
          {
            path: '/:prefix/:class/regrade-requests',
            element: (
              <RegradeRequestsTable
                requests={requests}
                emojiMappings={{ 'score-90': 90, 'score-60': 60, 'score-0': 0 }}
                org="test-org"
                canResolve={canResolve}
              />
            ),
          },
        ],
        { initialEntries: [path] }
      )}
    />
  );

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('RegradeRequestsTable, staff', () => {
  beforeEach(() => {
    role.current = 'ASSISTANT';
  });

  it('renders a quiz row (no repo submission) without crashing', () => {
    const html = render(
      [quizRow(), resolvedQuizRow(), repoRow()],
      '/assistant/cs1/regrade-requests'
    );
    const flat = text(html);

    expect(flat).toContain('Regrade/Resubmit Requests');
    // What each request is on, as the design system's chips.
    expect(html.match(/data-testid="regrade-kind-quiz"/g)?.length).toBe(2);
    expect(html.match(/data-testid="regrade-kind-repository"/g)?.length).toBe(1);
    expect(html).toMatch(/class="chip shrink-0 chip-quiz"[^>]*>Quiz</);
    expect(html).toMatch(/class="chip shrink-0 chip-asgn"[^>]*>Repository</);
    expect(flat).toContain('Recursion check-in · Attempt 2');
    expect(flat).toContain('Recursion check-in · Attempt 1');
    // The attempt drawer under the viewer's own prefix.
    expect(html).toContain('href="/assistant/cs1/quizzes/quiz-1/attempt/att-1"');
    // Previous grade on both; the new one only once resolved.
    expect(html).toContain('data-emoji="score-60"');
    expect(html).toContain('data-emoji="score-90"');
    expect(flat).toContain('Score adjusted');
    // The table prints no grade number of its own: every grade goes through
    // Emoji (mocked here to text-free markers), though the scale it was handed
    // carries the numbers. A score-N badge's own label is Emoji's business.
    expect(flat).not.toMatch(/\d+\s*%|(^|\s)(0|60|90)(\s|$)/);
    expect(html.match(/data-emoji="score-(60|90)"/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('offers Resolve on an open quiz request only, and no Grade picker on quiz rows', () => {
    const open = render([quizRow()], '/teacher/cs1/regrade-requests');
    expect(open.match(/data-testid="regrade-quiz-resolve"/g)?.length).toBe(1);
    expect(open).not.toContain('emoji-grade-trigger');
    expect(open).toContain('href="/teacher/cs1/quizzes/quiz-1/attempt/att-1"');

    const done = render([resolvedQuizRow()], '/teacher/cs1/regrade-requests');
    expect(done).not.toContain('regrade-quiz-resolve');
  });

  it("reads a resolved quiz row with the resolution's own grade", () => {
    // Adjusted to 👀-90 at resolution; adjusted again afterwards directly.
    const approved = quizRow({
      id: 'req-approved',
      status: 'APPROVED',
      quiz: { ...quizRow().quiz!, effectiveEmoji: 'score-0', resolvedEmoji: 'score-90' },
    });
    const html = render([approved], '/admin/cs1/regrade-requests');
    expect(text(html)).toContain('Approved');
    expect(text(html)).toContain('Score adjusted');
    expect(html).toContain('data-emoji="score-90"');
    expect(html).not.toContain('data-emoji="score-0"');

    const denied = quizRow({
      id: 'req-denied',
      status: 'DENIED',
      quiz: { ...quizRow().quiz!, resolvedEmoji: 'score-60' },
    });
    const kept = text(render([denied], '/admin/cs1/regrade-requests'));
    expect(kept).toContain('Denied');
    expect(kept).toContain('Score kept');
  });

  it('shows no Resolve or picker in a read-only classroom', () => {
    const html = render([quizRow(), repoRow()], '/admin/cs1/regrade-requests', false);
    expect(html).not.toContain('regrade-quiz-resolve');
    expect(html).not.toContain('regrade-repo-resolve');
    expect(html).not.toContain('emoji-grade-trigger');
  });

  it('keeps the repo row: its title, the picker and Resolve', () => {
    const html = render([repoRow()], '/admin/cs1/regrade-requests');
    const flat = text(html);

    expect(flat).toContain('Linked lists');
    expect(html).toContain('emoji-grade-trigger');
    expect(flat).toContain('Resolve');
    expect(html).not.toContain('regrade-quiz-view');
  });
});

describe('RegradeRequestsTable, student', () => {
  beforeEach(() => {
    role.current = 'STUDENT';
  });

  it('shows quiz rows with the staff reply and the request button, no Resolve', () => {
    const html = render([quizRow(), resolvedQuizRow(), repoRow()], '/student/cs1/regrade-requests');
    const flat = text(html);

    expect(flat).toContain('Request regrade/resubmit');
    expect(flat).toContain('Recursion check-in · Attempt 1');
    expect(html).toContain('href="/student/cs1/quizzes/quiz-1/attempt/att-1"');
    expect(html).toContain('data-testid="regrade-staff-reply"');
    expect(flat).toContain('Jordan Lee · Oct 14');
    expect(flat).toContain('Q3 now has full credit.');
    expect(html).not.toContain('regrade-quiz-resolve');
    expect(html).not.toContain('emoji-grade-trigger');
    // No staff columns.
    expect(flat).not.toContain('Sam Chen');
  });

  it('signs a resolved repo request with its resolver too', () => {
    const html = render(
      [
        {
          ...repoRow(),
          status: 'DENIED',
          grader_comment: 'The deadline was firm.',
          resolved_by_name: 'Ari Patel',
          resolved_at: '2026-10-15T10:00:00.000Z',
        },
      ],
      '/student/cs1/regrade-requests'
    );
    expect(text(html)).toContain('Ari Patel · Oct 15');
    expect(text(html)).toContain('The deadline was firm.');
  });

  it('names no one on a request resolved before the resolver was recorded', () => {
    const html = render(
      [
        {
          ...resolvedQuizRow(),
          resolved_by_name: null,
          resolved_at: null,
        },
      ],
      '/student/cs1/regrade-requests'
    );
    const flat = text(html);
    expect(html).toContain('data-testid="regrade-staff-reply"');
    expect(flat).toContain('Q3 now has full credit.');
    expect(flat).not.toContain('Jordan Lee');
  });
});
