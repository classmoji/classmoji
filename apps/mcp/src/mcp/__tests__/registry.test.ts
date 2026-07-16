/**
 * Unit tests for the registry enforcement pipeline (S5, S6, S7 + plan §4).
 *
 * Fake tools are registered and driven through a REAL McpServer over the
 * SDK's in-memory transport, so what's asserted is exactly what a client
 * sees: scope-filtered registration, the call-time enforcement order
 * (scope → rate limit → classroom/role → mutation gate), and structured
 * isError results for every failure mode.
 *
 * `@classmoji/services` is mocked (factory idiom per packages/services
 * __tests__) so classroom/membership lookups are hand-built rows — the
 * DECISIONS under test (pure gates, ordering) all run for real.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import type { Viewer } from '../../auth/resolveViewer.ts';

const findAll = vi.fn();
const findByClassroomAndUser = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: {
      findAll: (...args: unknown[]) => findAll(...args),
      // Sanitization itself is the webapp service's concern; identity is fine here.
      getClassroomForUI: (c: unknown) => c,
    },
    classroomMembership: {
      findByClassroomAndUser: (...args: unknown[]) => findByClassroomAndUser(...args),
    },
  },
}));

const { buildMcpServer, registerToolDefinition, toolAnnotations } = await import('../registry.ts');
const { resetRateLimits } = await import('../rateLimit.ts');

/** Minimal def stub — toolAnnotations only reads `.scope` and `.annotations`. */
function annotationsOf(
  scope: 'read' | 'write',
  annotations?: { destructive?: boolean; idempotent?: boolean; openWorld?: boolean }
) {
  return toolAnnotations({ scope, annotations } as Parameters<typeof toolAnnotations>[0]);
}

// ─── Fake tools ──────────────────────────────────────────────────────────────

const throwingHandlerError = new Error('secret internal detail: db password is hunter2');
let writeHandlerCalls = 0;

beforeAll(() => {
  registerToolDefinition({
    name: 't_read_plain',
    title: 'Read plain',
    description: 'read-scope, no classroom binding',
    scope: 'read',
    roles: null,
    inputSchema: {},
    handler: async () => ({ content: [{ type: 'text', text: 'read-ok' }] }),
  });

  registerToolDefinition({
    name: 't_write_plain',
    title: 'Write plain',
    description: 'write-scope, no classroom binding',
    scope: 'write',
    roles: null,
    inputSchema: {},
    handler: async () => ({ content: [{ type: 'text', text: 'write-ok' }] }),
  });

  registerToolDefinition<{ classroom: string }>({
    name: 't_read_classroom',
    title: 'Read classroom',
    description: 'read-scope, teaching-team gated',
    scope: 'read',
    roles: ['OWNER', 'TEACHER', 'ASSISTANT'],
    inputSchema: { classroom: z.string() },
    handler: async (_args, ctx) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            classroomId: ctx.classroom?.classroomId,
            role: ctx.classroom?.role,
          }),
        },
      ],
    }),
  });

  registerToolDefinition<{ classroom: string }>({
    name: 't_write_classroom',
    title: 'Write classroom',
    description: 'write-scope, any-member classroom mutation',
    scope: 'write',
    roles: ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'],
    inputSchema: { classroom: z.string() },
    handler: async () => {
      writeHandlerCalls += 1;
      return { content: [{ type: 'text', text: 'mutated' }] };
    },
  });

  registerToolDefinition({
    name: 't_throws',
    title: 'Throws',
    description: 'handler throws a raw Error (S5)',
    scope: 'read',
    roles: null,
    inputSchema: {},
    handler: async () => {
      throw throwingHandlerError;
    },
  });

  registerToolDefinition({
    name: 't_limited',
    title: 'Limited',
    description: 'capacity-1 bucket, no refill',
    scope: 'read',
    roles: null,
    inputSchema: {},
    rateLimit: { capacity: 1, refillPerSecond: 0 },
    handler: async () => ({ content: [{ type: 'text', text: 'limited-ok' }] }),
  });

  // Registry defense-in-depth guard for a missing classroom arg: the zod
  // schema must let the argument through so the registry's own check runs.
  registerToolDefinition<{ classroom?: string }>({
    name: 't_optional_classroom',
    title: 'Optional classroom',
    description: 'role-gated but schema-optional classroom (registry guard probe)',
    scope: 'read',
    roles: ['OWNER'],
    inputSchema: { classroom: z.string().optional() },
    handler: async () => ({ content: [{ type: 'text', text: 'never' }] }),
  });
});

// ─── Harness ─────────────────────────────────────────────────────────────────

let viewerSeq = 0;

function makeViewer(scopes: string[], userId?: string): Viewer {
  viewerSeq += 1;
  return {
    userId: userId ?? `user-${viewerSeq}`,
    clientId: 'test-client',
    scopes: new Set(scopes),
  };
}

async function connectClient(viewer: Viewer) {
  const server = buildMcpServer(viewer);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'registry-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

interface ToolCallResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolCallResult;
}

function parseErrorResult(result: ToolCallResult): {
  error: string;
  code?: string;
  message: string;
} {
  expect(result.isError).toBe(true);
  expect(result.content[0]?.type).toBe('text');
  return JSON.parse(result.content[0].text);
}

const CLASSROOM_ROW = { id: 'classroom-1', status: 'ACTIVE', slug: 'cs101-fall-2025' };

/** Configure the mocked lookups: classroom row + the caller's membership role. */
function mockClassroom({
  status = 'ACTIVE',
  memberRole = null,
}: {
  status?: string;
  memberRole?: string | null;
}) {
  findAll.mockResolvedValue([{ ...CLASSROOM_ROW, status }]);
  findByClassroomAndUser.mockImplementation(
    async (_classroomId: string, _userId: string, roles: string[] | null) => {
      if (!memberRole) return null;
      if (roles && !roles.includes(memberRole)) return null;
      return { id: 'membership-1', role: memberRole };
    }
  );
}

beforeEach(() => {
  resetRateLimits();
  findAll.mockReset();
  findByClassroomAndUser.mockReset();
  writeHandlerCalls = 0;
});

// ─── Registration validation ────────────────────────────────────────────────

describe('registerToolDefinition validation', () => {
  it('rejects duplicate tool names at startup', () => {
    expect(() =>
      registerToolDefinition({
        name: 't_read_plain',
        title: 'dup',
        description: 'dup',
        scope: 'read',
        roles: null,
        inputSchema: {},
        handler: async () => ({ content: [] }),
      })
    ).toThrow(/duplicate tool definition/);
  });

  it('rejects a role-gated tool whose schema has no classroom argument', () => {
    expect(() =>
      registerToolDefinition({
        name: 't_bad_no_classroom',
        title: 'bad',
        description: 'roles without classroom arg',
        scope: 'read',
        roles: ['OWNER'],
        inputSchema: {},
        handler: async () => ({ content: [] }),
      })
    ).toThrow(/no 'classroom' argument/);
  });
});

// ─── S7: scope-filtered registration ─────────────────────────────────────────

describe('scope-filtered registration (S7)', () => {
  it('a token with only identity scopes sees ZERO tools', async () => {
    // With no read/write scope, NO tool is registered, so the McpServer never
    // advertises the `tools` capability at all — tools/list is -32601 Method
    // not found (SDK 1.29 behavior). Either way the surface is empty (S7).
    const client = await connectClient(makeViewer(['openid', 'profile', 'email']));
    await expect(client.listTools()).rejects.toMatchObject({ code: -32601 });
  });

  it('a read-only token sees read tools but no write tools', async () => {
    const client = await connectClient(makeViewer(['read']));
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain('t_read_plain');
    expect(names).toContain('t_read_classroom');
    expect(names).not.toContain('t_write_plain');
    expect(names).not.toContain('t_write_classroom');
  });

  it('a read+write token sees both', async () => {
    const client = await connectClient(makeViewer(['read', 'write']));
    const names = (await client.listTools()).tools.map(t => t.name);
    expect(names).toContain('t_read_plain');
    expect(names).toContain('t_write_plain');
  });
});

// ─── Enforcement order: scope → rate limit → classroom/role → mutation ──────

describe('call-time enforcement order', () => {
  it('rejects a missing scope BEFORE consuming the rate-limit bucket', async () => {
    // t_limited has a capacity-1, zero-refill bucket. Register with the scope
    // present, then revoke it from the (mutable) Set to trigger the call-time
    // defense-in-depth check.
    const viewer = makeViewer(['read']);
    const client = await connectClient(viewer);

    (viewer.scopes as Set<string>).delete('read');
    const denied = parseErrorResult(await callTool(client, 't_limited'));
    expect(denied.error).toBe('forbidden');
    expect(denied.message).toMatch(/requires the 'read' scope/);

    // The forbidden call must NOT have consumed the single bucket token:
    // with the scope restored, the very next call succeeds.
    (viewer.scopes as Set<string>).add('read');
    const allowed = await callTool(client, 't_limited');
    expect(allowed.isError).toBeFalsy();
    expect(allowed.content[0].text).toBe('limited-ok');
  });

  it('returns a structured rate_limited error once the bucket is exhausted (S6)', async () => {
    const client = await connectClient(makeViewer(['read']));

    const first = await callTool(client, 't_limited');
    expect(first.isError).toBeFalsy();

    const second = parseErrorResult(await callTool(client, 't_limited'));
    expect(second.error).toBe('rate_limited');
    expect(second.message).toMatch(/rate limit/i);
  });

  it('rate limit is per-user: one user exhausting a tool does not affect another', async () => {
    const clientA = await connectClient(makeViewer(['read'], 'rl-user-a'));
    const clientB = await connectClient(makeViewer(['read'], 'rl-user-b'));

    await callTool(clientA, 't_limited');
    expect(parseErrorResult(await callTool(clientA, 't_limited')).error).toBe('rate_limited');

    const other = await callTool(clientB, 't_limited');
    expect(other.isError).toBeFalsy();
  });
});

// ─── Classroom + role resolution ─────────────────────────────────────────────

describe('classroom-bound tools', () => {
  const REF = 'dev-org/cs101-fall-2025';

  it('hands the handler a resolved ClassroomContext (id + satisfying role)', async () => {
    mockClassroom({ status: 'ACTIVE', memberRole: 'ASSISTANT' });
    const client = await connectClient(makeViewer(['read']));

    const result = await callTool(client, 't_read_classroom', { classroom: REF });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text)).toEqual({
      classroomId: 'classroom-1',
      role: 'ASSISTANT',
    });
  });

  it('denies insufficient role with a structured forbidden error (S4)', async () => {
    // STUDENT calling a teaching-team tool.
    mockClassroom({ status: 'ACTIVE', memberRole: 'STUDENT' });
    const client = await connectClient(makeViewer(['read']));

    const denied = parseErrorResult(await callTool(client, 't_read_classroom', { classroom: REF }));
    expect(denied.error).toBe('forbidden');
    expect(denied.code).toBe('INSUFFICIENT_ROLE');
  });

  it('distinguishes non-members from insufficient roles', async () => {
    mockClassroom({ status: 'ACTIVE', memberRole: null });
    const client = await connectClient(makeViewer(['read']));

    const denied = parseErrorResult(await callTool(client, 't_read_classroom', { classroom: REF }));
    expect(denied.error).toBe('forbidden');
    expect(denied.code).toBe('NOT_A_MEMBER');
  });

  it('returns not_found for an unknown classroom', async () => {
    findAll.mockResolvedValue([]);
    const client = await connectClient(makeViewer(['read']));

    const denied = parseErrorResult(await callTool(client, 't_read_classroom', { classroom: REF }));
    expect(denied.error).toBe('not_found');
  });

  it('returns invalid_params for a malformed classroom reference', async () => {
    const client = await connectClient(makeViewer(['read']));
    const denied = parseErrorResult(
      await callTool(client, 't_read_classroom', { classroom: 'no-slash-here' })
    );
    expect(denied.error).toBe('invalid_params');
  });

  it('returns invalid_params when the classroom argument is missing entirely', async () => {
    const client = await connectClient(makeViewer(['read']));
    const denied = parseErrorResult(await callTool(client, 't_optional_classroom'));
    expect(denied.error).toBe('invalid_params');
    expect(denied.message).toMatch(/'classroom' argument/);
  });

  it('blocks non-owner ENTRY to an UNPUBLISHED classroom even for reads', async () => {
    mockClassroom({ status: 'UNPUBLISHED', memberRole: 'TEACHER' });
    const client = await connectClient(makeViewer(['read']));

    const denied = parseErrorResult(await callTool(client, 't_read_classroom', { classroom: REF }));
    expect(denied.error).toBe('forbidden');
    expect(denied.code).toBe('CLASSROOM_UNPUBLISHED');
  });

  it('lets the OWNER into an UNPUBLISHED classroom', async () => {
    mockClassroom({ status: 'UNPUBLISHED', memberRole: 'OWNER' });
    const client = await connectClient(makeViewer(['read']));

    const result = await callTool(client, 't_read_classroom', { classroom: REF });
    expect(result.isError).toBeFalsy();
  });

  it('does NOT block reads on a LOCKED classroom (locked ≠ unpublished)', async () => {
    mockClassroom({ status: 'LOCKED', memberRole: 'TEACHER' });
    const client = await connectClient(makeViewer(['read']));

    const result = await callTool(client, 't_read_classroom', { classroom: REF });
    expect(result.isError).toBeFalsy();
  });
});

// ─── Mutation gate (write tools) ─────────────────────────────────────────────

describe('mutation gate on write tools', () => {
  const REF = 'dev-org/cs101-fall-2025';

  it('blocks a non-owner write on a LOCKED classroom without running the handler', async () => {
    mockClassroom({ status: 'LOCKED', memberRole: 'TEACHER' });
    const client = await connectClient(makeViewer(['read', 'write']));

    const denied = parseErrorResult(
      await callTool(client, 't_write_classroom', { classroom: REF })
    );
    expect(denied.error).toBe('forbidden');
    expect(denied.code).toBe('CLASSROOM_LOCKED');
    expect(writeHandlerCalls).toBe(0);
  });

  it('allows the OWNER to write on a LOCKED classroom', async () => {
    mockClassroom({ status: 'LOCKED', memberRole: 'OWNER' });
    const client = await connectClient(makeViewer(['read', 'write']));

    const result = await callTool(client, 't_write_classroom', { classroom: REF });
    expect(result.isError).toBeFalsy();
    expect(writeHandlerCalls).toBe(1);
  });

  it('allows a non-owner write on an ACTIVE classroom', async () => {
    mockClassroom({ status: 'ACTIVE', memberRole: 'STUDENT' });
    const client = await connectClient(makeViewer(['read', 'write']));

    const result = await callTool(client, 't_write_classroom', { classroom: REF });
    expect(result.isError).toBeFalsy();
    expect(writeHandlerCalls).toBe(1);
  });
});

// ─── Tool annotations (behavioral hints surfaced to clients) ────────────────

describe('toolAnnotations mapping', () => {
  it('marks reads read-only and omits the write-only hints', () => {
    const a = annotationsOf('read');
    expect(a.readOnlyHint).toBe(true);
    expect(a.openWorldHint).toBe(false);
    // destructive/idempotent are "meaningful only when readOnlyHint is false".
    expect('destructiveHint' in a).toBe(false);
    expect('idempotentHint' in a).toBe(false);
  });

  it('defaults an unannotated write to destructive (safety-biased)', () => {
    const a = annotationsOf('write');
    expect(a).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it('passes through a destructive, external-reaching write', () => {
    expect(annotationsOf('write', { destructive: true, openWorld: true })).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it('passes through an additive idempotent write (upsert)', () => {
    expect(annotationsOf('write', { destructive: false, idempotent: true })).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });
});

describe('annotations reach the wire (tools/list)', () => {
  it('advertises readOnlyHint on reads and destructiveHint on writes', async () => {
    const client = await connectClient(makeViewer(['read', 'write']));
    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map(t => [t.name, t.annotations]));

    // t_read_plain is a read tool → read-only, no destructive hint.
    expect(byName.get('t_read_plain')).toMatchObject({ readOnlyHint: true });
    // t_write_plain is a write tool with no declared annotations → default
    // destructive:true (a client should confirm before running it).
    expect(byName.get('t_write_plain')).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    });
  });
});

// ─── S5: thrown handler errors become structured isError results ────────────

describe('async error wrapping (S5)', () => {
  it('converts a thrown handler error into a structured isError result', async () => {
    const client = await connectClient(makeViewer(['read']));

    const result = await callTool(client, 't_throws');
    const parsed = parseErrorResult(result);
    expect(parsed.error).toBe('internal');
    expect(parsed.message).toBe('Internal server error');
  });

  it('never leaks internal error details to the client', async () => {
    const client = await connectClient(makeViewer(['read']));

    const result = await callTool(client, 't_throws');
    const raw = JSON.stringify(result);
    expect(raw).not.toContain('secret internal detail');
    expect(raw).not.toContain('hunter2');
  });
});
