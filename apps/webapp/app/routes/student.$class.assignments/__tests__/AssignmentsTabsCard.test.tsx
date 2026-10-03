/**
 * What the Assignments page's table renders for each kind of row. A REPO row
 * must keep every field the repo-only table had (the repo link is the only way
 * a student reaches their repo), keyed for regrades and extensions on the
 * GitRepoAssignment id; QUIZ and FORM rows carry their own status, score and
 * link. Rendered on the server, Current tab first.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import type { StudentCourseworkRow } from '@classmoji/services';

const popover = vi.hoisted(() => vi.fn());
vi.mock('~/components/features/TokenExtensionPopover', () => ({
  default: (props: { repositoryAssignment: { id: string } }) => {
    popover(props);
    return <span data-extend-for={props.repositoryAssignment.id} />;
  },
}));
vi.mock('~/components/ui/display/Emoji', () => ({
  default: ({ emoji }: { emoji: string }) => <span data-emoji={emoji} />,
}));
vi.mock('~/components/features/analytics', () => ({
  CommitCount: ({ snapshot }: { snapshot: { total_commits: number } }) => (
    <span data-commits={snapshot.total_commits} />
  ),
}));

const { default: AssignmentsTabsCard } = await import('../AssignmentsTabsCard');

const base = {
  module: { id: 'm1', title: 'Week 1' },
  isExtraCredit: false,
  tracked: true,
  score: null,
  scoredAt: null,
  attemptsUsed: null,
  maxAttempts: null,
  deadline: '2099-01-01T12:00:00.000Z',
} as const;

const REPO_LATE: StudentCourseworkRow = {
  ...base,
  assignmentId: 'a-repo',
  type: 'REPO',
  title: 'Lab 1',
  status: 'NOT_SUBMITTED',
  done: false,
  href: 'https://github.com/org/lab-ada/issues/3',
  external: true,
  action: { kind: 'OPEN', href: 'https://github.com/org/lab-ada/issues/3' },
  deadline: '2020-01-01T12:00:00.000Z',
  repo: {
    gitRepoAssignmentId: 'gra-1',
    repositoryTitle: 'lab-ada',
    repoUrl: 'https://github.com/org/lab-ada',
    commitCount: 9,
    issueUrl: 'https://github.com/org/lab-ada/issues/3',
    moduleType: 'GROUP',
    gradesReleased: false,
    grades: [],
    graders: [{ id: 'g1', name: 'Grace' }],
    gradersSummary: 'Grace',
    numLateHours: 5,
    isLateOverride: false,
    tokensPerHour: 2,
    extensionHours: 0,
    submissionMode: 'ISSUE',
    closedAt: null,
  },
};

const QUIZ_OPEN: StudentCourseworkRow = {
  ...base,
  assignmentId: 'a-quiz',
  type: 'QUIZ',
  title: 'Recursion quiz',
  status: 'NOT_STARTED',
  done: false,
  attemptsUsed: 0,
  maxAttempts: 2,
  href: '/student/cs52/quizzes?quiz=q1',
  external: false,
  action: { kind: 'START_QUIZ', quizId: 'q1' },
};

const FORM_PUBLIC: StudentCourseworkRow = {
  ...base,
  assignmentId: 'a-form',
  type: 'FORM',
  title: 'Team sign-up',
  status: null,
  tracked: false,
  done: false,
  isExtraCredit: true,
  href: 'https://pages.test/cs52/forms/signup',
  external: true,
  action: null,
};

const render = (rows: StudentCourseworkRow[], initialTab?: 'current' | 'completed' | 'all') =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={['/student/cs52/assignments']}>
      <Routes>
        <Route
          path="/student/:class/assignments"
          element={<AssignmentsTabsCard rows={rows} balance={10} initialTab={initialTab} />}
        />
      </Routes>
    </MemoryRouter>
  );

describe('AssignmentsTabsCard', () => {
  it('keeps every field of a repo row, keyed on the submission id', () => {
    const html = render([REPO_LATE]);

    expect(html).toContain('>REPO<');
    expect(html).toContain('href="https://github.com/org/lab-ada/issues/3"');
    expect(html).toContain('href="https://github.com/org/lab-ada"');
    expect(html).toContain('lab-ada');
    expect(html).toContain('data-commits="9"');
    expect(html).toContain('Group');
    expect(html).toContain('Grace');
    expect(html).toContain('Not submitted');
    expect(html).toContain('5h late');
    expect(html).toContain('overdue');
    expect(html).toContain('data-extend-for="gra-1"');
  });

  describe('Extend: extension hours sell at any time', () => {
    const repoRow = (
      over: Partial<StudentCourseworkRow>,
      repo: Partial<NonNullable<StudentCourseworkRow['repo']>>
    ): StudentCourseworkRow => ({ ...REPO_LATE, ...over, repo: { ...REPO_LATE.repo!, ...repo } });

    it('offers it before the deadline, on work that is not late', () => {
      const html = render([repoRow({ deadline: '2099-01-01T12:00:00.000Z' }, { numLateHours: 0 })]);

      expect(html).toContain('data-extend-for="gra-1"');
      expect(html).not.toContain('h late');
    });

    it('offers it on submitted work, on time (push mode) or late, with how late it was', () => {
      const submitted = { status: 'SUBMITTED', done: true } as const;
      const onTime = render(
        [repoRow(submitted, { numLateHours: 0, submissionMode: 'REPO' })],
        'completed'
      );
      expect(onTime).toContain('data-extend-for="gra-1"');

      const late = render([repoRow(submitted, { numLateHours: 3 })], 'completed');
      expect(late).toContain('data-extend-for="gra-1"');
      expect(late).toContain('3h late');
      expect(late).not.toContain('overdue');
    });

    it('offers it next to Request regrade on graded work that was late', () => {
      const html = render(
        [repoRow({ status: 'SUBMITTED', done: true }, { gradesReleased: true, numLateHours: 2 })],
        'completed'
      );

      expect(html).toContain('data-extend-for="gra-1"');
      expect(html).toContain('Request regrade');
    });

    it('offers it on push-mode work submitted on time, before grading: a later push can still count', () => {
      const html = render(
        [repoRow({ status: 'SUBMITTED', done: true }, { submissionMode: 'REPO', numLateHours: 0 })],
        'completed'
      );
      expect(html).toContain('data-extend-for="gra-1"');
    });

    it('does not offer it on issue-mode work submitted on time: closing the issue settled it', () => {
      const html = render(
        [
          repoRow(
            { status: 'SUBMITTED', done: true },
            { submissionMode: 'ISSUE', numLateHours: 0 }
          ),
        ],
        'completed'
      );
      expect(html).not.toContain('data-extend-for');
    });

    it('does not offer it where hours buy nothing', () => {
      // Graded and on time.
      const graded = render(
        [repoRow({ status: 'SUBMITTED', done: true }, { gradesReleased: true, numLateHours: 0 })],
        'completed'
      );
      expect(graded).toContain('Request regrade');
      expect(graded).not.toContain('data-extend-for');

      // No price per hour, or the late penalty is already waived.
      expect(render([repoRow({}, { tokensPerHour: 0 })])).not.toContain('data-extend-for');
      expect(render([repoRow({}, { isLateOverride: true })])).not.toContain('data-extend-for');
    });
  });

  it('shows a quiz row with its attempts and its own link', () => {
    const html = render([QUIZ_OPEN]);

    expect(html).toContain('>QUIZ<');
    expect(html).toContain('href="/student/cs52/quizzes?quiz=q1"');
    expect(html).toContain('Week 1 · 0 of 2 attempts used');
    expect(html).toContain('Not started');
  });

  it('shows a public form under All, with no per-student status', () => {
    expect(render([FORM_PUBLIC])).not.toContain('Team sign-up');
    const html = render([FORM_PUBLIC], 'all');

    expect(html).toContain('>FORM<');
    expect(html).toContain('href="https://pages.test/cs52/forms/signup"');
    expect(html).toContain('Week 1 · Extra credit');
    expect(html).not.toContain('Not submitted');
  });

  it('counts every row in its tab, public forms (open or closed) under All only', () => {
    const done: StudentCourseworkRow = {
      ...QUIZ_OPEN,
      assignmentId: 'a-done',
      title: 'Finished quiz',
      status: 'COMPLETED',
      done: true,
      score: 0,
      action: null,
    };
    const closedPublic: StudentCourseworkRow = {
      ...FORM_PUBLIC,
      assignmentId: 'a-form-closed',
      title: 'Waitlist',
      status: 'CLOSED',
      done: true,
    };
    const rows = [REPO_LATE, QUIZ_OPEN, FORM_PUBLIC, closedPublic, done];
    const tabCounts = (html: string) =>
      [...html.matchAll(/(Current|Completed|All)<span[^>]*>(\d+)</g)].map(m => [m[1], m[2]]);

    const current = render(rows);
    expect(tabCounts(current)).toEqual([
      ['Current', '2'],
      ['Completed', '1'],
      ['All', '5'],
    ]);
    // The Current tab is shown: neither the completed quiz nor a public form.
    expect(current).not.toContain('Finished quiz');
    expect(current).not.toContain('Team sign-up');

    const completed = render(rows, 'completed');
    expect(completed).toContain('Finished quiz');
    expect(completed).not.toContain('Waitlist');

    // Under All, the closed public form still reads Closed.
    const all = render(rows, 'all');
    expect(all).toContain('Waitlist');
    expect(all).toContain('>Closed<');
  });

  describe('the note under the date: the deadline stays, the hours applied are said', () => {
    const DEADLINE = '2020-01-01T12:00:00.000Z';
    const repoRow = (
      over: Partial<StudentCourseworkRow>,
      repo: Partial<NonNullable<StudentCourseworkRow['repo']>>
    ): StudentCourseworkRow => ({
      ...REPO_LATE,
      deadline: DEADLINE,
      ...over,
      repo: { ...REPO_LATE.repo!, ...repo },
    });

    it('says a late submission was bought back, and keeps the date', () => {
      const html = render(
        [
          repoRow(
            { status: 'SUBMITTED', done: true },
            { extensionHours: 5, numLateHours: 0, closedAt: '2020-01-01T17:10:00.000Z' }
          ),
        ],
        'completed'
      );
      expect(html).toContain('+5h applied · no longer late');
      expect(html).toContain('Jan 1');
    });

    it('says how late a submission still is when the hours did not cover it', () => {
      const html = render(
        [
          repoRow(
            { status: 'SUBMITTED', done: true },
            { extensionHours: 2, numLateHours: 3, closedAt: '2020-01-01T17:10:00.000Z' }
          ),
        ],
        'completed'
      );
      expect(html).toContain('+2h applied · 3h still late');
      expect(html).toContain('3h late');
    });

    it('shows nothing when no hours were bought', () => {
      expect(render([repoRow({}, { extensionHours: 0 })])).not.toContain('applied');
    });
  });
});
