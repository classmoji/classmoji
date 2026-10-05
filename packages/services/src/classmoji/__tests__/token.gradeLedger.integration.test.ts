/**
 * Grades and their token rows against a REAL Postgres.
 *
 * A grade that pays tokens is one database transaction: adding it writes the
 * grade, a GAIN row per recipient and the grade's link to its reward; removing
 * it deletes the grade and writes a REMOVAL row per recipient; replacing a
 * numeric score and clearing grades for an open regrade request do both. A
 * fake Prisma runs every step in turn and cannot show what another request
 * sees between them, or what is left behind when one step fails; only a real
 * database can.
 *
 * Checked throughout:
 *   - a failed step leaves the grade and the ledgers as they were;
 *   - every reward is reversed exactly once, so each balance returns to where
 *     it started when the grades are removed;
 *   - read in ledger order, every row's balance_after is the previous row's
 *     balance_after plus its own amount.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * afterAll by deleting the git organization (cascades classroom → repos,
 * grades, token transactions) and the users. Nothing is truncated and no
 * pre-existing row is touched.
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database, exactly as
 * token.ledgerOrder.integration.test.ts does.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';

// A switch to make chosen ledger writes fail, so a test can stop a grade
// operation part-way through. Everything else goes to the real service.
// Every attempted ledger write is recorded, in order, before the switch is
// checked.
const ledgerHook = vi.hoisted(() => ({
  failWhen: null as
    | null
    | ((data: { studentId: string; type?: unknown; amount: number }) => boolean),
  calls: [] as Array<{ studentId: string; type?: unknown; amount: number }>,
}));

vi.mock('../token.service.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../token.service.ts')>();
  return {
    ...actual,
    assignToStudent: async (...args: Parameters<typeof actual.assignToStudent>) => {
      const { studentId, type, amount } = args[0];
      ledgerHook.calls.push({ studentId, type, amount });
      if (ledgerHook.failWhen?.(args[0])) throw new Error('ledger write failed (test)');
      return actual.assignToStudent(...args);
    },
  };
});

const tokenService = await import('../token.service.ts');
const { default: HelperService } = await import('../../helper/index.ts');

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const START = 100;

describe.skipIf(!RUN)('grade changes and the token ledger (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let orgId: string;
  let classroomId: string;
  let moduleId: string;
  let graderId: string;
  const userIds: string[] = [];
  let serial = 0;

  const classroom = () => ({ id: classroomId });

  const makeUser = async () => {
    const user = await prisma.user.create({
      data: { email: `gradeledger-${randomUUID().slice(0, 8)}-${suite}@example.test` },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  };

  /** A student with START tokens. */
  const makeStudent = async () => {
    const id = await makeUser();
    await tokenService.assignToStudent({ classroomId, studentId: id, amount: START });
    return id;
  };

  const makeTeam = async (size: number) => {
    const members = await Promise.all(Array.from({ length: size }, () => makeStudent()));
    const n = ++serial;
    const team = await prisma.team.create({
      data: {
        classroom_id: classroomId,
        name: `Team ${n} ${suite}`,
        slug: `team-${n}-${suite}`,
        memberships: { create: members.map(user_id => ({ user_id })) },
      },
      select: { id: true },
    });
    return { teamId: team.id, members };
  };

  /** A submission on a fresh repo owned by one student or by a team. */
  const makeSubmission = async (owner: { studentId?: string; teamId?: string }) => {
    const n = ++serial;
    const repository = await prisma.repository.create({
      data: {
        classroom_id: classroomId,
        title: `lab-${n}-${suite}`,
        template: 'org/template',
        type: owner.teamId ? 'GROUP' : 'INDIVIDUAL',
      },
      select: { id: true },
    });
    const assignment = await prisma.assignment.create({
      data: {
        module_id: moduleId,
        type: 'REPO',
        repository_id: repository.id,
        title: `Lab ${n}`,
      },
      select: { id: true },
    });
    const gitRepo = await prisma.gitRepo.create({
      data: {
        provider: 'GITHUB',
        provider_id: `gradeledger-${n}-${suite}`,
        name: `lab-${n}-${suite}`,
        classroom_id: classroomId,
        repository_id: repository.id,
        student_id: owner.studentId ?? null,
        team_id: owner.teamId ?? null,
      },
      select: { id: true },
    });
    const submission = await prisma.gitRepoAssignment.create({
      data: { provider: 'GITHUB', git_repo_id: gitRepo.id, assignment_id: assignment.id },
      select: { id: true },
    });
    return submission.id;
  };

  /** The payloads the web route and the MCP tools send. */
  const add = (
    gitRepoAssignmentId: string,
    grade: string,
    owner: { studentId?: string; teamId?: string } = {}
  ) =>
    HelperService.addGradeToGitRepoAssignment({
      classroom: classroom(),
      gitRepoAssignment: { id: gitRepoAssignmentId },
      graderId,
      grade,
      ...owner,
    });

  const remove = async (
    gitRepoAssignmentId: string,
    gradeId: string,
    owner: { studentId?: string; teamId?: string } = {}
  ) => {
    const grade = await prisma.assignmentGrade.findUniqueOrThrow({
      where: { id: gradeId },
      include: { token_transaction: true },
    });
    return HelperService.removeGradeFromGitRepoAssignment({
      classroom: classroom(),
      gitRepoAssignment: { id: gitRepoAssignmentId, ...owner },
      grade,
    });
  };

  const grades = (gitRepoAssignmentId: string) =>
    prisma.assignmentGrade.findMany({
      where: { git_repo_assignment_id: gitRepoAssignmentId },
      orderBy: { created_at: 'asc' },
    });

  const rowsOf = (studentId: string, gitRepoAssignmentId: string) =>
    prisma.tokenTransaction.findMany({
      where: {
        classroom_id: classroomId,
        student_id: studentId,
        git_repo_assignment_id: gitRepoAssignmentId,
      },
    });

  /** Every row chains from the one before it, in ledger order; returns the balance. */
  const expectChained = async (studentId: string) => {
    const rows = await prisma.tokenTransaction.findMany({
      where: { classroom_id: classroomId, student_id: studentId },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    let balance = 0;
    for (const row of rows) {
      expect(row.balance_after).toBe(balance + row.amount);
      balance = row.balance_after;
    }
    expect(await tokenService.getBalance(classroomId, studentId)).toBe(balance);
    return balance;
  };

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `gradeledger-${suite}`,
        login: `gradeledger-org-${suite}`,
      },
    });
    orgId = org.id;
    const created = await prisma.classroom.create({
      data: {
        slug: `gradeledger-${suite}`,
        git_org_id: orgId,
        name: `Grade Ledger Test ${suite}`,
        content_namespace: `gradeledger-${suite}`,
        content_repo: `content-gradeledger-${suite}`,
      },
    });
    classroomId = created.id;
    moduleId = (
      await prisma.module.create({
        data: { classroom_id: classroomId, title: `Module ${suite}` },
        select: { id: true },
      })
    ).id;
    await prisma.emojiMapping.createMany({
      data: [
        { classroom_id: classroomId, emoji: '⭐', grade: 100, extra_tokens: 5 },
        { classroom_id: classroomId, emoji: '👍', grade: 80, extra_tokens: 0 },
        { classroom_id: classroomId, emoji: 'score-80', grade: 80, extra_tokens: 2 },
        { classroom_id: classroomId, emoji: 'score-90', grade: 90, extra_tokens: 3 },
      ],
    });
    graderId = await makeUser();
  });

  afterEach(() => {
    ledgerHook.failWhen = null;
    ledgerHook.calls = [];
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    for (const id of userIds) {
      await prisma.user.delete({ where: { id } }).catch(() => {});
    }
  });

  it('keeps the grade and writes no REMOVAL rows when a removal fails part-way', async () => {
    const { teamId, members } = await makeTeam(3);
    const submission = await makeSubmission({ teamId });
    await add(submission, '⭐', { teamId });
    const [grade] = await grades(submission);
    expect(grade.token_transaction_id).not.toBeNull();

    // The second member's reversal fails, after the first one was written.
    const sorted = [...members].sort();
    ledgerHook.calls = [];
    ledgerHook.failWhen = data => data.type === 'REMOVAL' && data.studentId === sorted[1];
    await expect(remove(submission, grade.id, { teamId })).rejects.toThrow(
      'ledger write failed (test)'
    );
    // The first member's REMOVAL row was written before the second one
    // failed, so the checks below show a written row rolled back.
    expect(ledgerHook.calls.map(c => [c.type, c.studentId, c.amount])).toEqual([
      ['REMOVAL', sorted[0], -5],
      ['REMOVAL', sorted[1], -5],
    ]);

    const after = await grades(submission);
    expect(after.map(g => [g.id, g.token_transaction_id])).toEqual([
      [grade.id, grade.token_transaction_id],
    ]);
    for (const member of members) {
      const rows = await rowsOf(member, submission);
      expect(rows.filter(r => r.type === 'REMOVAL')).toHaveLength(0);
      expect(await expectChained(member)).toBe(START + 5);
    }

    // Nothing was lost, so trying again completes the removal.
    ledgerHook.failWhen = null;
    expect(await remove(submission, grade.id, { teamId })).toBe(true);
    expect(await grades(submission)).toHaveLength(0);
    for (const member of members) {
      expect(await expectChained(member)).toBe(START);
    }
  });

  it('reverses a grade once when it is removed twice at the same time', async () => {
    const { teamId, members } = await makeTeam(2);
    const submission = await makeSubmission({ teamId });
    await add(submission, '⭐', { teamId });
    const [grade] = await grades(submission);
    const loaded = await prisma.assignmentGrade.findUniqueOrThrow({
      where: { id: grade.id },
      include: { token_transaction: true },
    });

    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        HelperService.removeGradeFromGitRepoAssignment({
          classroom: classroom(),
          gitRepoAssignment: { id: submission, teamId },
          grade: loaded,
        })
      )
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await grades(submission)).toHaveLength(0);
    for (const member of members) {
      const rows = await rowsOf(member, submission);
      expect(rows.filter(r => r.type === 'REMOVAL')).toHaveLength(1);
      expect(await expectChained(member)).toBe(START);
    }
  });

  it("returns every team member's balance to the start after add then remove", async () => {
    const { teamId, members } = await makeTeam(3);
    const submission = await makeSubmission({ teamId });

    await add(submission, '⭐', { teamId });
    await add(submission, '👍', { teamId });
    for (const member of members) {
      expect(await expectChained(member)).toBe(START + 5);
      const gains = (await rowsOf(member, submission)).filter(r => r.type === 'GAIN');
      expect(gains.map(r => [r.amount, r.description])).toEqual([[5, 'Tokens for getting a ⭐.']]);
    }

    for (const grade of await grades(submission)) {
      await remove(submission, grade.id, { teamId });
    }
    for (const member of members) {
      const rows = await rowsOf(member, submission);
      expect(rows.filter(r => r.type === 'REMOVAL').map(r => [r.amount, r.description])).toEqual([
        [-5, 'Removing ⭐.'],
      ]);
      expect(await expectChained(member)).toBe(START);
    }
  });

  it('keeps the old score and its reward when the new score cannot be paid', async () => {
    const studentId = await makeStudent();
    const submission = await makeSubmission({ studentId });
    await add(submission, 'score-80', { studentId });
    const [old] = await grades(submission);
    expect(await expectChained(studentId)).toBe(START + 2);

    ledgerHook.failWhen = data => data.type === undefined && data.amount === 3;
    await expect(add(submission, 'score-90', { studentId })).rejects.toThrow(
      'ledger write failed (test)'
    );

    const after = await grades(submission);
    expect(after.map(g => [g.id, g.emoji, g.token_transaction_id])).toEqual([
      [old.id, 'score-80', old.token_transaction_id],
    ]);
    expect((await rowsOf(studentId, submission)).filter(r => r.type === 'REMOVAL')).toHaveLength(0);
    expect(await expectChained(studentId)).toBe(START + 2);

    // Trying again replaces the score once: one reversal, one new reward.
    ledgerHook.failWhen = null;
    await add(submission, 'score-90', { studentId });
    expect((await grades(submission)).map(g => g.emoji)).toEqual(['score-90']);
    const rows = await rowsOf(studentId, submission);
    expect(rows.filter(r => r.type === 'REMOVAL').map(r => r.amount)).toEqual([-2]);
    expect(await expectChained(studentId)).toBe(START + 3);
  });

  it('reverses a paid grade cleared for an open regrade request and pays the new grade once', async () => {
    const studentId = await makeStudent();
    const submission = await makeSubmission({ studentId });
    await add(submission, '⭐', { studentId });
    const [old] = await grades(submission);
    expect(await expectChained(studentId)).toBe(START + 5);

    // The grade predates the request.
    const now = Date.now();
    await prisma.assignmentGrade.update({
      where: { id: old.id },
      data: { created_at: new Date(now - 60_000) },
    });
    await prisma.regradeRequest.create({
      data: {
        git_repo_assignment_id: submission,
        classroom_id: classroomId,
        student_id: studentId,
        previous_grade: ['⭐'],
        created_at: new Date(now - 30_000),
      },
    });

    await add(submission, '⭐', { studentId });

    const after = await grades(submission);
    expect(after).toHaveLength(1);
    expect(after[0].id).not.toBe(old.id);
    expect(after[0].token_transaction_id).not.toBeNull();
    const rows = await rowsOf(studentId, submission);
    expect(rows.filter(r => r.type === 'REMOVAL').map(r => [r.amount, r.description])).toEqual([
      [-5, 'Removing ⭐.'],
    ]);
    expect(rows.filter(r => r.type === 'GAIN')).toHaveLength(2);
    expect(await expectChained(studentId)).toBe(START + 5);
  });

  it('replaces a score cleared for an open regrade request when the grader gives the same score', async () => {
    const studentId = await makeStudent();
    const submission = await makeSubmission({ studentId });
    await add(submission, 'score-80', { studentId });
    const [old] = await grades(submission);
    expect(await expectChained(studentId)).toBe(START + 2);

    const now = Date.now();
    await prisma.assignmentGrade.update({
      where: { id: old.id },
      data: { created_at: new Date(now - 60_000) },
    });
    await prisma.regradeRequest.create({
      data: {
        git_repo_assignment_id: submission,
        classroom_id: classroomId,
        student_id: studentId,
        previous_grade: ['score-80'],
        created_at: new Date(now - 30_000),
      },
    });

    // The same score again: the stale grade is cleared inside the transaction,
    // so the grader's earlier score is no longer there and a new grade is
    // written.
    await add(submission, 'score-80', { studentId });

    const after = await grades(submission);
    expect(after.map(g => g.emoji)).toEqual(['score-80']);
    expect(after[0].id).not.toBe(old.id);
    expect(after[0].token_transaction_id).not.toBeNull();
    const rows = await rowsOf(studentId, submission);
    expect(rows.filter(r => r.type === 'REMOVAL').map(r => r.amount)).toEqual([-2]);
    expect(rows.filter(r => r.type === 'GAIN')).toHaveLength(2);
    expect(await expectChained(studentId)).toBe(START + 2);
  });

  it('adds and removes a paying grade on submissions that pay nobody', async () => {
    const { teamId: emptyTeam } = await makeTeam(0);
    const teamSubmission = await makeSubmission({ teamId: emptyTeam });
    const ownerless = await makeSubmission({});

    for (const submission of [teamSubmission, ownerless]) {
      await add(submission, '⭐');
      const [grade] = await grades(submission);
      expect(grade.emoji).toBe('⭐');
      expect(grade.token_transaction_id).toBeNull();

      expect(await remove(submission, grade.id)).toBe(true);
      expect(await grades(submission)).toHaveLength(0);
      expect(
        await prisma.tokenTransaction.count({ where: { git_repo_assignment_id: submission } })
      ).toBe(0);
    }
  });

  it('writes one grade when the same score is given twice at once on a submission that pays nobody', async () => {
    for (let round = 0; round < 5; round++) {
      const submission = await makeSubmission({});

      await Promise.all([add(submission, 'score-90'), add(submission, 'score-90')]);

      expect((await grades(submission)).map(g => g.emoji)).toEqual(['score-90']);
    }
  });

  it('writes one grade and one reward per member when the same emoji is given twice at once', async () => {
    const { teamId, members } = await makeTeam(2);
    const submission = await makeSubmission({ teamId });

    await Promise.all([add(submission, '⭐'), add(submission, '⭐')]);

    expect((await grades(submission)).map(g => g.emoji)).toEqual(['⭐']);
    for (const member of members) {
      const rows = await rowsOf(member, submission);
      expect(rows.filter(r => r.type === 'GAIN')).toHaveLength(1);
      expect(await expectChained(member)).toBe(START + 5);
    }
  });

  it('leaves no unreversed reward when a removal races the add', async () => {
    for (let round = 0; round < 5; round++) {
      const { teamId, members } = await makeTeam(3);
      const submission = await makeSubmission({ teamId });

      let added = false;
      const adding = add(submission, '⭐', { teamId }).finally(() => {
        added = true;
      });
      // Remove the grade the moment it can be seen, while the add may still
      // be running.
      let removing: Promise<unknown> | undefined;
      for (;;) {
        const wasAdded = added;
        const seen = await prisma.assignmentGrade.findFirst({
          where: { git_repo_assignment_id: submission },
          select: { id: true },
        });
        if (seen) {
          removing = remove(submission, seen.id, { teamId });
          break;
        }
        if (wasAdded) break;
      }
      await adding;
      await (removing ?? remove(submission, (await grades(submission))[0].id, { teamId }));

      expect(await grades(submission)).toHaveLength(0);
      for (const member of members) {
        const rows = await rowsOf(member, submission);
        expect(rows.filter(r => r.type === 'GAIN')).toHaveLength(1);
        expect(rows.filter(r => r.type === 'REMOVAL')).toHaveLength(1);
        expect(await expectChained(member)).toBe(START);
      }
    }
  });
});
