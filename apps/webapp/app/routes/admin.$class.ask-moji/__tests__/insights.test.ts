/**
 * The Ask Moji insights page and its exchange view, under /admin and
 * /teacher: who may load them, which classroom they read, what they audit,
 * and what they send.
 *
 * The gate is a stand-in that keeps `assertClassroomAccess`'s contract
 * (memberships by user and classroom slug, a 403 for a role outside
 * `allowedRoles` or for a non-member, the gated classroom sanitized), so the
 * matrix below runs user A vs B and classroom X vs Y against the loaders as
 * written.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ASK_MOJI_INSIGHT_DEFAULT_WEEKS } from '@classmoji/utils/ask-moji/limits';

type Role = 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT';

/** Who holds which role where. */
const MEMBERS: Record<string, Record<string, Role>> = {
  'owner-x': { 'class-x': 'OWNER' },
  'teacher-x': { 'class-x': 'TEACHER' },
  'assistant-x': { 'class-x': 'ASSISTANT' },
  'student-x': { 'class-x': 'STUDENT' },
  'owner-y': { 'class-y': 'OWNER' },
};

const CLASSROOMS: Record<string, { id: string; slug: string; settings: Record<string, unknown> }> =
  {
    'class-x': {
      id: 'X',
      slug: 'class-x',
      settings: { timezone: 'America/New_York', syllabus_bot_instructions: 'OWNER-ONLY-TEXT' },
    },
    'class-y': { id: 'Y', slug: 'class-y', settings: { timezone: null } },
  };

const mocks = vi.hoisted(() => ({
  currentUser: 'owner-x',
  assertClassroomAccess: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  impersonationAuditFields: vi.fn(),
  askMojiAvailable: vi.fn(),
  usage: vi.fn(),
  feedbackReview: vi.fn(),
  exchange: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));
vi.mock('~/routes/admin.$class.ask-moji/impersonation.server', () => ({
  impersonationAuditFields: (...a: unknown[]) => mocks.impersonationAuditFields(...a),
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    askMojiSession: { askMojiAvailable: (...a: unknown[]) => mocks.askMojiAvailable(...a) },
    askMojiInsights: {
      usage: (...a: unknown[]) => mocks.usage(...a),
      feedbackReview: (...a: unknown[]) => mocks.feedbackReview(...a),
      exchange: (...a: unknown[]) => mocks.exchange(...a),
    },
  },
}));
vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));

const adminPage = await import('../route');
const adminExchange = await import('../../admin.$class.ask-moji.$feedbackId/route');
const teacherPage = await import('../../teacher.$class_.ask-moji/route');
const teacherExchange = await import('../../teacher.$class_.ask-moji.$feedbackId/route');

/** The gate's contract, over MEMBERS and CLASSROOMS. */
const fakeGate = async (opts: { classroomSlug: string; allowedRoles: Role[] }) => {
  const classroom = CLASSROOMS[opts.classroomSlug];
  if (!classroom) throw new Response('Not Found', { status: 404 });
  const role = MEMBERS[mocks.currentUser]?.[opts.classroomSlug];
  if (!role || !opts.allowedRoles.includes(role)) {
    throw new Response('Forbidden', { status: 403 });
  }
  // The real gate hands back the classroom through getClassroomForUI, which
  // drops the instructions; the stand-in keeps them, so a leak would show.
  return { userId: mocks.currentUser, classroom, membership: { role } };
};

const USAGE = {
  timeZone: 'America/New_York',
  minAskers: 3,
  weeks: [
    {
      weekStart: '2026-10-05',
      questions: 4,
      conversations: 2,
      activeStudents: 2,
      staffQuestions: 1,
      tokensIn: 1000,
      tokensOut: 200,
      cacheRead: 50,
      cacheWrite: 5,
    },
    {
      weekStart: '2026-10-12',
      questions: 9,
      conversations: 5,
      activeStudents: 4,
      staffQuestions: 0,
      tokensIn: 3000,
      tokensOut: 700,
      cacheRead: 0,
      cacheWrite: 0,
    },
  ],
  askedFrom: [{ kind: 'page', id: 'p1', title: 'Lab 3', askers: 3, count: 7 }],
  mostCited: [
    { kind: 'platform_docs', id: null, path: '/docs/x', title: 'Docs', askers: 4, count: 5 },
  ],
};

const REVIEW_ROW = {
  feedbackId: 'fb-1',
  rating: 'DOWN',
  createdAt: new Date('2026-10-14T19:30:00Z'),
  updatedAt: new Date('2026-10-14T19:30:00Z'),
  asker: { userId: 'student-x', name: 'Ada Lovelace' },
  askerRole: 'STUDENT',
  question: 'Why is my loop infinite?',
  answerPreview: 'Check the **condition**.',
  viewing: { kind: 'page', id: 'p1', title: 'Lab 3' },
};

const EXCHANGE = {
  feedbackId: 'fb-1',
  rating: 'DOWN',
  createdAt: new Date('2026-10-14T19:30:00Z'),
  updatedAt: new Date('2026-10-14T19:30:00Z'),
  asker: { userId: 'student-x', name: 'Ada Lovelace' },
  askerRole: 'STUDENT',
  viewing: { kind: 'deck', id: 'd1', title: 'Week 3', slide: 2, detail: 'Slide 3' },
  question: { id: 'q', role: 'user', parts: [{ type: 'text', text: 'Why is my loop infinite?' }] },
  answer: {
    id: 'a',
    role: 'assistant',
    parts: [
      { type: 'data-step', id: 't1', data: { title: 'Reading Lab 3', status: 'done' } },
      { type: 'text', text: 'Check the **condition**.' },
      {
        type: 'tool-cite_content',
        toolCallId: 'c1',
        state: 'output-available',
        input: { type: 'page', id: 'p1' },
        output: { ok: true, title: 'Lab 3', url: 'https://pages.example/lab-3' },
      },
      {
        type: 'tool-cite_content',
        toolCallId: 'c2',
        state: 'output-available',
        input: { type: 'page', id: 'p2' },
        output: { ok: false },
      },
    ],
  },
};

const pageArgs = (slug: string, search = '', prefix = 'admin') => ({
  params: { class: slug },
  request: new Request(`http://x/${prefix}/${slug}/ask-moji${search}`),
});

const exchangeArgs = (slug: string, feedbackId: string, prefix = 'admin') => ({
  params: { class: slug, feedbackId },
  request: new Request(`http://x/${prefix}/${slug}/ask-moji/${feedbackId}`),
});

const loadPage = (slug: string, search = '', loader = adminPage.loader) =>
  loader(pageArgs(slug, search) as never);
const loadExchange = (slug: string, id: string, loader = adminExchange.loader) =>
  loader(exchangeArgs(slug, id) as never);

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (error) {
    if (error instanceof Response) return error.status;
    throw error;
  }
};

const auditRows = () =>
  mocks.addClassroomAuditLog.mock.calls.map(([row]) => row as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser = 'owner-x';
  mocks.assertClassroomAccess.mockImplementation(fakeGate);
  mocks.impersonationAuditFields.mockResolvedValue({});
  mocks.askMojiAvailable.mockResolvedValue({ available: true });
  mocks.usage.mockResolvedValue(USAGE);
  mocks.feedbackReview.mockResolvedValue([REVIEW_ROW]);
  mocks.exchange.mockResolvedValue(EXCHANGE);
});

describe('teacher routes', () => {
  it('re-export the admin loaders and screens, and no action', () => {
    expect(teacherPage.loader).toBe(adminPage.loader);
    expect(teacherPage.default).toBe(adminPage.default);
    expect(teacherExchange.loader).toBe(adminExchange.loader);
    expect(teacherExchange.default).toBe(adminExchange.default);
    expect(teacherPage).not.toHaveProperty('action');
    expect(teacherExchange).not.toHaveProperty('action');
  });
});

describe.each([
  ['the insights page', (slug: string) => loadPage(slug)],
  ['the exchange view', (slug: string) => loadExchange(slug, 'fb-1')],
])('%s: who may load it', (_name, load) => {
  it.each([
    ['owner-x', 200],
    ['teacher-x', 200],
    ['assistant-x', 403],
    ['student-x', 403],
    // The owner of another classroom is not a member of this one.
    ['owner-y', 403],
  ])('%s on class X: %i', async (user, expected) => {
    mocks.currentUser = user;
    expect(await status(load('class-x'))).toBe(expected);
  });

  it('asks the gate for OWNER or TEACHER only', async () => {
    await load('class-x');
    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ classroomSlug: 'class-x', allowedRoles: ['OWNER', 'TEACHER'] })
    );
  });

  it.each(['RUNTIME_OFF', 'TRIGGER_NOT_CONFIGURED', 'NO_API_KEY', 'PRO_REQUIRED', 'NOT_ENABLED'])(
    'is 404 where Ask Moji is unavailable (%s), reading and auditing nothing',
    async reason => {
      mocks.askMojiAvailable.mockResolvedValue({ available: false, reason });
      expect(await status(load('class-x'))).toBe(404);
      expect(mocks.askMojiAvailable).toHaveBeenCalledWith({ classroomId: 'X' });
      expect(mocks.usage).not.toHaveBeenCalled();
      expect(mocks.feedbackReview).not.toHaveBeenCalled();
      expect(mocks.exchange).not.toHaveBeenCalled();
      expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
    }
  );

  it('checks availability before any read, for a refused caller too', async () => {
    mocks.currentUser = 'student-x';
    await status(load('class-x'));
    expect(mocks.askMojiAvailable).not.toHaveBeenCalled();
  });
});

describe('the insights page', () => {
  it("reads the gated classroom's usage in its time zone, and the review as the viewer's role", async () => {
    mocks.currentUser = 'teacher-x';
    await loadPage('class-x');
    expect(mocks.usage).toHaveBeenCalledWith({
      classroomId: 'X',
      weeks: ASK_MOJI_INSIGHT_DEFAULT_WEEKS,
      timeZone: 'America/New_York',
    });
    expect(ASK_MOJI_INSIGHT_DEFAULT_WEEKS).toBe(12);
    expect(mocks.feedbackReview).toHaveBeenCalledWith({
      classroomId: 'X',
      viewerRole: 'TEACHER',
      rating: 'DOWN',
      limit: 50,
    });
  });

  it('reads classroom Y for its own owner, never X', async () => {
    mocks.currentUser = 'owner-y';
    await loadPage('class-y');
    expect(mocks.usage).toHaveBeenCalledWith(
      expect.objectContaining({ classroomId: 'Y', timeZone: 'UTC' })
    );
    expect(mocks.feedbackReview).toHaveBeenCalledWith(
      expect.objectContaining({ classroomId: 'Y', viewerRole: 'OWNER' })
    );
  });

  it.each([
    ['', 'DOWN'],
    ['?rating=down', 'DOWN'],
    ['?rating=up', 'UP'],
    ['?rating=anything', 'DOWN'],
  ])('reads the review filter %j as %s', async (search, rating) => {
    const data = await loadPage('class-x', search);
    expect(mocks.feedbackReview).toHaveBeenCalledWith(expect.objectContaining({ rating }));
    expect(data.rating).toBe(rating);
  });

  it('writes one VIEW row for the usage and one for the review', async () => {
    mocks.currentUser = 'teacher-x';
    await loadPage('class-x', '?rating=up');
    expect(auditRows()).toEqual([
      {
        classroomId: 'X',
        userId: 'teacher-x',
        role: 'TEACHER',
        action: 'VIEW',
        resourceType: 'ASK_MOJI_INSIGHTS',
        resourceId: 'X',
        metadata: { tool: 'web:ask_moji.insights', weeks: 12 },
      },
      {
        classroomId: 'X',
        userId: 'teacher-x',
        role: 'TEACHER',
        action: 'VIEW',
        resourceType: 'ASK_MOJI_FEEDBACK',
        resourceId: 'X',
        metadata: { tool: 'web:ask_moji.feedback_review', rating: 'UP', feedback_ids: ['fb-1'] },
      },
    ]);
  });

  it('names the rating filter in data.rating, so a 👎 read and a 👍 read are two rows', async () => {
    mocks.currentUser = 'teacher-x';
    await loadPage('class-x');
    await loadPage('class-x', '?rating=up');
    const reviews = auditRows().filter(row => row.resourceType === 'ASK_MOJI_FEEDBACK');
    expect(reviews.map(row => (row.metadata as { rating: string }).rating)).toEqual(['DOWN', 'UP']);
  });

  it('records the admin behind a View As session on both rows', async () => {
    mocks.impersonationAuditFields.mockResolvedValue({ impersonated_by: 'admin-9' });
    await loadPage('class-x');
    expect(
      auditRows().map(row => (row.metadata as Record<string, unknown>).impersonated_by)
    ).toEqual(['admin-9', 'admin-9']);
  });

  it('writes no row for a refused caller', async () => {
    mocks.currentUser = 'assistant-x';
    await status(loadPage('class-x'));
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('sends the shaped view: newest week first, times in the course zone', async () => {
    const data = await loadPage('class-x');
    expect(data.usage.timeZone).toBe('America/New_York');
    expect(data.usage.weeks.map(week => week.weekStart)).toEqual(['2026-10-12', '2026-10-05']);
    expect(data.usage.weeks[0]).toEqual({
      weekStart: '2026-10-12',
      label: 'Oct 12',
      questions: 9,
      conversations: 5,
      activeStudents: 4,
      staffQuestions: 0,
      tokensIn: 3000,
      tokensOut: 700,
    });
    expect(data.usage.askedFrom).toEqual([
      { key: 'page:p1', kind: 'Page', title: 'Lab 3', askers: 3, count: 7 },
    ]);
    expect(data.usage.mostCited[0]).toMatchObject({ kind: 'Docs', title: 'Docs', count: 5 });
    expect(data.review).toEqual([
      {
        feedbackId: 'fb-1',
        rating: 'DOWN',
        askerName: 'Ada Lovelace',
        askerRole: 'Student',
        question: 'Why is my loop infinite?',
        answerPreview: 'Check the **condition**.',
        // 19:30 UTC is 3:30 PM in New York (EDT).
        when: 'Oct 14, 3:30 PM',
        viewing: { kind: 'Page', title: 'Lab 3', detail: null },
      },
    ]);
  });

  it("never sends the owner's instructions, user ids or cache counts", async () => {
    mocks.currentUser = 'teacher-x';
    const json = JSON.stringify(await loadPage('class-x'));
    expect(json).not.toContain('OWNER-ONLY-TEXT');
    expect(json).not.toContain('student-x');
    expect(json).not.toContain('cacheRead');
  });
});

describe('the exchange view', () => {
  it('asks for the feedback id in the gated classroom, as the viewer role', async () => {
    mocks.currentUser = 'teacher-x';
    await loadExchange('class-x', 'fb-1');
    expect(mocks.exchange).toHaveBeenCalledWith({
      classroomId: 'X',
      viewerRole: 'TEACHER',
      feedbackId: 'fb-1',
    });
  });

  // The service answers null for an id in another classroom, a missing id,
  // and a staff exchange above the viewer's role alike.
  it('is 404 when the service finds no exchange this viewer may see, auditing nothing', async () => {
    mocks.currentUser = 'owner-y';
    mocks.exchange.mockResolvedValue(null);
    expect(await status(loadExchange('class-y', 'fb-1'))).toBe(404);
    expect(mocks.exchange).toHaveBeenCalledWith(
      expect.objectContaining({ classroomId: 'Y', feedbackId: 'fb-1' })
    );
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('writes a VIEW row on the feedback id', async () => {
    mocks.impersonationAuditFields.mockResolvedValue({ impersonated_by: 'admin-9' });
    await loadExchange('class-x', 'fb-1');
    expect(auditRows()).toEqual([
      {
        classroomId: 'X',
        userId: 'owner-x',
        role: 'OWNER',
        action: 'VIEW',
        resourceType: 'ASK_MOJI_FEEDBACK',
        resourceId: 'fb-1',
        metadata: {
          tool: 'web:ask_moji.exchange',
          asker_id: 'student-x',
          impersonated_by: 'admin-9',
        },
      },
    ]);
  });

  it('sends the question, the answer text, its checked sources and its steps', async () => {
    const data = await loadExchange('class-x', 'fb-1');
    expect(data.exchange).toEqual({
      feedbackId: 'fb-1',
      rating: 'DOWN',
      askerName: 'Ada Lovelace',
      askerRole: 'Student',
      when: 'Oct 14, 3:30 PM',
      viewing: { kind: 'Slides', title: 'Week 3', detail: 'Slide 3' },
      question: 'Why is my loop infinite?',
      answer: 'Check the **condition**.',
      sources: [{ title: 'Lab 3', url: 'https://pages.example/lab-3' }],
      steps: ['Reading Lab 3'],
    });
  });
});
