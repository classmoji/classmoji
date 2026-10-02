/**
 * Pins the quiz gate on the calendar: the deadline leg and the event links.
 *
 * A quiz assignment's deadline appears only where quizzes do
 * (`entitlement.quizzesVisible`). `getDeadlinesForRange` is the one place every
 * calendar surface takes its deadlines from, so the gate lives there: when the
 * answer is false, QUIZ deadlines are dropped and REPO/FORM ones stay.
 *
 * An event's link to a quiz assignment follows the same answer, dropped in
 * `getClassroomCalendar` before the rows are expanded, so neither the chips,
 * the starred resource nor the raw links the edit modal reads carry it.
 *
 * The lookup is asked at most once per call, and not at all when no quiz
 * deadline or quiz link falls in range — the web calendars and the ICS feed
 * read this on every request.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const assignmentFindMany = vi.fn();
const calendarEventFindMany = vi.fn();
const formFindMany = vi.fn();
const quizzesVisible = vi.fn();

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),

  default: () => ({
    assignment: { findMany: assignmentFindMany },
    calendarEvent: { findMany: calendarEventFindMany },
    form: { findMany: formFindMany },
  }),
}));

vi.mock('../entitlement.service.ts', () => ({
  quizzesVisible: (...a: unknown[]) => quizzesVisible(...a),
}));

const { getClassroomCalendar, getDeadlinesForRange } = await import('../calendar.service.ts');

const START = new Date('2026-09-01T00:00:00Z');
const END = new Date('2026-09-30T00:00:00Z');

const row = (id: string, type: 'REPO' | 'QUIZ' | 'FORM', day: number) => ({
  id,
  type,
  title: `${type} ${id}`,
  is_published: true,
  student_deadline: new Date(`2026-09-${String(day).padStart(2, '0')}T23:59:00Z`),
  module: { title: 'Week 1', classroom: { git_organization: { login: 'org' } } },
  repository: type === 'REPO' ? { id: `repo-${id}`, title: 'Lab', is_published: true } : null,
  pages: [],
  slides: [],
});

const REPO = row('a-repo', 'REPO', 3);
const QUIZ = row('a-quiz', 'QUIZ', 5);
const FORM = row('a-form', 'FORM', 7);

const ids = (items: Array<{ assignment_id: string }>) => items.map(i => i.assignment_id);

beforeEach(() => {
  vi.clearAllMocks();
  quizzesVisible.mockResolvedValue(true);
  calendarEventFindMany.mockResolvedValue([]);
  formFindMany.mockResolvedValue([]);
});

describe('getDeadlinesForRange — quiz deadlines', () => {
  it('keeps quiz deadlines when quizzes are visible', async () => {
    assignmentFindMany.mockResolvedValue([REPO, QUIZ, FORM]);

    const items = await getDeadlinesForRange('class-1', START, END);

    expect(ids(items)).toEqual(['a-repo', 'a-quiz', 'a-form']);
  });

  it('drops quiz deadlines, and only those, when quizzes are not visible', async () => {
    quizzesVisible.mockResolvedValue(false);
    assignmentFindMany.mockResolvedValue([REPO, QUIZ, FORM]);

    const items = await getDeadlinesForRange('class-1', START, END, null, true);

    expect(ids(items)).toEqual(['a-repo', 'a-form']);
    expect(JSON.stringify(items)).not.toContain('QUIZ a-quiz');
  });

  it('asks about the calendar’s own classroom exactly once, however many quizzes are due', async () => {
    quizzesVisible.mockResolvedValue(false);
    assignmentFindMany.mockResolvedValue([QUIZ, row('a-quiz-2', 'QUIZ', 9), REPO]);

    await getDeadlinesForRange('class-1', START, END);

    expect(quizzesVisible).toHaveBeenCalledTimes(1);
    expect(quizzesVisible).toHaveBeenCalledWith('class-1');
  });

  it('does not ask at all when no quiz deadline is in range', async () => {
    assignmentFindMany.mockResolvedValue([REPO, FORM]);

    const items = await getDeadlinesForRange('class-1', START, END);

    expect(quizzesVisible).not.toHaveBeenCalled();
    expect(ids(items)).toEqual(['a-repo', 'a-form']);
  });

  it('carries the same drop through getClassroomCalendar, which every calendar reader calls', async () => {
    quizzesVisible.mockResolvedValue(false);
    assignmentFindMany.mockResolvedValue([REPO, QUIZ]);

    const items = await getClassroomCalendar('class-1', START, END);

    expect(items.map(i => i.id)).toEqual(['deadline-a-repo']);
    expect(quizzesVisible).toHaveBeenCalledTimes(1);
  });
});

describe('getClassroomCalendar — event links to quiz assignments', () => {
  const link = (id: string, type: 'REPO' | 'QUIZ', featured = false) => ({
    assignment_id: id,
    occurrence_date: null,
    featured,
    assignment: {
      id,
      type,
      title: `${type} ${id}`,
      slug: id,
      is_published: true,
      repository:
        type === 'REPO'
          ? { id: `repo-${id}`, title: 'Lab', slug: 'lab', is_published: true }
          : null,
    },
  });

  const lecture = (assignmentLinks: unknown[]) => ({
    id: 'event-1',
    created_by: 'owner-1',
    event_type: 'LECTURE',
    title: 'Lecture 1',
    description: null,
    start_time: new Date('2026-09-10T14:00:00Z'),
    end_time: new Date('2026-09-10T15:00:00Z'),
    location: null,
    meeting_link: null,
    is_recurring: false,
    recurrence_rule: null,
    creator: { id: 'owner-1', name: 'Prof', accounts: [] },
    overrides: [],
    pageLinks: [],
    slideLinks: [],
    assignmentLinks,
  });

  type LinkedEvent = {
    assignments: Array<{ assignment: { id: string } }>;
    featured_resource: { id: string } | null;
    _rawAssignmentLinks?: Array<{ assignment_id: string }>;
  };

  /** The one event item, read with the raw links the edit modal gets. */
  const loadEvent = async () => {
    const items = await getClassroomCalendar('class-1', START, END, null, true, true, {
      canSeeDrafts: true,
    });
    return items.find(i => i.id === 'event-1') as unknown as LinkedEvent;
  };

  beforeEach(() => {
    assignmentFindMany.mockResolvedValue([]);
  });

  it('drops the quiz link from the chips, the star and the raw links when quizzes are hidden', async () => {
    quizzesVisible.mockResolvedValue(false);
    calendarEventFindMany.mockResolvedValue([
      lecture([link('a-repo', 'REPO'), link('a-quiz', 'QUIZ', true)]),
    ]);

    const event = await loadEvent();

    expect(event.assignments.map(a => a.assignment.id)).toEqual(['a-repo']);
    expect(event.featured_resource).toBeNull();
    expect(event._rawAssignmentLinks?.map(l => l.assignment_id)).toEqual(['a-repo']);
    expect(JSON.stringify(event)).not.toContain('a-quiz');
    expect(quizzesVisible).toHaveBeenCalledWith('class-1');
  });

  it('keeps the quiz link when quizzes are visible', async () => {
    calendarEventFindMany.mockResolvedValue([
      lecture([link('a-repo', 'REPO'), link('a-quiz', 'QUIZ', true)]),
    ]);

    const event = await loadEvent();

    expect(event.assignments.map(a => a.assignment.id)).toEqual(['a-repo', 'a-quiz']);
    expect(event.featured_resource?.id).toBe('a-quiz');
    expect(event._rawAssignmentLinks?.map(l => l.assignment_id)).toEqual(['a-repo', 'a-quiz']);
  });

  it('does not ask when no event links a quiz assignment', async () => {
    calendarEventFindMany.mockResolvedValue([lecture([link('a-repo', 'REPO')])]);

    const event = await loadEvent();

    expect(quizzesVisible).not.toHaveBeenCalled();
    expect(event.assignments.map(a => a.assignment.id)).toEqual(['a-repo']);
  });

  it('asks once for the call when a quiz link and a quiz deadline are both in range', async () => {
    quizzesVisible.mockResolvedValue(false);
    calendarEventFindMany.mockResolvedValue([lecture([link('a-quiz', 'QUIZ')])]);
    assignmentFindMany.mockResolvedValue([REPO, QUIZ]);

    const items = await getClassroomCalendar('class-1', START, END);

    expect(quizzesVisible).toHaveBeenCalledTimes(1);
    expect(items.map(i => i.id)).toEqual(['deadline-a-repo', 'event-1']);
  });
});
