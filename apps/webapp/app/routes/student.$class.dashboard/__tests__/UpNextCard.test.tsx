/**
 * The dashboard's Up next card, rendered on the server: one row per thing
 * still owed with its type tag and the button that starts it, the tour's
 * dashboard anchor, and the link to the whole list. The due text is written
 * only after hydration (it is read in the student's own time zone), so
 * `formatDue` is pinned on its own.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import dayjs from 'dayjs';
import { describe, expect, it, vi } from 'vitest';
import type { StudentCourseworkRow } from '@classmoji/services';

vi.mock('~/components/features/quiz/useStartQuiz', () => ({
  useStartQuiz: () => ({ startQuiz: vi.fn(), resumeQuiz: vi.fn(), startingQuizId: null }),
}));

const { default: UpNextCard, formatDue } = await import('../UpNextCard');

const row = (over: Partial<StudentCourseworkRow>): StudentCourseworkRow => ({
  assignmentId: 'a',
  type: 'QUIZ',
  title: 'Row',
  module: { id: 'm1', title: 'Week 1' },
  isExtraCredit: false,
  deadline: '2026-10-02T18:00:00.000Z',
  status: 'NOT_STARTED',
  tracked: true,
  done: false,
  score: null,
  scoredAt: null,
  attemptsUsed: 0,
  maxAttempts: 1,
  href: '/student/cs52/quizzes?quiz=q1',
  external: false,
  action: { kind: 'START_QUIZ', quizId: 'q1' },
  numLateHours: 0,
  isLateOverride: false,
  tokensPerHour: 0,
  extensionHours: 0,
  submittedAt: null,
  missing: false,
  extend: null,
  ...over,
});

const render = (rows: StudentCourseworkRow[], viewerIsStudent = true) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <UpNextCard rows={rows} classSlug="cs52" viewerIsStudent={viewerIsStudent} />
    </MemoryRouter>
  );

describe('UpNextCard', () => {
  it('lists each row with its tag and its action, under the tour anchor', () => {
    const html = render([
      row({ assignmentId: 'quiz', title: 'Recursion quiz' }),
      row({
        assignmentId: 'resume',
        title: 'Pointers quiz',
        status: 'IN_PROGRESS',
        action: { kind: 'RESUME_QUIZ', quizId: 'q2', attemptId: 'at-1' },
      }),
      row({
        assignmentId: 'repo',
        type: 'REPO',
        title: 'Lab 2',
        status: 'NOT_SUBMITTED',
        href: 'https://github.com/org/lab-2/issues/1',
        external: true,
        action: { kind: 'OPEN', href: 'https://github.com/org/lab-2/issues/1' },
      }),
      row({
        assignmentId: 'form',
        type: 'FORM',
        title: 'Team sign-up',
        status: 'NOT_SUBMITTED',
        href: 'https://pages.test/cs52/forms/signup',
        external: true,
        action: { kind: 'FILL_OUT', href: 'https://pages.test/cs52/forms/signup' },
      }),
    ]);

    expect(html).toContain('data-tour="dashboard-spotlight"');
    expect(html).toContain('UP NEXT');
    for (const text of ['Recursion quiz', 'Pointers quiz', 'Lab 2', 'Team sign-up']) {
      expect(html).toContain(text);
    }
    for (const tag of ['>QUIZ<', '>REPO<', '>FORM<']) expect(html).toContain(tag);
    expect(html).toContain('>Start quiz<');
    expect(html).toContain('>Resume<');
    expect(html).toContain('href="https://github.com/org/lab-2/issues/1"');
    expect(html).toContain('>Open<');
    expect(html).toContain('href="https://pages.test/cs52/forms/signup"');
    expect(html).toContain('>Fill out<');
    expect(html).toContain('href="/student/cs52/assignments"');
  });

  it('sends staff to the quiz list to start a quiz', () => {
    const html = render([row({})], false);

    expect(html).toContain('href="/student/cs52/quizzes?quiz=q1"');
    expect(html).toContain('>Start quiz<');
  });

  it('says there is nothing due when nothing is owed', () => {
    const html = render([]);

    expect(html).toContain('Nothing due');
    expect(html).toContain('href="/student/cs52/assignments"');
  });
});

describe('formatDue', () => {
  const now = dayjs('2026-10-01T12:00:00');

  it('flags an overdue date', () => {
    expect(formatDue('2026-09-30T12:00:00', now)).toEqual({
      text: 'Overdue · Sep 30',
      urgent: true,
    });
  });

  it('does not call a date overdue inside the hours the student bought', () => {
    // Due Sep 30 noon, now Oct 1 noon: 24h past it.
    expect(formatDue('2026-09-30T12:00:00', now, 30)).toEqual({
      text: 'Sep 30 · +30h applied',
      urgent: true,
    });
    // The hours bought have run out: overdue again.
    expect(formatDue('2026-09-30T12:00:00', now, 10).text).toBe('Overdue · Sep 30');
  });

  it('names today and tomorrow, with the time', () => {
    expect(formatDue('2026-10-01T17:00:00', now)).toEqual({ text: 'Today, 5:00 PM', urgent: true });
    expect(formatDue('2026-10-02T14:00:00', now)).toEqual({
      text: 'Tomorrow, 2:00 PM',
      urgent: true,
    });
  });

  it('gives the day and date for anything later', () => {
    expect(formatDue('2026-10-04T23:59:00', now)).toEqual({
      text: 'Sun Oct 4, 11:59 PM',
      urgent: false,
    });
  });
});
