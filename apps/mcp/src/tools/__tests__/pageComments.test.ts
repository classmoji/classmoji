/**
 * Page comments over MCP: `page_comments_list`, `page_comment_create`,
 * `_update`, `_delete`, `_react`, `_resolve`, and `content_get`'s
 * `open_comments`.
 *
 * WHAT IS REAL HERE
 * -----------------
 * The REAL `pageComments.service` (access, thread visibility, anchors, writes,
 * audit rows), the REAL `pageSections.service` (reader rule, reader state) and
 * the REAL `contentSearch.service` run against the schema-validating Prisma
 * stand-in. Its comment tables are a small in-memory store that answers each
 * query from its own `where` (equality, `in`, `not`, the `thread` relation
 * filter and `comments: { none: {} }`), `include`/`select` (comments → author
 * and reactions, resolved_by), `distinct` and `skipDuplicates`, so "student
 * B cannot edit A's comment" and "a thread id from classroom Y is not found
 * through X" are properties of the queries the service actually issues. Only
 * the content-repo read and the audit writer are mocked.
 *
 * Role gating by the registry is exercised through the pure gates it calls
 * (`requireRole`, `assertMutationAllowed`) with each tool's declared roles;
 * the accepted-member checks run through the handlers.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@prisma/client';
import { ToolError } from '../../mcp/errors.ts';
import { toolAnnotations, type ToolContext, type ToolDefinition } from '../../mcp/registry.ts';
import { assertMutationAllowed, requireRole } from '../../authz/pure.ts';

const mocks = vi.hoisted(() => ({
  fetchContentText: vi.fn(),
  auditCreate: vi.fn(),
  readLivePage: vi.fn(),
}));

// page_content_get's live read (the collab server), stood in for.
vi.mock('../../collab/livePage.ts', () => ({
  readLivePage: (...args: unknown[]) => mocks.readLivePage(...args),
}));

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

vi.mock('@classmoji/services', async () => {
  const search = await vi.importActual<
    typeof import('../../../../../packages/services/src/classmoji/contentSearch.service.ts')
  >('../../../../../packages/services/src/classmoji/contentSearch.service.ts');
  const sections = await vi.importActual<
    typeof import('../../../../../packages/services/src/classmoji/pageSections.service.ts')
  >('../../../../../packages/services/src/classmoji/pageSections.service.ts');
  const comments = await vi.importActual<
    typeof import('../../../../../packages/services/src/classmoji/pageComments.service.ts')
  >('../../../../../packages/services/src/classmoji/pageComments.service.ts');
  return {
    ...search,
    ClassmojiService: {
      contentDelivery: {
        fetchContentText: (...args: unknown[]) => mocks.fetchContentText(...args),
      },
      contentIndex: { slideMetadataText: () => '' },
      pageSections: sections,
      pageComments: comments,
      audit: { create: (...args: unknown[]) => mocks.auditCreate(...args) },
    },
  };
});

const {
  pageCommentsListTool,
  pageCommentCreateTool,
  pageCommentUpdateTool,
  pageCommentDeleteTool,
  pageCommentReactTool,
  pageCommentResolveTool,
  pageCommentTools,
  blockExcerpt,
  locateQuote,
} = await import('../pageComments.ts');
const { contentGetTool } = await import('../contentSearch.ts');
const { resetPrismaStub, setPrismaRaw, setPrismaRows, prismaCallsFor } =
  await import('../../__tests__/prismaSchemaStub.ts');

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CLASS_X = 'classroom-x';
const CLASS_Y = 'classroom-y';
const PAGE = '11111111-1111-4111-8111-111111111111'; // published, X
const DRAFT = '22222222-2222-4222-8222-222222222222'; // draft, X
const FOREIGN = '33333333-3333-4333-8333-333333333333'; // published, Y

const STUDENT_A = 'user-student-a';
const STUDENT_B = 'user-student-b';
const ASSISTANT = 'user-assistant';
const TEACHER = 'user-teacher';
const OWNER = 'user-owner';
const PENDING = 'user-pending'; // invited STUDENT of X, not accepted
const OUTSIDER = 'user-outsider'; // no membership in X
const STUDENT_Y = 'user-student-y'; // student of Y only

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];
const LONG =
  'Background. '.repeat(30) + 'The loop runs twice before it stops.' + ' Afterword.'.repeat(30);

const DOC_BLOCKS = [
  {
    id: 'intro',
    type: 'paragraph',
    props: {},
    content: text('Read this first. The loop runs twice.'),
    children: [],
  },
  { id: 'long', type: 'paragraph', props: {}, content: text(LONG), children: [] },
  {
    id: 'lock1',
    type: 'lockedSection',
    props: { title: 'Hint one' },
    children: [
      { id: 'b1', type: 'paragraph', props: {}, content: text('SECRET-ONE'), children: [] },
    ],
  },
];
const DOC = JSON.stringify({ blocks: DOC_BLOCKS });

const classroomStatus: Record<string, string> = {};
const collabEnabled: Record<string, boolean> = {};

const pageRow = (id: string, classroom_id: string, extra: Record<string, unknown>) => ({
  id,
  classroom_id,
  title: 'Lab',
  slug: id.slice(0, 4),
  content_path: `pages/${id}`,
  is_draft: false,
  is_public: false,
  ...extra,
});

const PAGES = [
  pageRow(PAGE, CLASS_X, {}),
  pageRow(DRAFT, CLASS_X, { is_draft: true }),
  pageRow(FOREIGN, CLASS_Y, {}),
];

type Row = Record<string, unknown>;

const membership = (user_id: string, classroom_id: string, role: Role, accepted = true): Row => ({
  user_id,
  classroom_id,
  role,
  has_accepted_invite: accepted,
});

const MEMBERSHIPS: Row[] = [
  membership(STUDENT_A, CLASS_X, 'STUDENT'),
  membership(STUDENT_B, CLASS_X, 'STUDENT'),
  membership(ASSISTANT, CLASS_X, 'ASSISTANT'),
  membership(TEACHER, CLASS_X, 'TEACHER'),
  membership(OWNER, CLASS_X, 'OWNER'),
  membership(PENDING, CLASS_X, 'STUDENT', false),
  membership(STUDENT_Y, CLASS_Y, 'STUDENT'),
  // A student of X is also a teacher of Y: Y's rights must stay in Y.
  membership(STUDENT_A, CLASS_Y, 'TEACHER'),
];

const USERS: Record<string, Row> = Object.fromEntries(
  [STUDENT_A, STUDENT_B, ASSISTANT, TEACHER, OWNER, PENDING, OUTSIDER, STUDENT_Y].map(id => [
    id,
    { id, name: `Name ${id}`, image: null },
  ])
);

// ─── The in-memory comment store ────────────────────────────────────────────

let threads: Row[] = [];
let comments: Row[] = [];
let reactions: Row[] = [];
let unlocks: Row[] = [];
let clock = 0;
const tick = () => new Date(Date.UTC(2026, 9, 29, 12, 0, clock++));

const threadById = (id: unknown) => threads.find(row => row.id === id) ?? null;

function matches(model: 'thread' | 'comment' | 'reaction' | 'plain', row: Row, where?: Row) {
  for (const [key, value] of Object.entries(where ?? {})) {
    if (model === 'comment' && key === 'thread') {
      const thread = threadById(row.thread_id);
      if (!thread || !matches('thread', thread, value as Row)) return false;
      continue;
    }
    if (model === 'thread' && key === 'comments') {
      const none = (value as { none?: unknown }).none;
      if (none === undefined) throw new Error('store: only comments.none is supported');
      if (comments.some(comment => comment.thread_id === row.id)) return false;
      continue;
    }
    if (value === null) {
      if (row[key] !== null && row[key] !== undefined) return false;
      continue;
    }
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      const filter = value as { in?: unknown[]; not?: unknown };
      if ('in' in filter) {
        if (!(filter.in ?? []).includes(row[key])) return false;
        continue;
      }
      if ('not' in filter) {
        if (
          filter.not === null
            ? row[key] === null || row[key] === undefined
            : row[key] === filter.not
        )
          return false;
        continue;
      }
      throw new Error(`store: unsupported filter on ${key}`);
    }
    if (row[key] !== value) return false;
  }
  return true;
}

const byCreated = (a: Row, b: Row) =>
  (a.created_at as Date).getTime() - (b.created_at as Date).getTime() ||
  String(a.id).localeCompare(String(b.id));

type Spec = { select?: Row; include?: Row } | undefined;

function relation(
  model: string,
  row: Row,
  key: string
): { many: boolean; model: string; rows: Row[] } | null {
  if (model === 'thread' && key === 'comments') {
    return {
      many: true,
      model: 'comment',
      rows: comments.filter(c => c.thread_id === row.id).sort(byCreated),
    };
  }
  if (model === 'thread' && (key === 'resolved_by' || key === 'created_by')) {
    const user = USERS[String(row[`${key}_id`])];
    return { many: false, model: 'user', rows: user ? [user] : [] };
  }
  if (model === 'comment' && key === 'author') {
    const user = USERS[String(row.author_id)];
    return { many: false, model: 'user', rows: user ? [user] : [] };
  }
  if (model === 'comment' && key === 'reactions') {
    return {
      many: true,
      model: 'reaction',
      rows: reactions.filter(r => r.comment_id === row.id).sort(byCreated),
    };
  }
  if (model === 'comment' && key === 'thread') {
    const thread = threadById(row.thread_id);
    return { many: false, model: 'thread', rows: thread ? [thread] : [] };
  }
  return null;
}

function project(model: string, row: Row, spec: Spec): Row {
  const pick = spec?.select ?? spec?.include;
  const out: Row = spec?.select ? {} : { ...row };
  for (const [key, value] of Object.entries(pick ?? {})) {
    if (!value) continue;
    const rel = relation(model, row, key);
    if (!rel) {
      out[key] = row[key];
      continue;
    }
    const nested = value === true ? undefined : (value as Spec);
    const shaped = rel.rows.map(r => project(rel.model, r, nested));
    out[key] = rel.many ? shaped : (shaped[0] ?? null);
  }
  return out;
}

function installDatabase(): void {
  setPrismaRows({
    page: {
      findFirst: (args: { where?: Row }) => {
        const page = PAGES.find(p => matches('plain', p, args.where));
        if (!page) return null;
        return {
          ...page,
          classroom: {
            id: page.classroom_id,
            status: classroomStatus[page.classroom_id],
            collab_enabled: collabEnabled[page.classroom_id] === true,
            content_key_version: 1,
            content_repo: `content-${page.classroom_id}`,
            git_organization: { login: 'org', provider: 'GITHUB' },
          },
        };
      },
    },
    classroom: { findUnique: () => ({ git_organization: { provider: 'GITHUB' } }) },
    classroomMembership: {
      findMany: (args: { where?: Row }) =>
        MEMBERSHIPS.filter(row => matches('plain', row, args.where)),
    },
    pageSectionUnlock: {
      findMany: (args: { where?: Row }) => unlocks.filter(row => matches('plain', row, args.where)),
    },
    pageSectionCheck: { findMany: () => [] },
    pageCommentThread: {
      findMany: (args: Row & Spec) =>
        threads
          .filter(t => matches('thread', t, args.where as Row))
          .map(t => project('thread', t, args)),
      findFirst: (args: Row & Spec) => {
        const found = threads.find(t => matches('thread', t, args.where as Row));
        return found ? project('thread', found, args) : null;
      },
      count: (args: { where?: Row }) =>
        threads.filter(t => matches('thread', t, args.where)).length,
      create: (args: { data: Row } & Spec) => {
        const { comments: nested, ...data } = args.data as Row & {
          comments?: { create: Row };
        };
        const thread: Row = {
          id: randomUUID(),
          resolved_at: null,
          resolved_by_id: null,
          ...data,
          created_at: tick(),
        };
        threads.push(thread);
        if (nested?.create) {
          comments.push({
            id: randomUUID(),
            edited_at: null,
            ...nested.create,
            thread_id: thread.id,
            created_at: tick(),
          });
        }
        return project('thread', thread, args);
      },
      updateMany: (args: { where: Row; data: Row }) => {
        const hit = threads.filter(t => matches('thread', t, args.where));
        for (const t of hit) Object.assign(t, args.data);
        return { count: hit.length };
      },
      deleteMany: (args: { where: Row }) => {
        const gone = new Set(threads.filter(t => matches('thread', t, args.where)).map(t => t.id));
        threads = threads.filter(t => !gone.has(t.id));
        const goneComments = new Set(comments.filter(c => gone.has(c.thread_id)).map(c => c.id));
        comments = comments.filter(c => !goneComments.has(c.id));
        reactions = reactions.filter(r => !goneComments.has(r.comment_id));
        return { count: gone.size };
      },
    },
    pageComment: {
      findFirst: (args: Row & Spec) => {
        const found = comments.find(c => matches('comment', c, args.where as Row));
        return found ? project('comment', found, args) : null;
      },
      create: (args: { data: Row } & Spec) => {
        if (!threadById(args.data.thread_id))
          throw Object.assign(new Error('fk'), { code: 'P2003' });
        const row: Row = { id: randomUUID(), edited_at: null, ...args.data, created_at: tick() };
        comments.push(row);
        return project('comment', row, args);
      },
      updateMany: (args: { where: Row; data: Row }) => {
        const hit = comments.filter(c => matches('comment', c, args.where));
        for (const c of hit) Object.assign(c, args.data);
        return { count: hit.length };
      },
      deleteMany: (args: { where: Row }) => {
        const gone = new Set(
          comments.filter(c => matches('comment', c, args.where)).map(c => c.id)
        );
        comments = comments.filter(c => !gone.has(c.id));
        reactions = reactions.filter(r => !gone.has(r.comment_id));
        return { count: gone.size };
      },
    },
    pageCommentReaction: {
      findMany: (args: { where?: Row; distinct?: string[] } & Spec) => {
        let rows = reactions.filter(r => matches('reaction', r, args.where)).sort(byCreated);
        if (args.distinct) {
          const seen = new Set<string>();
          rows = rows.filter(r => {
            const key = args.distinct!.map(k => String(r[k])).join('|');
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
        return rows.map(r => project('reaction', r, args));
      },
      createMany: (args: { data: Row[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const data of args.data) {
          const key = (r: Row) => `${r.comment_id}|${r.user_id}|${r.emoji}`;
          if (reactions.some(r => key(r) === key(data))) {
            if (!args.skipDuplicates) throw Object.assign(new Error('unique'), { code: 'P2002' });
            continue;
          }
          reactions.push({ id: randomUUID(), ...data, created_at: tick() });
          count++;
        }
        return { count };
      },
      deleteMany: (args: { where: Row }) => {
        const before = reactions.length;
        reactions = reactions.filter(r => !matches('reaction', r, args.where));
        return { count: before - reactions.length };
      },
    },
  });
}

/** Seed a thread with its first comment (and optional replies). */
function seedThread({
  page = PAGE,
  classroom = CLASS_X,
  block_id = null as string | null,
  quote = null as string | null,
  locked_section_id = null as string | null,
  author = STUDENT_A,
  body = 'First comment',
  resolved = false,
}: Partial<{
  page: string;
  classroom: string;
  block_id: string | null;
  quote: string | null;
  locked_section_id: string | null;
  author: string;
  body: string;
  resolved: boolean;
}> = {}): { threadId: string; commentId: string } {
  const thread: Row = {
    id: randomUUID(),
    page_id: page,
    classroom_id: classroom,
    block_id,
    quote,
    quote_occurrence: 0,
    locked_section_id,
    created_by_id: author,
    created_at: tick(),
    resolved_at: resolved ? tick() : null,
    resolved_by_id: resolved ? TEACHER : null,
  };
  threads.push(thread);
  const comment: Row = {
    id: randomUUID(),
    thread_id: thread.id,
    author_id: author,
    body,
    created_at: tick(),
    edited_at: null,
  };
  comments.push(comment);
  return { threadId: String(thread.id), commentId: String(comment.id) };
}

const ROLE_OF: Record<string, Role> = {
  [STUDENT_A]: 'STUDENT',
  [STUDENT_B]: 'STUDENT',
  [ASSISTANT]: 'ASSISTANT',
  [TEACHER]: 'TEACHER',
  [OWNER]: 'OWNER',
  [PENDING]: 'STUDENT',
  [OUTSIDER]: 'STUDENT',
  [STUDENT_Y]: 'STUDENT',
};

const ctxFor = (
  userId: string,
  {
    scopes = ['read', 'write'],
    classroomId = CLASS_X,
    impersonatedBy,
  }: { scopes?: string[]; classroomId?: string; impersonatedBy?: string } = {}
): ToolContext => {
  const role = ROLE_OF[userId];
  return {
    viewer: {
      userId,
      clientId: 'c',
      scopes: new Set(scopes),
      ...(impersonatedBy ? { impersonatedBy } : {}),
    },
    classroom: {
      classroomId,
      role,
      roles: [role],
      status: classroomStatus[classroomId],
      membership: { id: `m-${userId}`, role },
      classroom: { settings: {} },
    },
  } as unknown as ToolContext;
};

const payloadOf = (result: { content: Array<{ text: string }> }) =>
  JSON.parse(result.content[0].text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const call = async <A>(tool: ToolDefinition<A>, args: A, ctx: ToolContext) =>
  payloadOf((await tool.handler(args, ctx)) as { content: Array<{ text: string }> });

async function refusalOf(run: () => Promise<unknown>) {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the handler to refuse').toBeInstanceOf(ToolError);
  const error = caught as ToolError;
  return { error: error.kind, code: error.code, message: error.message };
}

const NOT_FOUND = { error: 'not_found' };

const list = (
  userId: string,
  args: Partial<{ page_id: string; status: 'open' | 'resolved' | 'all' }> = {}
) => call(pageCommentsListTool, { classroom: 'org/x', page_id: PAGE, ...args }, ctxFor(userId));
const create = (userId: string, args: Record<string, unknown>) =>
  call(
    pageCommentCreateTool,
    { classroom: 'org/x', page_id: PAGE, body: 'Hello', ...args } as never,
    ctxFor(userId)
  );
const update = (userId: string, comment_id: string, body: string, page_id = PAGE) =>
  call(pageCommentUpdateTool, { classroom: 'org/x', page_id, comment_id, body }, ctxFor(userId));
const remove = (userId: string, comment_id: string, page_id = PAGE) =>
  call(pageCommentDeleteTool, { classroom: 'org/x', page_id, comment_id }, ctxFor(userId));
const react = (userId: string, comment_id: string, emoji: string, on: boolean, page_id = PAGE) =>
  call(
    pageCommentReactTool,
    { classroom: 'org/x', page_id, comment_id, emoji, on },
    ctxFor(userId)
  );
const resolve = (userId: string, thread_id: string, resolved: boolean, page_id = PAGE) =>
  call(
    pageCommentResolveTool,
    { classroom: 'org/x', page_id, thread_id, resolved },
    ctxFor(userId)
  );

const auditRows = () => mocks.auditCreate.mock.calls.map(call => call[0] as Row);

let rawRows: unknown[] = [];

beforeEach(() => {
  resetPrismaStub();
  threads = [];
  comments = [];
  reactions = [];
  unlocks = [];
  clock = 0;
  rawRows = [];
  classroomStatus[CLASS_X] = 'ACTIVE';
  classroomStatus[CLASS_Y] = 'ACTIVE';
  collabEnabled[CLASS_X] = false;
  mocks.readLivePage.mockReset().mockResolvedValue({ fallbackNote: null });
  // Raw SQL: the service's row locks (answered from the store, scoped by the
  // values they bind), else the search index rows content_get reads.
  setPrismaRaw((parts: unknown) => {
    const [strings, ...values] = parts as [readonly string[], ...unknown[]];
    const sql = Array.isArray(strings) ? strings.join('?') : '';
    if (/FROM page_comment_threads/.test(sql) && /FOR UPDATE/.test(sql)) {
      const [id, page_id, classroom_id] = values;
      return threads
        .filter(t => t.id === id && t.page_id === page_id && t.classroom_id === classroom_id)
        .map(t => ({ id: t.id, resolved_at: t.resolved_at }));
    }
    if (/FROM page_comments\b/.test(sql) && /FOR UPDATE/.test(sql)) {
      return comments.filter(c => c.id === values[0]).map(c => ({ id: c.id }));
    }
    if (/FOR UPDATE/.test(sql)) throw new Error(`store: unexpected lock query ${sql}`);
    return rawRows;
  });
  installDatabase();
  mocks.fetchContentText
    .mockReset()
    .mockImplementation(async (_ctx: unknown, repoPath: string) =>
      repoPath.endsWith('/content.json') ? { text: DOC, sha: 'sha', source: 'worker' } : null
    );
  mocks.auditCreate.mockReset().mockResolvedValue(undefined);
});

// ─── Definitions ────────────────────────────────────────────────────────────

describe('tool definitions', () => {
  const hints = (tool: unknown) => toolAnnotations(tool as ToolDefinition<never>);

  it('pins scope, roles and annotations for every tool', () => {
    const MEMBERS = ['ASSISTANT', 'OWNER', 'STUDENT', 'TEACHER'];
    const expected: Record<string, { scope: string; roles: string[]; hints: Row }> = {
      page_comments_list: {
        scope: 'read',
        roles: MEMBERS,
        hints: { readOnlyHint: true, openWorldHint: false },
      },
      page_comment_create: {
        scope: 'write',
        roles: MEMBERS,
        hints: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      page_comment_update: {
        scope: 'write',
        roles: MEMBERS,
        hints: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      page_comment_delete: {
        scope: 'write',
        roles: MEMBERS,
        hints: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      page_comment_react: {
        scope: 'write',
        roles: MEMBERS,
        hints: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      page_comment_resolve: {
        scope: 'write',
        roles: ['ASSISTANT', 'OWNER', 'TEACHER'],
        hints: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    };
    expect(pageCommentTools.map(tool => tool.name).sort()).toEqual(Object.keys(expected).sort());
    for (const tool of pageCommentTools) {
      const want = expected[tool.name];
      expect(tool.scope, tool.name).toBe(want.scope);
      expect([...(tool.roles ?? [])].sort(), tool.name).toEqual(want.roles);
      expect(hints(tool), tool.name).toEqual(want.hints);
      // Every write declares its annotations explicitly (no safety default).
      if (tool.scope === 'write') {
        expect(tool.annotations?.destructive, tool.name).toBeTypeOf('boolean');
        expect(tool.annotations?.idempotent, tool.name).toBeTypeOf('boolean');
        expect(tool.annotations?.openWorld, tool.name).toBe(false);
      }
      // Writes follow the mutation rule (LOCKED is read-only), never readerState.
      expect(tool.readerState, tool.name).toBeUndefined();
      // No VIEW row: the shared discussion (plan D8).
      expect(tool.auditRead, tool.name).toBeUndefined();
      expect(tool.inputSchema, tool.name).toHaveProperty('classroom');
    }
  });

  it('keeps every description under the 1,500 bytes a client will keep', () => {
    for (const tool of [...pageCommentTools, contentGetTool]) {
      expect(Buffer.byteLength(tool.description, 'utf8'), tool.name).toBeLessThan(1500);
    }
    expect(pageCommentDeleteTool.description).toMatch(/cannot be undone/i);
  });

  it('are registered in the tool manifest', () => {
    const manifest = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.ts'),
      'utf8'
    );
    for (const name of [
      'pageCommentsListTool',
      'pageCommentCreateTool',
      'pageCommentUpdateTool',
      'pageCommentDeleteTool',
      'pageCommentReactTool',
      'pageCommentResolveTool',
    ]) {
      expect(manifest).toContain(`registerToolDefinition(${name})`);
    }
  });
});

describe('registry gates', () => {
  const gate = (tool: { roles: readonly Role[] | null }, role: Role) => () =>
    requireRole([{ role }], tool.roles);

  it('lets every member role reach the member tools, and nobody outside the class', () => {
    for (const tool of pageCommentTools.filter(t => t.name !== 'page_comment_resolve')) {
      for (const role of ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'] as Role[]) {
        expect(gate(tool, role), `${tool.name} ${role}`).not.toThrow();
      }
      expect(() => requireRole([], tool.roles), tool.name).toThrow(ToolError);
    }
  });

  it('keeps students off page_comment_resolve', () => {
    expect(gate(pageCommentResolveTool, 'STUDENT')).toThrow(ToolError);
    for (const role of ['OWNER', 'TEACHER', 'ASSISTANT'] as Role[]) {
      expect(gate(pageCommentResolveTool, role), role).not.toThrow();
    }
  });

  it('refuses every write in a LOCKED classroom for non-owners, with the reason', () => {
    for (const role of ['TEACHER', 'ASSISTANT', 'STUDENT'] as Role[]) {
      let caught: unknown;
      try {
        assertMutationAllowed({ status: 'LOCKED', role });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ToolError);
      expect((caught as ToolError).code).toBe('CLASSROOM_LOCKED');
      expect((caught as ToolError).message).toMatch(/read-only/);
    }
    expect(() => assertMutationAllowed({ status: 'LOCKED', role: 'OWNER' })).not.toThrow();
  });
});

// ─── Role matrix through the handlers ───────────────────────────────────────

describe('role matrix', () => {
  it.each([STUDENT_A, ASSISTANT, TEACHER, OWNER])(
    '%s lists, starts a thread, replies, reacts and edits their own comment',
    async userId => {
      const created = await create(userId, { block_id: 'intro', quote: 'loop runs' });
      expect(created.new_thread).toBe(true);
      const threadId = created.thread.thread_id as string;
      const reply = await create(userId, { thread_id: threadId, body: 'A reply' });
      expect(reply.thread.comments).toHaveLength(2);
      const commentId = reply.comment_id as string;
      const reacted = await react(userId, commentId, '👍', true);
      expect(reacted.thread.comments[1].reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
      const edited = await update(userId, commentId, 'A better reply');
      expect(edited.changed).toBe(true);
      expect(edited.thread.comments[1].edited_at).toBeTypeOf('string');

      const listed = await list(userId);
      expect(listed.threads).toHaveLength(1);
      expect(listed.viewer).toMatchObject({ can_write: true, frozen: false, write_tools: true });
    }
  );

  it('gives a pending invitee and a non-member "not found" on every tool', async () => {
    const { threadId, commentId } = seedThread();
    for (const userId of [PENDING, OUTSIDER]) {
      expect(await refusalOf(() => list(userId))).toMatchObject(NOT_FOUND);
      expect(await refusalOf(() => create(userId, {}))).toMatchObject(NOT_FOUND);
      expect(await refusalOf(() => create(userId, { thread_id: threadId }))).toMatchObject(
        NOT_FOUND
      );
      expect(await refusalOf(() => update(userId, commentId, 'x'))).toMatchObject(NOT_FOUND);
      expect(await refusalOf(() => remove(userId, commentId))).toMatchObject(NOT_FOUND);
      expect(await refusalOf(() => react(userId, commentId, '👍', true))).toMatchObject(NOT_FOUND);
    }
    expect(comments).toHaveLength(1);
    expect(reactions).toHaveLength(0);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    // Nothing is read from the content repo for a caller who may not read.
    expect(mocks.fetchContentText).not.toHaveBeenCalled();
  });

  it('hides a draft page from students, and shows it to the teaching team', async () => {
    expect(await refusalOf(() => list(STUDENT_A, { page_id: DRAFT }))).toMatchObject(NOT_FOUND);
    expect(await refusalOf(() => create(STUDENT_A, { page_id: DRAFT }))).toMatchObject(NOT_FOUND);
    for (const userId of [ASSISTANT, TEACHER, OWNER]) {
      expect((await list(userId, { page_id: DRAFT })).threads).toEqual([]);
    }
  });

  it('lets the teaching team resolve and reopen, and refuses a student in the handler too', async () => {
    const { threadId } = seedThread();
    const refused = await refusalOf(() => resolve(STUDENT_A, threadId, true));
    expect(refused).toMatchObject({ error: 'forbidden', code: 'NOT_TEACHING_TEAM' });

    const done = await resolve(ASSISTANT, threadId, true);
    expect(done.changed).toBe(true);
    expect(done.thread.resolved).toBe(true);
    expect(done.thread.resolved_by).toEqual({
      name: `Name ${ASSISTANT}`,
      image: null,
      badge: 'TA',
    });
    // Idempotent: no change, no second audit row.
    expect((await resolve(TEACHER, threadId, true)).changed).toBe(false);
    expect((await resolve(TEACHER, threadId, false)).thread.resolved).toBe(false);
    expect(auditRows().map(row => (row.data as Row).resolved)).toEqual([true, false]);
  });

  it('marks staff authors with their badge and never sends ids, logins or emails', async () => {
    seedThread({ author: TEACHER, body: 'From staff' });
    const listed = await list(STUDENT_A);
    expect(listed.threads[0].comments[0].author).toEqual({
      name: `Name ${TEACHER}`,
      image: null,
      badge: 'Instructor',
    });
    const json = JSON.stringify(listed);
    // The display name embeds the fixture id; the id itself is never a value.
    expect(json).not.toContain(`"${TEACHER}"`);
    expect(json).not.toMatch(/login|email/);
  });
});

// ─── User A vs user B ───────────────────────────────────────────────────────

describe('user A vs user B', () => {
  it("refuses B editing or deleting A's comment, and lists them as not B's to change", async () => {
    const { commentId } = seedThread({ author: STUDENT_A, body: 'Original' });

    expect(await refusalOf(() => update(STUDENT_B, commentId, 'Hijacked'))).toMatchObject({
      error: 'forbidden',
      code: 'NOT_AUTHOR',
    });
    expect(await refusalOf(() => remove(STUDENT_B, commentId))).toMatchObject({
      error: 'forbidden',
      code: 'NOT_AUTHOR',
    });
    // An assistant is not a moderator.
    expect(await refusalOf(() => remove(ASSISTANT, commentId))).toMatchObject({
      error: 'forbidden',
      code: 'NOT_AUTHOR',
    });
    // Nobody edits someone else's comment, moderators included.
    expect(await refusalOf(() => update(TEACHER, commentId, 'Edited by staff'))).toMatchObject({
      error: 'forbidden',
      code: 'NOT_AUTHOR',
    });
    expect(comments[0].body).toBe('Original');

    const forB = (await list(STUDENT_B)).threads[0].comments[0];
    expect(forB).toMatchObject({ can_edit: false, can_delete: false });
    const forA = (await list(STUDENT_A)).threads[0].comments[0];
    expect(forA).toMatchObject({ can_edit: true, can_delete: true });
    const forTeacher = (await list(TEACHER)).threads[0].comments[0];
    expect(forTeacher).toMatchObject({ can_edit: false, can_delete: true });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('keeps reactions per user: B sees A’s reaction counted, not as theirs', async () => {
    const { commentId } = seedThread();
    await react(STUDENT_A, commentId, '🎉', true);
    const forB = (await list(STUDENT_B)).threads[0].comments[0].reactions;
    expect(forB).toEqual([{ emoji: '🎉', count: 1, mine: false }]);
    // B removing their (absent) reaction does not remove A's.
    expect((await react(STUDENT_B, commentId, '🎉', false)).changed).toBe(false);
    expect(reactions).toHaveLength(1);
  });

  it.each([TEACHER, OWNER])(
    "lets %s delete a student's comment as moderation, audited with the author",
    async moderator => {
      const { threadId, commentId } = seedThread({ author: STUDENT_A, body: 'Rude words' });
      const reply = await create(STUDENT_B, { thread_id: threadId, body: 'Keep me' });

      const result = await remove(moderator, commentId);
      expect(result).toMatchObject({ deleted: true, thread_deleted: false });
      expect(result.thread.comments.map((c: Row) => c.comment_id)).toEqual([reply.comment_id]);

      const row = auditRows().at(-1)!;
      expect(row).toMatchObject({
        user_id: moderator,
        classroom_id: CLASS_X,
        role: ROLE_OF[moderator],
        resource_type: 'PAGES',
        resource_id: PAGE,
        action: 'DELETE',
      });
      expect(row.data).toMatchObject({
        tool: 'page_comment',
        via: 'mcp',
        moderated: true,
        comment_author_id: STUDENT_A,
        thread_deleted: false,
        page_id: PAGE,
      });
      expect(JSON.stringify(mocks.auditCreate.mock.calls)).not.toContain('Rude words');
    }
  );

  it('deletes a thread with its last comment, and an own delete is not moderation', async () => {
    const { threadId, commentId } = seedThread({ author: STUDENT_A });
    await react(STUDENT_B, commentId, '👍', true);
    const result = await remove(STUDENT_A, commentId);
    expect(result).toMatchObject({ deleted: true, thread_deleted: true, thread: null });
    expect(threads.find(t => t.id === threadId)).toBeUndefined();
    expect(reactions).toHaveLength(0);
    const data = auditRows().at(-1)!.data as Row;
    expect(data).toMatchObject({ moderated: false, thread_deleted: true });
    expect(data).not.toHaveProperty('comment_author_id');
  });
});

// ─── Classroom X vs classroom Y ─────────────────────────────────────────────

describe('classroom X vs classroom Y', () => {
  it("answers Y's page through X as not found, without reading its content", async () => {
    seedThread({ page: FOREIGN, classroom: CLASS_Y });
    for (const userId of [STUDENT_A, TEACHER, OWNER]) {
      expect(await refusalOf(() => list(userId, { page_id: FOREIGN }))).toMatchObject(NOT_FOUND);
      expect(await refusalOf(() => create(userId, { page_id: FOREIGN }))).toMatchObject(NOT_FOUND);
    }
    const lookups = prismaCallsFor('page', 'findFirst').map(c => (c.args as { where: Row }).where);
    expect(lookups.every(where => where.classroom_id === CLASS_X)).toBe(true);
    expect(mocks.fetchContentText).not.toHaveBeenCalled();
  });

  it("refuses Y's thread and comment ids through X's page, and changes nothing in Y", async () => {
    const foreign = seedThread({ page: FOREIGN, classroom: CLASS_Y, author: STUDENT_Y });
    seedThread(); // something on X's page, so the page itself is fine

    // STUDENT_A is a TEACHER in Y: their Y rights do not reach through X.
    for (const userId of [STUDENT_A, TEACHER, OWNER]) {
      expect(
        await refusalOf(() => create(userId, { thread_id: foreign.threadId, body: 'x' }))
      ).toMatchObject(NOT_FOUND);
      expect(await refusalOf(() => update(userId, foreign.commentId, 'x'))).toMatchObject(
        NOT_FOUND
      );
      expect(await refusalOf(() => remove(userId, foreign.commentId))).toMatchObject(NOT_FOUND);
      expect(await refusalOf(() => react(userId, foreign.commentId, '👍', true))).toMatchObject(
        NOT_FOUND
      );
    }
    for (const userId of [ASSISTANT, TEACHER, OWNER]) {
      expect(await refusalOf(() => resolve(userId, foreign.threadId, true))).toMatchObject(
        NOT_FOUND
      );
    }
    expect(comments.filter(c => c.thread_id === foreign.threadId)).toHaveLength(1);
    expect(threadById(foreign.threadId)?.resolved_at).toBeNull();
    expect(reactions).toHaveLength(0);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    // X's list never shows Y's thread.
    const listed = await list(OWNER);
    expect(JSON.stringify(listed)).not.toContain(foreign.threadId);
  });

  it('scopes every comment query by the page AND its classroom', async () => {
    const { commentId } = seedThread();
    await list(STUDENT_A);
    await react(STUDENT_A, commentId, '👍', true);
    const threadWheres = prismaCallsFor('pageCommentThread').map(
      c => (c.args as { where?: Row }).where
    );
    for (const where of threadWheres) {
      expect(where).toMatchObject({ page_id: PAGE, classroom_id: CLASS_X });
    }
    const [commentLookup] = prismaCallsFor('pageComment', 'findFirst');
    expect((commentLookup.args as { where: Row }).where).toEqual({
      id: commentId,
      thread: { page_id: PAGE, classroom_id: CLASS_X },
    });
  });
});

// ─── Locked sections ────────────────────────────────────────────────────────

describe('locked sections never leak', () => {
  const seedLocked = () => ({
    onBody: seedThread({
      block_id: 'b1',
      quote: 'SECRET-ONE',
      locked_section_id: 'lock1',
      author: STUDENT_B,
      body: 'Is this right?',
    }),
    // Its block is gone from the document; the gate outlives it.
    orphan: seedThread({ block_id: 'gone', locked_section_id: 'lock1', author: STUDENT_B }),
    open: seedThread({ block_id: 'intro', author: STUDENT_B }),
  });

  it('hides threads inside a locked body from a student who has not unlocked it', async () => {
    const seeded = seedLocked();
    const listed = await list(STUDENT_A, { status: 'all' });
    const json = JSON.stringify(listed);
    expect(listed.threads.map((t: Row) => t.thread_id)).toEqual([seeded.open.threadId]);
    expect(json).not.toContain('SECRET-ONE');
    expect(json).not.toContain(seeded.onBody.threadId);
    expect(json).not.toContain(seeded.orphan.threadId);
    expect(json).not.toContain('Is this right?');
    expect(listed.open).toBe(1);
  });

  it('refuses every act on a hidden thread like an id that does not exist', async () => {
    const { onBody } = seedLocked();
    expect(await refusalOf(() => create(STUDENT_A, { thread_id: onBody.threadId }))).toMatchObject(
      NOT_FOUND
    );
    expect(await refusalOf(() => react(STUDENT_A, onBody.commentId, '👍', true))).toMatchObject(
      NOT_FOUND
    );
    // A block or text inside the locked body cannot be commented on, or probed.
    expect(await refusalOf(() => create(STUDENT_A, { block_id: 'b1' }))).toMatchObject({
      error: 'invalid_params',
      code: 'INVALID_BLOCK',
    });
    expect(await refusalOf(() => create(STUDENT_A, { quote: 'SECRET-ONE' }))).toMatchObject({
      error: 'invalid_params',
      code: 'INVALID_QUOTE',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('shows them, with the excerpt, to a student who unlocked it and to staff', async () => {
    const seeded = seedLocked();
    unlocks = [{ page_id: PAGE, user_id: STUDENT_A, block_id: 'lock1', unlocked_at: new Date() }];
    const forA = await list(STUDENT_A);
    const thread = forA.threads.find((t: Row) => t.thread_id === seeded.onBody.threadId);
    expect(thread).toMatchObject({ block_excerpt: 'SECRET-ONE', anchor: 'ok' });
    expect(forA.threads.map((t: Row) => t.thread_id)).toContain(seeded.orphan.threadId);

    // A's unlock opens nothing for B: B started both threads and still sees
    // neither without unlocking the section themselves.
    const forB = await list(STUDENT_B);
    expect(forB.threads.map((t: Row) => t.thread_id)).toEqual([seeded.open.threadId]);

    const forTeacher = await list(TEACHER);
    expect(forTeacher.threads).toHaveLength(3);
  });

  it("content_get's open_comments counts only the threads the caller can read", async () => {
    seedLocked();
    seedThread({ resolved: true });
    const get = (userId: string) =>
      call(contentGetTool, { classroom: 'org/x', kind: 'page' as const, id: PAGE }, ctxFor(userId));
    const forA = await get(STUDENT_A);
    expect(forA.open_comments).toBe(1);
    expect(forA.comments_hint).toMatch(/page_comments_list/);
    expect((await get(TEACHER)).open_comments).toBe(3);
    // A pending invitee and a caller whose content cannot be read get no field.
    const pending = await get(PENDING);
    expect(pending).not.toHaveProperty('open_comments');
  });
});

describe("content_get's open_comments on an indexed page", () => {
  it('counts from the same blocks the per-viewer text reads, for accepted members only', async () => {
    seedThread({ block_id: 'intro' });
    seedThread({ block_id: 'b1', locked_section_id: 'lock1' });
    rawRows = [
      {
        docKind: 'page',
        docId: PAGE,
        title: 'Lab',
        sourcePath: `pages/${PAGE}/content.json`,
        text: 'Lab\nRead this first.',
        chunkCount: 1,
        isDraft: false,
      },
    ];
    const get = (userId: string) =>
      call(contentGetTool, { classroom: 'org/x', kind: 'page' as const, id: PAGE }, ctxFor(userId));

    const forA = await get(STUDENT_A);
    expect(forA.indexed).toBe(true);
    expect(forA.open_comments).toBe(1);
    expect((await get(TEACHER)).open_comments).toBe(2);
    expect(await get(PENDING)).not.toHaveProperty('open_comments');
    // One content read per call, shared by the text and the count.
    mocks.fetchContentText.mockClear();
    await get(STUDENT_A);
    expect(mocks.fetchContentText).toHaveBeenCalledTimes(1);
  });
});

// ─── LOCKED classroom ───────────────────────────────────────────────────────

describe('a LOCKED classroom', () => {
  it('keeps the list readable, refuses writes with the reason, and lets the owner write', async () => {
    const { threadId, commentId } = seedThread({ author: STUDENT_A });
    classroomStatus[CLASS_X] = 'LOCKED';

    const listed = await list(STUDENT_A);
    expect(listed.threads).toHaveLength(1);
    expect(listed.viewer).toMatchObject({ can_write: false, can_resolve: false, frozen: true });
    expect(listed.threads[0].comments[0]).toMatchObject({ can_edit: false, can_delete: false });

    const locked = { error: 'forbidden', code: 'CLASSROOM_LOCKED' };
    for (const userId of [STUDENT_A, ASSISTANT, TEACHER]) {
      expect(await refusalOf(() => create(userId, {}))).toMatchObject(locked);
      expect(await refusalOf(() => create(userId, { thread_id: threadId }))).toMatchObject(locked);
      expect(await refusalOf(() => react(userId, commentId, '👍', true))).toMatchObject(locked);
      expect(await refusalOf(() => remove(userId, commentId))).toMatchObject(locked);
    }
    expect(await refusalOf(() => update(STUDENT_A, commentId, 'x'))).toMatchObject(locked);
    expect(await refusalOf(() => resolve(TEACHER, threadId, true))).toMatchObject(locked);
    const message = (await refusalOf(() => create(STUDENT_A, {}))).message;
    expect(message).toMatch(/read-only/);
    expect(comments).toHaveLength(1);
    expect(mocks.auditCreate).not.toHaveBeenCalled();

    expect((await create(OWNER, { thread_id: threadId, body: 'Owner note' })).changed).toBe(true);
  });

  it('refuses everyone but the owner in an UNPUBLISHED classroom', async () => {
    classroomStatus[CLASS_X] = 'UNPUBLISHED';
    expect(await refusalOf(() => list(STUDENT_A))).toMatchObject(NOT_FOUND);
    expect(await refusalOf(() => list(TEACHER))).toMatchObject(NOT_FOUND);
    expect((await list(OWNER)).threads).toEqual([]);
  });
});

// ─── Writes and their audit rows ────────────────────────────────────────────

describe('writes and audit rows', () => {
  it('audits a new thread with ids and lengths only, never the text, never coalesced', async () => {
    const body = 'This sentence has a typo: teh.';
    const created = await create(STUDENT_A, { block_id: 'intro', quote: 'loop runs', body });
    expect(created.thread).toMatchObject({
      block_id: 'intro',
      quote: 'loop runs',
      quote_occurrence: 0,
      anchor: 'ok',
      block_excerpt: 'Read this first. The loop runs twice.',
      resolved: false,
    });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    const [row, options] = mocks.auditCreate.mock.calls[0];
    expect(options).toEqual({ dedupe: false });
    expect(row).toMatchObject({
      user_id: STUDENT_A,
      classroom_id: CLASS_X,
      role: 'STUDENT',
      resource_type: 'PAGES',
      resource_id: PAGE,
      action: 'CREATE',
      data: {
        tool: 'page_comment',
        via: 'mcp',
        page_id: PAGE,
        new_thread: true,
        block_id: 'intro',
        thread_id: created.thread.thread_id,
        comment_id: created.comment_id,
        quote_length: 'loop runs'.length,
        body_length: body.length,
      },
    });
    const logged = JSON.stringify(mocks.auditCreate.mock.calls);
    expect(logged).not.toContain('typo');
    expect(logged).not.toContain('loop runs');
  });

  it('writes no row for a no-op: the same body, a repeated reaction', async () => {
    const { commentId } = seedThread({ author: STUDENT_A, body: 'Same' });
    expect((await update(STUDENT_A, commentId, '  Same  ')).changed).toBe(false);
    expect(comments[0].edited_at).toBeNull();
    await react(STUDENT_A, commentId, '👍', true);
    expect((await react(STUDENT_A, commentId, '👍', true)).changed).toBe(false);
    await react(STUDENT_A, commentId, '👍', false);
    expect(auditRows().map(row => [row.action, (row.data as Row).tool])).toEqual([
      ['CREATE', 'page_comment_reaction'],
      ['DELETE', 'page_comment_reaction'],
    ]);
  });

  it('audits an edit with its length, not its text', async () => {
    const { commentId } = seedThread({ author: STUDENT_A, body: 'Old' });
    await update(STUDENT_A, commentId, 'Brand new words');
    const row = auditRows()[0];
    expect(row).toMatchObject({
      action: 'UPDATE',
      data: { tool: 'page_comment', body_length: 15 },
    });
    expect(JSON.stringify(row)).not.toContain('Brand new');
  });

  it('refuses a reply to a resolved thread until it is reopened', async () => {
    const { threadId } = seedThread({ resolved: true });
    expect(await refusalOf(() => create(STUDENT_A, { thread_id: threadId }))).toMatchObject({
      error: 'invalid_params',
      code: 'THREAD_RESOLVED',
    });
    await resolve(TEACHER, threadId, false);
    expect((await create(STUDENT_A, { thread_id: threadId })).changed).toBe(true);
  });

  it('refuses a reply that also names an anchor, and bad bodies and emoji', async () => {
    const { threadId, commentId } = seedThread();
    expect(
      await refusalOf(() => create(STUDENT_A, { thread_id: threadId, block_id: 'intro' }))
    ).toMatchObject({ error: 'invalid_params' });
    expect(await refusalOf(() => create(STUDENT_A, { body: '   ' }))).toMatchObject({
      error: 'invalid_params',
      code: 'INVALID_BODY',
    });
    expect(await refusalOf(() => react(STUDENT_A, commentId, 'ok', true))).toMatchObject({
      error: 'invalid_params',
      code: 'INVALID_EMOJI',
    });
    expect(await refusalOf(() => create(STUDENT_A, { quote: 'not on this page' }))).toMatchObject({
      error: 'invalid_params',
      code: 'INVALID_QUOTE',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('locates a quote given without a block on the page, by occurrence', async () => {
    // "loop runs" is in `intro` once and in `long` once: the second match is in `long`.
    const second = await create(STUDENT_A, { quote: 'loop runs', quote_occurrence: 1 });
    expect(second.thread).toMatchObject({ block_id: 'long', quote_occurrence: 0 });
    const first = await create(STUDENT_A, { quote: 'loop  runs' });
    expect(first.thread).toMatchObject({ block_id: 'intro', quote: 'loop runs' });
  });

  it('fails closed when no content.json can be read: page-level threads only', async () => {
    // No content.json and a failed read look the same (fetchContentText never
    // throws), and a block thread could sit in a locked body: a reader who
    // does not reveal all sees page-level threads only.
    const onBlock = seedThread({ block_id: 'intro' });
    const inLocked = seedThread({
      block_id: 'b1',
      locked_section_id: 'lock1',
      quote: 'SECRET-ONE',
    });
    const pageLevel = seedThread();
    mocks.fetchContentText.mockResolvedValue(null);
    const listed = await list(STUDENT_A);
    expect(listed.threads.map((t: Row) => t.thread_id)).toEqual([pageLevel.threadId]);
    expect(JSON.stringify(listed)).not.toContain('SECRET-ONE');
    expect(listed.open).toBe(1);
    // The teaching team sees every body anyway: all three, unplaced.
    const staff = await list(ASSISTANT);
    expect(staff.threads.map((t: Row) => t.thread_id).sort()).toEqual(
      [onBlock.threadId, inLocked.threadId, pageLevel.threadId].sort()
    );
    expect((await create(STUDENT_A, {})).thread.anchor).toBe('page');
    expect(await refusalOf(() => create(STUDENT_A, { block_id: 'intro' }))).toMatchObject({
      error: 'invalid_params',
      code: 'INVALID_BLOCK',
    });
    expect(await refusalOf(() => create(STUDENT_A, { quote: 'loop runs' }))).toMatchObject({
      error: 'invalid_params',
      code: 'INVALID_QUOTE',
    });
  });

  it('does not turn a failed audit write into a tool error', async () => {
    mocks.auditCreate.mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await create(STUDENT_A, {})).changed).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ─── Listing ────────────────────────────────────────────────────────────────

describe('page_comments_list', () => {
  it('filters by status, open by default, in document order', async () => {
    const pageLevel = seedThread();
    const onLong = seedThread({ block_id: 'long' });
    const onIntro = seedThread({ block_id: 'intro' });
    const done = seedThread({ block_id: 'intro', resolved: true });

    const open = await list(STUDENT_A);
    expect(open).toMatchObject({ status: 'open', open: 3, resolved: 1 });
    expect(open.threads.map((t: Row) => t.thread_id)).toEqual([
      onIntro.threadId,
      onLong.threadId,
      pageLevel.threadId,
    ]);
    expect(
      (await list(STUDENT_A, { status: 'resolved' })).threads.map((t: Row) => t.thread_id)
    ).toEqual([done.threadId]);
    expect((await list(STUDENT_A, { status: 'all' })).threads).toHaveLength(4);
  });

  it('reports a lost anchor: text changed, block removed, page-level', async () => {
    seedThread({ block_id: 'intro', quote: 'no longer here' });
    seedThread({ block_id: 'vanished' });
    seedThread();
    const anchors = (await list(STUDENT_A)).threads.map((t: Row) => [t.anchor, t.block_excerpt]);
    expect(anchors).toEqual([
      ['text_changed', 'Read this first. The loop runs twice.'],
      ['page', null],
      ['block_removed', null],
    ]);
  });

  it('tells a read-only connection (Ask Moji) it has no write tools', async () => {
    seedThread();
    const listed = await call(
      pageCommentsListTool,
      { classroom: 'org/x', page_id: PAGE },
      ctxFor(STUDENT_A, { scopes: ['read'] })
    );
    expect(listed.viewer.write_tools).toBe(false);
  });
});

// ─── Review fixes ───────────────────────────────────────────────────────────

const LIVE_BLOCKS = [
  ...DOC_BLOCKS,
  { id: 'livenew', type: 'paragraph', props: {}, content: text('Typed just now.'), children: [] },
];
const liveSnapshot = () => ({ snapshot: { content: { blocks: LIVE_BLOCKS } } });

describe('which document comments anchor on', () => {
  beforeEach(() => {
    collabEnabled[CLASS_X] = true;
    mocks.readLivePage.mockResolvedValue(liveSnapshot());
  });

  it.each([TEACHER, OWNER])(
    'gives %s (a page editor in a live classroom) the live document, pinning nothing',
    async userId => {
      const created = await create(userId, { block_id: 'livenew', quote: 'just now' });
      expect(created.thread).toMatchObject({
        block_id: 'livenew',
        block_excerpt: 'Typed just now.',
      });
      expect(mocks.readLivePage).toHaveBeenCalled();
      for (const call of mocks.readLivePage.mock.calls) {
        expect((call[1] as { id: string }).id).toBe(PAGE);
        expect(call[2]).toBeNull();
      }
    }
  );

  it.each([STUDENT_A, ASSISTANT])('gives %s git’s copy, never the live one', async userId => {
    expect(await refusalOf(() => create(userId, { block_id: 'livenew' }))).toMatchObject({
      error: 'invalid_params',
      code: 'INVALID_BLOCK',
    });
    expect(mocks.readLivePage).not.toHaveBeenCalled();
  });

  it('falls back to git when the live read fails or says to', async () => {
    mocks.readLivePage.mockRejectedValue(new Error('collab down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await refusalOf(() => create(TEACHER, { block_id: 'livenew' }))).toMatchObject({
      code: 'INVALID_BLOCK',
    });
    expect((await create(TEACHER, { block_id: 'intro' })).changed).toBe(true);
    mocks.readLivePage.mockResolvedValue({ fallbackNote: 'down' });
    expect((await list(TEACHER)).threads).toHaveLength(1);
    warn.mockRestore();
  });

  it('reads git for a teacher in a LOCKED classroom (no live editing for them)', async () => {
    classroomStatus[CLASS_X] = 'LOCKED';
    seedThread({ block_id: 'livenew' });
    const listed = await list(TEACHER);
    expect(listed.threads[0].anchor).toBe('block_removed');
    expect(mocks.readLivePage).not.toHaveBeenCalled();
  });

  it('leaves a classroom without live editing on git', async () => {
    collabEnabled[CLASS_X] = false;
    await list(TEACHER);
    expect(mocks.readLivePage).not.toHaveBeenCalled();
  });
});

describe('locateQuote is linear', () => {
  const big = [
    { id: 'big', type: 'paragraph', props: {}, content: text('e'.repeat(40_000)), children: [] },
    { id: 'tail', type: 'paragraph', props: {}, content: text('the end'), children: [] },
  ];

  it('skips whole blocks by their match count', () => {
    const started = performance.now();
    expect(locateQuote(big, 'e', 1000)).toEqual({ blockId: 'big', quoteOccurrence: 1000 });
    expect(locateQuote(big, 'e', 40_000)).toEqual({ blockId: 'tail', quoteOccurrence: 0 });
    expect(locateQuote(big, 'e', 40_002)).toBeNull();
    expect(locateQuote(big, 'e', 10_000_000)).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('caps quote_occurrence at 1000 in the schema', () => {
    const schema = pageCommentCreateTool.inputSchema.quote_occurrence;
    expect(schema.safeParse(1000).success).toBe(true);
    expect(schema.safeParse(1001).success).toBe(false);
  });
});

describe('content_get comment fields', () => {
  const get = (userId: string) =>
    call(contentGetTool, { classroom: 'org/x', kind: 'page' as const, id: PAGE }, ctxFor(userId));
  const PLAIN_DOC = JSON.stringify({
    blocks: [{ id: 'p', type: 'paragraph', props: {}, content: text('Plain.'), children: [] }],
  });

  it('gives 0 without a hint, and reads no unlocks or second reader rule on a plain page', async () => {
    mocks.fetchContentText.mockResolvedValue({ text: PLAIN_DOC, sha: 's', source: 'worker' });
    const payload = await get(STUDENT_A);
    expect(payload.open_comments).toBe(0);
    expect(payload).not.toHaveProperty('comments_hint');
    expect(prismaCallsFor('pageSectionUnlock')).toHaveLength(0);
    const ruleReads = prismaCallsFor('classroomMembership', 'findMany').filter(
      c => (c.args as { where: Row }).where.user_id === STUDENT_A
    );
    expect(ruleReads).toHaveLength(1);
  });

  it('still counts on a page with no content.json (page-level only for a student)', async () => {
    seedThread();
    seedThread({ block_id: 'intro' });
    mocks.fetchContentText.mockResolvedValue(null);
    rawRows = [
      {
        docKind: 'page',
        docId: PAGE,
        title: 'Lab',
        sourcePath: `pages/${PAGE}/index.html`,
        text: 'Lab',
        chunkCount: 1,
        isDraft: false,
      },
    ];
    // A student counts the page-level thread only (fail closed); staff both.
    const payload = await get(STUDENT_A);
    expect(payload.open_comments).toBe(1);
    expect(payload.comments_hint).toMatch(/page_comments_list/);
    expect((await get(ASSISTANT)).open_comments).toBe(2);
  });

  it('leaves the fields out, and still answers, when the count fails', async () => {
    seedThread();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setPrismaRows({
      pageCommentThread: {
        findMany: () => {
          throw new Error('db down');
        },
      },
    });
    const payload = await get(STUDENT_A);
    expect(payload.text).toBeTypeOf('string');
    expect(payload).not.toHaveProperty('open_comments');
    expect(payload).not.toHaveProperty('comments_hint');
    warn.mockRestore();
  });
});

describe('rate limits match the page', () => {
  it('posting 20 and reacting 60 per 10 minutes', () => {
    expect(pageCommentCreateTool.rateLimit).toEqual({ capacity: 20, refillPerSecond: 20 / 600 });
    expect(pageCommentReactTool.rateLimit).toEqual({ capacity: 60, refillPerSecond: 0.1 });
  });
});

describe('an impersonated session', () => {
  it('lists with every write flag off and has its writes refused', async () => {
    const { threadId, commentId } = seedThread({ author: TEACHER });
    const ctx = ctxFor(TEACHER, { impersonatedBy: 'admin-1' });
    const listed = await call(pageCommentsListTool, { classroom: 'org/x', page_id: PAGE }, ctx);
    expect(listed.viewer).toMatchObject({
      can_write: false,
      can_resolve: false,
      can_moderate: false,
    });
    expect(listed.threads[0].comments[0]).toMatchObject({ can_edit: false, can_delete: false });

    const refused = { error: 'forbidden', code: 'IMPERSONATED' };
    expect(
      await refusalOf(() =>
        call(pageCommentCreateTool, { classroom: 'org/x', page_id: PAGE, body: 'x' }, ctx)
      )
    ).toMatchObject(refused);
    expect(
      await refusalOf(() =>
        call(
          pageCommentResolveTool,
          { classroom: 'org/x', page_id: PAGE, thread_id: threadId, resolved: true },
          ctx
        )
      )
    ).toMatchObject(refused);
    expect(
      await refusalOf(() =>
        call(
          pageCommentDeleteTool,
          { classroom: 'org/x', page_id: PAGE, comment_id: commentId },
          ctx
        )
      )
    ).toMatchObject(refused);
    expect(comments).toHaveLength(1);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe('descriptions', () => {
  it('send only page editors to page_content_get; others anchor by quote', () => {
    const description = pageCommentCreateTool.description;
    expect(description).toMatch(
      /Page editors \(owners, teachers\) may also pass block_id, from page_content_get/
    );
    expect(description).toMatch(/pass `quote`/);
    for (const tool of pageCommentTools) {
      const mentions = tool.description.match(/page_content_get/g) ?? [];
      expect(mentions.length, tool.name).toBeLessThanOrEqual(1);
    }
  });
});

describe('blockExcerpt', () => {
  it('centres a long block on the quote, with ellipses', () => {
    const excerpt = blockExcerpt(DOC_BLOCKS, 'long', 'loop runs', 0)!;
    expect(excerpt.length).toBeLessThanOrEqual(242);
    expect(excerpt).toContain('The loop runs twice');
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('reads only the tree it is given', () => {
    expect(blockExcerpt(DOC_BLOCKS, 'b1', null, 0)).toBe('SECRET-ONE');
    const redacted = [{ ...DOC_BLOCKS[2], children: [] }];
    expect(blockExcerpt(redacted, 'b1', null, 0)).toBeNull();
    expect(blockExcerpt(DOC_BLOCKS, null, null, 0)).toBeNull();
  });
});
