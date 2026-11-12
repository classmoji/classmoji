/**
 * Phase-2 behavior matrix over a real seeded DB:
 *   1. Token economy: grade_add on the GROUP fixture mints GAIN per team
 *      member (emoji extra_tokens), linked to the grade; grade_remove issues
 *      REMOVAL per member and restores balances. Fixture ends ungraded.
 *   2. grades_released is the SOLE visibility gate for students: grades-mine
 *      and the repos resource both honor a flip in both directions.
 *   3. Slug uniqueness: a classroom slug is globally unique (migration
 *      20260818103726), so the database refuses a second classroom with the
 *      dev slug and the composite ref resolves to the dev classroom alone.
 *      (This replaced the same-slug "twin" ambiguity tests, whose fixture the
 *      database can no longer hold.)
 *   4. Quiz prompt stripping: system_prompt/rubric_prompt are visible to the
 *      quiz staff tier and stripped for students.
 *
 * NOTE: HelperService awaits the token rows it writes for a new grade, so they
 * exist when grade_add returns. Token assertions still poll via waitUntil as a
 * read-after-write guard.
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
  getPrisma,
  grantTestPro,
  loadFixtures,
  mintToken,
  readResource,
  RESOURCE_NOT_FOUND,
  startServer,
  DEV_SLUG,
  waitUntil,
  type Fixtures,
  type MintedToken,
  type ServerHandle,
  OWNER_LOGIN,
} from './helpers.ts';

const prisma = getPrisma();
const suiteStart = new Date();
const cleanup = new CleanupStack();

let server: ServerHandle;
let fx: Fixtures;

let ownerMint: MintedToken;
let taMint: MintedToken;
let owner: string;
let ta: string;
let teacher: string;
let student1: string;

const B_TITLES = {
  quiz: 'MCP-Behavior Quiz',
} as const;
/** A throwaway org for the slug test: nothing else lives under it. */
const SLUG_PROBE_ORG = {
  login: 'mcp-behavior-slug-probe',
  provider_id: '80000095',
} as const;

/** Drop the probe org, with any classroom the database let through under it. */
async function removeSlugProbeOrg(): Promise<void> {
  const org = await prisma.gitOrganization.findUnique({
    where: {
      provider_provider_id: { provider: 'GITHUB', provider_id: SLUG_PROBE_ORG.provider_id },
    },
    select: { id: true },
  });
  if (!org) return;
  await prisma.classroom.deleteMany({ where: { git_org_id: org.id } });
  await prisma.gitOrganization.delete({ where: { id: org.id } });
}

const SECRET_SYSTEM = 'MCP-SECRET-SYSTEM-PROMPT';
const SECRET_RUBRIC = 'MCP-SECRET-RUBRIC-PROMPT';

/** Latest per-classroom token balance for a student (the service's own rule:
 * balance == balance_after of the most recent transaction). */
async function balanceOf(studentId: string): Promise<number> {
  const head = await prisma.tokenTransaction.findFirst({
    where: { classroom_id: fx.dev.id, student_id: studentId },
    orderBy: { created_at: 'desc' },
  });
  return head?.balance_after ?? 0;
}

beforeAll(async () => {
  fx = await loadFixtures();

  // Defensive pre-clean (re-runnability even after a crashed earlier run).
  await removeSlugProbeOrg();
  await prisma.quiz.deleteMany({ where: { name: B_TITLES.quiz, classroom_id: fx.dev.id } });
  await prisma.assignmentGrade.deleteMany({
    where: { git_repo_assignment_id: fx.teamGra.id },
  });
  await prisma.tokenTransaction.deleteMany({
    where: { git_repo_assignment_id: fx.teamGra.id },
  });

  server = await startServer();

  const [o, t, a, s1] = await Promise.all([
    mintToken({ login: OWNER_LOGIN }),
    mintToken({ login: 'fake-teacher' }),
    mintToken({ login: 'fake-ta' }),
    mintToken({ login: 'fake-student-1' }),
  ]);
  ownerMint = o;
  taMint = a;
  owner = o.access_token;
  teacher = t.access_token;
  ta = a.access_token;
  student1 = s1.access_token;
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
      await deleteTestNotifications(suiteStart, [fx.dev.id, fx.foreign.id]);
      await deleteMintedTokens();
    } finally {
      await server?.stop();
      await prisma.$disconnect();
    }
  }
}, 120_000);

// ─── 1. Token economy on the GROUP fixture ───────────────────────────────────

describe('token economy (GROUP grading)', () => {
  it('grade_add mints GAIN per team member; grade_remove reverses with REMOVAL', async () => {
    const gra = fx.teamGra.id;
    const s1 = fx.users['fake-student-1'].id;
    const s2 = fx.users['fake-student-2'].id;

    const starMapping = await prisma.emojiMapping.findFirstOrThrow({
      where: { classroom_id: fx.dev.id, emoji: '⭐' },
    });
    const originalExtraTokens = starMapping.extra_tokens;

    // Restore runs even if the test throws mid-way (afterAll cleanup stack).
    cleanup.add('restore ⭐ extra_tokens', () =>
      prisma.emojiMapping.update({
        where: { id: starMapping.id },
        data: { extra_tokens: originalExtraTokens },
      })
    );
    cleanup.add('drop any token transactions on the team fixture', () =>
      prisma.tokenTransaction.deleteMany({ where: { git_repo_assignment_id: gra } })
    );
    cleanup.add('team fixture must end ungraded', () =>
      prisma.assignmentGrade.deleteMany({ where: { git_repo_assignment_id: gra } })
    );

    // OWNER-allow path: set the emoji's token reward through the tool.
    const upsert = await callTool(owner, 'emoji_mapping_upsert', {
      classroom: DEV_REF,
      emoji: '⭐',
      grade: starMapping.grade,
      extra_tokens: 5,
    });
    expect(upsert.isError).toBe(false);
    await expectAuditRow({
      userId: ownerMint.user_id,
      classroomId: fx.dev.id,
      role: 'OWNER',
      resourceType: 'SETTINGS',
      action: 'UPDATE',
      resourceId: starMapping.id,
      tool: 'emoji_mapping_upsert',
      since: suiteStart,
    });

    const baseline1 = await balanceOf(s1);
    const baseline2 = await balanceOf(s2);
    // Timestamp scope for the polls below — a concurrent agent shares this
    // dev DB, so only transactions minted during THIS test may count.
    const mintStart = new Date();

    // Teaching-team grade on the team submission.
    const added = await callTool(ta, 'grade_add', {
      classroom: DEV_REF,
      git_repo_assignment_id: gra,
      emoji: '⭐',
    });
    expect(added.isError).toBe(false);
    const grades = added.payload.grades as Array<{ id: string; emoji: string }>;
    const starGrade = grades.find(g => g.emoji === '⭐');
    expect(starGrade).toBeDefined();

    // HelperService awaits the token rows; poll anyway as a read-after-write guard.
    const gains = await waitUntil(
      async () => {
        const rows = await prisma.tokenTransaction.findMany({
          where: { git_repo_assignment_id: gra, type: 'GAIN', created_at: { gte: mintStart } },
        });
        return rows.length === 2 ? rows : null;
      },
      { label: 'one GAIN per team member' }
    );
    expect(new Set(gains.map(g => g.student_id))).toEqual(new Set([s1, s2]));
    for (const gain of gains) {
      expect(gain.amount).toBe(5);
      expect(gain.classroom_id).toBe(fx.dev.id);
    }
    expect(await balanceOf(s1)).toBe(baseline1 + 5);
    expect(await balanceOf(s2)).toBe(baseline2 + 5);

    // The grade row links a minted transaction (the first one).
    const gradeRow = await waitUntil(
      async () => {
        const row = await prisma.assignmentGrade.findUnique({ where: { id: starGrade!.id } });
        return row?.token_transaction_id ? row : null;
      },
      { label: 'grade linked to its token transaction' }
    );
    expect(gains.map(g => g.id)).toContain(gradeRow.token_transaction_id);

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

    // Remove the grade — REMOVAL per member, balances restored.
    const removed = await callTool(ta, 'grade_remove', {
      classroom: DEV_REF,
      git_repo_assignment_id: gra,
      grade_id: starGrade!.id,
    });
    expect(removed.isError).toBe(false);

    const removals = await waitUntil(
      async () => {
        const rows = await prisma.tokenTransaction.findMany({
          where: { git_repo_assignment_id: gra, type: 'REMOVAL', created_at: { gte: mintStart } },
        });
        return rows.length === 2 ? rows : null;
      },
      { label: 'one REMOVAL per team member' }
    );
    expect(new Set(removals.map(r => r.student_id))).toEqual(new Set([s1, s2]));
    for (const removal of removals) {
      expect(removal.amount).toBe(-5);
    }
    expect(await balanceOf(s1)).toBe(baseline1);
    expect(await balanceOf(s2)).toBe(baseline2);

    // The fixture ends ungraded.
    expect(await prisma.assignmentGrade.count({ where: { git_repo_assignment_id: gra } })).toBe(0);

    await expectAuditRow({
      userId: taMint.user_id,
      classroomId: fx.dev.id,
      role: 'ASSISTANT',
      resourceType: 'GIT_REPO_ASSIGNMENT',
      action: 'DELETE',
      resourceId: gra,
      tool: 'grade_remove',
      since: suiteStart,
    });
  });
});

// ─── 2. grades_released is the sole student visibility gate ─────────────────

describe('grades_released gating (locked decision 7)', () => {
  it('grades-mine and repos both honor a grades_released flip', async () => {
    const assignmentId = fx.releasedAssignment.id;
    const original = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(original.grades_released, 'seed expectation: Hello World Part 1 is released').toBe(true);
    // Restore no matter what (raw prisma flip — the notifying service path is
    // deliberately avoided so restoring cannot spam ASSIGNMENT_GRADED rows).
    cleanup.add('restore grades_released', () =>
      prisma.assignment.update({
        where: { id: assignmentId },
        data: { grades_released: original.grades_released },
      })
    );

    const readState = async () => {
      const gradesMine = await readResource(student1, `classmoji://${DEV_REF}/grades-mine`);
      expect(gradesMine.error).toBeUndefined();
      const feedback = gradesMine.payload!.grades as Array<{ id: string }>;
      const inGradesMine = feedback.some(g => g.id === fx.student1Gra.id);

      const repos = await readResource(student1, `classmoji://${DEV_REF}/repos`);
      expect(repos.error).toBeUndefined();
      const assignments = (repos.payload!.repositories as Array<Record<string, unknown>>).flatMap(
        r => r.assignments as Array<Record<string, unknown>>
      );
      const target = assignments.find(a => a.id === assignmentId);
      expect(target, 'student owns a repo on the released assignment').toBeDefined();
      const submission = target!.my_submission as { grades: unknown[] } | null;
      return {
        inGradesMine,
        releasedFlag: target!.grades_released as boolean,
        grades: submission?.grades ?? [],
      };
    };

    // Released: the seeded 🟢 on student1's submission is visible everywhere.
    const before = await readState();
    expect(before.inGradesMine).toBe(true);
    expect(before.releasedFlag).toBe(true);
    expect(before.grades.length).toBeGreaterThan(0);

    // Flip off → the same submission must vanish from BOTH read surfaces.
    await prisma.assignment.update({
      where: { id: assignmentId },
      data: { grades_released: false },
    });
    const hidden = await readState();
    expect(hidden.inGradesMine).toBe(false);
    expect(hidden.releasedFlag).toBe(false);
    expect(hidden.grades).toHaveLength(0);

    // Flip back on → visible again (both directions honored).
    await prisma.assignment.update({
      where: { id: assignmentId },
      data: { grades_released: true },
    });
    const restored = await readState();
    expect(restored.inGradesMine).toBe(true);
    expect(restored.grades.length).toBeGreaterThan(0);
  });
});

// ─── 3. Slug uniqueness (no same-slug twin can exist) ───────────────────────

describe('slug uniqueness', () => {
  // A different org from the dev classroom's, so only the GLOBAL slug index
  // can refuse the probe (the per-org one cannot).
  let probeOrgId: string;
  beforeAll(async () => {
    const devOrg = await prisma.classroom.findUniqueOrThrow({
      where: { id: fx.dev.id },
      select: { git_org_id: true },
    });
    const probeOrg = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: SLUG_PROBE_ORG.provider_id,
        login: SLUG_PROBE_ORG.login,
      },
    });
    expect(probeOrg.id).not.toBe(devOrg.git_org_id);
    probeOrgId = probeOrg.id;
    cleanup.add('slug probe org (and any classroom the database let through)', () =>
      removeSlugProbeOrg()
    );
  });

  it('refuses a second classroom with the dev slug under another org', async () => {
    await expect(
      prisma.classroom.create({
        data: {
          git_org_id: probeOrgId,
          slug: DEV_SLUG,
          name: 'Slug probe',
          content_namespace: SLUG_PROBE_ORG.login,
          content_repo: `content-${SLUG_PROBE_ORG.login}`,
        },
      })
    ).rejects.toMatchObject({ code: 'P2002', meta: { target: ['slug'] } });
  });

  it('the composite ref resolves to the dev classroom', async () => {
    const devInfo = await readResource(teacher, `classmoji://${DEV_REF}`);
    expect(devInfo.error).toBeUndefined();
    expect(devInfo.payload!.id).toBe(fx.dev.id);
  });

  it('a ref naming another org does not resolve to the dev classroom', async () => {
    const wrongOrg = await readResource(teacher, `classmoji://${SLUG_PROBE_ORG.login}/${DEV_SLUG}`);
    expect(wrongOrg.payload).toBeUndefined();
    expect(wrongOrg.error?.code).toBe(RESOURCE_NOT_FOUND);
    expect(wrongOrg.error?.data).toMatchObject({ kind: 'not_found' });
  });

  it('serves the dev classroom leaderboard without an ambiguity refusal', async () => {
    const outcome = await readResource(owner, `classmoji://${DEV_REF}/leaderboard`);
    expect(outcome.error).toBeUndefined();
    expect(Array.isArray(outcome.payload!.leaderboard)).toBe(true);
  });
});

// ─── 4. Quiz prompt stripping (+ temp PRO subscription) ─────────────────────

describe('quiz prompt stripping', () => {
  it('staff tier (ASSISTANT) sees prompts; students never do', async () => {
    // The quiz Pro gate resolves the classroom OWNER's subscription.
    await grantTestPro(fx.users.owner.id, 'behavior', cleanup);

    const quiz = await prisma.quiz.create({
      data: {
        classroom_id: fx.dev.id,
        name: B_TITLES.quiz,
        status: 'PUBLISHED',
        system_prompt: SECRET_SYSTEM,
        rubric_prompt: SECRET_RUBRIC,
        weight: 0,
      },
    });
    cleanup.add('behavior quiz', () => prisma.quiz.deleteMany({ where: { id: quiz.id } }));

    // Staff tier: prompts present. fake-ta is an unambiguous single-role
    // staff identity.
    const staffView = await readResource(ta, `classmoji://${DEV_REF}/quizzes`);
    expect(staffView.error).toBeUndefined();
    const staffQuiz = (staffView.payload!.quizzes as Array<Record<string, unknown>>).find(
      q => q.id === quiz.id
    );
    expect(staffQuiz).toBeDefined();
    expect(staffQuiz!.system_prompt).toBe(SECRET_SYSTEM);
    expect(staffQuiz!.rubric_prompt).toBe(SECRET_RUBRIC);

    // Student: the quiz is listed (PUBLISHED) but prompts are STRIPPED —
    // not nulled, absent — and the secrets never appear anywhere in the body.
    const studentView = await readResource(student1, `classmoji://${DEV_REF}/quizzes`);
    expect(studentView.error).toBeUndefined();
    const studentQuiz = (studentView.payload!.quizzes as Array<Record<string, unknown>>).find(
      q => q.id === quiz.id
    );
    expect(studentQuiz).toBeDefined();
    expect(studentQuiz).not.toHaveProperty('system_prompt');
    expect(studentQuiz).not.toHaveProperty('rubric_prompt');
    expect(JSON.stringify(studentView.payload)).not.toContain('MCP-SECRET');
  });
});
