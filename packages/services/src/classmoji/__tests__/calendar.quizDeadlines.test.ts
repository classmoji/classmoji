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
 *
 * Past the quiz gate, the student view (and the ICS feed, which reads it)
 * applies the one student-visibility rule, `openToStudents`: a quiz deadline
 * whose assignment is unpublished (a draft quiz), or a quiz or form deadline
 * before its `release_at`, is left out. The staff view keeps every deadline
 * and flags those.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const assignmentFindMany = vi.fn();
const calendarEventFindMany = vi.fn();
const formFindMany = vi.fn();
const quizzesVisible = vi.fn();

vi.mock('@classmoji/database', () => ({
  // calendar.service reads it for its includes; its shape does not matter here.
  GIT_IDENTITY: {},
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

const row = (
  id: string,
  type: 'REPO' | 'QUIZ' | 'FORM',
  day: number,
  over: Record<string, unknown> = {}
) => ({
  id,
  type,
  title: `${type} ${id}`,
  is_published: true,
  release_at: null,
  student_deadline: new Date(`2026-09-${String(day).padStart(2, '0')}T23:59:00Z`),
  module: { title: 'Week 1', classroom: { git_organization: { login: 'org' } } },
  repository: type === 'REPO' ? { id: `repo-${id}`, title: 'Lab', is_published: true } : null,
  quiz: type === 'QUIZ' ? { status: 'PUBLISHED' } : null,
  form: type === 'FORM' ? { status: 'OPEN' } : null,
  pages: [],
  slides: [],
  ...over,
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

describe('getDeadlinesForRange — the student-visibility rule', () => {
  // Release dates either side of the real clock, which the service reads.
  const FUTURE = new Date(Date.now() + 7 * 86_400_000);
  const PAST = new Date(Date.now() - 7 * 86_400_000);

  // A draft quiz: its assignment is unpublished (the quiz's status mirrors it).
  const DRAFT_QUIZ = row('a-draft-quiz', 'QUIZ', 9, {
    is_published: false,
    quiz: { status: 'DRAFT' },
  });
  const LATER_QUIZ = row('a-later-quiz', 'QUIZ', 10, { release_at: FUTURE });
  const OPENED_QUIZ = row('a-opened-quiz', 'QUIZ', 11, { release_at: PAST });
  const CLOSED_QUIZ = row('a-closed-quiz', 'QUIZ', 12, { quiz: { status: 'CLOSED' } });
  const DRAFT_FORM = row('a-draft-form', 'FORM', 13, { form: { status: 'DRAFT' } });
  const LATER_FORM = row('a-later-form', 'FORM', 14, { release_at: FUTURE });
  const ALL = [
    REPO,
    QUIZ,
    FORM,
    DRAFT_QUIZ,
    LATER_QUIZ,
    OPENED_QUIZ,
    CLOSED_QUIZ,
    DRAFT_FORM,
    LATER_FORM,
  ];

  it('leaves out, for students, a draft quiz and anything not yet released', async () => {
    assignmentFindMany.mockResolvedValue(ALL);

    const items = await getDeadlinesForRange('class-1', START, END);

    expect(ids(items)).toEqual(['a-repo', 'a-quiz', 'a-form', 'a-opened-quiz', 'a-closed-quiz']);
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain('a-draft-quiz');
    expect(serialized).not.toContain('a-later-quiz');
  });

  it('keeps every deadline for staff, flagging what students cannot see yet', async () => {
    assignmentFindMany.mockResolvedValue(ALL);

    const items = await getDeadlinesForRange('class-1', START, END, null, true);

    expect(Object.fromEntries(items.map(i => [i.assignment_id, i.is_unpublished]))).toEqual({
      'a-repo': false,
      'a-quiz': false,
      'a-form': false,
      'a-draft-quiz': true,
      'a-later-quiz': true,
      'a-opened-quiz': false,
      'a-closed-quiz': false,
      'a-draft-form': true,
      'a-later-form': true,
    });
  });

  it('flags for staff a repo assignment whose repository is unpublished', async () => {
    assignmentFindMany.mockResolvedValue([
      row('a-repo-hidden', 'REPO', 3, {
        repository: { id: 'repo-x', title: 'Lab', is_published: false },
      }),
    ]);

    const [item] = await getDeadlinesForRange('class-1', START, END, null, true);

    expect(item.is_unpublished).toBe(true);
  });

  it('still drops every quiz deadline, for staff too, where quizzes are hidden', async () => {
    quizzesVisible.mockResolvedValue(false);
    assignmentFindMany.mockResolvedValue(ALL);

    const items = await getDeadlinesForRange('class-1', START, END, null, true);

    expect(items.some(i => i.assignment_id.includes('quiz'))).toBe(false);
    expect(quizzesVisible).toHaveBeenCalledTimes(1);
  });

  it("reads the form's status for the rule, and nothing off the quiz", async () => {
    assignmentFindMany.mockResolvedValue([]);

    await getDeadlinesForRange('class-1', START, END);

    // A quiz's publish state and Opens date are the assignment's own columns.
    const { include } = assignmentFindMany.mock.calls[0][0];
    expect(include.quiz).toBeUndefined();
    expect(include.form).toEqual({ select: { status: true } });
  });
});

describe('getClassroomCalendar — event links to quiz assignments', () => {
  const link = (
    id: string,
    type: 'REPO' | 'QUIZ',
    featured = false,
    over: Record<string, unknown> = {}
  ) => ({
    assignment_id: id,
    occurrence_date: null,
    featured,
    assignment: {
      id,
      type,
      title: `${type} ${id}`,
      slug: id,
      is_published: true,
      release_at: null,
      quiz: type === 'QUIZ' ? { status: 'PUBLISHED' } : null,
      form: null,
      repository:
        type === 'REPO'
          ? { id: `repo-${id}`, title: 'Lab', slug: 'lab', is_published: true }
          : null,
      ...over,
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

  it('hides a link to a draft or not-yet-released quiz from students, and flags it for staff', async () => {
    const future = new Date(Date.now() + 7 * 86_400_000);
    const links = () => [
      link('a-quiz', 'QUIZ'),
      link('a-draft', 'QUIZ', true, { is_published: false, quiz: { status: 'DRAFT' } }),
      link('a-later', 'QUIZ', false, { release_at: future }),
    ];

    calendarEventFindMany.mockResolvedValue([lecture(links())]);
    const asStudent = (await getClassroomCalendar('class-1', START, END, null, false, false)).find(
      i => i.id === 'event-1'
    ) as unknown as LinkedEvent;

    expect(asStudent.assignments.map(a => a.assignment.id)).toEqual(['a-quiz']);
    expect(asStudent.featured_resource).toBeNull();
    expect(JSON.stringify(asStudent)).not.toContain('a-draft');

    calendarEventFindMany.mockResolvedValue([lecture(links())]);
    const asStaff = (await loadEvent()) as unknown as {
      assignments: Array<{ assignment: { id: string; is_published: boolean } }>;
      featured_resource: { id: string; is_draft: boolean } | null;
    };

    expect(
      Object.fromEntries(asStaff.assignments.map(a => [a.assignment.id, a.assignment.is_published]))
    ).toEqual({ 'a-quiz': true, 'a-draft': false, 'a-later': false });
    expect(asStaff.featured_resource).toMatchObject({ id: 'a-draft', is_draft: true });
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
