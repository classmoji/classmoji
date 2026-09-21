/**
 * What the student calendar loader actually sends to the browser.
 *
 * `gitRepoAssignment.findForUser` returns the whole graph around a repository
 * assignment — the grades on it, who graded them, the token transactions, the
 * classroom, the student row. The calendar reads exactly two things off it: the
 * issue number, and the repository's name. Handing the row over put everything
 * else into the page's payload, where anyone could read it out of the network
 * tab or the hydration script.
 *
 * So this pins the map's shape twice over: field by field, and by sweeping the
 * serialized payload for something that is only ever on the parts left behind.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  findBySlug: vi.fn(),
  getClassroomCalendar: vi.fn(),
  findForUser: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: { findBySlug: (...a: unknown[]) => mocks.findBySlug(...a) },
    calendar: { getClassroomCalendar: (...a: unknown[]) => mocks.getClassroomCalendar(...a) },
    gitRepoAssignment: { findForUser: (...a: unknown[]) => mocks.findForUser(...a) },
  },
}));

vi.mock('~/utils/calendar.server', () => ({
  buildCalendarUrl: () => 'webcal://example.test/cal.ics',
  getCalendarDateRange: () => ({ start: new Date(0), end: new Date(0) }),
}));

// The view layer only needs to import; a node test must not drag antd and a
// React tree in with it.
vi.mock('antd', () => ({ Modal: () => null }));
vi.mock('~/components/features/calendar/CalendarSubscriptionCard', () => ({ default: () => null }));
vi.mock('~/components/features/calendar/EventCard', () => ({ default: () => null }));
vi.mock('~/components/features/calendar/EventLinks', () => ({ default: () => null }));
vi.mock('~/components/features/calendar/StudentCalendarView', () => ({ default: () => null }));
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { data: actual.data, useFetcher: () => ({ submit: vi.fn() }), useParams: () => ({}) };
});

const route = await import('../route.tsx');

const CLASS_SLUG = 'cs52-26f';

/** A name that exists ONLY on the parts of the row the map must not carry. */
const GRADER_NAME = 'Grader McGradeface';
const STUDENT_LOGIN = 'student-login-should-not-ship';

/** One row, shaped the way `findForUser`'s includes actually shape it. */
const repoAssignmentRow = {
  id: 'ra-1',
  assignment_id: 'a-1',
  provider: 'GITHUB',
  provider_id: 'issue-node-1',
  provider_issue_number: 7,
  git_repo_id: 'gr-1',
  status: 'OPEN',
  closed_at: null,
  is_late_override: false,
  git_repo: {
    id: 'gr-1',
    name: 'landing-page-jane',
    provider_id: '12345',
    student_id: 'student-1',
    student: { id: 'student-1', login: STUDENT_LOGIN, name: 'Jane' },
    repository: { id: 'repo-1', title: 'Landing Page', slug: 'landing-page' },
    classroom: { id: 'class-1', git_organization: { login: 'cs52' } },
  },
  assignment: { id: 'a-1', title: 'Landing Page Part 1' },
  graders: [{ grader: { id: 'ta-1', name: GRADER_NAME, login: 'ta-login' } }],
  grades: [{ id: 'g-1', emoji: '🍎', grader: { id: 'ta-1', name: GRADER_NAME } }],
  token_transactions: [{ id: 'tx-1', amount: 3 }],
};

const load = () =>
  route.loader({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/student/${CLASS_SLUG}/calendar`),
  } as unknown as Parameters<typeof route.loader>[0]) as Promise<{
    data: {
      repoAssignmentsByAssignmentId: Record<string, Record<string, unknown>>;
      gitOrgLogin: string | null;
    };
  }>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertClassroomAccess.mockResolvedValue({ userId: 'student-1' });
  mocks.findBySlug.mockResolvedValue({
    id: 'class-1',
    slug: CLASS_SLUG,
    git_organization: { login: 'cs52' },
  });
  mocks.getClassroomCalendar.mockResolvedValue([]);
  mocks.findForUser.mockResolvedValue([repoAssignmentRow]);
});

describe('the student calendar loader’s repo-assignment map', () => {
  it('carries exactly the two fields the calendar reads', async () => {
    const { data } = await load();
    const entry = data.repoAssignmentsByAssignmentId['a-1'];

    expect(Object.keys(entry).sort()).toEqual(['git_repo', 'provider_issue_number']);
    expect(Object.keys(entry.git_repo as object)).toEqual(['name']);
    expect(entry).toEqual({ provider_issue_number: 7, git_repo: { name: 'landing-page-jane' } });
  });

  it('is keyed by assignment, and still builds the issue URL the chip needs', async () => {
    const { data } = await load();

    expect(Object.keys(data.repoAssignmentsByAssignmentId)).toEqual(['a-1']);
    // The two halves the destination is built from, and nothing else.
    expect(data.gitOrgLogin).toBe('cs52');
  });

  it('leaves the rest of the row on the server', async () => {
    const { data } = await load();
    const payload = JSON.stringify(data.repoAssignmentsByAssignmentId);

    // A grader's name is the plainest thing on that graph that has no business
    // on a student's calendar page.
    expect(payload).not.toContain(GRADER_NAME);
    expect(payload).not.toContain(STUDENT_LOGIN);
    for (const leaked of ['graders', 'grades', 'token_transactions', 'classroom', 'student']) {
      expect(payload).not.toContain(leaked);
    }
  });

  it('sweeps the WHOLE loader payload for the same thing', async () => {
    // Not just the map: whatever else the loader returns has to be clean too,
    // and this is the assertion that keeps noticing when something new is
    // added beside it.
    const { data } = await load();
    const payload = JSON.stringify(data);

    expect(payload).not.toContain(GRADER_NAME);
    expect(payload).not.toContain(STUDENT_LOGIN);
  });

  it('asks only for this reader’s own repositories in this classroom', async () => {
    await load();
    expect(mocks.findForUser).toHaveBeenCalledWith({
      git_repo: { student_id: 'student-1', classroom_id: 'class-1' },
    });
  });

  it('is empty when the reader has no repository yet', async () => {
    mocks.findForUser.mockResolvedValue([]);
    const { data } = await load();
    expect(data.repoAssignmentsByAssignmentId).toEqual({});
  });
});
