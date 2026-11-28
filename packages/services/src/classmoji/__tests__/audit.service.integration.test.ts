/**
 * The audit writer against a REAL Postgres: every change is a row, a
 * repeated read is counted on the row it repeats, and the merge rule (newest
 * row for the user and resource, same action, role and data, first written
 * under 5 s ago) decides which. Also the CHECK constraint on `role`.
 *
 * SAFETY: fixtures are namespaced with a fresh uuid and torn down in afterAll
 * (deleting the classrooms cascades their audit rows). Skipped unless
 * DATABASE_URL names a LOCAL, non-shared database, like the other
 * integration tests here.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import * as audit from '../audit.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

describe.skipIf(!RUN)('audit writer (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let orgId: string;
  let classX: string;
  let classY: string;
  let userA: string;
  let userB: string;
  let resource: string;

  const makeClassroom = async (label: string) =>
    (
      await prisma.classroom.create({
        data: {
          slug: `audit-${label}-${suite}`,
          git_org_id: orgId,
          name: `Audit ${label} ${suite}`,
          content_namespace: `audit-${label}-${suite}`,
          content_repo: `content-audit-${label}-${suite}`,
        },
      })
    ).id;

  const makeUser = async (label: string) =>
    (
      await prisma.user.create({
        data: { email: `audit-${suite}-${label}@example.test`, name: `Audit ${label}` },
      })
    ).id;

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `audit-${suite}`, login: `audit-${suite}` },
    });
    orgId = org.id;
    classX = await makeClassroom('x');
    classY = await makeClassroom('y');
    userA = await makeUser('a');
    userB = await makeUser('b');
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } }).catch(() => {});
  });

  beforeEach(() => {
    resource = randomUUID(); // a fresh resource per test: no row leaks between tests
  });

  const row = (over: Partial<Parameters<typeof audit.create>[0]> = {}) => ({
    user_id: userA,
    classroom_id: classX,
    role: 'TEACHER' as string | null,
    resource_type: 'PAGES',
    resource_id: resource as string | null,
    action: 'VIEW' as Parameters<typeof audit.create>[0]['action'],
    data: { tool: 'test.read' } as Parameters<typeof audit.create>[0]['data'],
    ...over,
  });

  const rowsFor = (where: Record<string, unknown> = {}) =>
    prisma.auditLog.findMany({
      where: { classroom_id: { in: [classX, classY] }, resource_id: resource, ...where },
      orderBy: { timestamp: 'asc' },
    });

  /**
   * One write, then a pause so the next row's timestamp is later: rows that
   * share a millisecond have no order, and the writer inserts rather than
   * guess which is the newest (covered on its own below).
   */
  const write = async (entry: Parameters<typeof audit.create>[0]) => {
    const result = await audit.create(entry);
    await new Promise(resolve => setTimeout(resolve, 3));
    return result;
  };

  /** Move a row's first occurrence back by `ms`, leaving updated_at fresh. */
  const age = (id: string, ms: number) =>
    prisma.auditLog.update({
      where: { id },
      data: { timestamp: new Date(Date.now() - ms), updated_at: new Date() },
    });

  describe('changes', () => {
    it.each(['CREATE', 'UPDATE', 'DELETE', 'COLLAB_CHECKPOINT'] as const)(
      'N identical %s calls give N rows, each with count 1',
      async action => {
        for (let i = 0; i < 4; i++) await write(row({ action }));
        const rows = await rowsFor();
        expect(rows).toHaveLength(4);
        expect(rows.every(r => r.count === 1 && r.action === action)).toBe(true);
      }
    );

    it('X, Y, X gives three rows', async () => {
      for (const value of ['public', 'draft', 'public']) {
        await write(row({ action: 'UPDATE', data: { tool: 'web:pages.status', value } }));
      }
      const rows = await rowsFor();
      expect(rows.map(r => (r.data as { value: string }).value)).toEqual([
        'public',
        'draft',
        'public',
      ]);
    });
  });

  describe('repeated reads', () => {
    it('the same VIEW N times is one row with count N', async () => {
      for (let i = 0; i < 5; i++) await write(row());
      const rows = await rowsFor();
      expect(rows).toHaveLength(1);
      expect(rows[0].count).toBe(5);
      expect(rows[0].updated_at.getTime()).toBeGreaterThan(rows[0].timestamp.getTime());
    });

    it('data compares deeply and ignores key order', async () => {
      await write(row({ data: { tool: 't', ids: { a: 1, b: [1, 2] } } }));
      await write(row({ data: { ids: { b: [1, 2], a: 1 }, tool: 't' } }));
      await write(row({ data: { tool: 't', ids: { a: 1, b: [2, 1] } } }));
      const rows = await rowsFor();
      expect(rows.map(r => r.count)).toEqual([2, 1]);
    });

    it('the window is anchored to the first occurrence, not the last merge', async () => {
      await write(row());
      const [first] = await rowsFor();

      await age(first.id, 4_000);
      await write(row());
      expect((await rowsFor()).map(r => r.count)).toEqual([2]);

      // Merged a moment ago (updated_at fresh), but first written 6 s ago.
      await age(first.id, 6_000);
      await write(row());
      const rows = await rowsFor();
      expect(rows.map(r => r.count)).toEqual([2, 1]);
    });

    it('a poller repeating one read gets a new row every window', async () => {
      for (let window = 0; window < 3; window++) {
        await write(row());
        await write(row());
        const rows = await rowsFor();
        await age(rows[rows.length - 1].id, 6_000);
      }
      expect((await rowsFor()).map(r => r.count)).toEqual([2, 2, 2]);
    });

    it('A, B, A is three rows: only the newest row can take a repeat', async () => {
      await write(row({ data: { tool: 'a' } }));
      await write(row({ data: { tool: 'b' } }));
      await write(row({ data: { tool: 'a' } }));
      const rows = await rowsFor();
      expect(rows.map(r => [(r.data as { tool: string }).tool, r.count])).toEqual([
        ['a', 1],
        ['b', 1],
        ['a', 1],
      ]);
    });

    it('a change in between ends the run: VIEW, UPDATE, VIEW is three rows', async () => {
      await write(row());
      await write(row({ action: 'UPDATE' }));
      await write(row());
      expect((await rowsFor()).map(r => r.action)).toEqual(['VIEW', 'UPDATE', 'VIEW']);
    });

    it('JOIN, LEAVE, JOIN is three rows; JOIN, JOIN is one', async () => {
      for (const action of ['COLLAB_JOIN', 'COLLAB_LEAVE', 'COLLAB_JOIN'] as const) {
        await write(row({ action, data: undefined }));
      }
      expect((await rowsFor()).map(r => [r.action, r.count])).toEqual([
        ['COLLAB_JOIN', 1],
        ['COLLAB_LEAVE', 1],
        ['COLLAB_JOIN', 1],
      ]);
      await write(row({ action: 'COLLAB_JOIN', data: undefined }));
      expect((await rowsFor()).map(r => r.count)).toEqual([1, 1, 2]);
    });

    it('missing data, null data and JSON null are the same; {} is not', async () => {
      await write(row({ data: undefined }));
      await write(row({ data: null }));
      await write(row({ data: undefined }));
      expect((await rowsFor()).map(r => r.count)).toEqual([3]);

      await write(row({ data: {} }));
      await write(row({ data: {} }));
      await write(row({ data: null }));
      expect((await rowsFor()).map(r => r.count)).toEqual([3, 2, 1]);
    });

    it('a null resource_id matches only null', async () => {
      const typed = `AUDIT_NULL_${suite}_${randomUUID().slice(0, 4)}`;
      const nullRows = () =>
        prisma.auditLog.findMany({ where: { classroom_id: classX, resource_type: typed } });
      await write(row({ resource_type: typed, resource_id: null }));
      await write(row({ resource_type: typed, resource_id: null }));
      await write(row({ resource_type: typed, resource_id: 'x' }));
      const rows = await nullRows();
      expect(rows.find(r => r.resource_id === null)?.count).toBe(2);
      expect(rows.find(r => r.resource_id === 'x')?.count).toBe(1);
      expect(rows).toHaveLength(2);
    });

    it('an impersonated read and the person’s own never merge, in either order', async () => {
      const own = { tool: 'test.read' };
      const asAdmin = { tool: 'test.read', impersonated_by: userB };
      for (const data of [own, asAdmin, own, asAdmin, asAdmin]) await write(row({ data }));
      const rows = await rowsFor();
      expect(
        rows.map(r => [(r.data as { impersonated_by?: string }).impersonated_by ?? null, r.count])
      ).toEqual([
        [null, 1],
        [userB, 1],
        [null, 1],
        [userB, 2],
      ]);
    });

    it('two newest rows sharing a timestamp: a repeat inserts rather than guess', async () => {
      await write(row({ data: { tool: 'a' } }));
      await write(row({ data: { tool: 'b' } }));
      const rows = await rowsFor();
      const at = new Date();
      for (const r of rows)
        await prisma.auditLog.update({ where: { id: r.id }, data: { timestamp: at } });
      await write(row({ data: { tool: 'a' } }));
      expect((await rowsFor()).map(r => r.count)).toEqual([1, 1, 1]);
    });

    it('a different role, user or classroom never merges', async () => {
      await write(row());
      await write(row({ role: 'OWNER' }));
      await write(row({ user_id: userB }));
      await write(row({ classroom_id: classY }));
      await write(row({ user_id: userB }));
      const rows = await rowsFor();
      // userB's second read merged into userB's first (the newest row for
      // userB); nothing else merged.
      expect(rows.map(r => [r.user_id, r.classroom_id, r.role, r.count])).toEqual([
        [userA, classX, 'TEACHER', 1],
        [userA, classX, 'OWNER', 1],
        [userB, classX, 'TEACHER', 2],
        [userA, classY, 'TEACHER', 1],
      ]);
    });
  });

  describe('role and the CHECK constraint', () => {
    it('writes a null-role ACCESS_DENIED row', async () => {
      await write(row({ role: null, action: 'ACCESS_DENIED' }));
      await write(row({ role: null, action: 'ACCESS_DENIED' }));
      const rows = await rowsFor();
      expect(rows.map(r => [r.role, r.count])).toEqual([[null, 2]]);
    });

    it('the database refuses a null role on anything but ACCESS_DENIED', async () => {
      await expect(
        prisma.auditLog.create({
          data: {
            user_id: userA,
            classroom_id: classX,
            role: null,
            action: 'UPDATE',
            resource_type: 'PAGES',
            resource_id: resource,
          },
        })
      ).rejects.toThrow(/audit_logs_role_required_check/);
      await expect(
        prisma.auditLog.create({
          data: {
            user_id: userA,
            classroom_id: classX,
            role: null,
            action: 'ACCESS_DENIED',
            resource_type: 'PAGES',
            resource_id: resource,
          },
        })
      ).resolves.toMatchObject({ role: null, count: 1 });
    });
  });

  describe('a non-member refusal (recordNonMemberRefusal)', () => {
    // Each test refuses on a day of its own: the row id is derived from the
    // person, the classroom and the UTC day, so a shared day would share rows.
    let dayIndex = 0;
    const nextDay = () => {
      dayIndex += 1;
      return new Date(Date.UTC(2031, 0, dayIndex, 12, 0, 0, 123));
    };
    const refusalRows = (from: Date, days = 1) =>
      prisma.auditLog.findMany({
        where: {
          classroom_id: { in: [classX, classY] },
          resource_type: 'CLASSROOM',
          timestamp: {
            gte: new Date(from.getTime() - 12 * 3600_000),
            lt: new Date(from.getTime() + days * 86_400_000),
          },
        },
        orderBy: [{ timestamp: 'asc' }, { user_id: 'asc' }, { classroom_id: 'asc' }],
      });

    it('one refusal is one row with the fixed fields', async () => {
      const now = nextDay();
      await audit.recordNonMemberRefusal({ userId: userA, classroomId: classX }, { now });

      const rows = await refusalRows(now);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toEqual({
        id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        ),
        classroom_id: classX,
        user_id: userA,
        role: null,
        action: 'ACCESS_DENIED',
        resource_type: 'CLASSROOM',
        resource_id: classX,
        data: { reason: 'not_classroom_member', tool: 'gate' },
        count: 1,
        timestamp: now,
        updated_at: now,
      });
    });

    it('derives the row id from the person, the classroom and the UTC day (pinned)', async () => {
      // Fixed inputs and the id the derivation gives them: a change to how
      // the id is made would split one person's refusals of a day in two.
      const userId = '00000000-0000-4000-8000-00000000a001';
      const classroomId = '00000000-0000-4000-8000-00000000c001';
      const pinnedId = 'c563729f-d914-87da-9c41-bbd35b6739fb';
      const clear = async () => {
        await prisma.auditLog.deleteMany({ where: { id: pinnedId } });
        await prisma.classroom.deleteMany({ where: { id: classroomId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      };
      await clear(); // anything a crashed run left behind
      try {
        await prisma.user.create({
          data: { id: userId, email: `audit-pinned-${suite}@example.test`, name: 'Pinned' },
        });
        await prisma.classroom.create({
          data: {
            id: classroomId,
            slug: `audit-pinned-${suite}`,
            git_org_id: orgId,
            name: `Audit pinned ${suite}`,
            content_namespace: `audit-pinned-${suite}`,
            content_repo: `content-audit-pinned-${suite}`,
          },
        });

        await audit.recordNonMemberRefusal(
          { userId, classroomId },
          { now: new Date('2031-06-15T12:00:00.000Z') }
        );

        const rows = await prisma.auditLog.findMany({ where: { classroom_id: classroomId } });
        expect(rows.map(row => row.id)).toEqual([pinnedId]);
      } finally {
        await clear();
      }
    });

    it('25 refusals at once are one row with count 25', async () => {
      const now = nextDay();
      await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          audit.recordNonMemberRefusal(
            { userId: userA, classroomId: classX },
            { now: new Date(now.getTime() + i * 1000) }
          )
        )
      );

      const rows = await refusalRows(now);
      expect(rows).toHaveLength(1);
      expect(rows[0].count).toBe(25);
      // The first refusal's time stays; updated_at is the latest one's.
      expect(rows[0].timestamp.getTime()).toBeGreaterThanOrEqual(now.getTime());
      expect(rows[0].updated_at).toEqual(new Date(now.getTime() + 24 * 1000));
    });

    it('a later refusal the same day raises count and updated_at, not timestamp', async () => {
      const now = nextDay();
      const later = new Date(now.getTime() + 5 * 3600_000);
      await audit.recordNonMemberRefusal({ userId: userA, classroomId: classX }, { now });
      await audit.recordNonMemberRefusal({ userId: userA, classroomId: classX }, { now: later });

      const rows = await refusalRows(now);
      expect(rows.map(r => [r.count, r.timestamp, r.updated_at])).toEqual([[2, now, later]]);
    });

    it('the next UTC day is a row of its own', async () => {
      const now = nextDay();
      nextDay(); // keep the following day to this test
      const lastMinute = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999)
      );
      const nextMorning = new Date(lastMinute.getTime() + 1);
      await audit.recordNonMemberRefusal(
        { userId: userA, classroomId: classX },
        { now: lastMinute }
      );
      await audit.recordNonMemberRefusal(
        { userId: userA, classroomId: classX },
        { now: nextMorning }
      );

      const rows = await refusalRows(now, 2);
      expect(rows.map(r => [r.timestamp, r.count])).toEqual([
        [lastMinute, 1],
        [nextMorning, 1],
      ]);
      expect(rows[0].id).not.toBe(rows[1].id);
    });

    it('person A and B, classroom X and Y, are separate rows', async () => {
      const now = nextDay();
      const refuse = (userId: string, classroomId: string) =>
        audit.recordNonMemberRefusal({ userId, classroomId }, { now });
      await refuse(userA, classX);
      await refuse(userA, classX);
      await refuse(userB, classX);
      await refuse(userA, classY);

      const rows = await refusalRows(now);
      expect(rows.map(r => [r.user_id, r.classroom_id, r.resource_id, r.count]).sort()).toEqual(
        [
          [userA, classX, classX, 2],
          [userA, classY, classY, 1],
          [userB, classX, classX, 1],
        ].sort()
      );
    });

    it('a refusal while an admin views as the person is a row of its own, naming the admin', async () => {
      const now = nextDay();
      const admin = randomUUID();
      await audit.recordNonMemberRefusal({ userId: userA, classroomId: classX }, { now });
      await audit.recordNonMemberRefusal(
        { userId: userA, classroomId: classX, impersonatedBy: admin },
        { now }
      );
      await audit.recordNonMemberRefusal(
        { userId: userA, classroomId: classX, impersonatedBy: admin },
        { now }
      );

      const rows = await refusalRows(now);
      expect(rows).toHaveLength(2);
      const own = rows.find(r => !(r.data as Record<string, unknown>).impersonated_by);
      const viewedAs = rows.find(r => (r.data as Record<string, unknown>).impersonated_by);
      expect(own).toMatchObject({
        user_id: userA,
        count: 1,
        data: { reason: 'not_classroom_member', tool: 'gate' },
      });
      expect(viewedAs).toMatchObject({
        user_id: userA,
        role: null,
        resource_id: classX,
        count: 2,
        data: { reason: 'not_classroom_member', tool: 'gate', impersonated_by: admin },
      });
      expect(own!.id).not.toBe(viewedAs!.id);
    });

    it('two different admins viewing as the person are two rows', async () => {
      const now = nextDay();
      const [first, second] = [randomUUID(), randomUUID()];
      await audit.recordNonMemberRefusal(
        { userId: userA, classroomId: classX, impersonatedBy: first },
        { now }
      );
      await audit.recordNonMemberRefusal(
        { userId: userA, classroomId: classX, impersonatedBy: second },
        { now }
      );

      const rows = await refusalRows(now);
      expect(
        rows.map(r => [(r.data as Record<string, unknown>).impersonated_by, r.count]).sort()
      ).toEqual(
        [
          [first, 1],
          [second, 1],
        ].sort()
      );
    });

    it('parallel refusals under the same admin still land on one row', async () => {
      const now = nextDay();
      const admin = randomUUID();
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          audit.recordNonMemberRefusal(
            { userId: userA, classroomId: classX, impersonatedBy: admin },
            { now: new Date(now.getTime() + i * 1000) }
          )
        )
      );

      const rows = await refusalRows(now);
      expect(rows).toHaveLength(1);
      expect(rows[0].count).toBe(20);
      expect(rows[0].data).toEqual({
        reason: 'not_classroom_member',
        tool: 'gate',
        impersonated_by: admin,
      });
    });

    it('an empty impersonator is the person’s own row', async () => {
      const now = nextDay();
      await audit.recordNonMemberRefusal({ userId: userA, classroomId: classX }, { now });
      await audit.recordNonMemberRefusal(
        { userId: userA, classroomId: classX, impersonatedBy: '' },
        { now }
      );
      await audit.recordNonMemberRefusal(
        { userId: userA, classroomId: classX, impersonatedBy: null },
        { now }
      );

      const rows = await refusalRows(now);
      expect(rows.map(r => [r.count, r.data])).toEqual([
        [3, { reason: 'not_classroom_member', tool: 'gate' }],
      ]);
    });

    it('a user id that is no user writes no row, logs one audit_miss and does not throw', async () => {
      const now = nextDay();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(
          audit.recordNonMemberRefusal({ userId: randomUUID(), classroomId: classX }, { now })
        ).resolves.toBeUndefined();
        const misses = error.mock.calls.filter(([first]) => first === 'audit_miss');
        expect(misses).toHaveLength(1);
        expect(JSON.parse(misses[0][1] as string)).toMatchObject({
          reason: expect.stringContaining('non-member refusal write failed'),
          row: { classroom_id: classX, action: 'ACCESS_DENIED', resource_type: 'CLASSROOM' },
        });
      } finally {
        error.mockRestore();
      }
      expect(await refusalRows(now)).toEqual([]);
    });

    it('writes nothing without a user id or a classroom id', async () => {
      const now = nextDay();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await audit.recordNonMemberRefusal({ userId: '', classroomId: classX }, { now });
        await audit.recordNonMemberRefusal({ userId: userA, classroomId: '' }, { now });
      } finally {
        error.mockRestore();
      }
      expect(await refusalRows(now)).toEqual([]);
    });
  });
});
