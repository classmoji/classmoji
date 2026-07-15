/**
 * S4 — role alignment matrix (plan §8, HIGH) over the Phase-2 tool + resource
 * surface: for each role tier, one allow and one deny at the adjacent role
 * boundary, plus the not-a-member branch, assignment_update per-field
 * tiering, roster field tiering, and S2 revocation extended to a WRITE tool.
 *
 * Test-integrity guard (S10): timofei7 holds OWNER+ASSISTANT+STUDENT and
 * passes every role gate — it is used ONLY for OWNER-allow paths. Every
 * denial uses a single-role identity, and the first test PROVES the
 * identities are distinct single-role users (modeled on
 * apps/webapp/tests/auth.setup.ts:122-149).
 *
 * Audit: each successful write is asserted against audit_logs. The audit
 * service dedups same-shape rows ((user, classroom, role, type, id, action))
 * within 5s — sequences below either vary one of those fields or space the
 * writes past the window.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callTool,
  CleanupStack,
  deleteMcpAuditRows,
  deleteMintedTokens,
  deleteTestNotifications,
  DEV_REF,
  expectAuditRow,
  expectForbidden,
  expectScopedNotFound,
  getPrisma,
  loadFixtures,
  mintToken,
  readResource,
  RESOURCE_FORBIDDEN,
  rpcRaw,
  startServer,
  type Fixtures,
  type MintedToken,
  type ServerHandle,
} from './helpers.ts';

const prisma = getPrisma();
const suiteStart = new Date();
const cleanup = new CleanupStack();

let server: ServerHandle;
let fx: Fixtures;

let ownerMint: MintedToken; // timofei7 — OWNER-allow paths ONLY
let teacherMint: MintedToken; // fake-teacher — TEACHER (single role)
let taMint: MintedToken; // fake-ta — ASSISTANT (single role)
let student1Mint: MintedToken; // fake-student-1 — STUDENT (single role)
let student2Mint: MintedToken; // fake-student-2 — STUDENT (single role)
let otherOwnerMint: MintedToken; // fake-other-owner — no dev-classroom membership

let owner: string;
let teacher: string;
let ta: string;
let student1: string;
let student2: string;
let otherOwner: string;

/** Assignment created for this file (no GitRepoAssignments → the notifying
 * update paths have zero recipients). */
let tierAssignmentId: string;
/** Page created for this file (dev classroom, draft). */
let tierPageId: string;

const S4_TITLES = {
  assignment: 'MCP-S4 Tier Assignment',
  page: 'MCP-S4 Tier Page',
  pageRenamed: 'MCP-S4 Tier Page Renamed',
  module: 'MCP-S4 Module',
  moduleRenamed: 'MCP-S4 Module Renamed',
  taEvent: 'MCP-S4 TA Event',
  ownerEvent: 'MCP-S4 Owner Event',
  revocationEvent: 'MCP-S4 Revocation Event',
  letterGrade: 'MCPZ',
} as const;

beforeAll(async () => {
  fx = await loadFixtures();

  // Defensive pre-clean (crashed earlier runs must not break unique keys).
  await prisma.assignment.deleteMany({
    where: { title: S4_TITLES.assignment, repository: { classroom_id: fx.dev.id } },
  });
  await prisma.page.deleteMany({
    where: { title: { in: [S4_TITLES.page, S4_TITLES.pageRenamed] }, classroom_id: fx.dev.id },
  });
  await prisma.module.deleteMany({
    where: {
      title: { in: [S4_TITLES.module, S4_TITLES.moduleRenamed] },
      classroom_id: fx.dev.id,
    },
  });
  await prisma.calendarEvent.deleteMany({
    where: {
      title: { in: [S4_TITLES.taEvent, S4_TITLES.ownerEvent, S4_TITLES.revocationEvent] },
      classroom_id: fx.dev.id,
    },
  });
  await prisma.letterGradeMapping.deleteMany({
    where: { classroom_id: fx.dev.id, letter_grade: S4_TITLES.letterGrade },
  });
  // The team fixture must START ungraded (it must also END ungraded), and
  // carry no stray token transactions (a concurrent agent shares this DB).
  await prisma.assignmentGrade.deleteMany({
    where: { git_repo_assignment_id: fx.teamGra.id },
  });
  await prisma.tokenTransaction.deleteMany({
    where: { git_repo_assignment_id: fx.teamGra.id },
  });

  server = await startServer();

  [ownerMint, teacherMint, taMint, student1Mint, student2Mint, otherOwnerMint] = await Promise.all([
    mintToken({ login: 'timofei7' }),
    mintToken({ login: 'fake-teacher' }),
    mintToken({ login: 'fake-ta' }),
    mintToken({ login: 'fake-student-1' }),
    mintToken({ login: 'fake-student-2' }),
    mintToken({ login: 'fake-other-owner' }),
  ]);
  owner = ownerMint.access_token;
  teacher = teacherMint.access_token;
  ta = taMint.access_token;
  student1 = student1Mint.access_token;
  student2 = student2Mint.access_token;
  otherOwner = otherOwnerMint.access_token;

  const tierAssignment = await prisma.assignment.create({
    data: {
      repository_id: fx.devRepository.id,
      title: S4_TITLES.assignment,
      weight: 10,
      is_published: false,
    },
  });
  tierAssignmentId = tierAssignment.id;
  cleanup.add('tier assignment', () =>
    prisma.assignment.deleteMany({ where: { id: tierAssignmentId } })
  );

  const tierPage = await prisma.page.create({
    data: {
      classroom_id: fx.dev.id,
      title: S4_TITLES.page,
      content_path: 'pages/mcp-s4-tier-page',
      created_by: fx.users.timofei7.id,
    },
  });
  tierPageId = tierPage.id;
  cleanup.add('tier page (fallback if page_delete test did not run)', () =>
    prisma.page.deleteMany({ where: { id: tierPageId } })
  );
}, 300_000);

afterAll(async () => {
  try {
    await cleanup.run();
  } finally {
    try {
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

// ─── S10 guard: the denial identities are DISTINCT single-role users ─────────

describe('identity integrity (S10 guard)', () => {
  it('all matrix identities are distinct users', () => {
    const ids = [
      ownerMint.user_id,
      teacherMint.user_id,
      taMint.user_id,
      student1Mint.user_id,
      student2Mint.user_id,
      otherOwnerMint.user_id,
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(teacherMint.login).toBe('fake-teacher');
    expect(taMint.login).toBe('fake-ta');
    expect(student1Mint.login).toBe('fake-student-1');
  });

  it('denial identities hold exactly ONE role in the dev classroom (never multi-role)', async () => {
    const rolesOf = async (userId: string) =>
      (
        await prisma.classroomMembership.findMany({
          where: { classroom_id: fx.dev.id, user_id: userId },
          select: { role: true },
        })
      ).map(m => m.role);

    expect(await rolesOf(teacherMint.user_id)).toEqual(['TEACHER']);
    expect(await rolesOf(taMint.user_id)).toEqual(['ASSISTANT']);
    expect(await rolesOf(student1Mint.user_id)).toEqual(['STUDENT']);
    expect(await rolesOf(otherOwnerMint.user_id)).toEqual([]);
    // …and the all-roles identity really is multi-role (allow-path only).
    expect((await rolesOf(ownerMint.user_id)).sort()).toEqual(['ASSISTANT', 'OWNER', 'STUDENT']);
  });
});

// ─── Grading tier (TEACHING_TEAM; remove_all OWNER) ──────────────────────────

describe('grading tools', () => {
  it('grade_add/remove: TA and TEACHER allowed, STUDENT denied, remove_all OWNER-only', async () => {
    const gra = fx.teamGra.id;

    // DENY (adjacent boundary): STUDENT cannot grade.
    expectForbidden(
      await callTool(student1, 'grade_add', {
        classroom: DEV_REF,
        git_repo_assignment_id: gra,
        emoji: '🟡',
      }),
      'grade_add as student',
      'INSUFFICIENT_ROLE'
    );

    // ALLOW: ASSISTANT adds 🟡 (extra_tokens=0 in the seed scale → no tokens).
    const added = await callTool(ta, 'grade_add', {
      classroom: DEV_REF,
      git_repo_assignment_id: gra,
      emoji: '🟡',
    });
    expect(added.isError).toBe(false);
    expect(added.payload.deduplicated).toBe(false);
    await expectAuditRow({
      userId: taMint.user_id,
      classroomId: fx.dev.id,
      role: 'ASSISTANT',
      resourceType: 'GIT_REPO_ASSIGNMENT',
      action: 'CREATE',
      resourceId: gra,
      tool: 'grade_add',
      since: suiteStart,
    });

    // The orchestrator dedups a repeated emoji silently; the tool surfaces it.
    const duped = await callTool(ta, 'grade_add', {
      classroom: DEV_REF,
      git_repo_assignment_id: gra,
      emoji: '🟡',
    });
    expect(duped.isError).toBe(false);
    expect(duped.payload.deduplicated).toBe(true);
    expect(await prisma.assignmentGrade.count({ where: { git_repo_assignment_id: gra } })).toBe(1);

    // ALLOW: ⭐ too, so remove and remove_all each have a target.
    const starred = await callTool(ta, 'grade_add', {
      classroom: DEV_REF,
      git_repo_assignment_id: gra,
      emoji: '⭐',
    });
    expect(starred.isError).toBe(false);
    const grades = starred.payload.grades as Array<{ id: string; emoji: string }>;
    const yellowGrade = grades.find(g => g.emoji === '🟡');
    expect(yellowGrade).toBeDefined();

    // S9: an emoji outside the classroom scale is rejected up front.
    const junk = await callTool(ta, 'grade_add', {
      classroom: DEV_REF,
      git_repo_assignment_id: gra,
      emoji: '🦄',
    });
    expect(junk.isError).toBe(true);
    expect(junk.payload.error).toBe('invalid_params');

    // ALLOW: TEACHER (grading tier includes TEACHER) removes 🟡.
    const removed = await callTool(teacher, 'grade_remove', {
      classroom: DEV_REF,
      git_repo_assignment_id: gra,
      grade_id: yellowGrade!.id,
    });
    expect(removed.isError).toBe(false);
    await expectAuditRow({
      userId: teacherMint.user_id,
      classroomId: fx.dev.id,
      role: 'TEACHER',
      resourceType: 'GIT_REPO_ASSIGNMENT',
      action: 'DELETE',
      resourceId: gra,
      tool: 'grade_remove',
      since: suiteStart,
    });

    // DENY (adjacent boundary): remove_all is OWNER-only — TEACHER refused.
    expectForbidden(
      await callTool(teacher, 'grade_remove_all', {
        classroom: DEV_REF,
        git_repo_assignment_id: gra,
      }),
      'grade_remove_all as teacher',
      'INSUFFICIENT_ROLE'
    );
    expect(await prisma.assignmentGrade.count({ where: { git_repo_assignment_id: gra } })).toBe(1);

    // ALLOW: OWNER clears the rest — the team fixture ends ungraded.
    const removedAll = await callTool(owner, 'grade_remove_all', {
      classroom: DEV_REF,
      git_repo_assignment_id: gra,
    });
    expect(removedAll.isError).toBe(false);
    expect(removedAll.payload.removed_count).toBe(1);
    await expectAuditRow({
      userId: ownerMint.user_id,
      classroomId: fx.dev.id,
      role: 'OWNER',
      resourceType: 'GIT_REPO_ASSIGNMENT',
      action: 'DELETE',
      resourceId: gra,
      tool: 'grade_remove_all',
      since: suiteStart,
    });
    expect(await prisma.assignmentGrade.count({ where: { git_repo_assignment_id: gra } })).toBe(0);
    // Zero-token emojis must not have minted anything DURING this suite
    // (timestamp-scoped: a concurrent agent may touch the shared fixture).
    expect(
      await prisma.tokenTransaction.count({
        where: { git_repo_assignment_id: gra, created_at: { gte: suiteStart } },
      })
    ).toBe(0);
  });
});

// ─── Grader assignment + grading-scale tiers (OWNER-only) ───────────────────

describe('OWNER-only tools deny the adjacent TEACHER boundary', () => {
  it('grader_assign / grader_unassign refuse a TEACHER', async () => {
    expectForbidden(
      await callTool(teacher, 'grader_assign', {
        classroom: DEV_REF,
        git_repo_assignment_id: fx.teamGra.id,
        grader_id: fx.users['fake-ta'].id,
      }),
      'grader_assign as teacher',
      'INSUFFICIENT_ROLE'
    );
    expectForbidden(
      await callTool(teacher, 'grader_unassign', {
        classroom: DEV_REF,
        git_repo_assignment_id: fx.teamGra.id,
        grader_id: fx.users['fake-ta'].id,
      }),
      'grader_unassign as teacher',
      'INSUFFICIENT_ROLE'
    );
    expect(
      await prisma.gitRepoAssignmentGrader.count({
        where: { git_repo_assignment_id: fx.teamGra.id },
      })
    ).toBe(0);
  });

  it('emoji/letter grade mappings: TEACHER denied, OWNER allowed (letter)', async () => {
    expectForbidden(
      await callTool(teacher, 'emoji_mapping_upsert', {
        classroom: DEV_REF,
        emoji: '🟢',
        grade: 100,
      }),
      'emoji_mapping_upsert as teacher',
      'INSUFFICIENT_ROLE'
    );
    expectForbidden(
      await callTool(teacher, 'letter_grade_mapping_upsert', {
        classroom: DEV_REF,
        letter_grade: S4_TITLES.letterGrade,
        min_grade: 0,
      }),
      'letter_grade_mapping_upsert as teacher',
      'INSUFFICIENT_ROLE'
    );
    expect(
      await prisma.letterGradeMapping.count({
        where: { classroom_id: fx.dev.id, letter_grade: S4_TITLES.letterGrade },
      })
    ).toBe(0);

    const created = await callTool(owner, 'letter_grade_mapping_upsert', {
      classroom: DEV_REF,
      letter_grade: S4_TITLES.letterGrade,
      min_grade: 1,
    });
    expect(created.isError).toBe(false);
    cleanup.add('letter grade mapping', () =>
      prisma.letterGradeMapping.deleteMany({
        where: { classroom_id: fx.dev.id, letter_grade: S4_TITLES.letterGrade },
      })
    );
    const row = await prisma.letterGradeMapping.findFirstOrThrow({
      where: { classroom_id: fx.dev.id, letter_grade: S4_TITLES.letterGrade },
    });
    expect(row.min_grade).toBe(1);
    await expectAuditRow({
      userId: ownerMint.user_id,
      classroomId: fx.dev.id,
      role: 'OWNER',
      resourceType: 'SETTINGS',
      action: 'UPDATE',
      resourceId: row.id,
      tool: 'letter_grade_mapping_upsert',
      since: suiteStart,
    });
  });

  it('token_grant: TEACHER denied; OWNER may grant only to enrolled STUDENTs', async () => {
    expectForbidden(
      await callTool(teacher, 'token_grant', {
        classroom: DEV_REF,
        student_id: fx.users['fake-student-3'].id,
        amount: 3,
      }),
      'token_grant as teacher',
      'INSUFFICIENT_ROLE'
    );

    // S9: a non-STUDENT target (the TA) is refused with the uniform not_found.
    expectScopedNotFound(
      await callTool(owner, 'token_grant', {
        classroom: DEV_REF,
        student_id: fx.users['fake-ta'].id,
        amount: 3,
      }),
      'token_grant to a non-student'
    );

    const before = await prisma.tokenTransaction.findFirst({
      where: { classroom_id: fx.dev.id, student_id: fx.users['fake-student-3'].id },
      orderBy: { created_at: 'desc' },
    });
    const balanceBefore = before?.balance_after ?? 0;

    const granted = await callTool(owner, 'token_grant', {
      classroom: DEV_REF,
      student_id: fx.users['fake-student-3'].id,
      amount: 3,
      description: 'MCP-S4 token grant',
    });
    expect(granted.isError).toBe(false);
    const txn = granted.payload.transaction as { id: string; balance_after: number };
    expect(txn.balance_after).toBe(balanceBefore + 3);
    cleanup.add('granted token transaction (balance restores to previous head)', () =>
      prisma.tokenTransaction.deleteMany({ where: { id: txn.id } })
    );
    await expectAuditRow({
      userId: ownerMint.user_id,
      classroomId: fx.dev.id,
      role: 'OWNER',
      resourceType: 'TOKEN_GRANT',
      action: 'CREATE',
      resourceId: txn.id,
      tool: 'token_grant',
      since: suiteStart,
    });
  });
});

// ─── assignment_update per-field tiering (OWNER_TEACHER + in-handler gate) ──

describe('assignment_update per-field tiering', () => {
  it('TEACHER may flip grades_released + move student_deadline, NOT weight; ASSISTANT denied outright', async () => {
    // DENY (role gate): ASSISTANT is outside OWNER_TEACHER.
    expectForbidden(
      await callTool(ta, 'assignment_update', {
        classroom: DEV_REF,
        assignment_id: tierAssignmentId,
        grades_released: true,
      }),
      'assignment_update as assistant',
      'INSUFFICIENT_ROLE'
    );

    // ALLOW: TEACHER updates the TEACHER-tier fields.
    const deadline = '2026-08-15T23:59:00-04:00';
    const updated = await callTool(teacher, 'assignment_update', {
      classroom: DEV_REF,
      assignment_id: tierAssignmentId,
      grades_released: true,
      student_deadline: deadline,
    });
    expect(updated.isError).toBe(false);
    const afterTeacher = await prisma.assignment.findUniqueOrThrow({
      where: { id: tierAssignmentId },
    });
    expect(afterTeacher.grades_released).toBe(true);
    expect(afterTeacher.student_deadline?.toISOString()).toBe(new Date(deadline).toISOString());
    await expectAuditRow({
      userId: teacherMint.user_id,
      classroomId: fx.dev.id,
      role: 'TEACHER',
      resourceType: 'ASSIGNMENT',
      action: 'UPDATE',
      resourceId: tierAssignmentId,
      tool: 'assignment_update',
      since: suiteStart,
    });

    // DENY (in-handler per-field gate): weight is OWNER-only.
    const weightDenied = await callTool(teacher, 'assignment_update', {
      classroom: DEV_REF,
      assignment_id: tierAssignmentId,
      weight: 60,
    });
    expectForbidden(weightDenied, 'weight update as teacher', 'INSUFFICIENT_ROLE');
    expect(String(weightDenied.payload.message)).toMatch(/weight/);
    // …and a mixed update must not partially apply the allowed fields.
    const mixedDenied = await callTool(teacher, 'assignment_update', {
      classroom: DEV_REF,
      assignment_id: tierAssignmentId,
      grades_released: false,
      weight: 60,
    });
    expectForbidden(mixedDenied, 'mixed update as teacher', 'INSUFFICIENT_ROLE');
    const afterDenied = await prisma.assignment.findUniqueOrThrow({
      where: { id: tierAssignmentId },
    });
    expect(afterDenied.weight).toBe(10);
    expect(afterDenied.grades_released).toBe(true);

    // ALLOW: OWNER updates weight.
    const ownerUpdate = await callTool(owner, 'assignment_update', {
      classroom: DEV_REF,
      assignment_id: tierAssignmentId,
      weight: 60,
    });
    expect(ownerUpdate.isError).toBe(false);
    expect(
      (await prisma.assignment.findUniqueOrThrow({ where: { id: tierAssignmentId } })).weight
    ).toBe(60);
  });
});

// ─── Regrades (student self-create; teaching-team resolve) ───────────────────
//
// dd9ae64 rewired BOTH success paths through Trigger.dev tasks
// (request_regrade / update_regrade_request) with a 60s run-completion poll.
// Without a live Trigger.dev worker the runs never complete AND every attempt
// queues a task that may execute later (side effects beyond the DB), so the
// success paths only run when MCP_IT_TRIGGER_TASKS=true. All authorization
// boundaries below fire BEFORE tasks.trigger and stay covered unconditionally.

const TRIGGER_TASKS_ENABLED = process.env.MCP_IT_TRIGGER_TASKS === 'true';

describe('regrade tools', () => {
  it('denial boundaries: role gate, IDOR self-scoping, team-owned rejection, resolve tier', async () => {
    // DENY (role gate): staff cannot file student regrades.
    expectForbidden(
      await callTool(ta, 'regrade_create', {
        classroom: DEV_REF,
        git_repo_assignment_id: fx.student1Gra.id,
        comment: 'as staff',
      }),
      'regrade_create as assistant',
      'INSUFFICIENT_ROLE'
    );

    // DENY (self-scoping IDOR): another student's submission → uniform not_found.
    expectScopedNotFound(
      await callTool(student2, 'regrade_create', {
        classroom: DEV_REF,
        git_repo_assignment_id: fx.student1Gra.id,
        comment: 'not mine',
      }),
      'regrade_create for another student'
    );

    // DENY: team-owned submissions are rejected (mirrors the web action).
    expectScopedNotFound(
      await callTool(student1, 'regrade_create', {
        classroom: DEV_REF,
        git_repo_assignment_id: fx.teamGra.id,
        comment: 'team repo',
      }),
      'regrade_create on a team submission'
    );

    // No regrade rows may have been created by the denials.
    expect(
      await prisma.regradeRequest.count({
        where: { created_at: { gte: suiteStart }, classroom_id: fx.dev.id },
      })
    ).toBe(0);

    // DENY (adjacent boundary): a STUDENT cannot resolve. The pending request
    // is created directly in the DB — the tool's create path is task-bound.
    const pending = await prisma.regradeRequest.create({
      data: {
        classroom_id: fx.dev.id,
        git_repo_assignment_id: fx.student1Gra.id,
        student_id: student1Mint.user_id,
        student_comment: 'MCP-S4 pending regrade fixture',
        previous_grade: ['🟢'],
      },
    });
    cleanup.add('pending regrade fixture', () =>
      prisma.regradeRequest.deleteMany({ where: { id: pending.id } })
    );
    expectForbidden(
      await callTool(student1, 'regrade_resolve', {
        classroom: DEV_REF,
        regrade_request_id: pending.id,
        resolution: 'APPROVED',
      }),
      'regrade_resolve as student',
      'INSUFFICIENT_ROLE'
    );
    expect(
      (await prisma.regradeRequest.findUniqueOrThrow({ where: { id: pending.id } })).status
    ).toBe('IN_REVIEW');

    // Close the fixture out immediately (an open IN_REVIEW request changes
    // grade_add semantics on that submission — never leave one behind).
    await prisma.regradeRequest.delete({ where: { id: pending.id } });
  });

  // Success paths require a live Trigger.dev worker since dd9ae64 — opt in
  // with MCP_IT_TRIGGER_TASKS=true. Kept as the executable spec of the
  // task-orchestrated flow for environments that run `npm run trigger:dev`.
  it.runIf(TRIGGER_TASKS_ENABLED)(
    'student self-create + teaching-team resolve (Trigger.dev-backed)',
    async () => {
      const created = await callTool(student1, 'regrade_create', {
        classroom: DEV_REF,
        git_repo_assignment_id: fx.student1Gra.id,
        comment: 'MCP-S4 regrade request',
      });
      expect(created.isError).toBe(false);
      const request = created.payload.regrade_request as {
        id: string;
        status: string;
        previous_grade: string[];
      };
      cleanup.add('regrade request', () =>
        prisma.regradeRequest.deleteMany({ where: { id: request.id } })
      );
      expect(request.status).toBe('IN_REVIEW');
      expect(request.previous_grade).toContain('🟢'); // seeded grade on that GRA
      await expectAuditRow({
        userId: student1Mint.user_id,
        classroomId: fx.dev.id,
        role: 'STUDENT',
        resourceType: 'REGRADE_REQUEST',
        action: 'CREATE',
        resourceId: request.id,
        tool: 'regrade_create',
        since: suiteStart,
      });

      // ALLOW: teaching team resolves (close it out so the grade fixture on
      // student1Gra is never subject to the open-regrade replace path).
      const resolved = await callTool(ta, 'regrade_resolve', {
        classroom: DEV_REF,
        regrade_request_id: request.id,
        resolution: 'DENIED',
      });
      expect(resolved.isError).toBe(false);
      expect(
        (await prisma.regradeRequest.findUniqueOrThrow({ where: { id: request.id } })).status
      ).toBe('DENIED');
      await expectAuditRow({
        userId: taMint.user_id,
        classroomId: fx.dev.id,
        role: 'ASSISTANT',
        resourceType: 'REGRADE_REQUEST',
        action: 'UPDATE',
        resourceId: request.id,
        tool: 'regrade_resolve',
        since: suiteStart,
      });
    },
    150_000
  );
});

// ─── Modules (OWNER-only CRUD) ───────────────────────────────────────────────

describe('module tools', () => {
  it('TEACHER denied; OWNER create → update → item_add → publish', async () => {
    expectForbidden(
      await callTool(teacher, 'module_create', {
        classroom: DEV_REF,
        title: S4_TITLES.module,
      }),
      'module_create as teacher',
      'INSUFFICIENT_ROLE'
    );

    const created = await callTool(owner, 'module_create', {
      classroom: DEV_REF,
      title: S4_TITLES.module,
      description: 'S4 matrix module',
    });
    expect(created.isError).toBe(false);
    const moduleId = (created.payload.module as { id: string }).id;
    cleanup.add('S4 module (items cascade)', () =>
      prisma.module.deleteMany({ where: { id: moduleId } })
    );
    await expectAuditRow({
      userId: ownerMint.user_id,
      classroomId: fx.dev.id,
      role: 'OWNER',
      resourceType: 'MODULES',
      action: 'CREATE',
      resourceId: moduleId,
      tool: 'module_create',
      since: suiteStart,
    });

    const renamed = await callTool(owner, 'module_update', {
      classroom: DEV_REF,
      module_id: moduleId,
      title: S4_TITLES.moduleRenamed,
    });
    expect(renamed.isError).toBe(false);
    await expectAuditRow({
      userId: ownerMint.user_id,
      classroomId: fx.dev.id,
      role: 'OWNER',
      resourceType: 'MODULES',
      action: 'UPDATE',
      resourceId: moduleId,
      tool: 'module_update',
      since: suiteStart,
    });

    const item = await callTool(owner, 'module_item_add', {
      classroom: DEV_REF,
      module_id: moduleId,
      item_type: 'REPOSITORY',
      target_id: fx.devRepository.id,
    });
    expect(item.isError).toBe(false);
    await expectAuditRow({
      userId: ownerMint.user_id,
      classroomId: fx.dev.id,
      role: 'OWNER',
      resourceType: 'MODULE_ITEM',
      action: 'CREATE',
      tool: 'module_item_add',
      since: suiteStart,
    });

    // module_publish audits (MODULES, id, UPDATE) — the SAME dedup shape as
    // module_update above, so wait out the 5s window to prove the row lands.
    await new Promise(r => setTimeout(r, 5_200));
    const publishedAt = new Date();
    const published = await callTool(owner, 'module_publish', {
      classroom: DEV_REF,
      module_id: moduleId,
      published: true,
    });
    expect(published.isError).toBe(false);
    expect((published.payload.module as { is_published: boolean }).is_published).toBe(true);
    await expectAuditRow({
      userId: ownerMint.user_id,
      classroomId: fx.dev.id,
      role: 'OWNER',
      resourceType: 'MODULES',
      action: 'UPDATE',
      resourceId: moduleId,
      tool: 'module_publish',
      since: publishedAt,
    });
  }, 60_000);
});

// ─── Calendar (teaching team; assistants own-events-only) ────────────────────

describe('calendar tools', () => {
  it('assistant own-events rule + student denied', async () => {
    expectForbidden(
      await callTool(student1, 'calendar_event_create', {
        classroom: DEV_REF,
        title: 'nope',
        event_type: 'LECTURE',
        start_time: '2026-07-21T10:00:00-04:00',
        end_time: '2026-07-21T11:00:00-04:00',
      }),
      'calendar_event_create as student',
      'INSUFFICIENT_ROLE'
    );

    const taEvent = await callTool(ta, 'calendar_event_create', {
      classroom: DEV_REF,
      title: S4_TITLES.taEvent,
      event_type: 'OFFICE_HOURS',
      start_time: '2026-07-21T10:00:00-04:00',
      end_time: '2026-07-21T11:00:00-04:00',
    });
    expect(taEvent.isError).toBe(false);
    const taEventId = (taEvent.payload.event as { id: string }).id;
    cleanup.add('TA calendar event (fallback)', () =>
      prisma.calendarEvent.deleteMany({ where: { id: taEventId } })
    );
    await expectAuditRow({
      userId: taMint.user_id,
      classroomId: fx.dev.id,
      role: 'ASSISTANT',
      resourceType: 'CALENDAR',
      action: 'CREATE',
      resourceId: taEventId,
      tool: 'calendar_event_create',
      since: suiteStart,
    });

    const ownerEvent = await callTool(owner, 'calendar_event_create', {
      classroom: DEV_REF,
      title: S4_TITLES.ownerEvent,
      event_type: 'LECTURE',
      start_time: '2026-07-22T10:00:00-04:00',
      end_time: '2026-07-22T11:00:00-04:00',
    });
    expect(ownerEvent.isError).toBe(false);
    const ownerEventId = (ownerEvent.payload.event as { id: string }).id;
    cleanup.add('owner calendar event (fallback)', () =>
      prisma.calendarEvent.deleteMany({ where: { id: ownerEventId } })
    );

    // DENY: an ASSISTANT may not touch someone else's event.
    expectForbidden(
      await callTool(ta, 'calendar_event_update', {
        classroom: DEV_REF,
        event_id: ownerEventId,
        title: 'HIJACKED',
      }),
      'assistant updating another creator’s event',
      'INSUFFICIENT_ROLE'
    );
    expectForbidden(
      await callTool(ta, 'calendar_event_delete', {
        classroom: DEV_REF,
        event_id: ownerEventId,
      }),
      'assistant deleting another creator’s event',
      'INSUFFICIENT_ROLE'
    );
    expect(
      (await prisma.calendarEvent.findUniqueOrThrow({ where: { id: ownerEventId } })).title
    ).toBe(S4_TITLES.ownerEvent);

    // ALLOW: the assistant edits their OWN event.
    const ownUpdate = await callTool(ta, 'calendar_event_update', {
      classroom: DEV_REF,
      event_id: taEventId,
      location: 'Sudikoff 115',
    });
    expect(ownUpdate.isError).toBe(false);
    await expectAuditRow({
      userId: taMint.user_id,
      classroomId: fx.dev.id,
      role: 'ASSISTANT',
      resourceType: 'CALENDAR',
      action: 'UPDATE',
      resourceId: taEventId,
      tool: 'calendar_event_update',
      since: suiteStart,
    });

    // ALLOW: TEACHER may edit anyone's event (OWNER/TEACHER escape hatch).
    const teacherUpdate = await callTool(teacher, 'calendar_event_update', {
      classroom: DEV_REF,
      event_id: taEventId,
      description: 'teacher was here',
    });
    expect(teacherUpdate.isError).toBe(false);

    // ALLOW: OWNER deletes both events (also the cleanup path).
    for (const eventId of [taEventId, ownerEventId]) {
      const deleted = await callTool(owner, 'calendar_event_delete', {
        classroom: DEV_REF,
        event_id: eventId,
      });
      expect(deleted.isError).toBe(false);
    }
    await expectAuditRow({
      userId: ownerMint.user_id,
      classroomId: fx.dev.id,
      role: 'OWNER',
      resourceType: 'CALENDAR',
      action: 'DELETE',
      resourceId: ownerEventId,
      tool: 'calendar_event_delete',
      since: suiteStart,
    });
    expect(
      await prisma.calendarEvent.count({ where: { id: { in: [taEventId, ownerEventId] } } })
    ).toBe(0);
  });
});

// ─── Pages (OWNER+TEACHER; ASSISTANT excluded) ───────────────────────────────

describe('page tools', () => {
  it('ASSISTANT denied; TEACHER updates and deletes', async () => {
    expectForbidden(
      await callTool(ta, 'page_update', {
        classroom: DEV_REF,
        page_id: tierPageId,
        title: 'nope',
      }),
      'page_update as assistant',
      'INSUFFICIENT_ROLE'
    );

    const renamed = await callTool(teacher, 'page_update', {
      classroom: DEV_REF,
      page_id: tierPageId,
      title: S4_TITLES.pageRenamed,
      width: 3,
    });
    expect(renamed.isError).toBe(false);
    const afterRename = await prisma.page.findUniqueOrThrow({ where: { id: tierPageId } });
    expect(afterRename.title).toBe(S4_TITLES.pageRenamed);
    expect(afterRename.width).toBe(3);
    await expectAuditRow({
      userId: teacherMint.user_id,
      classroomId: fx.dev.id,
      role: 'TEACHER',
      resourceType: 'PAGES',
      action: 'UPDATE',
      resourceId: tierPageId,
      tool: 'page_update',
      since: suiteStart,
    });

    expectForbidden(
      await callTool(ta, 'page_delete', { classroom: DEV_REF, page_id: tierPageId }),
      'page_delete as assistant',
      'INSUFFICIENT_ROLE'
    );

    // Orchestrated delete (the GitHub folder removal 404s on this synthetic
    // page and is tolerated by the service).
    const deleted = await callTool(teacher, 'page_delete', {
      classroom: DEV_REF,
      page_id: tierPageId,
    });
    expect(deleted.isError).toBe(false);
    expect(await prisma.page.count({ where: { id: tierPageId } })).toBe(0);
    await expectAuditRow({
      userId: teacherMint.user_id,
      classroomId: fx.dev.id,
      role: 'TEACHER',
      resourceType: 'PAGES',
      action: 'DELETE',
      resourceId: tierPageId,
      tool: 'page_delete',
      since: suiteStart,
    });
  }, 60_000);
});

// ─── Not-a-member branch (distinct from insufficient role) ───────────────────

describe('not-a-member denial', () => {
  it('a foreign classroom OWNER gets NOT_A_MEMBER on dev-classroom surfaces', async () => {
    expectForbidden(
      await callTool(otherOwner, 'grade_add', {
        classroom: DEV_REF,
        git_repo_assignment_id: fx.teamGra.id,
        emoji: '🟢',
      }),
      'grade_add as non-member',
      'NOT_A_MEMBER'
    );

    const roster = await readResource(otherOwner, `classmoji://${DEV_REF}/roster`);
    expect(roster.payload).toBeUndefined();
    expect(roster.error?.code).toBe(RESOURCE_FORBIDDEN);

    // …while their own identity resource still works.
    const me = await readResource(otherOwner, 'classmoji://me');
    expect(me.error).toBeUndefined();
    const memberships = me.payload!.memberships as Array<{ classroom: string }>;
    expect(memberships.some(m => m.classroom.endsWith('/classmoji-other-class'))).toBe(true);
    expect(memberships.some(m => m.classroom.endsWith('/classmoji-dev-winter-2025'))).toBe(false);
  });
});

// ─── Resource role matrix ────────────────────────────────────────────────────

describe('resource tiers', () => {
  it('roster: TA sees identity-only fields, OWNER sees contact + grade fields, STUDENT denied', async () => {
    const taRoster = await readResource(ta, `classmoji://${DEV_REF}/roster`);
    expect(taRoster.error).toBeUndefined();
    const taStudents = taRoster.payload!.students as Array<Record<string, unknown>>;
    expect(taStudents.length).toBeGreaterThanOrEqual(3);
    for (const s of taStudents) {
      expect(s).toHaveProperty('login');
      expect(s).toHaveProperty('is_grader');
      expect(s).not.toHaveProperty('email');
      expect(s).not.toHaveProperty('school_id');
      expect(s).not.toHaveProperty('letter_grade');
      expect(s).not.toHaveProperty('comment');
    }

    // timofei7 holds OWNER+ASSISTANT+STUDENT — this also pins U6: multi-role
    // callers must DETERMINISTICALLY resolve to their highest matching role
    // (OWNER), never an arbitrary ASSISTANT membership that would drop the
    // OWNER-only fields below.
    const ownerRoster = await readResource(owner, `classmoji://${DEV_REF}/roster`);
    expect(ownerRoster.error).toBeUndefined();
    const ownerStudents = ownerRoster.payload!.students as Array<Record<string, unknown>>;
    expect(ownerStudents[0]).toHaveProperty('email');
    expect(ownerStudents[0]).toHaveProperty('school_id');
    expect(ownerStudents[0]).toHaveProperty('letter_grade');
    expect(ownerStudents[0]).toHaveProperty('comment');

    const denied = await readResource(student1, `classmoji://${DEV_REF}/roster`);
    expect(denied.error?.code).toBe(RESOURCE_FORBIDDEN);
  });

  it('grading-queue + submission: teaching team only', async () => {
    const queue = await readResource(ta, `classmoji://${DEV_REF}/grading-queue`);
    expect(queue.error).toBeUndefined();
    expect(Array.isArray(queue.payload!.all)).toBe(true);
    expect(Array.isArray(queue.payload!.emoji_scale)).toBe(true);
    const all = queue.payload!.all as Array<{ id: string }>;
    expect(all.some(s => s.id === fx.teamGra.id)).toBe(true);

    const denied = await readResource(student1, `classmoji://${DEV_REF}/grading-queue`);
    expect(denied.error?.code).toBe(RESOURCE_FORBIDDEN);

    const submission = await readResource(
      ta,
      `classmoji://${DEV_REF}/submissions/${fx.teamGra.id}`
    );
    expect(submission.error).toBeUndefined();
    expect(submission.payload!.id).toBe(fx.teamGra.id);

    const submissionDenied = await readResource(
      student1,
      `classmoji://${DEV_REF}/submissions/${fx.teamGra.id}`
    );
    expect(submissionDenied.error?.code).toBe(RESOURCE_FORBIDDEN);
  });

  it('leaderboard: OWNER only (TEACHER is the adjacent deny)', async () => {
    const denied = await readResource(teacher, `classmoji://${DEV_REF}/leaderboard`);
    expect(denied.error?.code).toBe(RESOURCE_FORBIDDEN);

    const allowed = await readResource(owner, `classmoji://${DEV_REF}/leaderboard`);
    expect(allowed.error).toBeUndefined();
    const rows = allowed.payload!.leaderboard as Array<{ login?: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });

  it('regrade queues: staff queue exposes grader_comment, student view strips it', async () => {
    const queue = await readResource(ta, `classmoji://${DEV_REF}/regrade-requests`);
    expect(queue.error).toBeUndefined();
    const staffRows = queue.payload!.requests as Array<Record<string, unknown>>;
    expect(staffRows.length).toBeGreaterThan(0);
    expect(staffRows[0]).toHaveProperty('grader_comment');

    const queueDenied = await readResource(student1, `classmoji://${DEV_REF}/regrade-requests`);
    expect(queueDenied.error?.code).toBe(RESOURCE_FORBIDDEN);

    const mine = await readResource(student1, `classmoji://${DEV_REF}/regrade-requests/mine`);
    expect(mine.error).toBeUndefined();
    const myRows = mine.payload!.requests as Array<Record<string, unknown>>;
    expect(myRows.length).toBeGreaterThan(0); // seeded APPROVED request
    for (const row of myRows) {
      expect(row).not.toHaveProperty('grader_comment');
      expect(row).toHaveProperty('student_comment');
    }

    const mineDenied = await readResource(ta, `classmoji://${DEV_REF}/regrade-requests/mine`);
    expect(mineDenied.error?.code).toBe(RESOURCE_FORBIDDEN);
  });

  it('grades-mine + tokens: student self only', async () => {
    const grades = await readResource(student1, `classmoji://${DEV_REF}/grades-mine`);
    expect(grades.error).toBeUndefined();
    expect(typeof grades.payload!.count).toBe('number');

    const gradesDenied = await readResource(ta, `classmoji://${DEV_REF}/grades-mine`);
    expect(gradesDenied.error?.code).toBe(RESOURCE_FORBIDDEN);

    const tokens = await readResource(student1, `classmoji://${DEV_REF}/tokens`);
    expect(tokens.error).toBeUndefined();
    expect(typeof tokens.payload!.balance).toBe('number');
    expect(Array.isArray(tokens.payload!.transactions)).toBe(true);

    const tokensDenied = await readResource(ta, `classmoji://${DEV_REF}/tokens`);
    expect(tokensDenied.error?.code).toBe(RESOURCE_FORBIDDEN);
  });

  it('repos: staff shape vs student shape', async () => {
    const staff = await readResource(ta, `classmoji://${DEV_REF}/repos`);
    expect(staff.error).toBeUndefined();
    const staffRepos = staff.payload!.repositories as Array<Record<string, unknown>>;
    expect(staffRepos.length).toBeGreaterThan(0);
    // Staff rows carry publish state + grader-facing fields.
    expect(staffRepos[0]).toHaveProperty('is_published');
    const staffAssignments = staffRepos.flatMap(
      r => r.assignments as Array<Record<string, unknown>>
    );
    expect(staffAssignments[0]).toHaveProperty('grader_deadline');
    expect(staffAssignments[0]).not.toHaveProperty('my_submission');

    const studentView = await readResource(student1, `classmoji://${DEV_REF}/repos`);
    expect(studentView.error).toBeUndefined();
    const studentRepos = studentView.payload!.repositories as Array<Record<string, unknown>>;
    expect(studentRepos.length).toBeGreaterThan(0);
    for (const repo of studentRepos) {
      expect(repo).not.toHaveProperty('is_published'); // published-only listing
      for (const a of repo.assignments as Array<Record<string, unknown>>) {
        expect(a).toHaveProperty('my_submission');
        expect(a).not.toHaveProperty('grader_deadline');
      }
    }

    const denied = await readResource(otherOwner, `classmoji://${DEV_REF}/repos`);
    expect(denied.error?.code).toBe(RESOURCE_FORBIDDEN);
  });

  it('pages: OWNER/TEACHER full listing, ASSISTANT/STUDENT student-menu listing', async () => {
    const teacherPages = await readResource(teacher, `classmoji://${DEV_REF}/pages`);
    expect(teacherPages.error).toBeUndefined();
    const fullRows = teacherPages.payload!.pages as Array<Record<string, unknown>>;
    expect(fullRows.length).toBeGreaterThan(0);
    expect(fullRows[0]).toHaveProperty('is_draft');

    for (const token of [ta, student1]) {
      const menu = await readResource(token, `classmoji://${DEV_REF}/pages`);
      expect(menu.error).toBeUndefined();
      for (const row of menu.payload!.pages as Array<Record<string, unknown>>) {
        expect(row).not.toHaveProperty('is_draft');
        expect(row).not.toHaveProperty('is_public');
      }
    }
  });

  it('calendar: any member; non-members refused', async () => {
    const cal = await readResource(student1, `classmoji://${DEV_REF}/calendar`);
    expect(cal.error).toBeUndefined();
    expect(cal.payload).toHaveProperty('range');
    expect(Array.isArray(cal.payload!.events)).toBe(true);

    const range = await readResource(
      student1,
      `classmoji://${DEV_REF}/calendar/2026-01-01/2026-12-31`
    );
    expect(range.error).toBeUndefined();

    const denied = await readResource(otherOwner, `classmoji://${DEV_REF}/calendar`);
    expect(denied.error?.code).toBe(RESOURCE_FORBIDDEN);
  });

  it('classroom-info: member allow with sanitized settings', async () => {
    const info = await readResource(student1, `classmoji://${DEV_REF}`);
    expect(info.error).toBeUndefined();
    expect(info.payload!.id).toBe(fx.dev.id);
    expect(info.payload!.viewer_role).toBe('STUDENT');
    const text = JSON.stringify(info.payload);
    expect(text).not.toMatch(/anthropic_api_key|openai_api_key|access_token/);
  });

  it('quizzes: TEACHER is genuinely excluded by the role gate', async () => {
    const denied = await readResource(teacher, `classmoji://${DEV_REF}/quizzes`);
    expect(denied.error?.code).toBe(RESOURCE_FORBIDDEN);
    // Tie the denial to the ROLE gate specifically: the Pro-tier and
    // quizzes_enabled gates also answer -32003, so the code alone would keep
    // passing if TEACHER were ever added to QUIZ_ROLES. INSUFFICIENT_ROLE is
    // only ever attached by the role gate (authz/pure.ts requireRole).
    expect((denied.error?.data as { code?: string } | undefined)?.code).toBe('INSUFFICIENT_ROLE');
    expect(denied.error?.message).toMatch(/Required role/);
  });
});

// ─── S2 — revocation under load, extended to a WRITE tool ───────────────────

describe('S2 revocation on the write path', () => {
  it('a revoked token is rejected on the very next WRITE call', async () => {
    const minted = await mintToken({ login: 'fake-ta' });

    const created = await callTool(minted.access_token, 'calendar_event_create', {
      classroom: DEV_REF,
      title: S4_TITLES.revocationEvent,
      event_type: 'LAB',
      start_time: '2026-07-23T10:00:00-04:00',
      end_time: '2026-07-23T11:00:00-04:00',
    });
    expect(created.isError).toBe(false);
    const eventId = (created.payload.event as { id: string }).id;
    cleanup.add('revocation-test calendar event', () =>
      prisma.calendarEvent.deleteMany({ where: { id: eventId } })
    );

    // Revoke by deleting the token row mid-flight…
    const deleted = await prisma.oauthAccessToken.deleteMany({
      where: { accessToken: minted.access_token },
    });
    expect(deleted.count).toBe(1);

    // …and the SAME token is rejected on the next write immediately.
    const res = await rpcRaw(minted.access_token, 'tools/call', {
      name: 'calendar_event_delete',
      arguments: { classroom: DEV_REF, event_id: eventId },
    });
    expect(res.status).toBe(401);
    // The write must NOT have happened — immediately and after a settle beat.
    expect(await prisma.calendarEvent.count({ where: { id: eventId } })).toBe(1);
    await new Promise(r => setTimeout(r, 750));
    expect(await prisma.calendarEvent.count({ where: { id: eventId } })).toBe(1);
  });
});
