/**
 * A classroom deletion against a REAL Postgres: the classroom's audit rows go
 * with it (the foreign key cascades), and one `platform_audit_logs` row
 * records the deletion — the owner's delete (`classroom.deleteById`) and the
 * daily sandbox sweep (`deleteAbandonedExampleClassrooms`). A failure writing
 * that row never fails the delete; it logs `audit_miss`.
 *
 * SAFETY: fixtures are namespaced with a fresh uuid and torn down in afterAll
 * (deleting the git organization cascades its classrooms; platform rows have
 * no foreign key, so the ones written here are deleted by id). The sweep is
 * run with a `now` in the year 2000 and fixtures back-dated before it, so
 * only this suite's sandboxes are old enough. Skipped unless DATABASE_URL
 * names a LOCAL, non-shared database, like the other integration tests here.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import * as classroomService from '../classroom.service.ts';
import { deleteAbandonedExampleClassrooms } from '../exampleClassroom.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

describe.skipIf(!RUN)('classroom deletion record (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const platformRowIds: string[] = [];
  let orgId: string;
  let orgLogin: string;
  let owner: { id: string; email: string | null };
  let student: { id: string; email: string | null };

  const makeClassroom = async (label: string, extra: Record<string, unknown> = {}) =>
    prisma.classroom.create({
      data: {
        slug: `del-${label}-${suite}`,
        git_org_id: orgId,
        name: `Delete ${label} ${suite}`,
        content_namespace: `del-${label}-${suite}`,
        content_repo: `content-del-${label}-${suite}`,
        ...extra,
      },
      select: { id: true, slug: true, name: true },
    });

  const makeUser = async (label: string) =>
    prisma.user.create({
      data: { email: `del-${suite}-${label}@example.test`, name: `Delete ${label}` },
      select: { id: true, email: true },
    });

  const auditRows = (classroomId: string, n: number, userId: string) =>
    prisma.auditLog.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        user_id: userId,
        classroom_id: classroomId,
        role: 'OWNER' as const,
        action: 'UPDATE' as const,
        resource_type: 'TEST',
        resource_id: `r-${i}`,
      })),
    });

  /** The platform rows this suite's classrooms left, remembered for teardown. */
  const platformRowsFor = async (where: Record<string, unknown>) => {
    const rows = await prisma.platformAuditLog.findMany({ where, orderBy: { created_at: 'asc' } });
    platformRowIds.push(...rows.map(r => r.id));
    return rows;
  };

  beforeAll(async () => {
    orgLogin = `del-${suite}`;
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `del-${suite}`, login: orgLogin },
    });
    orgId = org.id;
    owner = await makeUser('owner');
    student = await makeUser('student');
  });

  afterAll(async () => {
    if (platformRowIds.length > 0) {
      await prisma.platformAuditLog
        .deleteMany({ where: { id: { in: platformRowIds } } })
        .catch(() => {});
    }
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user
      .deleteMany({ where: { id: { in: [owner?.id, student?.id].filter(Boolean) } } })
      .catch(() => {});
  });

  describe("an owner's delete (classroom.deleteById)", () => {
    it('removes its audit rows and leaves exactly one classroom.delete row, for it alone', async () => {
      const x = await makeClassroom('x');
      const y = await makeClassroom('y');
      await prisma.classroomMembership.createMany({
        data: [
          { classroom_id: x.id, user_id: owner.id, role: 'OWNER', has_accepted_invite: true },
          { classroom_id: x.id, user_id: student.id, role: 'STUDENT', has_accepted_invite: true },
          { classroom_id: y.id, user_id: owner.id, role: 'OWNER', has_accepted_invite: true },
        ],
      });
      const module = await prisma.module.create({
        data: { classroom_id: x.id, title: `Module ${suite}` },
      });
      const repository = await prisma.repository.create({
        data: {
          classroom_id: x.id,
          title: `repo-${suite}`,
          type: 'INDIVIDUAL',
          template: `template-${suite}`,
        },
      });
      await prisma.assignment.create({
        data: {
          module_id: module.id,
          type: 'REPO',
          title: `Assignment ${suite}`,
          repository_id: repository.id,
        },
      });
      await auditRows(x.id, 3, student.id);
      await auditRows(y.id, 2, owner.id);

      const deleted = await classroomService.deleteById(x.id, { actorId: owner.id });

      expect(deleted.id).toBe(x.id);
      expect(await prisma.classroom.findUnique({ where: { id: x.id } })).toBeNull();
      expect(await prisma.auditLog.count({ where: { classroom_id: x.id } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { classroom_id: y.id } })).toBe(2);

      const rows = await platformRowsFor({ target_id: x.id });
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toMatchObject({
        actor_id: owner.id,
        action: 'classroom.delete',
        target_type: 'classroom',
        target_id: x.id,
        classroom_id: x.id,
      });
      expect(row.data).toEqual({
        slug: x.slug,
        name: x.name,
        git_organization: orgLogin,
        provider: 'GITHUB',
        counts: { audit_rows: 3, members: 2, assignments: 1 },
      });
      // Nothing about the people in it: no student id or email.
      const stored = JSON.stringify(row.data);
      expect(stored).not.toContain(student.id);
      expect(stored).not.toContain(student.email!);

      // Classroom Y is untouched and has no record.
      expect(await prisma.classroom.findUnique({ where: { id: y.id } })).not.toBeNull();
      expect(await platformRowsFor({ OR: [{ target_id: y.id }, { classroom_id: y.id }] })).toEqual(
        []
      );
    });

    it("marks a create's rollback with its reason", async () => {
      const z = await makeClassroom('rollback');

      await classroomService.deleteById(z.id, { actorId: owner.id, reason: 'create_rollback' });

      const rows = await platformRowsFor({ target_id: z.id });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor_id: owner.id, action: 'classroom.delete' });
      expect(rows[0].data).toEqual({
        slug: z.slug,
        name: z.name,
        git_organization: orgLogin,
        provider: 'GITHUB',
        counts: { audit_rows: 0, members: 0, assignments: 0 },
        reason: 'create_rollback',
      });
    });

    it('still deletes, and logs audit_miss, when the record cannot be written', async () => {
      const w = await makeClassroom('miss');
      await auditRows(w.id, 1, owner.id);
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      // No such user: the actor's foreign key refuses the platform row.
      const ghost = randomUUID();

      try {
        await expect(classroomService.deleteById(w.id, { actorId: ghost })).resolves.toMatchObject({
          id: w.id,
        });

        expect(await prisma.classroom.findUnique({ where: { id: w.id } })).toBeNull();
        expect(await prisma.auditLog.count({ where: { classroom_id: w.id } })).toBe(0);
        expect(await platformRowsFor({ target_id: w.id })).toEqual([]);
        const misses = logged.mock.calls.filter(call => call[0] === 'audit_miss');
        expect(misses).toHaveLength(1);
        const line = JSON.parse(String(misses[0][1]));
        expect(line.reason).toMatch(/^platform audit write failed/);
        expect(line.row).toMatchObject({
          actor_id: ghost,
          action: 'classroom.delete',
          target_id: w.id,
          data: { slug: w.slug, counts: { audit_rows: 1, members: 0, assignments: 0 } },
        });
      } finally {
        logged.mockRestore();
      }
    });
  });

  describe('the sandbox sweep (deleteAbandonedExampleClassrooms)', () => {
    const LONG_AGO = new Date('2000-01-01T00:00:00Z');
    const SWEEP_AT = new Date('2000-01-10T00:00:00Z');

    const sweepRowsSince = (since: Date) =>
      platformRowsFor({ action: 'classroom.delete_sandboxes', created_at: { gte: since } });

    it('writes one row with how many sandboxes and audit rows went', async () => {
      const a = await makeClassroom('sandbox-a', { is_example: true, created_at: LONG_AGO });
      const b = await makeClassroom('sandbox-b', { is_example: true, created_at: LONG_AGO });
      await auditRows(a.id, 2, owner.id);
      await auditRows(b.id, 3, owner.id);
      const since = new Date();

      const report = await deleteAbandonedExampleClassrooms({ now: SWEEP_AT });

      expect(report).toEqual({ candidates: 2, deleted: 2, kept: 0 });
      expect(await prisma.classroom.count({ where: { id: { in: [a.id, b.id] } } })).toBe(0);
      expect(await prisma.auditLog.count({ where: { classroom_id: { in: [a.id, b.id] } } })).toBe(
        0
      );
      const rows = await sweepRowsSince(since);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_id: null,
        action: 'classroom.delete_sandboxes',
        target_type: 'classrooms',
        target_id: null,
        classroom_id: null,
      });
      expect(rows[0].data).toEqual({ classrooms: 2, audit_rows: 5 });
    });

    it('writes no row when nothing is old enough to delete', async () => {
      const c = await makeClassroom('sandbox-c', { is_example: true, created_at: LONG_AGO });
      const since = new Date();

      // A sweep "run" before the sandbox existed: nothing is past the cutoff.
      const report = await deleteAbandonedExampleClassrooms({
        now: new Date('1999-01-01T00:00:00Z'),
      });

      expect(report).toEqual({ candidates: 0, deleted: 0, kept: 0 });
      expect(await prisma.classroom.findUnique({ where: { id: c.id } })).not.toBeNull();
      expect(await sweepRowsSince(since)).toEqual([]);
    });
  });
});
