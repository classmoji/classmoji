/**
 * The registry records staff reads of student data in the audit log: a read
 * tool or resource that declares `auditRead` gets one VIEW row per successful
 * call, for every client (a person's own MCP client and Ask Moji alike), and
 * none on a refusal or an error. Reads without it write nothing.
 *
 * Driven through a REAL McpServer over the in-memory transport, so what is
 * asserted is what a client's call produces. `@classmoji/services` is mocked:
 * classroom/membership rows are hand-built and `audit.create` is a spy.
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
  findUsersByRole: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: {
      findAll: (...args: unknown[]) => mocks.findAll(...args),
      getClassroomForUI: (c: unknown) => c,
      getTimeZone: async () => null,
      findByUserId: async () => [],
    },
    classroomMembership: {
      findByClassroomAndUser: (...args: unknown[]) => mocks.findByClassroomAndUser(...args),
      findUsersByRole: (...args: unknown[]) => mocks.findUsersByRole(...args),
    },
    audit: { create: (...args: unknown[]) => mocks.auditCreate(...args) },
  },
}));

const { buildMcpServer, registerResourceDefinition, registerToolDefinition } =
  await import('../registry.ts');
const { resetRateLimits } = await import('../rateLimit.ts');
const { filterKey, idArgs, writeAudit } = await import('../audit.ts');
const { getRosterTool } = await import('../../tools/reads.ts');
const { rosterResource } = await import('../../resources/roster.ts');

const MEMBER: Role[] = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'];
const TEACHING_TEAM: Role[] = ['OWNER', 'TEACHER', 'ASSISTANT'];
const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

beforeAll(() => {
  registerToolDefinition<{ classroom: string; target_id?: string; note?: string }>({
    name: 't_staff_read',
    title: 'Staff read',
    description: 'teaching-team read of student data',
    scope: 'read',
    roles: TEACHING_TEAM,
    auditRead: {
      resourceType: 'GIT_REPO_ASSIGNMENT',
      ids: args => ({
        resourceId: typeof args.target_id === 'string' ? args.target_id : null,
        data: idArgs(args, ['target_id']),
      }),
    },
    inputSchema: {
      classroom: z.string(),
      target_id: z.string().optional(),
      note: z.string().optional(),
    },
    handler: async () => text({ students: ['SECRET-NAME'] }),
  });

  registerToolDefinition<{ classroom: string; assignment_id?: string; grader_id?: string }>({
    name: 't_filtered_read',
    title: 'Filtered read',
    description: 'a list read whose recorded filters vary',
    scope: 'read',
    roles: TEACHING_TEAM,
    auditRead: {
      resourceType: 'GIT_REPO_ASSIGNMENT',
      ids: (args, classroom) => ({
        resourceId: classroom.classroomId,
        data: idArgs(args, ['grader_id', 'assignment_id']),
      }),
    },
    inputSchema: {
      classroom: z.string(),
      assignment_id: z.string().optional(),
      grader_id: z.string().optional(),
    },
    handler: async () => text({ rows: [] }),
  });

  registerToolDefinition<{ classroom: string }>({
    name: 't_staff_write',
    title: 'Staff write',
    description: 'a write that records its own row',
    scope: 'write',
    roles: TEACHING_TEAM,
    annotations: { destructive: false },
    inputSchema: { classroom: z.string() },
    handler: async (_args, ctx) => {
      await writeAudit(ctx, {
        resource_type: 'GIT_REPO_ASSIGNMENT',
        resource_id: 'sub-1',
        action: 'UPDATE',
        data: { tool: 't_staff_write' },
      });
      await writeAudit(ctx, { resource_type: 'GIT_REPO_ASSIGNMENT', action: 'UPDATE' });
      return text({ ok: true });
    },
  });

  // Ask Moji's own surfaces as resources (none ship today): hidden from it.
  for (const name of ['ask_moji_r_test', 'ask-moji-r-test']) {
    registerResourceDefinition({
      name,
      uriTemplate: `classmoji-test://{org}/{slug}/${name}`,
      title: name,
      description: 'an Ask Moji owner resource',
      scope: 'read',
      roles: TEACHING_TEAM,
      handler: async () => ({ questions: ['SECRET-QUESTION'] }),
    });
  }

  registerToolDefinition<{ classroom: string }>({
    name: 't_other_staff_read',
    title: 'Other staff read',
    description: 'a second audited read on the same resource type',
    scope: 'read',
    roles: TEACHING_TEAM,
    auditRead: { resourceType: 'GIT_REPO_ASSIGNMENT' },
    inputSchema: { classroom: z.string() },
    handler: async () => text({ ok: true }),
  });

  registerToolDefinition<{ classroom: string }>({
    name: 't_branch_read',
    title: 'Role-dependent read',
    description: 'any member; only the staff branch reads other people',
    scope: 'read',
    roles: MEMBER,
    auditRead: {
      resourceType: 'TEAMS',
      when: classroom => classroom.role !== 'STUDENT',
    },
    inputSchema: { classroom: z.string() },
    handler: async (_args, ctx) => text({ role: ctx.classroom?.role }),
  });

  registerToolDefinition<{ classroom: string }>({
    name: 't_content_read',
    title: 'Content read',
    description: 'course content: not audited',
    scope: 'read',
    roles: MEMBER,
    inputSchema: { classroom: z.string() },
    handler: async () => text({ pages: [] }),
  });

  registerToolDefinition<{ classroom: string }>({
    name: 't_staff_read_throws',
    title: 'Throws',
    description: 'audited read whose handler throws',
    scope: 'read',
    roles: TEACHING_TEAM,
    auditRead: { resourceType: 'GIT_REPO_ASSIGNMENT' },
    inputSchema: { classroom: z.string() },
    handler: async () => {
      throw new Error('boom');
    },
  });

  registerToolDefinition<{ classroom: string }>({
    name: 't_staff_read_is_error',
    title: 'isError',
    description: 'audited read that answers with an isError result',
    scope: 'read',
    roles: TEACHING_TEAM,
    auditRead: { resourceType: 'GIT_REPO_ASSIGNMENT' },
    inputSchema: { classroom: z.string() },
    handler: async () => ({ ...text({ error: 'not_found' }), isError: true }),
  });

  registerResourceDefinition({
    name: 'r-staff-detail',
    uriTemplate: 'classmoji-test://{org}/{slug}/detail/{detailId}',
    title: 'Staff detail',
    description: 'audited resource',
    scope: 'read',
    roles: TEACHING_TEAM,
    auditRead: {
      resourceType: 'GIT_REPO_ASSIGNMENT',
      ids: vars => ({ resourceId: String(vars.detailId) }),
    },
    handler: async vars => ({ id: vars.detailId, student: 'SECRET-NAME' }),
  });

  // The real roster pair, end to end through the registry.
  registerToolDefinition(getRosterTool);
  registerResourceDefinition(rosterResource);
});

// ─── Harness ─────────────────────────────────────────────────────────────────

const CLASS_X = { id: 'class-x', slug: 'x', status: 'ACTIVE' };
const CLASS_Y = { id: 'class-y', slug: 'y', status: 'ACTIVE' };

/** Roles held per `${classroomId}:${userId}` (findFirst semantics). */
let held: Record<string, Role[]> = {};

function viewer(userId: string, overrides: Partial<Viewer> = {}): Viewer {
  return { userId, clientId: 'personal-client', scopes: new Set(['read']), ...overrides };
}

async function connect(v: Viewer) {
  const server = buildMcpServer(v);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'read-audit-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(v: Viewer, name: string, args: Record<string, unknown>) {
  const client = await connect(v);
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
}

const rows = () => mocks.auditCreate.mock.calls.map(c => c[0] as Record<string, unknown>);

beforeEach(() => {
  resetRateLimits();
  mocks.auditCreate.mockReset();
  mocks.auditCreate.mockResolvedValue({ id: 'audit-1' });
  mocks.findUsersByRole.mockReset();
  mocks.findUsersByRole.mockResolvedValue([
    { id: 'stu-1', name: 'Student One', is_grader: false, has_accepted_invite: true },
  ]);
  mocks.findAll.mockReset();
  mocks.findAll.mockImplementation(async (where: { slug: string }) =>
    [CLASS_X, CLASS_Y].filter(c => c.slug === where.slug)
  );
  held = {
    'class-x:ta-a': ['ASSISTANT'],
    'class-x:ta-b': ['ASSISTANT'],
    'class-y:ta-a': ['TEACHER'],
    'class-x:stu-1': ['STUDENT'],
    'class-x:ta-stu': ['ASSISTANT', 'STUDENT'],
  };
  mocks.findByClassroomAndUser.mockReset();
  mocks.findByClassroomAndUser.mockImplementation(
    async (cid: string, uid: string, roles: Role[] | null) => {
      const mine = held[`${cid}:${uid}`] ?? [];
      const match = roles ? mine.find(r => roles.includes(r)) : mine[0];
      return match ? { id: `m-${cid}-${uid}-${match}`, role: match } : null;
    }
  );
});

// ─── Registration ───────────────────────────────────────────────────────────

describe('auditRead registration', () => {
  it('refuses auditRead on a write tool or a tool with no classroom', () => {
    expect(() =>
      registerToolDefinition({
        name: 't_bad_write',
        title: 'x',
        description: 'x',
        scope: 'write',
        roles: TEACHING_TEAM,
        auditRead: { resourceType: 'X' },
        inputSchema: { classroom: z.string() },
        handler: async () => text({}),
      })
    ).toThrow(/auditRead/);
    expect(() =>
      registerToolDefinition({
        name: 't_bad_unbound',
        title: 'x',
        description: 'x',
        scope: 'read',
        roles: null,
        auditRead: { resourceType: 'X' },
        inputSchema: {},
        handler: async () => text({}),
      })
    ).toThrow(/auditRead/);
  });

  it('refuses auditRead on a resource with no classroom', () => {
    expect(() =>
      registerResourceDefinition({
        name: 'r-bad-unbound',
        uriTemplate: 'classmoji-test://static',
        title: 'x',
        description: 'x',
        scope: 'read',
        roles: null,
        auditRead: { resourceType: 'X' },
        handler: async () => ({}),
      })
    ).toThrow(/auditRead/);
  });
});

// ─── Rows ────────────────────────────────────────────────────────────────────

describe('audited reads', () => {
  it('writes exactly one VIEW row on success, with ids and no payload', async () => {
    const result = await call(viewer('ta-a'), 't_staff_read', {
      classroom: 'org/x',
      target_id: 'sub-7',
      note: 'free text that must not be recorded',
    });
    expect(result.isError).toBeFalsy();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toEqual({
      user_id: 'ta-a',
      classroom_id: 'class-x',
      role: 'ASSISTANT',
      resource_type: 'GIT_REPO_ASSIGNMENT',
      resource_id: 'sub-7',
      action: 'VIEW',
      data: {
        tool: 't_staff_read',
        via: 'mcp',
        client_id: 'personal-client',
        target_id: 'sub-7',
        filter_key: '{"target_id":"sub-7"}',
      },
    });
    expect(JSON.stringify(rows()[0])).not.toContain('SECRET-NAME');
    expect(JSON.stringify(rows()[0])).not.toContain('free text');
  });

  it('records the OAuth client, and audits an Ask Moji call the same way', async () => {
    await call(viewer('ta-a'), 't_staff_read', { classroom: 'org/x' });
    await call(viewer('ta-a', { clientId: ASK_MOJI_CLIENT_ID }), 't_staff_read', {
      classroom: 'org/x',
    });
    expect(rows()).toHaveLength(2);
    const [own, askMoji] = rows();
    expect((own.data as { client_id: string }).client_id).toBe('personal-client');
    expect((askMoji.data as { client_id: string }).client_id).toBe(ASK_MOJI_CLIENT_ID);
    const { data: ownData, ...ownRest } = own;
    const { data: askData, ...askRest } = askMoji;
    expect(askRest).toEqual(ownRest);
    expect({ ...(askData as object), client_id: 'x' }).toEqual({
      ...(ownData as object),
      client_id: 'x',
    });
  });

  it('names each tool, so two tools on one resource stay two rows', async () => {
    await call(viewer('ta-a'), 't_staff_read', { classroom: 'org/x' });
    await call(viewer('ta-a'), 't_other_staff_read', { classroom: 'org/x' });
    expect(rows().map(r => (r.data as { tool: string }).tool)).toEqual([
      't_staff_read',
      't_other_staff_read',
    ]);
  });

  it('writes nothing on a refusal', async () => {
    const insufficient = await call(viewer('stu-1'), 't_staff_read', { classroom: 'org/x' });
    expect(insufficient.isError).toBe(true);
    const notMember = await call(viewer('stranger'), 't_staff_read', { classroom: 'org/x' });
    expect(notMember.isError).toBe(true);
    const unknown = await call(viewer('ta-a'), 't_staff_read', { classroom: 'org/nope' });
    expect(unknown.isError).toBe(true);
    expect(rows()).toHaveLength(0);
  });

  it('writes nothing when the handler throws or answers isError', async () => {
    expect(
      (await call(viewer('ta-a'), 't_staff_read_throws', { classroom: 'org/x' })).isError
    ).toBe(true);
    expect(
      (await call(viewer('ta-a'), 't_staff_read_is_error', { classroom: 'org/x' })).isError
    ).toBe(true);
    expect(rows()).toHaveLength(0);
  });

  it('writes nothing for a read without auditRead', async () => {
    await call(viewer('ta-a'), 't_content_read', { classroom: 'org/x' });
    await call(viewer('stu-1'), 't_content_read', { classroom: 'org/x' });
    expect(rows()).toHaveLength(0);
  });

  it('a role-dependent read is audited on its staff branch only', async () => {
    await call(viewer('stu-1'), 't_branch_read', { classroom: 'org/x' });
    expect(rows()).toHaveLength(0);
    await call(viewer('ta-a'), 't_branch_read', { classroom: 'org/x' });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ user_id: 'ta-a', role: 'ASSISTANT', resource_type: 'TEAMS' });
  });

  it('follows the role the read was served as (Ask Moji role ceiling)', async () => {
    // A TA who is also a student, in the student view: the student branch.
    const capped = viewer('ta-stu', { clientId: ASK_MOJI_CLIENT_ID, roleCeiling: 'STUDENT' });
    await call(capped, 't_branch_read', { classroom: 'org/x' });
    expect(rows()).toHaveLength(0);
    await call(viewer('ta-stu', { clientId: ASK_MOJI_CLIENT_ID }), 't_branch_read', {
      classroom: 'org/x',
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ role: 'ASSISTANT' });
  });

  it('user A vs B: each row names the caller', async () => {
    await call(viewer('ta-a'), 't_staff_read', { classroom: 'org/x' });
    await call(viewer('ta-b'), 't_staff_read', { classroom: 'org/x' });
    expect(rows().map(r => r.user_id)).toEqual(['ta-a', 'ta-b']);
  });

  it('classroom X vs Y: each row names the classroom the call resolved', async () => {
    await call(viewer('ta-a'), 't_staff_read', { classroom: 'org/x' });
    await call(viewer('ta-a'), 't_staff_read', { classroom: 'org/y' });
    expect(rows().map(r => [r.classroom_id, r.role])).toEqual([
      ['class-x', 'ASSISTANT'],
      ['class-y', 'TEACHER'],
    ]);
  });

  it('a failed audit write is logged and the read still answers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.auditCreate.mockRejectedValueOnce(new Error('db down'));
    const result = await call(viewer('ta-a'), 't_staff_read', { classroom: 'org/x' });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({ students: ['SECRET-NAME'] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('t_staff_read'), expect.any(Error));
    warn.mockRestore();
  });
});

describe('audited resources', () => {
  it('a resources/read writes one row named after the resource, with the URI id', async () => {
    const client = await connect(viewer('ta-a'));
    await client.readResource({ uri: 'classmoji-test://org/x/detail/sub-9' });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      user_id: 'ta-a',
      classroom_id: 'class-x',
      resource_type: 'GIT_REPO_ASSIGNMENT',
      resource_id: 'sub-9',
      action: 'VIEW',
      data: { tool: 'r-staff-detail', via: 'mcp', client_id: 'personal-client' },
    });
  });

  it('a refused resources/read writes nothing', async () => {
    const client = await connect(viewer('stu-1'));
    await expect(
      client.readResource({ uri: 'classmoji-test://org/x/detail/sub-9' })
    ).rejects.toThrow();
    expect(rows()).toHaveLength(0);
  });
});

describe('the real roster read', () => {
  it('get_roster and the roster resource each write their own STUDENT_ROSTER row', async () => {
    await call(viewer('ta-a'), 'get_roster', { classroom: 'org/x' });
    const client = await connect(viewer('ta-a'));
    await client.readResource({ uri: 'classmoji://org/x/roster' });
    expect(rows()).toEqual([
      expect.objectContaining({
        resource_type: 'STUDENT_ROSTER',
        action: 'VIEW',
        data: { tool: 'get_roster', via: 'mcp', client_id: 'personal-client' },
      }),
      expect.objectContaining({
        resource_type: 'STUDENT_ROSTER',
        action: 'VIEW',
        data: { tool: 'roster', via: 'mcp', client_id: 'personal-client' },
      }),
    ]);
    expect(JSON.stringify(rows())).not.toContain('Student One');
  });
});

// ─── Filtered reads ─────────────────────────────────────────────────────────

/**
 * The audit service's 5-second merge, reduced to the fields these rows vary
 * in (packages/services audit.service.ts keys on them, filter_key included).
 */
function mergedRows() {
  const kept: Array<Record<string, unknown>> = [];
  const key = (row: Record<string, unknown>) => {
    const data = (row.data ?? {}) as Record<string, unknown>;
    return JSON.stringify([
      row.user_id,
      row.classroom_id,
      row.role,
      row.resource_type,
      row.resource_id,
      row.action,
      data.tool,
      data.client_id,
      data.filter_key,
    ]);
  };
  const seen = new Set<string>();
  for (const row of rows()) {
    if (seen.has(key(row))) continue;
    seen.add(key(row));
    kept.push(row);
  }
  return kept;
}

describe('filter_key', () => {
  it('two different filters inside the window are two rows; the same filter twice is one', async () => {
    await call(viewer('ta-a'), 't_filtered_read', { classroom: 'org/x', grader_id: 'g-1' });
    await call(viewer('ta-a'), 't_filtered_read', { classroom: 'org/x', grader_id: 'g-2' });
    await call(viewer('ta-a'), 't_filtered_read', { classroom: 'org/x' });
    await call(viewer('ta-a'), 't_filtered_read', { classroom: 'org/x', grader_id: 'g-1' });
    expect(rows()).toHaveLength(4);
    expect(mergedRows().map(r => (r.data as { filter_key: string }).filter_key)).toEqual([
      '{"grader_id":"g-1"}',
      '{"grader_id":"g-2"}',
      '{}',
    ]);
    // The classroom is the row's resource.
    expect(new Set(rows().map(r => r.resource_id))).toEqual(new Set(['class-x']));
  });

  it('is stable whatever the order the filters arrive in', async () => {
    await call(viewer('ta-a'), 't_filtered_read', {
      classroom: 'org/x',
      grader_id: 'g-1',
      assignment_id: 'a-1',
    });
    expect((rows()[0].data as Record<string, unknown>).filter_key).toBe(
      '{"assignment_id":"a-1","grader_id":"g-1"}'
    );
    expect(filterKey({ b: '2', a: '1' })).toBe(filterKey({ a: '1', b: '2' }));
  });

  it('a read that records no filters gets no filter_key', async () => {
    await call(viewer('ta-a'), 't_other_staff_read', { classroom: 'org/x' });
    expect(rows()[0].data).not.toHaveProperty('filter_key');
  });
});

describe('idArgs', () => {
  it('keeps id-shaped values only', () => {
    expect(
      idArgs(
        {
          uuid: '3f6c1f0e-8a7b-4c39-9b1e-2d4f5a6b7c8d',
          gitlab: '7:12345',
          rating: 'DOWN',
          spaced: 'two words',
          slash: 'a/b',
          long: 'x'.repeat(129),
          empty: '',
          number: 5,
        },
        ['uuid', 'gitlab', 'rating', 'spaced', 'slash', 'long', 'empty', 'number', 'absent']
      )
    ).toEqual({
      uuid: '3f6c1f0e-8a7b-4c39-9b1e-2d4f5a6b7c8d',
      gitlab: '7:12345',
      rating: 'DOWN',
    });
    expect(idArgs({ id: 'x'.repeat(128) }, ['id'])).toEqual({ id: 'x'.repeat(128) });
  });
});

// ─── Impersonation ──────────────────────────────────────────────────────────

describe('impersonated_by', () => {
  const askMoji = (overrides: Partial<Viewer> = {}) =>
    viewer('ta-a', {
      clientId: ASK_MOJI_CLIENT_ID,
      scopes: new Set(['read', 'write']),
      ...overrides,
    });

  it('is on the read row when the request runs under impersonation', async () => {
    await call(askMoji({ impersonatedBy: 'admin-1' }), 't_staff_read', {
      classroom: 'org/x',
      target_id: 'sub-7',
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      user_id: 'ta-a',
      data: {
        tool: 't_staff_read',
        client_id: ASK_MOJI_CLIENT_ID,
        target_id: 'sub-7',
        impersonated_by: 'admin-1',
      },
    });
  });

  it("is on every row a tool's own writeAudit calls write", async () => {
    await call(askMoji({ impersonatedBy: 'admin-1' }), 't_staff_write', { classroom: 'org/x' });
    expect(rows().map(r => r.data)).toEqual([
      { tool: 't_staff_write', impersonated_by: 'admin-1' },
      { impersonated_by: 'admin-1' },
    ]);
  });

  it('is absent without impersonation, on reads and writes alike', async () => {
    await call(askMoji(), 't_staff_read', { classroom: 'org/x' });
    await call(askMoji({ impersonatedBy: null }), 't_staff_write', { classroom: 'org/x' });
    expect(rows()).toHaveLength(3);
    for (const row of rows()) expect(JSON.stringify(row)).not.toContain('impersonated_by');
    expect(rows()[2]).not.toHaveProperty('data');
  });
});

// ─── Ask Moji resources ─────────────────────────────────────────────────────

describe('ask_moji_* resources', () => {
  const NAMES = ['ask_moji_r_test', 'ask-moji-r-test'];

  it('are not offered to the Ask Moji client, and are refused if read anyway', async () => {
    const client = await connect(viewer('ta-a', { clientId: ASK_MOJI_CLIENT_ID }));
    const templates = (await client.listResourceTemplates()).resourceTemplates.map(t => t.name);
    for (const name of NAMES) expect(templates).not.toContain(name);
    expect(templates).toContain('r-staff-detail');
    for (const name of NAMES) {
      await expect(
        client.readResource({ uri: `classmoji-test://org/x/${name}` })
      ).rejects.toThrow();
    }
  });

  it('are refused at read time too, not only left out of the listing', async () => {
    // Registered for another client, then read as Ask Moji: the read wrapper
    // itself refuses (the viewer object is the one the wrappers close over).
    const v = viewer('ta-a');
    const client = await connect(v);
    v.clientId = ASK_MOJI_CLIENT_ID;
    for (const name of NAMES) {
      await expect(client.readResource({ uri: `classmoji-test://org/x/${name}` })).rejects.toThrow(
        /not available to Ask Moji/
      );
    }
    expect(rows()).toHaveLength(0);
  });

  it('answer the same caller on another client', async () => {
    const client = await connect(viewer('ta-a'));
    const templates = (await client.listResourceTemplates()).resourceTemplates.map(t => t.name);
    for (const name of NAMES) expect(templates).toContain(name);
    const read = await client.readResource({ uri: 'classmoji-test://org/x/ask_moji_r_test' });
    expect(JSON.stringify(read.contents)).toContain('SECRET-QUESTION');
  });
});
