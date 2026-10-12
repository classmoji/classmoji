/**
 * Page sections over MCP: `page_sections_status`, `page_section_unlock`, and
 * the per-viewer page text `content_get` serves for a page with locked
 * sections.
 *
 * WHAT IS REAL HERE
 * -----------------
 * The REAL `pageSections.service` (accepted-only roles, reader state, unlock
 * recording, the current-student filter) and the REAL `contentSearch.service`
 * run against the schema-validating Prisma stand-in, which answers from a small
 * in-memory table set filtered by each query's own `where`. So "student A never
 * sees student B's unlock" is a property of the queries the code actually
 * issues, not of a hand-written stub that agrees with it. Only the content-repo
 * read (`fetchContentText`) and the audit writer are mocked.
 *
 * Role gating by the registry is exercised through the pure gate it calls
 * (`requireRole`) with each tool's declared roles; the in-handler gates (staff
 * who are also students, pending invitees) run through the handlers.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@prisma/client';
import { ToolError } from '../../mcp/errors.ts';
import { toolAnnotations, type ToolContext, type ToolDefinition } from '../../mcp/registry.ts';
import { requireRole } from '../../authz/pure.ts';

const mocks = vi.hoisted(() => ({
  fetchContentText: vi.fn(),
  auditCreate: vi.fn(),
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
  return {
    ...search,
    ClassmojiService: {
      contentDelivery: {
        fetchContentText: (...args: unknown[]) => mocks.fetchContentText(...args),
      },
      contentIndex: { slideMetadataText: () => '' },
      pageSections: sections,
      audit: { create: (...args: unknown[]) => mocks.auditCreate(...args) },
    },
  };
});

const { pageSectionCheckTool, pageSectionsStatusTool, pageSectionUnlockTool, viewerPageBlocks } =
  await import('../pageSections.ts');
const { contentGetTool } = await import('../contentSearch.ts');
const { resetPrismaStub, setPrismaRaw, setPrismaRows, prismaCallsFor } =
  await import('../../__tests__/prismaSchemaStub.ts');
const { extractText } =
  await import('../../../../../packages/services/src/content/extract/index.ts');

// ─── Fixtures: two classrooms, their people, three pages ────────────────────

const CLASS_A = 'classroom-a';
const CLASS_B = 'classroom-b';
const PAGE = '11111111-1111-4111-8111-111111111111'; // published, classroom A
const DRAFT = '22222222-2222-4222-8222-222222222222'; // draft, classroom A
const FOREIGN = '33333333-3333-4333-8333-333333333333'; // published, classroom B
const PLAIN = '44444444-4444-4444-8444-444444444444'; // no locked sections, classroom A
const CHECKLIST = '55555555-5555-4555-8555-555555555555'; // a checkable heading only, classroom A

const STUDENT_A = 'user-student-a';
const STUDENT_B = 'user-student-b';
const STUDENT_OTHER_CLASS = 'user-student-c'; // student of classroom B only
const TEACHER = 'user-teacher';
const ASSISTANT = 'user-assistant';
const PENDING = 'user-pending'; // invited STUDENT, not accepted
const STAFF_STUDENT = 'user-staff-student'; // TEACHER and STUDENT in A
const REMOVED = 'user-removed'; // no membership any more

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];

/** The page document: a checkable heading, two locked sections, one nested. */
const DOC_BLOCKS = [
  { id: 'intro', type: 'paragraph', props: {}, content: text('Read this first.'), children: [] },
  {
    id: 'h1',
    type: 'heading',
    props: { level: 2, checkable: true },
    content: text('Part one'),
    children: [],
  },
  {
    id: 'lock1',
    type: 'lockedSection',
    props: {},
    content: text('Hint one'),
    children: [
      { id: 'b1', type: 'paragraph', props: {}, content: text('SECRET-ONE'), children: [] },
      {
        id: 'lock2',
        type: 'lockedSection',
        props: {},
        content: text('Deeper hint'),
        children: [
          { id: 'b2', type: 'paragraph', props: {}, content: text('SECRET-TWO'), children: [] },
        ],
      },
    ],
  },
  {
    id: 'lock3',
    type: 'lockedSection',
    props: {},
    content: text('Answer'),
    children: [
      { id: 'b3', type: 'paragraph', props: {}, content: text('SECRET-THREE'), children: [] },
      // A checkable heading inside a locked body: only there for whoever opened it.
      {
        id: 'h2',
        type: 'heading',
        props: { level: 3, checkable: true },
        content: text('Answer step'),
        children: [],
      },
    ],
  },
];
const DOC = JSON.stringify({ blocks: DOC_BLOCKS });
const PLAIN_DOC = JSON.stringify({
  blocks: [{ id: 'p', type: 'paragraph', props: {}, content: text('Just text.'), children: [] }],
});
const CHECKLIST_DOC = JSON.stringify({
  blocks: [
    {
      id: 'step1',
      type: 'heading',
      props: { level: 2, checkable: true },
      content: text('Step one'),
      children: [],
    },
  ],
});
const SECRETS = ['SECRET-ONE', 'SECRET-TWO', 'SECRET-THREE'];

const classroomOf = (id: string) => ({
  id,
  content_key_version: 1,
  content_repo: `content-${id}`,
  git_organization: { login: 'org', provider: 'GITHUB' },
});

const PAGES = [
  {
    id: PAGE,
    classroom_id: CLASS_A,
    title: 'Lab 3',
    slug: 'lab-3',
    content_path: 'pages/lab-3',
    is_draft: false,
    is_public: false,
  },
  {
    id: DRAFT,
    classroom_id: CLASS_A,
    title: 'Draft lab',
    slug: 'draft',
    content_path: 'pages/draft',
    is_draft: true,
    is_public: false,
  },
  {
    id: FOREIGN,
    classroom_id: CLASS_B,
    title: 'Other lab',
    slug: 'other',
    content_path: 'pages/other',
    is_draft: false,
    is_public: false,
  },
  {
    id: PLAIN,
    classroom_id: CLASS_A,
    title: 'Plain',
    slug: 'plain',
    content_path: 'pages/plain',
    is_draft: false,
    is_public: false,
  },
  {
    id: CHECKLIST,
    classroom_id: CLASS_A,
    title: 'Checklist',
    slug: 'checklist',
    content_path: 'pages/checklist',
    is_draft: false,
    is_public: false,
  },
].map(page => ({ ...page, classroom: classroomOf(page.classroom_id) }));

const CONTENT_BY_PATH: Record<string, string> = {
  'pages/lab-3/content.json': DOC,
  'pages/draft/content.json': DOC,
  'pages/other/content.json': DOC,
  'pages/plain/content.json': PLAIN_DOC,
  'pages/checklist/content.json': CHECKLIST_DOC,
};

type Row = Record<string, unknown>;

const membership = (user_id: string, classroom_id: string, role: Role, accepted = true): Row => ({
  user_id,
  classroom_id,
  role,
  has_accepted_invite: accepted,
});

const MEMBERSHIPS: Row[] = [
  membership(STUDENT_A, CLASS_A, 'STUDENT'),
  membership(STUDENT_B, CLASS_A, 'STUDENT'),
  membership(TEACHER, CLASS_A, 'TEACHER'),
  membership(ASSISTANT, CLASS_A, 'ASSISTANT'),
  membership(PENDING, CLASS_A, 'STUDENT', false),
  membership(STAFF_STUDENT, CLASS_A, 'TEACHER'),
  membership(STAFF_STUDENT, CLASS_A, 'STUDENT'),
  membership(STUDENT_OTHER_CLASS, CLASS_B, 'STUDENT'),
  // A student of classroom A is also a student of B: B's rows must stay in B.
  membership(STUDENT_A, CLASS_B, 'STUDENT'),
];

const userRow = (id: string) => ({
  id,
  name: `Name ${id}`,
  image: null,
  accounts: [
    {
      provider_id: 'github',
      account_id: `gh-${id}`,
      username: `login-${id}`,
      image: null,
      email: null,
    },
  ],
});

let unlocks: Row[] = [];
let checks: Row[] = [];

/** Equality, `{ in: [...] }` and the compound unique key — what the services use. */
function matches(row: Row, where: Row | undefined): boolean {
  for (const [key, value] of Object.entries(where ?? {})) {
    if (key === 'page_id_user_id_block_id') {
      if (!matches(row, value as Row)) return false;
      continue;
    }
    if (value && typeof value === 'object' && 'in' in (value as Row)) {
      if (!((value as { in: unknown[] }).in ?? []).includes(row[key])) return false;
      continue;
    }
    if (row[key] !== value) return false;
  }
  return true;
}

const withUser = (row: Row) => ({ ...row, user: userRow(String(row.user_id)) });
const newestFirst = (field: string) => (a: Row, b: Row) =>
  (b[field] as Date).getTime() - (a[field] as Date).getTime();

function installDatabase(): void {
  setPrismaRows({
    page: {
      findFirst: (args: { where?: Row }) => PAGES.find(page => matches(page, args.where)) ?? null,
    },
    classroom: {
      findUnique: () => ({ git_organization: { provider: 'GITHUB' } }),
    },
    classroomMembership: {
      findMany: (args: { where?: Row }) => MEMBERSHIPS.filter(row => matches(row, args.where)),
    },
    pageSectionUnlock: {
      findMany: (args: { where?: Row }) =>
        unlocks
          .filter(row => matches(row, args.where))
          .sort(newestFirst('unlocked_at'))
          .map(withUser),
      findUnique: (args: { where?: Row }) => unlocks.find(row => matches(row, args.where)) ?? null,
      create: (args: { data: Row }) => {
        const row = { id: `u-${unlocks.length}`, ...args.data, unlocked_at: new Date() };
        unlocks.push(row);
        return row;
      },
    },
    pageSectionCheck: {
      findMany: (args: { where?: Row }) =>
        checks
          .filter(row => matches(row, args.where))
          .sort(newestFirst('checked_at'))
          .map(withUser),
      createMany: (args: { data: Row[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const data of args.data) {
          const key = (row: Row) => `${row.page_id}|${row.user_id}|${row.block_id}`;
          // The unique key is (page, user, block): without skipDuplicates a
          // repeat would throw, with it the repeat is skipped and not counted.
          if (checks.some(row => key(row) === key(data))) {
            if (!args.skipDuplicates) throw new Error('Unique constraint failed');
            continue;
          }
          checks.push({ id: `c-${checks.length}`, ...data, checked_at: new Date() });
          count += 1;
        }
        return { count };
      },
      deleteMany: (args: { where: Row }) => {
        const before = checks.length;
        checks = checks.filter(row => !matches(row, args.where));
        return { count: before - checks.length };
      },
    },
  });
}

const unlockRow = (user_id: string, block_id: string, classroom_id = CLASS_A, page_id = PAGE) => ({
  id: `seed-${user_id}-${block_id}-${page_id}`,
  page_id,
  user_id,
  classroom_id,
  block_id,
  unlocked_at: new Date('2026-10-10T15:00:00.000Z'),
});

const ctxFor = (
  userId: string,
  role: Role,
  {
    scopes = ['read', 'write'],
    classroomId = CLASS_A,
  }: { scopes?: string[]; classroomId?: string } = {}
): ToolContext =>
  ({
    viewer: { userId, clientId: 'c', scopes: new Set(scopes) },
    classroom: {
      classroomId,
      role,
      roles: [role],
      status: 'ACTIVE',
      membership: { id: `m-${userId}`, role },
      classroom: { settings: {} },
    },
  }) as unknown as ToolContext;

const payloadOf = (result: { content: Array<{ text: string }> }) =>
  JSON.parse(result.content[0].text) as Record<string, unknown>;

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

/** The index row content_get reads first: titles only, as the extractor stores it. */
const indexRow = (docId: string, title: string, sourcePath: string) => ({
  docKind: 'page' as const,
  docId,
  title,
  sourcePath,
  text: `${title}\nRead this first.\nPart one\nHint one\nAnswer`,
  chunkCount: 1,
  isDraft: null,
});

let rawRows: unknown[] = [];

beforeEach(() => {
  resetPrismaStub();
  unlocks = [];
  checks = [];
  rawRows = [];
  setPrismaRaw(() => rawRows);
  installDatabase();
  mocks.fetchContentText.mockReset().mockImplementation(async (_ctx: unknown, repoPath: string) => {
    const body = CONTENT_BY_PATH[repoPath];
    return body ? { text: body, sha: 'sha', source: 'worker' } : null;
  });
  mocks.auditCreate.mockReset().mockResolvedValue(undefined);
});

const getPage = (ctx: ToolContext, id = PAGE) =>
  call(contentGetTool, { classroom: 'org/a', kind: 'page' as const, id }, ctx);

const unlock = (ctx: ToolContext, block_id: string, page_id = PAGE) =>
  call(pageSectionUnlockTool, { classroom: 'org/a', page_id, block_id }, ctx);

// ─── Definitions ────────────────────────────────────────────────────────────

describe('tool definitions', () => {
  it('page_sections_status is a read tool for OWNER and TEACHER only', () => {
    expect(pageSectionsStatusTool.scope).toBe('read');
    expect([...(pageSectionsStatusTool.roles ?? [])].sort()).toEqual(['OWNER', 'TEACHER']);
    expect(pageSectionsStatusTool.annotations).toBeUndefined();
    expect(toolAnnotations(pageSectionsStatusTool as unknown as ToolDefinition<never>)).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
    });
  });

  it('page_section_unlock is a student write annotated for confirmation', () => {
    expect(pageSectionUnlockTool.scope).toBe('write');
    expect(pageSectionUnlockTool.roles).toEqual(['STUDENT']);
    expect(toolAnnotations(pageSectionUnlockTool as unknown as ToolDefinition<never>)).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(pageSectionUnlockTool.description).toMatch(/confirm with the student/i);
    expect(pageSectionUnlockTool.description).toMatch(/staff can see/i);
  });

  it('page_section_check is a reversible member write, not destructive', () => {
    expect(pageSectionCheckTool.scope).toBe('write');
    expect([...(pageSectionCheckTool.roles ?? [])].sort()).toEqual([
      'ASSISTANT',
      'OWNER',
      'STUDENT',
      'TEACHER',
    ]);
    expect(toolAnnotations(pageSectionCheckTool as unknown as ToolDefinition<never>)).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('keeps every description under the 1,500 bytes a client will keep', () => {
    for (const tool of [
      pageSectionsStatusTool,
      pageSectionUnlockTool,
      pageSectionCheckTool,
      contentGetTool,
    ]) {
      expect(Buffer.byteLength(tool.description, 'utf8'), tool.name).toBeLessThan(1500);
    }
  });

  it('are registered in the tool manifest', () => {
    const manifest = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../index.ts'),
      'utf8'
    );
    expect(manifest).toContain('registerToolDefinition(pageSectionsStatusTool)');
    expect(manifest).toContain('registerToolDefinition(pageSectionUnlockTool)');
    expect(manifest).toContain('registerToolDefinition(pageSectionCheckTool)');
  });
});

describe('role gating (the registry gate each tool declares)', () => {
  const gate = (tool: { roles: readonly Role[] | null }, role: Role) => () =>
    requireRole([{ role }], tool.roles);

  it('lets OWNER and TEACHER read status, and refuses ASSISTANT and STUDENT', () => {
    expect(gate(pageSectionsStatusTool, 'OWNER')).not.toThrow();
    expect(gate(pageSectionsStatusTool, 'TEACHER')).not.toThrow();
    expect(gate(pageSectionsStatusTool, 'ASSISTANT')).toThrow(ToolError);
    expect(gate(pageSectionsStatusTool, 'STUDENT')).toThrow(ToolError);
  });

  it('lets every member role reach page_section_check (the handler then requires acceptance)', () => {
    for (const role of ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'] as Role[]) {
      expect(gate(pageSectionCheckTool, role), role).not.toThrow();
    }
    expect(() => requireRole([], pageSectionCheckTool.roles)).toThrow(ToolError);
  });

  it('lets only STUDENT unlock', () => {
    expect(gate(pageSectionUnlockTool, 'STUDENT')).not.toThrow();
    for (const role of ['OWNER', 'TEACHER', 'ASSISTANT'] as Role[]) {
      expect(gate(pageSectionUnlockTool, role), role).toThrow(ToolError);
    }
  });
});

// ─── content_get: per-viewer text ───────────────────────────────────────────

describe('content_get on a page with locked sections', () => {
  it('the extractor never puts a locked body into the shared (index) text', () => {
    const extracted = extractText({ kind: 'blocknote', json: DOC }, { title: 'Lab 3' });
    expect(extracted.ok).toBe(true);
    for (const secret of SECRETS) expect(extracted.text).not.toContain(secret);
    expect(extracted.text).toContain('Hint one');
  });

  it('shows a student with no unlocks only markers, with ids and the unlock tool', async () => {
    rawRows = [indexRow(PAGE, 'Lab 3', 'pages/lab-3/content.json')];
    const payload = await getPage(ctxFor(STUDENT_A, 'STUDENT'));

    for (const secret of SECRETS) expect(payload.text).not.toContain(secret);
    expect(payload.text).toContain(
      '[Locked section "Hint one" (id lock1) — use page_section_unlock to open it]'
    );
    expect(payload.text).toContain(
      '[Locked section "Answer" (id lock3) — use page_section_unlock to open it]'
    );
    // A section nested in a closed one is not there at all, not even its id.
    expect(JSON.stringify(payload)).not.toContain('lock2');
    expect(payload.locked_sections).toEqual([
      { id: 'lock1', title: 'Hint one', open: false },
      { id: 'lock3', title: 'Answer', open: false },
    ]);
    expect(payload.indexed).toBe(true);
  });

  it("never shows student A the body student B unlocked, before or after B's read", async () => {
    unlocks = [unlockRow(STUDENT_B, 'lock1')];
    rawRows = [indexRow(PAGE, 'Lab 3', 'pages/lab-3/content.json')];

    const before = await getPage(ctxFor(STUDENT_A, 'STUDENT'));
    const forB = await getPage(ctxFor(STUDENT_B, 'STUDENT'));
    const after = await getPage(ctxFor(STUDENT_A, 'STUDENT'));

    expect(forB.text).toContain('SECRET-ONE');
    expect(forB.text).not.toContain('SECRET-TWO');
    expect(forB.text).not.toContain('SECRET-THREE');
    expect(forB.text).toContain('(id lock2) — use page_section_unlock');
    for (const payload of [before, after]) {
      for (const secret of SECRETS) expect(payload.text).not.toContain(secret);
    }
    // Reader state is read per page AND user: A's query never names B.
    const reads = prismaCallsFor('pageSectionUnlock', 'findMany').map(
      c => (c.args as { where: Row }).where
    );
    expect(reads).toContainEqual({ page_id: PAGE, user_id: STUDENT_A });
    expect(reads.every(where => typeof where.user_id === 'string')).toBe(true);
  });

  it('ignores an unlock row the same student holds in another classroom', async () => {
    unlocks = [unlockRow(STUDENT_A, 'lock1', CLASS_B, FOREIGN)];
    rawRows = [indexRow(PAGE, 'Lab 3', 'pages/lab-3/content.json')];
    const payload = await getPage(ctxFor(STUDENT_A, 'STUDENT'));
    for (const secret of SECRETS) expect(payload.text).not.toContain(secret);
  });

  it.each([
    ['teacher', TEACHER, 'TEACHER'],
    ['assistant', ASSISTANT, 'ASSISTANT'],
    ['teacher who is also a student', STAFF_STUDENT, 'STUDENT'],
  ] as const)('shows a %s every locked body', async (_label, userId, role) => {
    rawRows = [indexRow(PAGE, 'Lab 3', 'pages/lab-3/content.json')];
    const payload = await getPage(ctxFor(userId, role));
    for (const secret of SECRETS) expect(payload.text).toContain(secret);
    expect(payload.text).toContain('[End of locked section "Hint one"]');
    expect((payload.locked_sections as Array<{ open: boolean }>).every(s => s.open)).toBe(true);
  });

  it('shows a pending (not accepted) student titles only, with no id and no unlock hint', async () => {
    rawRows = [indexRow(PAGE, 'Lab 3', 'pages/lab-3/content.json')];
    const payload = await getPage(ctxFor(PENDING, 'STUDENT'));
    for (const secret of SECRETS) expect(payload.text).not.toContain(secret);
    expect(payload.text).toContain('[Locked section "Hint one"]');
    expect(payload.text).not.toContain('lock1');
    expect(payload.text).not.toContain('page_section_unlock');
  });

  it('points a read-only token (Ask Moji) at the page rather than at a tool it lacks', async () => {
    rawRows = [indexRow(PAGE, 'Lab 3', 'pages/lab-3/content.json')];
    const payload = await getPage(ctxFor(STUDENT_A, 'STUDENT', { scopes: ['read'] }));
    expect(payload.text).toContain(
      '[Locked section "Hint one" — the student can unlock it on the page]'
    );
    expect(payload.text).not.toContain('page_section_unlock');
  });

  it('builds the same per-viewer text on the live fallback (page not indexed yet)', async () => {
    rawRows = [];
    const student = await getPage(ctxFor(STUDENT_A, 'STUDENT'));
    expect(student.indexed).toBe(false);
    for (const secret of SECRETS) expect(student.text).not.toContain(secret);
    expect(student.text).toContain('(id lock1) — use page_section_unlock');

    const teacher = await getPage(ctxFor(TEACHER, 'TEACHER'));
    for (const secret of SECRETS) expect(teacher.text).toContain(secret);
  });

  it('keeps the index text when the content cannot be read (it never holds a body)', async () => {
    rawRows = [indexRow(PAGE, 'Lab 3', 'pages/lab-3/content.json')];
    mocks.fetchContentText.mockResolvedValue(null);
    const payload = await getPage(ctxFor(TEACHER, 'TEACHER'));
    expect(payload.text).toBe('Lab 3\nRead this first.\nPart one\nHint one\nAnswer');
    expect(payload).not.toHaveProperty('locked_sections');
  });

  it('serves a page without locked sections its index text unchanged', async () => {
    rawRows = [
      { ...indexRow(PLAIN, 'Plain', 'pages/plain/content.json'), text: 'Plain\nJust text.' },
    ];
    const payload = await getPage(ctxFor(STUDENT_A, 'STUDENT'), PLAIN);
    expect(payload.text).toBe('Plain\nJust text.');
    expect(payload).not.toHaveProperty('locked_sections');
    // No reader state is read for a page with nothing locked.
    expect(prismaCallsFor('pageSectionUnlock')).toHaveLength(0);
  });

  it('reads the page content by a query scoped to the bound classroom', async () => {
    rawRows = [indexRow(PAGE, 'Lab 3', 'pages/lab-3/content.json')];
    await getPage(ctxFor(STUDENT_A, 'STUDENT'));
    const [lookup] = prismaCallsFor('page', 'findFirst');
    expect((lookup.args as { where: Row }).where).toEqual({ id: PAGE, classroom_id: CLASS_A });
  });
});

const checkRow = (user_id: string, block_id: string, page_id = PAGE): Row => ({
  id: `seed-check-${user_id}-${block_id}-${page_id}`,
  page_id,
  user_id,
  block_id,
  checked_at: new Date('2026-10-11T09:00:00.000Z'),
});

describe("content_get shows the caller's own checked state", () => {
  it('marks a heading done for the student who checked it, and only for them', async () => {
    checks = [checkRow(STUDENT_A, 'h1')];
    rawRows = [indexRow(PAGE, 'Lab 3', 'pages/lab-3/content.json')];

    const forA = await getPage(ctxFor(STUDENT_A, 'STUDENT'));
    const forB = await getPage(ctxFor(STUDENT_B, 'STUDENT'));

    expect(forA.text).toContain('Part one [done] (id h1)');
    expect(forA.checkable_headings).toEqual([{ id: 'h1', title: 'Part one', checked: true }]);
    expect(forB.text).toContain('Part one [not done] (id h1)');
    expect(forB.text).not.toContain('[done] (id h1)');
    expect(forB.checkable_headings).toEqual([{ id: 'h1', title: 'Part one', checked: false }]);
    // A heading inside a closed locked section is not there for a student.
    expect(JSON.stringify(forA)).not.toContain('h2');
    // Check rows are read per page AND user.
    const reads = prismaCallsFor('pageSectionCheck', 'findMany').map(
      c => (c.args as { where: Row }).where
    );
    expect(reads).toEqual([
      { page_id: PAGE, user_id: STUDENT_A },
      { page_id: PAGE, user_id: STUDENT_B },
    ]);
  });

  it("ignores the student's check on another classroom's page with the same block id", async () => {
    checks = [checkRow(STUDENT_A, 'h1', FOREIGN)];
    rawRows = [indexRow(PAGE, 'Lab 3', 'pages/lab-3/content.json')];
    const payload = await getPage(ctxFor(STUDENT_A, 'STUDENT'));
    expect(payload.text).toContain('Part one [not done] (id h1)');
  });

  it("shows staff their own state on every heading, the locked body's included", async () => {
    checks = [checkRow(STUDENT_A, 'h1'), checkRow(TEACHER, 'h2')];
    rawRows = [indexRow(PAGE, 'Lab 3', 'pages/lab-3/content.json')];
    const payload = await getPage(ctxFor(TEACHER, 'TEACHER'));
    expect(payload.text).toContain('Part one [not done] (id h1)');
    expect(payload.text).toContain('Answer step [done] (id h2)');
  });

  it('shows a pending invitee no state at all', async () => {
    checks = [checkRow(PENDING, 'h1')];
    rawRows = [indexRow(PAGE, 'Lab 3', 'pages/lab-3/content.json')];
    const payload = await getPage(ctxFor(PENDING, 'STUDENT'));
    expect(payload.text).not.toContain('done]');
    expect(payload).not.toHaveProperty('checkable_headings');
  });

  it('answers a page with checkable headings but no locked section per viewer too', async () => {
    checks = [checkRow(STUDENT_B, 'step1', CHECKLIST)];
    rawRows = [
      {
        ...indexRow(CHECKLIST, 'Checklist', 'pages/checklist/content.json'),
        text: 'Checklist\nStep one',
      },
    ];
    const forA = await getPage(ctxFor(STUDENT_A, 'STUDENT'), CHECKLIST);
    expect(forA.text).toBe('Checklist\nStep one [not done] (id step1)');
    expect(forA).not.toHaveProperty('locked_sections');

    const pending = await getPage(ctxFor(PENDING, 'STUDENT'), CHECKLIST);
    expect(pending.text).toBe('Checklist\nStep one');
  });
});

describe('viewerPageBlocks', () => {
  it('never mutates the stored blocks', () => {
    const before = JSON.stringify(DOC_BLOCKS);
    viewerPageBlocks(DOC_BLOCKS, {
      revealAll: false,
      unlocked: new Set(['lock1']),
      canUnlock: true,
      canCheck: false,
      checked: new Set(),
      hasWriteTools: true,
    });
    viewerPageBlocks(DOC_BLOCKS, {
      revealAll: true,
      unlocked: new Set(),
      canUnlock: false,
      canCheck: false,
      checked: new Set(),
      hasWriteTools: false,
    });
    expect(JSON.stringify(DOC_BLOCKS)).toBe(before);
  });

  it('shows staff a locked section that has no id', () => {
    const blocks = [
      {
        type: 'lockedSection',
        content: text('No id'),
        children: [{ type: 'paragraph', content: text('BODY') }],
      },
    ];
    const staff = viewerPageBlocks(blocks, {
      revealAll: true,
      unlocked: new Set(),
      canUnlock: false,
      canCheck: false,
      checked: new Set(),
      hasWriteTools: false,
    });
    expect(JSON.stringify(staff.blocks)).toContain('BODY');
    const student = viewerPageBlocks(blocks, {
      revealAll: false,
      unlocked: new Set(),
      canUnlock: true,
      canCheck: false,
      checked: new Set(),
      hasWriteTools: true,
    });
    expect(JSON.stringify(student.blocks)).not.toContain('BODY');
  });
});

// ─── page_section_unlock ────────────────────────────────────────────────────

describe('page_section_unlock', () => {
  it("records the unlock with the page's classroom and returns only that section's body", async () => {
    const payload = await unlock(ctxFor(STUDENT_A, 'STUDENT'), 'lock1');

    expect(payload).toMatchObject({
      page_id: PAGE,
      block_id: 'lock1',
      title: 'Hint one',
      already_unlocked: false,
    });
    expect(payload.text).toContain('SECRET-ONE');
    expect(payload.text).not.toContain('SECRET-TWO');
    expect(payload.text).not.toContain('SECRET-THREE');
    expect(payload.text).toContain('(id lock2) — use page_section_unlock');
    expect(payload.text).not.toContain('Read this first.');

    expect(unlocks).toEqual([
      expect.objectContaining({
        page_id: PAGE,
        user_id: STUDENT_A,
        classroom_id: CLASS_A,
        block_id: 'lock1',
      }),
    ]);
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: STUDENT_A,
        classroom_id: CLASS_A,
        resource_type: 'PAGES',
        resource_id: PAGE,
        action: 'CREATE',
        data: expect.objectContaining({ tool: 'page_section_unlock', block_id: 'lock1' }),
      })
    );
  });

  it('is idempotent: a second call keeps the first time and writes nothing', async () => {
    const first = await unlock(ctxFor(STUDENT_A, 'STUDENT'), 'lock1');
    mocks.auditCreate.mockClear();
    const second = await unlock(ctxFor(STUDENT_A, 'STUDENT'), 'lock1');
    expect(second.already_unlocked).toBe(true);
    expect(second.unlocked_at).toBe(first.unlocked_at);
    expect(unlocks).toHaveLength(1);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a section nested in a closed one exactly like an id that does not exist', async () => {
    const ctx = ctxFor(STUDENT_A, 'STUDENT');
    const nested = await refusalOf(() =>
      pageSectionUnlockTool.handler({ classroom: 'org/a', page_id: PAGE, block_id: 'lock2' }, ctx)
    );
    const bogus = await refusalOf(() =>
      pageSectionUnlockTool.handler({ classroom: 'org/a', page_id: PAGE, block_id: 'nope' }, ctx)
    );
    const heading = await refusalOf(() =>
      pageSectionUnlockTool.handler({ classroom: 'org/a', page_id: PAGE, block_id: 'h1' }, ctx)
    );
    expect(nested).toEqual(bogus);
    expect(heading).toEqual(bogus);
    expect(bogus.error).toBe('invalid_params');
    expect(unlocks).toHaveLength(0);

    // Once the outer section is open, the nested one can be unlocked.
    await unlock(ctx, 'lock1');
    const inner = await unlock(ctx, 'lock2');
    expect(inner.text).toContain('SECRET-TWO');
  });

  it("does not open a nested section on another student's unlock of its parent", async () => {
    unlocks = [unlockRow(STUDENT_B, 'lock1')];
    const refusal = await refusalOf(() =>
      pageSectionUnlockTool.handler(
        { classroom: 'org/a', page_id: PAGE, block_id: 'lock2' },
        ctxFor(STUDENT_A, 'STUDENT')
      )
    );
    expect(refusal.error).toBe('invalid_params');
  });

  it('refuses staff who are also students: they already see everything', async () => {
    const refusal = await refusalOf(() =>
      pageSectionUnlockTool.handler(
        { classroom: 'org/a', page_id: PAGE, block_id: 'lock1' },
        ctxFor(STAFF_STUDENT, 'STUDENT')
      )
    );
    expect(refusal).toMatchObject({ error: 'forbidden', code: 'TEACHING_TEAM' });
    expect(unlocks).toHaveLength(0);
  });

  it('refuses a pending invitee as not found', async () => {
    const refusal = await refusalOf(() =>
      pageSectionUnlockTool.handler(
        { classroom: 'org/a', page_id: PAGE, block_id: 'lock1' },
        ctxFor(PENDING, 'STUDENT')
      )
    );
    expect(refusal.error).toBe('not_found');
    expect(unlocks).toHaveLength(0);
  });

  it('answers a draft page and another classroom’s page with the same not-found', async () => {
    const ctx = ctxFor(STUDENT_A, 'STUDENT');
    const draft = await refusalOf(() =>
      pageSectionUnlockTool.handler({ classroom: 'org/a', page_id: DRAFT, block_id: 'lock1' }, ctx)
    );
    const foreign = await refusalOf(() =>
      pageSectionUnlockTool.handler(
        { classroom: 'org/a', page_id: FOREIGN, block_id: 'lock1' },
        ctx
      )
    );
    expect(draft).toEqual(foreign);
    expect(draft.error).toBe('not_found');
    expect(unlocks).toHaveLength(0);
    // The foreign page was never even read from its repo.
    expect(mocks.fetchContentText.mock.calls.map(c => c[1])).not.toContain(
      'pages/other/content.json'
    );
  });
});

// ─── page_section_check ─────────────────────────────────────────────────────

describe('page_section_check', () => {
  const check = (ctx: ToolContext, block_id: string, checked: boolean, page_id = PAGE) =>
    call(pageSectionCheckTool, { classroom: 'org/a', page_id, block_id, checked }, ctx);
  const refuse = (ctx: ToolContext, block_id: string, page_id = PAGE) =>
    refusalOf(() =>
      pageSectionCheckTool.handler({ classroom: 'org/a', page_id, block_id, checked: true }, ctx)
    );

  it("checks and unchecks the caller's own heading, auditing each change", async () => {
    checks = [checkRow(STUDENT_B, 'h1')];
    const ctx = ctxFor(STUDENT_A, 'STUDENT');

    const on = await check(ctx, 'h1', true);
    expect(on).toMatchObject({ block_id: 'h1', title: 'Part one', checked: true, changed: true });
    expect(checks.filter(row => row.user_id === STUDENT_A)).toEqual([
      expect.objectContaining({ page_id: PAGE, user_id: STUDENT_A, block_id: 'h1' }),
    ]);
    expect(mocks.auditCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        user_id: STUDENT_A,
        classroom_id: CLASS_A,
        resource_type: 'PAGES',
        resource_id: PAGE,
        action: 'CREATE',
        data: expect.objectContaining({
          tool: 'page_section_check',
          block_id: 'h1',
          checked: true,
        }),
      })
    );

    const off = await check(ctx, 'h1', false);
    expect(off).toMatchObject({ checked: false, changed: true });
    expect(mocks.auditCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'DELETE',
        data: expect.objectContaining({
          tool: 'page_section_check',
          block_id: 'h1',
          checked: false,
        }),
      })
    );
    // Only A's row went; B's check on the same heading is untouched.
    expect(checks).toEqual([expect.objectContaining({ user_id: STUDENT_B, block_id: 'h1' })]);
    const deletes = prismaCallsFor('pageSectionCheck', 'deleteMany').map(
      c => (c.args as { where: Row }).where
    );
    expect(deletes).toEqual([{ page_id: PAGE, user_id: STUDENT_A, block_id: 'h1' }]);
  });

  it('writes and audits nothing when the state already matches', async () => {
    checks = [checkRow(STUDENT_A, 'h1')];
    const payload = await check(ctxFor(STUDENT_A, 'STUDENT'), 'h1', true);
    expect(payload.changed).toBe(false);
    // A repeat check may reach the database (skipDuplicates makes it a no-op),
    // but never adds a row and never reaches the audit log.
    expect(checks).toHaveLength(1);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('writes and audits nothing when unchecking a heading that is not checked', async () => {
    checks = [checkRow(STUDENT_B, 'h1')];
    const payload = await check(ctxFor(STUDENT_A, 'STUDENT'), 'h1', false);
    expect(payload).toMatchObject({ checked: false, changed: false });
    expect(checks).toEqual([expect.objectContaining({ user_id: STUDENT_B })]);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('checks with skipDuplicates on the caller own key', async () => {
    await check(ctxFor(STUDENT_A, 'STUDENT'), 'h1', true);
    const creates = prismaCallsFor('pageSectionCheck', 'createMany').map(c => c.args);
    expect(creates).toEqual([
      {
        data: [{ page_id: PAGE, user_id: STUDENT_A, block_id: 'h1' }],
        skipDuplicates: true,
      },
    ]);
  });

  it('refuses a heading inside a closed locked section like an id that does not exist', async () => {
    const ctx = ctxFor(STUDENT_A, 'STUDENT');
    const hidden = await refuse(ctx, 'h2');
    const bogus = await refuse(ctx, 'nope');
    const notAHeading = await refuse(ctx, 'lock1');
    expect(hidden).toEqual(bogus);
    expect(notAHeading).toEqual(bogus);
    expect(bogus.error).toBe('invalid_params');
    expect(checks).toHaveLength(0);

    // Opened, it can be checked.
    await call(
      pageSectionUnlockTool,
      { classroom: 'org/a', page_id: PAGE, block_id: 'lock3' },
      ctx
    );
    expect((await check(ctx, 'h2', true)).changed).toBe(true);
  });

  it("does not reach a heading through another student's unlock", async () => {
    unlocks = [unlockRow(STUDENT_B, 'lock3')];
    expect((await refuse(ctxFor(STUDENT_A, 'STUDENT'), 'h2')).error).toBe('invalid_params');
  });

  it('lets an accepted staff member check, like the page checkbox', async () => {
    const payload = await check(ctxFor(TEACHER, 'TEACHER'), 'h2', true);
    expect(payload.changed).toBe(true);
    expect(checks).toEqual([expect.objectContaining({ user_id: TEACHER, block_id: 'h2' })]);
  });

  it('refuses a pending invitee as not found', async () => {
    expect((await refuse(ctxFor(PENDING, 'STUDENT'), 'h1')).error).toBe('not_found');
    expect(checks).toHaveLength(0);
  });

  it("answers a draft page and another classroom's page with the same not-found", async () => {
    const ctx = ctxFor(STUDENT_A, 'STUDENT');
    const draft = await refuse(ctx, 'h1', DRAFT);
    const foreign = await refuse(ctx, 'h1', FOREIGN);
    expect(draft).toEqual(foreign);
    expect(draft.error).toBe('not_found');
    expect(checks).toHaveLength(0);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(mocks.fetchContentText.mock.calls.map(c => c[1])).not.toContain(
      'pages/other/content.json'
    );
  });
});

// ─── page_sections_status ───────────────────────────────────────────────────

describe('page_sections_status', () => {
  const status = (ctx: ToolContext, page_id = PAGE) =>
    call(pageSectionsStatusTool, { classroom: 'org/a', page_id }, ctx);

  it("reports this classroom's current students only, per section, newest first", async () => {
    unlocks = [
      unlockRow(STUDENT_B, 'lock1'),
      // Another classroom's row on this page id, a removed student, and a
      // teacher who is also a student: none of them count.
      unlockRow(STUDENT_OTHER_CLASS, 'lock1', CLASS_B),
      unlockRow(REMOVED, 'lock1'),
      unlockRow(STAFF_STUDENT, 'lock3'),
      // Student A's unlock on classroom B's page stays out of A's page.
      unlockRow(STUDENT_A, 'lock1', CLASS_B, FOREIGN),
    ];
    checks = [
      {
        id: 'c1',
        page_id: PAGE,
        user_id: STUDENT_A,
        block_id: 'h1',
        checked_at: new Date('2026-10-11T10:00:00Z'),
      },
      {
        id: 'c2',
        page_id: PAGE,
        user_id: REMOVED,
        block_id: 'h1',
        checked_at: new Date('2026-10-11T11:00:00Z'),
      },
      {
        id: 'c3',
        page_id: FOREIGN,
        user_id: STUDENT_OTHER_CLASS,
        block_id: 'h1',
        checked_at: new Date('2026-10-11T12:00:00Z'),
      },
    ];

    const payload = await status(ctxFor(TEACHER, 'TEACHER'));

    expect(payload.students).toBe(2);
    expect(payload.checkable_headings).toEqual([
      {
        id: 'h1',
        title: 'Part one',
        checked: 1,
        students: [
          {
            name: `Name ${STUDENT_A}`,
            login: `login-${STUDENT_A}`,
            at: '2026-10-11T10:00:00.000Z',
          },
        ],
      },
      { id: 'h2', title: 'Answer step', checked: 0, students: [] },
    ]);
    expect(payload.locked_sections).toEqual([
      {
        id: 'lock1',
        title: 'Hint one',
        unlocked: 1,
        students: [
          {
            name: `Name ${STUDENT_B}`,
            login: `login-${STUDENT_B}`,
            at: '2026-10-10T15:00:00.000Z',
          },
        ],
      },
      { id: 'lock2', title: 'Deeper hint', unlocked: 0, students: [] },
      { id: 'lock3', title: 'Answer', unlocked: 0, students: [] },
    ]);
    const serialized = JSON.stringify(payload);
    for (const outsider of [STUDENT_OTHER_CLASS, REMOVED, STAFF_STUDENT]) {
      expect(serialized).not.toContain(outsider);
    }

    // The unlock query names this classroom and the current-student set.
    const [unlockQuery] = prismaCallsFor('pageSectionUnlock', 'findMany');
    expect((unlockQuery.args as { where: Row }).where).toMatchObject({
      page_id: PAGE,
      classroom_id: CLASS_A,
      user_id: { in: expect.arrayContaining([STUDENT_A, STUDENT_B]) },
    });
  });

  it('writes an audit VIEW row on every call', async () => {
    await status(ctxFor(TEACHER, 'TEACHER'));
    await status(ctxFor(TEACHER, 'TEACHER'));
    expect(mocks.auditCreate).toHaveBeenCalledTimes(2);
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: TEACHER,
        classroom_id: CLASS_A,
        resource_type: 'PAGES',
        resource_id: PAGE,
        action: 'VIEW',
        data: expect.objectContaining({ tool: 'page_sections_status' }),
      })
    );
  });

  it("answers another classroom's page as not found, and reads none of its rows", async () => {
    unlocks = [unlockRow(STUDENT_OTHER_CLASS, 'lock1', CLASS_B, FOREIGN)];
    const refusal = await refusalOf(() =>
      pageSectionsStatusTool.handler(
        { classroom: 'org/a', page_id: FOREIGN },
        ctxFor(TEACHER, 'TEACHER')
      )
    );
    expect(refusal.error).toBe('not_found');
    expect(prismaCallsFor('pageSectionUnlock')).toHaveLength(0);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('still reports activity when the content cannot be read', async () => {
    unlocks = [unlockRow(STUDENT_B, 'lock1')];
    mocks.fetchContentText.mockResolvedValue(null);
    const payload = await status(ctxFor(TEACHER, 'TEACHER'));
    expect(payload.content_unavailable).toBe(true);
    expect(payload.not_in_current_content).toEqual([{ id: 'lock1', kind: 'unlock', count: 1 }]);
  });
});
