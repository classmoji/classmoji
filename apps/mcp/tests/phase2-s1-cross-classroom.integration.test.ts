/**
 * S1 — cross-classroom scoping (plan §8, CRITICAL), per write family.
 *
 * For EVERY write family, a caller authorized for the dev classroom
 * (classmoji-development/classmoji-dev-winter-2025) aims the tool at a
 * foreign-classroom (dev-org/classmoji-other-class) target UUID. Expected:
 * the UNIFORM `not_found` (identical to the "record does not exist" error, so
 * probes cannot enumerate foreign records), and — asserted in the DB — no
 * mutation of the foreign row.
 *
 * The seeded foreign chain (other-hello-world → fake-issue-fake-other-student)
 * covers grade/grader/assignment/regrade-create/token targets; the seed lacks
 * a foreign module/page/calendar-event/regrade-request, so those rows are
 * created here and deleted in afterAll (create-and-clean).
 *
 * Identity discipline: timofei7 (all-roles) is used ONLY where the tool's
 * role gate is OWNER-only — the assertion here is cross-classroom rejection
 * (post-role-gate), never role denial.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callTool,
  CleanupStack,
  deleteMcpAuditRows,
  deleteMintedTokens,
  deleteTestNotifications,
  DEV_REF,
  expectScopedNotFound,
  getPrisma,
  loadFixtures,
  mintToken,
  readResource,
  RESOURCE_NOT_FOUND,
  startServer,
  type Fixtures,
  type ServerHandle,
} from './helpers.ts';

const prisma = getPrisma();
const suiteStart = new Date();
const cleanup = new CleanupStack();

let server: ServerHandle;
let fx: Fixtures;

// Bearer tokens per role (minted once; deleted by value in afterAll).
let owner: string; // timofei7 — OWNER-only tools
let teacher: string; // fake-teacher — OWNER_TEACHER tools
let ta: string; // fake-ta — teaching-team tools
let student: string; // fake-student-1 — student tools

// Foreign rows created by this file (the seed lacks these targets).
let foreignModuleId: string;
let foreignPageId: string;
let foreignEventId: string;
let foreignRegradeId: string;
let devModuleId: string;

const S1_TITLES = {
  foreignModule: 'MCP-S1 Foreign Module',
  foreignPage: 'MCP-S1 Foreign Page',
  foreignEvent: 'MCP-S1 Foreign Event',
  devModule: 'MCP-S1 Dev Module',
} as const;

beforeAll(async () => {
  fx = await loadFixtures();

  // Defensive pre-clean so a crashed earlier run can't break unique keys.
  await prisma.module.deleteMany({
    where: { title: { in: [S1_TITLES.foreignModule, S1_TITLES.devModule] } },
  });
  await prisma.page.deleteMany({ where: { title: S1_TITLES.foreignPage } });
  await prisma.calendarEvent.deleteMany({ where: { title: S1_TITLES.foreignEvent } });

  server = await startServer();

  [owner, teacher, ta, student] = (
    await Promise.all([
      mintToken({ login: 'timofei7' }),
      mintToken({ login: 'fake-teacher' }),
      mintToken({ login: 'fake-ta' }),
      mintToken({ login: 'fake-student-1' }),
    ])
  ).map(t => t.access_token);

  // ── Foreign fixtures the seed lacks (tracked; deleted in afterAll) ──
  const foreignModule = await prisma.module.create({
    data: {
      classroom_id: fx.foreign.id,
      title: S1_TITLES.foreignModule,
      slug: 'mcp-s1-foreign-module',
    },
  });
  foreignModuleId = foreignModule.id;
  cleanup.add('foreign module', () => prisma.module.deleteMany({ where: { id: foreignModuleId } }));

  const foreignPage = await prisma.page.create({
    data: {
      classroom_id: fx.foreign.id,
      title: S1_TITLES.foreignPage,
      content_path: 'pages/mcp-s1-foreign-page',
      created_by: fx.users['fake-other-owner'].id,
    },
  });
  foreignPageId = foreignPage.id;
  cleanup.add('foreign page', () => prisma.page.deleteMany({ where: { id: foreignPageId } }));

  const foreignEvent = await prisma.calendarEvent.create({
    data: {
      classroom_id: fx.foreign.id,
      created_by: fx.users['fake-other-owner'].id,
      event_type: 'LECTURE',
      title: S1_TITLES.foreignEvent,
      start_time: new Date('2026-07-20T10:00:00Z'),
      end_time: new Date('2026-07-20T11:00:00Z'),
    },
  });
  foreignEventId = foreignEvent.id;
  cleanup.add('foreign calendar event', () =>
    prisma.calendarEvent.deleteMany({ where: { id: foreignEventId } })
  );

  const foreignRegrade = await prisma.regradeRequest.create({
    data: {
      classroom_id: fx.foreign.id,
      git_repo_assignment_id: fx.foreignGra.id,
      student_id: fx.users['fake-other-student'].id,
      student_comment: 'MCP-S1 foreign regrade fixture',
      previous_grade: [],
    },
  });
  foreignRegradeId = foreignRegrade.id;
  cleanup.add('foreign regrade request', () =>
    prisma.regradeRequest.deleteMany({ where: { id: foreignRegradeId } })
  );

  // A module in the DEV classroom, used to aim module_item_add at a FOREIGN
  // item target (the reverse arrow of the module family).
  const devModule = await prisma.module.create({
    data: { classroom_id: fx.dev.id, title: S1_TITLES.devModule, slug: 'mcp-s1-dev-module' },
  });
  devModuleId = devModule.id;
  cleanup.add('dev module', () => prisma.module.deleteMany({ where: { id: devModuleId } }));
}, 300_000);

afterAll(async () => {
  try {
    await cleanup.run();
  } finally {
    try {
      // S1 calls are all denials, but scrub any stray audit/notification rows.
      await deleteMcpAuditRows(
        suiteStart,
        Object.values(fx?.users ?? {}).map(u => u.id)
      );
      await deleteTestNotifications(suiteStart, [fx.dev.id, fx.twin.id, fx.foreign.id]);
      await deleteMintedTokens();
    } finally {
      await server?.stop();
      await prisma.$disconnect();
    }
  }
}, 120_000);

// ─── Uniformity: foreign UUID and nonexistent UUID are indistinguishable ────

describe('S1 uniform rejection (non-enumerability)', () => {
  it('grade_add returns byte-identical errors for a foreign UUID and a random UUID', async () => {
    const foreign = await callTool(ta, 'grade_add', {
      classroom: DEV_REF,
      git_repo_assignment_id: fx.foreignGra.id,
      emoji: '🟢',
    });
    const random = await callTool(ta, 'grade_add', {
      classroom: DEV_REF,
      git_repo_assignment_id: randomUUID(),
      emoji: '🟢',
    });
    expectScopedNotFound(foreign, 'grade_add foreign UUID');
    expectScopedNotFound(random, 'grade_add random UUID');
    expect(foreign.payload).toEqual(random.payload);
  });
});

// ─── The write-family matrix ─────────────────────────────────────────────────

describe('S1 cross-classroom rejection per write family', () => {
  it('grade family: grade_add / grade_remove / grade_remove_all', async () => {
    const gradesBefore = await prisma.assignmentGrade.count({
      where: { git_repo_assignment_id: fx.foreignGra.id },
    });

    expectScopedNotFound(
      await callTool(ta, 'grade_add', {
        classroom: DEV_REF,
        git_repo_assignment_id: fx.foreignGra.id,
        emoji: '🟢',
      }),
      'grade_add'
    );

    // grade_remove: aim at the foreign submission with a REAL dev grade id —
    // the S1 check on the submission must fire before the grade is touched.
    const devGrade = await prisma.assignmentGrade.findFirstOrThrow({
      where: { git_repo_assignment: { git_repo: { classroom_id: fx.dev.id } } },
    });
    expectScopedNotFound(
      await callTool(ta, 'grade_remove', {
        classroom: DEV_REF,
        git_repo_assignment_id: fx.foreignGra.id,
        grade_id: devGrade.id,
      }),
      'grade_remove'
    );
    expect(
      await prisma.assignmentGrade.findUnique({ where: { id: devGrade.id } }),
      'the dev grade aimed through a foreign submission must survive'
    ).toBeTruthy();

    expectScopedNotFound(
      await callTool(owner, 'grade_remove_all', {
        classroom: DEV_REF,
        git_repo_assignment_id: fx.foreignGra.id,
      }),
      'grade_remove_all'
    );

    expect(
      await prisma.assignmentGrade.count({
        where: { git_repo_assignment_id: fx.foreignGra.id },
      })
    ).toBe(gradesBefore);
  });

  it('grader family: grader_assign / grader_unassign', async () => {
    expectScopedNotFound(
      await callTool(owner, 'grader_assign', {
        classroom: DEV_REF,
        git_repo_assignment_id: fx.foreignGra.id,
        grader_id: fx.users['fake-ta'].id,
      }),
      'grader_assign'
    );
    expectScopedNotFound(
      await callTool(owner, 'grader_unassign', {
        classroom: DEV_REF,
        git_repo_assignment_id: fx.foreignGra.id,
        grader_id: fx.users['fake-ta'].id,
      }),
      'grader_unassign'
    );
    expect(
      await prisma.gitRepoAssignmentGrader.count({
        where: { git_repo_assignment_id: fx.foreignGra.id },
      })
    ).toBe(0);
  });

  it('assignment family: assignment_update', async () => {
    const before = await prisma.assignment.findUniqueOrThrow({
      where: { id: fx.foreignAssignment.id },
    });
    expectScopedNotFound(
      await callTool(teacher, 'assignment_update', {
        classroom: DEV_REF,
        assignment_id: fx.foreignAssignment.id,
        grades_released: true,
        student_deadline: '2026-08-01T23:59:00-04:00',
      }),
      'assignment_update'
    );
    const after = await prisma.assignment.findUniqueOrThrow({
      where: { id: fx.foreignAssignment.id },
    });
    expect(after.grades_released).toBe(before.grades_released);
    expect(after.student_deadline).toEqual(before.student_deadline);
    expect(after.weight).toBe(before.weight);
  });

  it('module family: module_update / module_publish / module_item_add', async () => {
    expectScopedNotFound(
      await callTool(owner, 'module_update', {
        classroom: DEV_REF,
        module_id: foreignModuleId,
        title: 'HIJACKED',
      }),
      'module_update'
    );
    expectScopedNotFound(
      await callTool(owner, 'module_publish', {
        classroom: DEV_REF,
        module_id: foreignModuleId,
        published: true,
      }),
      'module_publish'
    );
    expectScopedNotFound(
      await callTool(owner, 'module_item_add', {
        classroom: DEV_REF,
        module_id: foreignModuleId,
        item_type: 'REPOSITORY',
        target_id: fx.devRepository.id,
      }),
      'module_item_add (foreign module)'
    );

    const after = await prisma.module.findUniqueOrThrow({
      where: { id: foreignModuleId },
      include: { items: true },
    });
    expect(after.title).toBe(S1_TITLES.foreignModule);
    expect(after.is_published).toBe(false);
    expect(after.items).toHaveLength(0);
  });

  it('module_item family (reverse arrow): own module + FOREIGN item target', async () => {
    expectScopedNotFound(
      await callTool(owner, 'module_item_add', {
        classroom: DEV_REF,
        module_id: devModuleId,
        item_type: 'REPOSITORY',
        target_id: fx.foreignRepository.id,
      }),
      'module_item_add (foreign target)'
    );
    expect(await prisma.moduleItem.count({ where: { module_id: devModuleId } })).toBe(0);
  });

  it('calendar family: calendar_event_update / calendar_event_delete', async () => {
    expectScopedNotFound(
      await callTool(ta, 'calendar_event_update', {
        classroom: DEV_REF,
        event_id: foreignEventId,
        title: 'HIJACKED',
      }),
      'calendar_event_update'
    );
    expectScopedNotFound(
      await callTool(ta, 'calendar_event_delete', {
        classroom: DEV_REF,
        event_id: foreignEventId,
      }),
      'calendar_event_delete'
    );
    const after = await prisma.calendarEvent.findUnique({ where: { id: foreignEventId } });
    expect(after?.title).toBe(S1_TITLES.foreignEvent);
  });

  it('page family: page_update / page_delete', async () => {
    expectScopedNotFound(
      await callTool(teacher, 'page_update', {
        classroom: DEV_REF,
        page_id: foreignPageId,
        title: 'HIJACKED',
      }),
      'page_update'
    );
    expectScopedNotFound(
      await callTool(teacher, 'page_delete', {
        classroom: DEV_REF,
        page_id: foreignPageId,
      }),
      'page_delete'
    );
    const after = await prisma.page.findUnique({ where: { id: foreignPageId } });
    expect(after?.title).toBe(S1_TITLES.foreignPage);
  });

  it('regrade_create family: student aims at a foreign submission', async () => {
    expectScopedNotFound(
      await callTool(student, 'regrade_create', {
        classroom: DEV_REF,
        git_repo_assignment_id: fx.foreignGra.id,
        comment: 'please regrade',
      }),
      'regrade_create'
    );
    expect(
      await prisma.regradeRequest.count({
        where: {
          git_repo_assignment_id: fx.foreignGra.id,
          student_id: fx.users['fake-student-1'].id,
        },
      })
    ).toBe(0);
  });

  it('regrade_resolve family: teaching team aims at a foreign request', async () => {
    expectScopedNotFound(
      await callTool(ta, 'regrade_resolve', {
        classroom: DEV_REF,
        regrade_request_id: foreignRegradeId,
        resolution: 'APPROVED',
      }),
      'regrade_resolve'
    );
    const after = await prisma.regradeRequest.findUniqueOrThrow({
      where: { id: foreignRegradeId },
    });
    expect(after.status).toBe('IN_REVIEW');
  });

  it('token_grant family: OWNER aims at a non-member target', async () => {
    expectScopedNotFound(
      await callTool(owner, 'token_grant', {
        classroom: DEV_REF,
        student_id: fx.users['fake-other-student'].id,
        amount: 5,
      }),
      'token_grant (non-member)'
    );
    expect(
      await prisma.tokenTransaction.count({
        where: { classroom_id: fx.dev.id, student_id: fx.users['fake-other-student'].id },
      })
    ).toBe(0);
  });
});

// ─── Read-side S1 (bonus): the submission resource scopes in the query ──────

describe('S1 read-side: submission resource', () => {
  it('a foreign submission id resolves to resource not_found (-32002)', async () => {
    const outcome = await readResource(
      ta,
      `classmoji://${DEV_REF}/submissions/${fx.foreignGra.id}`
    );
    expect(outcome.payload).toBeUndefined();
    expect(outcome.error?.code).toBe(RESOURCE_NOT_FOUND);
  });
});
