/**
 * A student's token ledger against a REAL Postgres, with writers running at
 * the same time.
 *
 * Every ledger writer computes the new row from the latest row's balance, so
 * writes to one student's ledger must happen one after another. A fake Prisma
 * would run every "concurrent" call in turn and agree with whatever the
 * service did; only a real database shows whether two writers can read the
 * same latest row.
 *
 * Checked after each burst:
 *   - the final balance is the starting balance plus the amounts of the
 *     writes that succeeded;
 *   - read in ledger order (created_at, then id), every row's balance_after
 *     is the previous row's balance_after plus its own amount, and created_at
 *     strictly increases.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * afterAll by deleting the git organization (cascades classroom → token
 * transactions) and the student. Nothing is truncated and no pre-existing row
 * is touched.
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database, exactly as
 * assignment.moveToModuleEnd.integration.test.ts does.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import * as tokenService from '../token.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

describe.skipIf(!RUN)('token ledger under concurrent writers (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let orgId: string;
  let classroomId: string;
  const studentIds: string[] = [];

  const makeStudent = async () => {
    const student = await prisma.user.create({
      data: { email: `ledger-${randomUUID().slice(0, 8)}-${suite}@example.test` },
      select: { id: true },
    });
    studentIds.push(student.id);
    return student.id;
  };

  const ledger = (studentId: string) =>
    prisma.tokenTransaction.findMany({
      where: { classroom_id: classroomId, student_id: studentId },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });

  /** Every row chains from the one before it, in ledger order. */
  const expectChained = async (studentId: string) => {
    const rows = await ledger(studentId);
    let balance = 0;
    let previous = 0;
    for (const row of rows) {
      expect(row.created_at.getTime()).toBeGreaterThan(previous);
      expect(row.balance_after).toBe(balance + row.amount);
      balance = row.balance_after;
      previous = row.created_at.getTime();
    }
    expect(await tokenService.getBalance(classroomId, studentId)).toBe(balance);
    return rows;
  };

  const purchase = (studentId: string, cost: number) =>
    tokenService.updateExtension({
      classroom_id: classroomId,
      student_id: studentId,
      amount: -cost,
      hours_purchased: 1,
      type: 'PURCHASE',
      description: 'Purchase of 1 hour(s).',
    });

  const grant = (studentId: string, amount: number, type = 'GAIN') =>
    tokenService.assignToStudent({ classroomId, studentId, amount, type });

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `ledgertest-${suite}`,
        login: `ledgertest-org-${suite}`,
      },
    });
    orgId = org.id;
    const classroom = await prisma.classroom.create({
      data: {
        slug: `ledgertest-${suite}`,
        git_org_id: orgId,
        name: `Ledger Test ${suite}`,
        content_namespace: `ledgertest-${suite}`,
        content_repo: `content-ledgertest-${suite}`,
      },
    });
    classroomId = classroom.id;
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    for (const id of studentIds) {
      await prisma.user.delete({ where: { id } }).catch(() => {});
    }
  });

  it('applies concurrent purchases in order against the latest balance', async () => {
    const studentId = await makeStudent();
    await grant(studentId, 100);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => purchase(studentId, 30))
    );

    const succeeded = results.filter(r => r.status === 'fulfilled');
    const refused = results.filter(r => r.status === 'rejected');
    expect(succeeded).toHaveLength(3);
    for (const r of refused) {
      expect((r as PromiseRejectedResult).reason.message).toContain('Insufficient token balance');
    }
    expect(await tokenService.getBalance(classroomId, studentId)).toBe(100 - 3 * 30);
    const rows = await expectChained(studentId);
    expect(rows).toHaveLength(1 + 3);
  });

  it('keeps grants and removals that race each other in one chain', async () => {
    const studentId = await makeStudent();
    await grant(studentId, 50);

    const amounts = [5, -3, 7, -2, 11, -4, 6, -1, 9, -8];
    await Promise.all(
      amounts.map(amount => grant(studentId, amount, amount < 0 ? 'REMOVAL' : 'GAIN'))
    );

    const total = amounts.reduce((sum, a) => sum + a, 50);
    expect(await tokenService.getBalance(classroomId, studentId)).toBe(total);
    const rows = await expectChained(studentId);
    expect(rows).toHaveLength(1 + amounts.length);
  });

  it('refunds a cancelled purchase from the true balance while other purchases land', async () => {
    const studentId = await makeStudent();
    await grant(studentId, 100);
    const first = await purchase(studentId, 20);
    const second = await purchase(studentId, 20);

    const results = await Promise.allSettled([
      tokenService.cancelPurchase(first.id),
      purchase(studentId, 15),
      tokenService.cancelPurchase(second.id),
      purchase(studentId, 15),
      grant(studentId, 4),
    ]);

    expect(results.every(r => r.status === 'fulfilled')).toBe(true);
    // 100 - 20 - 20 + 20 - 15 + 20 - 15 + 4
    expect(await tokenService.getBalance(classroomId, studentId)).toBe(74);
    const rows = await expectChained(studentId);
    expect(rows.filter(r => r.type === 'REFUND')).toHaveLength(2);
  });

  it('records one refund when the same purchase is cancelled concurrently', async () => {
    const studentId = await makeStudent();
    await grant(studentId, 60);
    const bought = await purchase(studentId, 40);

    const results = await Promise.allSettled([
      tokenService.cancelPurchase(bought.id),
      tokenService.cancelPurchase(bought.id),
      tokenService.cancelPurchase(bought.id),
      purchase(studentId, 10),
    ]);

    const cancels = results.slice(0, 3);
    expect(cancels.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results[3].status).toBe('fulfilled');
    expect(await tokenService.getBalance(classroomId, studentId)).toBe(60 - 40 + 40 - 10);
    const rows = await expectChained(studentId);
    expect(rows.filter(r => r.type === 'REFUND')).toHaveLength(1);
  });

  it("keeps two students' ledgers separate under concurrent writes", async () => {
    const a = await makeStudent();
    const b = await makeStudent();
    await Promise.all([grant(a, 10), grant(b, 20)]);

    await Promise.all([grant(a, 1), grant(b, 2), grant(a, 3), grant(b, 4)]);

    expect(await tokenService.getBalance(classroomId, a)).toBe(14);
    expect(await tokenService.getBalance(classroomId, b)).toBe(26);
    await expectChained(a);
    await expectChained(b);
  });
});
