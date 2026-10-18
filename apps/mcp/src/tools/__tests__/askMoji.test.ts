/**
 * The Ask Moji owner tools: ask_moji_usage, ask_moji_feedback_list,
 * ask_moji_exchange_get and ask_moji_settings_get.
 *
 * Driven through a REAL McpServer over the in-memory transport, so the role
 * gate, the role ceiling, the client refusal and the read audit are the
 * registry's own. `@classmoji/services` is mocked: classroom and membership
 * rows are hand-built, the insights and availability services are spies, and
 * `audit.create` records the rows.
 *
 * Covered for each tool: owner and teacher in, assistant and student out
 * (settings: owner only), classroom X vs Y, refused while Ask Moji is not
 * available, exactly one audit row per success (none for settings_get). And:
 * the Ask Moji client neither lists nor calls any of them; other clients do.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ASK_MOJI_CLIENT_ID } from '@classmoji/auth/mcp-token';
import type { Role } from '@prisma/client';
import { z } from 'zod';
import type { Viewer } from '../../auth/resolveViewer.ts';

const mocks = vi.hoisted(() => ({
  findAll: vi.fn(),
  findByClassroomAndUser: vi.fn(),
  getTimeZone: vi.fn(),
  getClassroomSettingsForServer: vi.fn(),
  auditCreate: vi.fn(),
  usage: vi.fn(),
  feedbackReview: vi.fn(),
  exchange: vi.fn(),
  askMojiAvailable: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: {
      findAll: (...args: unknown[]) => mocks.findAll(...args),
      getClassroomForUI: (c: unknown) => c,
      getTimeZone: (...args: unknown[]) => mocks.getTimeZone(...args),
      findByUserId: async () => [],
      getClassroomSettingsForServer: (...args: unknown[]) =>
        mocks.getClassroomSettingsForServer(...args),
    },
    classroomMembership: {
      findByClassroomAndUser: (...args: unknown[]) => mocks.findByClassroomAndUser(...args),
    },
    audit: { create: (...args: unknown[]) => mocks.auditCreate(...args) },
    askMojiInsights: {
      usage: (...args: unknown[]) => mocks.usage(...args),
      feedbackReview: (...args: unknown[]) => mocks.feedbackReview(...args),
      exchange: (...args: unknown[]) => mocks.exchange(...args),
    },
    askMojiSession: {
      askMojiAvailable: (...args: unknown[]) => mocks.askMojiAvailable(...args),
    },
  },
}));

const { buildMcpServer, hiddenFromClient, registerToolDefinition } =
  await import('../../mcp/registry.ts');
const { resetRateLimits } = await import('../../mcp/rateLimit.ts');
const { askMojiTools } = await import('../askMoji.ts');

const ASK_MOJI_TOOL_NAMES = [
  'ask_moji_usage',
  'ask_moji_feedback_list',
  'ask_moji_exchange_get',
  'ask_moji_settings_get',
] as const;
const INSIGHT_TOOLS = ['ask_moji_usage', 'ask_moji_feedback_list', 'ask_moji_exchange_get'];

beforeAll(() => {
  for (const tool of askMojiTools) registerToolDefinition(tool);
  // An ordinary read, to show the Ask Moji client keeps everything else.
  registerToolDefinition<{ classroom: string }>({
    name: 't_course_read',
    title: 'Course read',
    description: 'course content',
    scope: 'read',
    roles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    inputSchema: { classroom: z.string() },
    handler: async () => ({ content: [{ type: 'text', text: '{}' }] }),
  });
});

// ─── Harness ─────────────────────────────────────────────────────────────────

const CLASS_X = { id: 'class-x', slug: 'x', status: 'ACTIVE' };
const CLASS_Y = { id: 'class-y', slug: 'y', status: 'ACTIVE' };

/** Roles held per `${classroomId}:${userId}`. */
let held: Record<string, Role[]> = {};

function viewer(userId: string, overrides: Partial<Viewer> = {}): Viewer {
  return { userId, clientId: 'personal-client', scopes: new Set(['read']), ...overrides };
}

async function connect(v: Viewer) {
  const server = buildMcpServer(v);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'ask-moji-tools-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type CallResult = { isError?: boolean; content: Array<{ text: string }> };

async function call(v: Viewer, name: string, args: Record<string, unknown>) {
  const client = await connect(v);
  return (await client.callTool({ name, arguments: args })) as CallResult;
}

const body = (result: CallResult) => JSON.parse(result.content[0].text);
const rows = () => mocks.auditCreate.mock.calls.map(c => c[0] as Record<string, unknown>);

const ARGS: Record<string, Record<string, unknown>> = {
  ask_moji_usage: {},
  ask_moji_feedback_list: {},
  ask_moji_exchange_get: { feedback_id: 'fb-x' },
  ask_moji_settings_get: {},
};
const argsFor = (name: string, classroom: string) => ({ classroom, ...ARGS[name] });

const ANSWER = {
  id: 'a-1',
  role: 'assistant',
  parts: [
    { type: 'data-step', id: 'call-1', data: { title: 'Looking at Week 3', status: 'done' } },
    { type: 'text', text: 'Recursion calls itself.' },
    {
      type: 'tool-cite_content',
      toolCallId: 'c-1',
      state: 'output-available',
      input: { type: 'page', id: 'page-1' },
      output: {
        ok: true,
        title: 'Week 3',
        url: 'https://pages/x/week-3',
        type: 'page',
        id: 'page-1',
      },
    },
    {
      type: 'tool-cite_content',
      toolCallId: 'c-2',
      state: 'output-available',
      input: { type: 'page', id: 'page-2' },
      output: { ok: false },
    },
    { type: 'text', text: 'See the base case.' },
  ],
};

const reviewRow = (classroomId: string) => ({
  feedbackId: `fb-${classroomId.slice(-1)}`,
  rating: 'DOWN',
  createdAt: new Date('2026-10-10T12:00:00Z'),
  updatedAt: new Date('2026-10-10T12:00:00Z'),
  asker: { userId: 'stu-x', name: 'Student X' },
  askerRole: 'STUDENT',
  question: 'What is recursion?',
  viewing: { kind: 'page', id: 'page-1', title: 'Week 3' },
});

beforeEach(() => {
  resetRateLimits();
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue({ id: 'audit-1' });
  mocks.findAll.mockImplementation(async (where: { slug: string }) =>
    [CLASS_X, CLASS_Y].filter(c => c.slug === where.slug)
  );
  mocks.getTimeZone.mockImplementation(async (id: string) =>
    id === 'class-x' ? 'America/New_York' : null
  );
  held = {
    'class-x:owner-x': ['OWNER'],
    'class-x:teacher-x': ['TEACHER'],
    'class-x:ta-x': ['ASSISTANT'],
    'class-x:stu-x': ['STUDENT'],
    'class-x:owner-teacher': ['OWNER', 'TEACHER'],
    'class-y:owner-y': ['OWNER'],
  };
  mocks.findByClassroomAndUser.mockImplementation(
    async (cid: string, uid: string, roles: Role[] | null) => {
      const mine = held[`${cid}:${uid}`] ?? [];
      const match = roles ? mine.find(r => roles.includes(r)) : mine[0];
      return match ? { id: `m-${cid}-${uid}-${match}`, role: match } : null;
    }
  );
  mocks.askMojiAvailable.mockResolvedValue({ available: true });
  mocks.usage.mockImplementation(async ({ classroomId }: { classroomId: string }) => ({
    timeZone: classroomId === 'class-x' ? 'America/New_York' : 'UTC',
    minAskers: 3,
    weeks: [
      {
        weekStart: '2026-10-12',
        questions: 4,
        conversations: 2,
        activeStudents: 2,
        staffQuestions: 1,
        tokensIn: 100,
        tokensOut: 50,
        cacheRead: 10,
        cacheWrite: 5,
      },
    ],
    askedFrom: [{ kind: 'page', id: 'page-1', title: 'Week 3', askers: 3, count: 5 }],
    mostCited: [
      { kind: 'platform_docs', id: null, path: 'docs/a.md', title: 'Docs', askers: 3, count: 4 },
    ],
  }));
  mocks.feedbackReview.mockImplementation(async ({ classroomId }: { classroomId: string }) => [
    reviewRow(classroomId),
  ]);
  // A rating exists only in the classroom it was made in.
  mocks.exchange.mockImplementation(
    async ({ classroomId, feedbackId }: { classroomId: string; feedbackId: string }) =>
      feedbackId === `fb-${classroomId.slice(-1)}`
        ? {
            ...reviewRow(classroomId),
            question: {
              id: 'q-1',
              role: 'user',
              parts: [{ type: 'text', text: 'What is recursion?' }],
            },
            answer: ANSWER,
          }
        : null
  );
  mocks.getClassroomSettingsForServer.mockResolvedValue({
    syllabus_bot_enabled: true,
    syllabus_bot_instructions: '  Be brief.  ',
    syllabus_bot_model: 'claude-sonnet-4-5',
    syllabus_bot_effort: 'low',
    anthropic_api_key: 'sk-ant-SECRET',
    openai_api_key: 'sk-OPENAI-SECRET',
  });
});

// ─── Definitions ────────────────────────────────────────────────────────────

describe('definitions', () => {
  it('are classroom-bound reads with closed-world annotations and short descriptions', async () => {
    const client = await connect(viewer('owner-x'));
    const { tools } = await client.listTools();
    for (const name of ASK_MOJI_TOOL_NAMES) {
      const tool = tools.find(t => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.annotations, name).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(tool?.inputSchema.required, name).toContain('classroom');
    }
    for (const def of askMojiTools) {
      expect(def.scope).toBe('read');
      expect(def.annotations).toEqual({ openWorld: false });
      expect(Buffer.byteLength(def.description, 'utf8'), def.name).toBeLessThan(1500);
    }
  });

  it('tiers: insights OWNER+TEACHER and audited; settings OWNER only and not audited', () => {
    const byName = new Map(askMojiTools.map(def => [def.name, def]));
    for (const name of INSIGHT_TOOLS) {
      expect(byName.get(name)?.roles, name).toEqual(['OWNER', 'TEACHER']);
      expect(byName.get(name)?.auditRead, name).toBeDefined();
    }
    expect(byName.get('ask_moji_settings_get')?.roles).toEqual(['OWNER']);
    expect(byName.get('ask_moji_settings_get')?.auditRead).toBeUndefined();
  });
});

// ─── Roles and classrooms ───────────────────────────────────────────────────

describe('who may call them', () => {
  it.each(INSIGHT_TOOLS)('%s: owner and teacher yes, assistant and student no', async name => {
    for (const user of ['owner-x', 'teacher-x']) {
      const result = await call(viewer(user), name, argsFor(name, 'org/x'));
      expect(result.isError, `${name} as ${user}`).toBeFalsy();
    }
    for (const user of ['ta-x', 'stu-x']) {
      const result = await call(viewer(user), name, argsFor(name, 'org/x'));
      expect(result.isError, `${name} as ${user}`).toBe(true);
      expect(body(result).error).toBe('forbidden');
    }
  });

  it('ask_moji_settings_get: owner only', async () => {
    expect(
      (await call(viewer('owner-x'), 'ask_moji_settings_get', { classroom: 'org/x' })).isError
    ).toBeFalsy();
    for (const user of ['teacher-x', 'ta-x', 'stu-x']) {
      const result = await call(viewer(user), 'ask_moji_settings_get', { classroom: 'org/x' });
      expect(result.isError, user).toBe(true);
      expect(body(result).error).toBe('forbidden');
    }
    expect(mocks.getClassroomSettingsForServer).toHaveBeenCalledTimes(1);
  });

  it.each(ASK_MOJI_TOOL_NAMES)('%s: classroom X vs Y', async name => {
    // Y's owner is nobody in X, and X's owner nobody in Y.
    for (const [user, ref] of [
      ['owner-y', 'org/x'],
      ['owner-x', 'org/y'],
    ] as const) {
      const result = await call(viewer(user), name, argsFor(name, ref));
      expect(result.isError, `${user} on ${ref}`).toBe(true);
    }
    expect(mocks.usage).not.toHaveBeenCalled();
    expect(mocks.feedbackReview).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.getClassroomSettingsForServer).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);

    // Each owner reads their own classroom, by the id the registry resolved.
    const own = await call(viewer('owner-y'), name, {
      ...argsFor(name, 'org/y'),
      ...(name === 'ask_moji_exchange_get' ? { feedback_id: 'fb-y' } : {}),
    });
    expect(own.isError).toBeFalsy();
    const service = {
      ask_moji_usage: mocks.usage,
      ask_moji_feedback_list: mocks.feedbackReview,
      ask_moji_exchange_get: mocks.exchange,
      ask_moji_settings_get: mocks.askMojiAvailable,
    }[name];
    expect(service.mock.calls[0][0]).toMatchObject({ classroomId: 'class-y' });
    if (name === 'ask_moji_settings_get') {
      expect(mocks.getClassroomSettingsForServer).toHaveBeenCalledWith('class-y');
    }
  });
});

// ─── Availability ───────────────────────────────────────────────────────────

describe('availability', () => {
  it.each(INSIGHT_TOOLS)(
    '%s: refused while not Pro, switched off or on another runtime',
    async name => {
      for (const reason of ['PRO_REQUIRED', 'NOT_ENABLED', 'RUNTIME_OFF', 'NO_API_KEY']) {
        mocks.askMojiAvailable.mockResolvedValueOnce({ available: false, reason });
        const result = await call(viewer('owner-x'), name, argsFor(name, 'org/x'));
        expect(result.isError, reason).toBe(true);
        expect(body(result)).toMatchObject({ error: 'forbidden', code: reason });
        expect(typeof body(result).message).toBe('string');
      }
      expect(mocks.askMojiAvailable).toHaveBeenCalledWith({ classroomId: 'class-x' });
      expect(mocks.usage).not.toHaveBeenCalled();
      expect(mocks.feedbackReview).not.toHaveBeenCalled();
      expect(mocks.exchange).not.toHaveBeenCalled();
      expect(rows()).toHaveLength(0);
    }
  );

  it('ask_moji_settings_get answers while unavailable, and says why', async () => {
    mocks.askMojiAvailable.mockResolvedValueOnce({ available: false, reason: 'PRO_REQUIRED' });
    mocks.getClassroomSettingsForServer.mockResolvedValueOnce({ syllabus_bot_enabled: false });
    const result = await call(viewer('owner-x'), 'ask_moji_settings_get', { classroom: 'org/x' });
    expect(result.isError).toBeFalsy();
    expect(body(result)).toMatchObject({
      syllabus_bot_enabled: false,
      instructions: null,
      available: false,
      unavailable_reason: 'PRO_REQUIRED',
    });
  });
});

// ─── Audit ──────────────────────────────────────────────────────────────────

describe('audit', () => {
  it('ask_moji_usage: one VIEW row per success', async () => {
    await call(viewer('teacher-x'), 'ask_moji_usage', { classroom: 'org/x', weeks: 4 });
    expect(rows()).toEqual([
      {
        user_id: 'teacher-x',
        classroom_id: 'class-x',
        role: 'TEACHER',
        resource_type: 'ASK_MOJI_INSIGHTS',
        resource_id: null,
        action: 'VIEW',
        data: { tool: 'ask_moji_usage', via: 'mcp', client_id: 'personal-client' },
      },
    ]);
  });

  it('ask_moji_feedback_list: one row with the rating only, never since', async () => {
    await call(viewer('owner-x'), 'ask_moji_feedback_list', {
      classroom: 'org/x',
      rating: 'DOWN',
      since: '2026-10-01T00:00:00Z',
      limit: 10,
    });
    expect(rows()).toEqual([
      {
        user_id: 'owner-x',
        classroom_id: 'class-x',
        role: 'OWNER',
        resource_type: 'ASK_MOJI_FEEDBACK_REVIEW',
        resource_id: null,
        action: 'VIEW',
        data: {
          tool: 'ask_moji_feedback_list',
          via: 'mcp',
          client_id: 'personal-client',
          rating: 'DOWN',
        },
      },
    ]);
    expect(JSON.stringify(rows())).not.toContain('2026-10-01');
    expect(JSON.stringify(rows())).not.toContain('recursion');
  });

  it('ask_moji_exchange_get: one row naming the feedback id, none for not found', async () => {
    await call(viewer('owner-x'), 'ask_moji_exchange_get', {
      classroom: 'org/x',
      feedback_id: 'fb-x',
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      resource_type: 'ASK_MOJI_FEEDBACK',
      resource_id: 'fb-x',
      action: 'VIEW',
      data: { tool: 'ask_moji_exchange_get', via: 'mcp', client_id: 'personal-client' },
    });
    expect(JSON.stringify(rows())).not.toContain('recursion');

    await call(viewer('owner-x'), 'ask_moji_exchange_get', {
      classroom: 'org/x',
      feedback_id: 'missing',
    });
    expect(rows()).toHaveLength(1);
  });

  it('ask_moji_settings_get: no row (the owner reads their own configuration)', async () => {
    await call(viewer('owner-x'), 'ask_moji_settings_get', { classroom: 'org/x' });
    expect(rows()).toHaveLength(0);
  });
});

// ─── Payloads ───────────────────────────────────────────────────────────────

describe('ask_moji_usage', () => {
  it("reads the course's own zone and the default weeks, and answers in snake_case", async () => {
    const result = await call(viewer('owner-x'), 'ask_moji_usage', { classroom: 'org/x' });
    expect(mocks.usage).toHaveBeenCalledWith({
      classroomId: 'class-x',
      weeks: 8,
      timeZone: 'America/New_York',
    });
    expect(body(result)).toEqual({
      time_zone: 'America/New_York',
      min_askers: 3,
      weeks: [
        {
          week_start: '2026-10-12',
          questions: 4,
          conversations: 2,
          active_students: 2,
          staff_questions: 1,
          tokens_in: 100,
          tokens_out: 50,
          cache_read: 10,
          cache_write: 5,
        },
      ],
      asked_from: [{ kind: 'page', id: 'page-1', title: 'Week 3', askers: 3, count: 5 }],
      most_cited: [
        { kind: 'platform_docs', id: null, path: 'docs/a.md', title: 'Docs', askers: 3, count: 4 },
      ],
    });
  });

  it('never takes the request zone hint over the course zone', async () => {
    await call(viewer('owner-y', { timezoneHint: 'Europe/Paris' }), 'ask_moji_usage', {
      classroom: 'org/y',
      weeks: 2,
    });
    expect(mocks.usage).toHaveBeenCalledWith({ classroomId: 'class-y', weeks: 2, timeZone: null });
  });

  it('bounds weeks in the schema', async () => {
    for (const weeks of [0, 27, 1.5]) {
      const result = await call(viewer('owner-x'), 'ask_moji_usage', {
        classroom: 'org/x',
        weeks,
      });
      expect(result.isError, String(weeks)).toBe(true);
    }
    expect(mocks.usage).not.toHaveBeenCalled();
  });
});

describe('ask_moji_feedback_list', () => {
  it('passes the role the registry resolved, the filters, and the classroom', async () => {
    const result = await call(viewer('owner-x'), 'ask_moji_feedback_list', {
      classroom: 'org/x',
      rating: 'UP',
      since: '2026-10-01T00:00:00-04:00',
      limit: 5,
    });
    expect(mocks.feedbackReview).toHaveBeenCalledWith({
      classroomId: 'class-x',
      viewerRole: 'OWNER',
      rating: 'UP',
      since: new Date('2026-10-01T04:00:00Z'),
      limit: 5,
    });
    expect(body(result)).toMatchObject({
      total: 1,
      rows: [
        {
          feedback_id: 'fb-x',
          rating: 'DOWN',
          created_at: '2026-10-10T12:00:00.000Z',
          asker: { user_id: 'stu-x', name: 'Student X' },
          asker_role: 'STUDENT',
          question: 'What is recursion?',
          viewing: { kind: 'page', id: 'page-1', title: 'Week 3' },
        },
      ],
    });
  });

  it('a teacher reviews as TEACHER', async () => {
    await call(viewer('teacher-x'), 'ask_moji_feedback_list', { classroom: 'org/x' });
    expect(mocks.feedbackReview).toHaveBeenCalledWith({
      classroomId: 'class-x',
      viewerRole: 'TEACHER',
    });
  });

  it('under a role ceiling, reviews as the capped role, not the highest held', async () => {
    await call(viewer('owner-teacher', { roleCeiling: 'TEACHER' }), 'ask_moji_feedback_list', {
      classroom: 'org/x',
    });
    expect(mocks.feedbackReview.mock.calls[0][0]).toMatchObject({ viewerRole: 'TEACHER' });
    await call(viewer('owner-teacher'), 'ask_moji_feedback_list', { classroom: 'org/x' });
    expect(mocks.feedbackReview.mock.calls[1][0]).toMatchObject({ viewerRole: 'OWNER' });
  });

  it('refuses a malformed rating, since or limit before any read', async () => {
    for (const extra of [{ rating: 'MEH' }, { since: 'last week' }, { limit: 0 }, { limit: 101 }]) {
      const result = await call(viewer('owner-x'), 'ask_moji_feedback_list', {
        classroom: 'org/x',
        ...extra,
      });
      expect(result.isError, JSON.stringify(extra)).toBe(true);
    }
    expect(mocks.feedbackReview).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });
});

describe('ask_moji_exchange_get', () => {
  it('returns the question and answer text and the cited materials only', async () => {
    const result = await call(viewer('owner-x'), 'ask_moji_exchange_get', {
      classroom: 'org/x',
      feedback_id: 'fb-x',
    });
    expect(mocks.exchange).toHaveBeenCalledWith({
      classroomId: 'class-x',
      viewerRole: 'OWNER',
      feedbackId: 'fb-x',
    });
    const out = body(result);
    expect(out).toMatchObject({
      feedback_id: 'fb-x',
      rating: 'DOWN',
      asker_role: 'STUDENT',
      question: 'What is recursion?',
      answer: 'Recursion calls itself.\n\nSee the base case.',
      cites: [{ title: 'Week 3', url: 'https://pages/x/week-3', type: 'page', id: 'page-1' }],
    });
    // No step lines or tool parts.
    expect(result.content[0].text).not.toContain('Looking at Week 3');
    expect(result.content[0].text).not.toContain('page-2');
  });

  it("another classroom's feedback id is not found, through the caller's classroom", async () => {
    const result = await call(viewer('owner-x'), 'ask_moji_exchange_get', {
      classroom: 'org/x',
      feedback_id: 'fb-y',
    });
    expect(result.isError).toBe(true);
    expect(body(result).error).toBe('not_found');
    expect(mocks.exchange).toHaveBeenCalledWith({
      classroomId: 'class-x',
      viewerRole: 'OWNER',
      feedbackId: 'fb-y',
    });
    expect(rows()).toHaveLength(0);
  });

  it('passes the ceiling-resolved role', async () => {
    await call(viewer('owner-teacher', { roleCeiling: 'TEACHER' }), 'ask_moji_exchange_get', {
      classroom: 'org/x',
      feedback_id: 'fb-x',
    });
    expect(mocks.exchange.mock.calls[0][0]).toMatchObject({ viewerRole: 'TEACHER' });
  });
});

describe('ask_moji_settings_get', () => {
  it('returns the switch, instructions, model and effort, and never a key', async () => {
    const result = await call(viewer('owner-x'), 'ask_moji_settings_get', { classroom: 'org/x' });
    expect(body(result)).toEqual({
      syllabus_bot_enabled: true,
      instructions: 'Be brief.',
      model: 'claude-sonnet-4-5',
      effort: 'low',
      has_own_key: true,
      available: true,
    });
    expect(result.content[0].text).not.toContain('SECRET');
  });
});

// ─── The Ask Moji client ────────────────────────────────────────────────────

describe('the Ask Moji client', () => {
  const askMoji = (userId: string) =>
    viewer(userId, { clientId: ASK_MOJI_CLIENT_ID, scopes: new Set(['read', 'write']) });

  it('is never offered an ask_moji_* tool, and keeps the rest', async () => {
    const client = await connect(askMoji('owner-x'));
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names.filter(n => n.startsWith('ask_moji_'))).toEqual([]);
    expect(names).toContain('t_course_read');

    const own = await connect(viewer('owner-x'));
    const ownNames = (await own.listTools()).tools.map(t => t.name);
    for (const name of ASK_MOJI_TOOL_NAMES) expect(ownNames).toContain(name);
  });

  it.each(ASK_MOJI_TOOL_NAMES)('cannot call %s, even as the owner', async name => {
    const client = await connect(askMoji('owner-x'));
    const outcome = await client
      .callTool({ name, arguments: argsFor(name, 'org/x') })
      .then(r => ({ refused: (r as CallResult).isError === true }))
      .catch(() => ({ refused: true }));
    expect(outcome.refused).toBe(true);
    expect(mocks.askMojiAvailable).not.toHaveBeenCalled();
    expect(mocks.usage).not.toHaveBeenCalled();
    expect(mocks.feedbackReview).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.getClassroomSettingsForServer).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });

  it('the same tools answer the same owner on another client', async () => {
    for (const name of ASK_MOJI_TOOL_NAMES) {
      const result = await call(viewer('owner-x'), name, argsFor(name, 'org/x'));
      expect(result.isError, name).toBeFalsy();
    }
  });

  it('the rule is by client and prefix only', () => {
    expect(hiddenFromClient('ask_moji_usage', { clientId: ASK_MOJI_CLIENT_ID })).toBe(true);
    expect(hiddenFromClient('ask_moji_anything', { clientId: ASK_MOJI_CLIENT_ID })).toBe(true);
    expect(hiddenFromClient('content_get', { clientId: ASK_MOJI_CLIENT_ID })).toBe(false);
    expect(hiddenFromClient('ask_moji_usage', { clientId: 'personal-client' })).toBe(false);
    expect(hiddenFromClient('ask_moji_usage', { clientId: null })).toBe(false);
  });
});
