/**
 * The people services write the audit row of each change they make, against
 * a REAL Postgres: one row with exactly the actor's fields (a web actor, and
 * an MCP one under View as), none when the call changed nothing, none and no
 * throw for `actor: null`, and a saved change that reports `missed` when its
 * row could not be written (an actor with no user row, which the
 * `audit_logs.user_id` foreign key refuses). Rows are scoped to the classroom
 * the caller named and to the actor: user A in classroom X and user B in
 * classroom Y never see each other's rows, and a person of Y named in X
 * changes nothing and records nothing.
 *
 * Covers staff.addStaff / updateStaff / removeStaff / recordStaffRemoval /
 * recordLeftoverSettled (and that previewLeftoverSlots reads back only the
 * MCP's follow-up rows), the grader moves a staff removal makes inline and in
 * `move_grader_slot` runs (HelperService.settleUngradedSlots,
 * resolveUngradedSlots, moveGraderSlot), classroomMembership.remove (the
 * completed student removal), roster.addStudents,
 * classroomInvite.deleteInviteInClassroom and claimPendingInvites, and the
 * removal payload's actor (buildRemoveUserPayload → parseAuditActor).
 *
 * Trigger.dev and the git provider are faked (no run is started, nothing
 * reaches Github). SAFETY: fixtures are namespaced with a fresh uuid and torn
 * down in afterAll (deleting the git organization cascades classrooms,
 * memberships, submissions and audit rows). Skipped unless DATABASE_URL names a
 * LOCAL, non-shared database, like the other integration tests here.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import type { AuditActor } from '../audit.service.ts';
import type { MoveGraderSlotPayload } from '../../helper/index.ts';

const trigger = vi.hoisted(() => ({
  trigger: vi.fn(async () => ({ id: 'run-1' })),
  batchTrigger: vi.fn(async () => ({ runs: [] })),
}));
vi.mock('@trigger.dev/sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@trigger.dev/sdk')>()),
  tasks: { trigger: trigger.trigger, batchTrigger: trigger.batchTrigger },
}));

/** Github ids the fake provider hands out, one per login. */
const githubIds = new Map<string, number>();
vi.mock('../../git/index.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../git/index.ts')>()),
  ensureClassroomTeam: vi.fn(async () => ({ id: 1, slug: 'staff-team' })),
  getGitProvider: () => ({
    getUserByLogin: vi.fn(async (login: string) => {
      if (!githubIds.has(login)) githubIds.set(login, 900_000 + githubIds.size);
      return { id: githubIds.get(login), login };
    }),
    isUserMemberOfOrganization: vi.fn(async () => true),
    addTeamMember: vi.fn(),
    inviteToOrganization: vi.fn(),
    addIssueAssignees: vi.fn(),
    removeIssueAssignees: vi.fn(),
  }),
}));

const staff = await import('../staff.service.ts');
const membershipService = await import('../classroomMembership.service.ts');
const roster = await import('../roster.service.ts');
const invites = await import('../classroomInvite.service.ts');
const { parseAuditActor } = await import('../audit.service.ts');
const { buildRemoveUserPayload } = await import('../removeUserPayload.ts');
const { ungradedCountsBeforeSettling } = await import('../staffAudit.ts');
const { default: HelperService } = await import('../../helper/index.ts');

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

describe.skipIf(!RUN)('people services write their audit rows (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const userIds: string[] = [];
  let orgId: string;
  let serial = 0;

  interface Fixture {
    label: string;
    classroomId: string;
    moduleId: string;
    ownerId: string;
  }
  let X: Fixture;
  let Y: Fixture;

  const login = (label: string) => `${label}-${suite}`;

  const makeUser = async (label: string, opts: { github?: boolean; email?: string } = {}) => {
    const user = await prisma.user.create({
      data: {
        email: opts.email ?? `peopleaudit-${label}-${suite}@example.test`,
        emailVerified: Boolean(opts.email),
        ...(opts.github
          ? {
              accounts: {
                create: {
                  provider_id: 'github',
                  account_id: `gh-${label}-${suite}`,
                  username: login(label),
                },
              },
            }
          : {}),
      },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  };

  const makeClassroom = async (label: string): Promise<Fixture> => {
    const classroom = await prisma.classroom.create({
      data: {
        slug: `peopleaudit-${label}-${suite}`,
        git_org_id: orgId,
        name: `People audit ${label} ${suite}`,
        content_namespace: `peopleaudit-${label}-${suite}`,
        content_repo: `content-peopleaudit-${label}-${suite}`,
      },
      select: { id: true },
    });
    const module = await prisma.module.create({
      data: { classroom_id: classroom.id, title: `Module ${label}` },
      select: { id: true },
    });
    const ownerId = await makeUser(`owner-${label}`, { github: true });
    await prisma.classroomMembership.create({
      data: {
        classroom_id: classroom.id,
        user_id: ownerId,
        role: 'OWNER',
        has_accepted_invite: true,
      },
    });
    return { label, classroomId: classroom.id, moduleId: module.id, ownerId };
  };

  /** A person with a Github account and `role` in `f` (a grader, unless told otherwise). */
  const makeMember = async (
    f: Fixture,
    label: string,
    role: 'ASSISTANT' | 'TEACHER' | 'STUDENT',
    { isGrader = role !== 'STUDENT' }: { isGrader?: boolean } = {}
  ) => {
    const userId = await makeUser(label, { github: true });
    await prisma.classroomMembership.create({
      data: { classroom_id: f.classroomId, user_id: userId, role, is_grader: isGrader },
    });
    return userId;
  };

  /** An ungraded submission of `f` (REPO mode) with `graderId` as its grader. */
  const makeSlot = async (f: Fixture, graderId: string) => {
    const n = ++serial;
    const studentId = await makeUser(`slot-student-${f.label}-${n}`);
    const repository = await prisma.repository.create({
      data: {
        classroom_id: f.classroomId,
        title: `lab-${n}-${suite}`,
        template: 'org/template',
        type: 'INDIVIDUAL',
      },
      select: { id: true },
    });
    const assignment = await prisma.assignment.create({
      data: {
        module_id: f.moduleId,
        type: 'REPO',
        repository_id: repository.id,
        title: `Lab ${n}`,
      },
      select: { id: true },
    });
    const gitRepo = await prisma.gitRepo.create({
      data: {
        provider: 'GITHUB',
        provider_id: `peopleaudit-${n}-${suite}`,
        name: `lab-${n}-${suite}`,
        classroom_id: f.classroomId,
        repository_id: repository.id,
        student_id: studentId,
      },
      select: { id: true },
    });
    const submission = await prisma.gitRepoAssignment.create({
      data: { provider: 'GITHUB', git_repo_id: gitRepo.id, assignment_id: assignment.id },
      select: { id: true },
    });
    await prisma.gitRepoAssignmentGrader.create({
      data: { git_repo_assignment_id: submission.id, grader_id: graderId },
    });
    return submission.id;
  };

  const SELECT = {
    user_id: true,
    classroom_id: true,
    role: true,
    resource_type: true,
    resource_id: true,
    action: true,
    data: true,
  } as const;
  const rowsFor = (resourceId: string) =>
    prisma.auditLog.findMany({
      where: { resource_id: resourceId },
      orderBy: { timestamp: 'asc' },
      select: SELECT,
    });
  const rowsIn = (classroomId: string, resourceId: string) =>
    prisma.auditLog.findMany({
      where: { classroom_id: classroomId, resource_id: resourceId },
      select: SELECT,
    });

  const webActor = (f: Fixture, tool: string): AuditActor => ({
    userId: f.ownerId,
    role: 'OWNER',
    tool,
    impersonatedBy: null,
  });
  const ADMIN = randomUUID();
  const mcpActor = (f: Fixture, tool: string): AuditActor => ({
    userId: f.ownerId,
    role: 'OWNER',
    tool,
    impersonatedBy: ADMIN,
    clientId: 'client-1',
    via: 'mcp',
  });
  /** An actor whose user row does not exist: the foreign key refuses its row. */
  const ghost = (tool: string): AuditActor => ({ userId: randomUUID(), role: 'OWNER', tool });

  const quietly = async <T>(fn: () => Promise<T>) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      return { value: await fn(), misses: logged.mock.calls.filter(c => c[0] === 'audit_miss') };
    } finally {
      logged.mockRestore();
    }
  };

  const membershipOf = (f: Fixture, userId: string, role: string) =>
    prisma.classroomMembership.findFirst({
      where: { classroom_id: f.classroomId, user_id: userId, role: role as never },
    });

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `peopleaudit-${suite}`, login: `pa-${suite}` },
    });
    orgId = org.id;
    X = await makeClassroom('x');
    Y = await makeClassroom('y');
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    // Users the staff service created for new logins, then the fixtures'.
    await prisma.user
      .deleteMany({
        where: {
          OR: [
            { id: { in: userIds } },
            { accounts: { some: { username: { endsWith: `-${suite}` } } } },
          ],
        },
      })
      .catch(() => {});
  });

  beforeEach(() => {
    trigger.trigger.mockClear();
    trigger.batchTrigger.mockClear();
  });

  // ─── staff ─────────────────────────────────────────────────────────────────

  describe('staff.addStaff', () => {
    it('writes one row with exactly the web actor’s fields; a repeat writes none', async () => {
      const add = () =>
        staff.addStaff({
          classroomId: X.classroomId,
          login: login('new-ta'),
          role: 'ASSISTANT',
          actor: webActor(X, 'web:staff.create'),
        });
      const result = await add();

      expect(result).toMatchObject({ created: true, audit: { written: 1, missed: 0 } });
      expect(await rowsFor(result.userId)).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'STAFF',
          resource_id: result.userId,
          action: 'CREATE',
          data: {
            tool: 'web:staff.create',
            user_id: result.userId,
            login: login('new-ta'),
            role: 'ASSISTANT',
            already_org_member: true,
          },
        },
      ]);

      const again = await add();
      expect(again).toMatchObject({ created: false, audit: { written: 0, missed: 0 } });
      expect(await rowsFor(result.userId)).toHaveLength(1);
    });

    it('an MCP actor under View as: via, client and the admin', async () => {
      const result = await staff.addStaff({
        classroomId: X.classroomId,
        login: login('new-teacher'),
        role: 'TEACHER',
        actor: mcpActor(X, 'staff_add'),
      });
      expect(await rowsFor(result.userId)).toEqual([
        expect.objectContaining({
          user_id: X.ownerId,
          action: 'CREATE',
          data: {
            via: 'mcp',
            tool: 'staff_add',
            user_id: result.userId,
            login: login('new-teacher'),
            role: 'TEACHER',
            already_org_member: true,
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        }),
      ]);
    });

    it('actor null: the member is added and no row is written', async () => {
      const result = await staff.addStaff({
        classroomId: X.classroomId,
        login: login('quiet-ta'),
        role: 'ASSISTANT',
        actor: null,
      });
      expect(result.audit).toEqual({ written: 0, missed: 0 });
      expect(await membershipOf(X, result.userId, 'ASSISTANT')).not.toBeNull();
      expect(await rowsFor(result.userId)).toHaveLength(0);
    });

    it('a row that cannot be written: the member stays added and the call reports the miss', async () => {
      const { value: result, misses } = await quietly(() =>
        staff.addStaff({
          classroomId: X.classroomId,
          login: login('missed-ta'),
          role: 'ASSISTANT',
          actor: ghost('web:staff.create'),
        })
      );
      expect(result.audit).toEqual({ written: 0, missed: 1 });
      expect(misses).toHaveLength(1);
      expect(await membershipOf(X, result.userId, 'ASSISTANT')).not.toBeNull();
      expect(await rowsFor(result.userId)).toHaveLength(0);
    });

    it('owner A adding in classroom X and owner B adding in Y each get their own row only', async () => {
      const inX = await staff.addStaff({
        classroomId: X.classroomId,
        login: login('shared-ta'),
        role: 'ASSISTANT',
        actor: webActor(X, 'web:staff.create'),
      });
      // The same person, in Y: a membership and a row of Y's alone.
      expect(await membershipOf(Y, inX.userId, 'ASSISTANT')).toBeNull();
      expect(await rowsIn(Y.classroomId, inX.userId)).toHaveLength(0);

      const inY = await staff.addStaff({
        classroomId: Y.classroomId,
        login: login('shared-ta'),
        role: 'ASSISTANT',
        actor: webActor(Y, 'web:staff.create'),
      });
      expect(inY.userId).toBe(inX.userId);
      expect((await rowsIn(X.classroomId, inX.userId)).map(r => r.user_id)).toEqual([X.ownerId]);
      expect((await rowsIn(Y.classroomId, inX.userId)).map(r => r.user_id)).toEqual([Y.ownerId]);
    });
  });

  describe('staff.updateStaff', () => {
    it('records a change of the flag once; the same flag again records nothing', async () => {
      const taId = await makeMember(X, 'flag-ta', 'ASSISTANT');
      const update = (isGrader: boolean, actor: AuditActor | null) =>
        staff.updateStaff({
          classroomId: X.classroomId,
          login: login('flag-ta'),
          role: 'ASSISTANT',
          isGrader,
          actor,
        });

      const off = await update(false, webActor(X, 'web:staff.update'));
      expect(off).toMatchObject({ changed: true, audit: { written: 1, missed: 0 } });
      expect(await rowsFor(taId)).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'STAFF',
          resource_id: taId,
          action: 'UPDATE',
          data: {
            tool: 'web:staff.update',
            user_id: taId,
            login: login('flag-ta'),
            role: 'ASSISTANT',
            is_grader: false,
          },
        },
      ]);

      expect(await update(false, webActor(X, 'web:staff.update'))).toMatchObject({
        changed: false,
        audit: { written: 0, missed: 0 },
      });
      expect(await rowsFor(taId)).toHaveLength(1);

      // actor null: the flag changes, nothing is recorded.
      expect(await update(true, null)).toMatchObject({ changed: true });
      expect((await membershipOf(X, taId, 'ASSISTANT'))?.is_grader).toBe(true);
      expect(await rowsFor(taId)).toHaveLength(1);
    });

    it('an MCP actor under View as, and a row that cannot be written', async () => {
      const taId = await makeMember(X, 'flag-ta-mcp', 'TEACHER');
      const update = (isGrader: boolean, actor: AuditActor) =>
        staff.updateStaff({
          classroomId: X.classroomId,
          login: login('flag-ta-mcp'),
          role: 'TEACHER',
          isGrader,
          actor,
        });
      await update(false, mcpActor(X, 'staff_update'));
      expect(await rowsFor(taId)).toEqual([
        expect.objectContaining({
          user_id: X.ownerId,
          action: 'UPDATE',
          data: {
            via: 'mcp',
            tool: 'staff_update',
            user_id: taId,
            login: login('flag-ta-mcp'),
            role: 'TEACHER',
            is_grader: false,
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        }),
      ]);

      const { value, misses } = await quietly(() => update(true, ghost('staff_update')));
      expect(value).toMatchObject({ changed: true, audit: { written: 0, missed: 1 } });
      expect(misses).toHaveLength(1);
      expect((await membershipOf(X, taId, 'TEACHER'))?.is_grader).toBe(true);
      expect(await rowsFor(taId)).toHaveLength(1);
    });

    it('a person of classroom Y named in X is not found, and nothing is written', async () => {
      const taY = await makeMember(Y, 'flag-ta-y', 'ASSISTANT');
      await expect(
        staff.updateStaff({
          classroomId: X.classroomId,
          login: login('flag-ta-y'),
          role: 'ASSISTANT',
          isGrader: false,
          actor: webActor(X, 'web:staff.update'),
        })
      ).rejects.toMatchObject({ code: 'staff_not_found' });
      expect((await membershipOf(Y, taY, 'ASSISTANT'))?.is_grader).toBe(true);
      expect(await rowsFor(taY)).toHaveLength(0);
    });
  });

  describe('staff removal', () => {
    it('removeStaff carries the owner for the hand-off, and no actor for a row of the run', async () => {
      const taId = await makeMember(X, 'leaving-ta', 'ASSISTANT');
      await staff.removeStaff({
        classroomId: X.classroomId,
        login: login('leaving-ta'),
        role: 'ASSISTANT',
        actor: mcpActor(X, 'staff_remove'),
      });
      const [taskId, { payload }] = trigger.trigger.mock.calls[0] as unknown as [
        string,
        { payload: Record<string, unknown> },
      ];
      expect(taskId).toBe('remove_user_from_organization');
      expect(payload).toMatchObject({
        user: { id: taId },
        classroom: { id: X.classroomId },
        role: 'ASSISTANT',
        actorUserId: X.ownerId,
        impersonatedBy: ADMIN,
      });
      // A staff removal's row is written by the caller once it knows the outcome.
      expect(payload).not.toHaveProperty('auditActor');
      expect(await rowsFor(taId)).toHaveLength(0);
    });

    it('a staff member of Y named in X is not found: nothing is queued or written', async () => {
      const taY = await makeMember(Y, 'stay-ta-y', 'ASSISTANT');
      await expect(
        staff.removeStaff({
          classroomId: X.classroomId,
          login: login('stay-ta-y'),
          role: 'ASSISTANT',
          actor: webActor(X, 'web:staff.remove'),
        })
      ).rejects.toMatchObject({ code: 'staff_not_found' });
      expect(trigger.trigger).not.toHaveBeenCalled();
      expect(await membershipOf(Y, taY, 'ASSISTANT')).not.toBeNull();
      expect(await rowsFor(taY)).toHaveLength(0);
    });

    it('the run deletes a staff role without a row of its own', async () => {
      const taId = await makeMember(X, 'run-ta', 'ASSISTANT');
      const removed = await membershipService.remove(X.classroomId, taId, 'ASSISTANT', {
        actorUserId: X.ownerId,
      });
      expect(removed).toEqual({ count: 1, audit: { written: 0, missed: 0 } });
      expect(await rowsFor(taId)).toHaveLength(0);
    });

    it('a web removal: one truthful row, no follow-up marker, never read back as pending', async () => {
      const taId = await makeMember(X, 'web-gone', 'ASSISTANT');
      await makeSlot(X, taId);
      await membershipService.remove(X.classroomId, taId, 'ASSISTANT', {});

      const audit = await staff.recordStaffRemoval(webActor(X, 'web:staff.remove'), {
        classroomId: X.classroomId,
        userId: taId,
        role: 'ASSISTANT',
        choice: 'keep',
        // What the MCP would call pending, and a marker it would keep: the
        // web's row keeps neither.
        removal: 'pending',
        followup: 'needs_decision',
        // What the web writes while its removal is still running.
        ungraded: ungradedCountsBeforeSettling('keep', 1),
      });
      expect(audit).toEqual({ written: 1, missed: 0 });
      expect(await rowsFor(taId)).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'STAFF',
          resource_id: taId,
          action: 'DELETE',
          data: {
            tool: 'web:staff.remove',
            value: 'ASSISTANT:keep',
            user_id: taId,
            role: 'ASSISTANT',
            removal: 'in_progress',
            ungraded_submissions: {
              choice: 'keep',
              total: 1,
              reassigned: 0,
              unassigned: 0,
              kept: 0,
              failed: 0,
              queued: false,
            },
          },
        },
      ]);

      // The MCP follow-up does not take a web removal as an open one.
      await expect(
        staff.previewLeftoverSlots({
          classroomId: X.classroomId,
          login: login('web-gone'),
          role: 'ASSISTANT',
        })
      ).rejects.toMatchObject({ code: 'staff_not_found' });
    });

    it('an MCP removal: the same row, markers and follow-up as before', async () => {
      const taId = await makeMember(X, 'mcp-gone', 'ASSISTANT');
      await makeSlot(X, taId);
      await membershipService.remove(X.classroomId, taId, 'ASSISTANT', {});

      await staff.recordStaffRemoval(mcpActor(X, 'staff_remove'), {
        classroomId: X.classroomId,
        userId: taId,
        login: login('mcp-gone'),
        role: 'ASSISTANT',
        choice: 'reassign',
        removal: 'pending',
        followup: null,
        ungraded: { choice: 'reassign', pending: true, count: 1 },
      });
      expect(await rowsFor(taId)).toEqual([
        expect.objectContaining({
          user_id: X.ownerId,
          resource_type: 'STAFF',
          action: 'DELETE',
          data: {
            via: 'mcp',
            tool: 'staff_remove',
            value: 'ASSISTANT:reassign',
            user_id: taId,
            login: login('mcp-gone'),
            role: 'ASSISTANT',
            removal: 'pending',
            ungraded_submissions: { choice: 'reassign', pending: true, count: 1 },
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        }),
      ]);
      await expect(
        staff.previewLeftoverSlots({
          classroomId: X.classroomId,
          login: login('mcp-gone'),
          role: 'ASSISTANT',
        })
      ).resolves.toMatchObject({ userId: taId, ungradedCount: 1 });

      // A completed MCP removal keeps its marker too.
      const otherId = await makeMember(X, 'mcp-deferred', 'ASSISTANT');
      await makeSlot(X, otherId);
      await membershipService.remove(X.classroomId, otherId, 'ASSISTANT', {});
      await staff.recordStaffRemoval(mcpActor(X, 'staff_remove'), {
        classroomId: X.classroomId,
        userId: otherId,
        login: login('mcp-deferred'),
        role: 'ASSISTANT',
        choice: 'unassign',
        removal: 'completed',
        followup: 'settle_deferred',
        ungraded: { choice: 'unassign', pending: true, count: 1 },
      });
      expect(await rowsFor(otherId)).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'STAFF',
          resource_id: otherId,
          action: 'DELETE',
          data: {
            via: 'mcp',
            tool: 'staff_remove',
            value: 'ASSISTANT:unassign',
            user_id: otherId,
            login: login('mcp-deferred'),
            role: 'ASSISTANT',
            removal: 'completed',
            settle_deferred: true,
            ungraded_submissions: { choice: 'unassign', pending: true, count: 1 },
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        },
      ]);
      await expect(
        staff.previewLeftoverSlots({
          classroomId: X.classroomId,
          login: login('mcp-deferred'),
          role: 'ASSISTANT',
        })
      ).resolves.toMatchObject({ userId: otherId, ungradedCount: 1 });

      // An open removal in X is not one in Y.
      await expect(
        staff.previewLeftoverSlots({
          classroomId: Y.classroomId,
          login: login('mcp-deferred'),
          role: 'ASSISTANT',
        })
      ).rejects.toMatchObject({ code: 'staff_not_found' });
    });

    it('a removal row: none for actor null, and a miss reported when it cannot be written', async () => {
      const taId = await makeMember(X, 'row-gone', 'ASSISTANT');
      await membershipService.remove(X.classroomId, taId, 'ASSISTANT', {});
      const record = (actor: AuditActor | null) =>
        staff.recordStaffRemoval(actor, {
          classroomId: X.classroomId,
          userId: taId,
          role: 'ASSISTANT',
          choice: null,
          removal: 'completed',
          ungraded: null,
        });
      expect(await record(null)).toEqual({ written: 0, missed: 0 });
      const { value, misses } = await quietly(() => record(ghost('web:staff.remove')));
      expect(value).toEqual({ written: 0, missed: 1 });
      expect(misses).toHaveLength(1);
      expect(await rowsFor(taId)).toHaveLength(0);
    });

    it('the follow-up’s row, and none for actor null or a row that cannot be written', async () => {
      const taId = await makeMember(X, 'leftover', 'ASSISTANT');
      const record = (actor: AuditActor | null) =>
        staff.recordLeftoverSettled(actor, {
          classroomId: X.classroomId,
          userId: taId,
          login: login('leftover'),
          role: 'ASSISTANT',
          choice: 'unassign',
          ungraded: { choice: 'unassign', total: 1, unassigned: 1 },
        });
      expect(await record(mcpActor(X, 'staff_remove'))).toEqual({ written: 1, missed: 0 });
      expect(await rowsFor(taId)).toEqual([
        expect.objectContaining({
          action: 'UPDATE',
          data: {
            via: 'mcp',
            tool: 'staff_remove',
            value: 'leftover:ASSISTANT:unassign',
            user_id: taId,
            login: login('leftover'),
            role: 'ASSISTANT',
            removal: 'already_done',
            ungraded_submissions: { choice: 'unassign', total: 1, unassigned: 1 },
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        }),
      ]);
      expect(await record(null)).toEqual({ written: 0, missed: 0 });
      const { value, misses } = await quietly(() => record(ghost('staff_remove')));
      expect(value).toEqual({ written: 0, missed: 1 });
      expect(misses).toHaveLength(1);
      expect(await rowsFor(taId)).toHaveLength(1);
    });
  });

  describe('grader moves of a staff removal', () => {
    /** The grader rows of one submission, actor and data only. */
    const graderRows = async (submissionId: string) =>
      (await rowsFor(submissionId)).map(r => ({
        user_id: r.user_id,
        classroom_id: r.classroom_id,
        role: r.role,
        resource_type: r.resource_type,
        action: r.action,
        data: r.data,
      }));

    it('inline and queued moves write the same rows, for the removing owner', async () => {
      // A classroom of its own, so the keeper is the only other grader.
      const Z = await makeClassroom('z');
      // Inline: one slot of a departing grader, reassigned to the other grader.
      const keeperId = await makeMember(Z, 'keeper', 'TEACHER');
      const goneInline = await makeMember(Z, 'gone-inline', 'ASSISTANT');
      const inlineSlot = await makeSlot(Z, goneInline);
      await membershipService.remove(Z.classroomId, goneInline, 'ASSISTANT', {});

      const actor = mcpActor(Z, 'staff_remove');
      const inline = await HelperService.settleUngradedSlots({
        classroomId: Z.classroomId,
        graderId: goneInline,
        choice: 'reassign',
        departingName: 'Gone',
        expectedCount: 1,
        actor,
      });
      expect(inline).toMatchObject({ queued: false, audit: { written: 2, missed: 0 } });

      const expected = (fromId: string) => [
        {
          user_id: Z.ownerId,
          classroom_id: Z.classroomId,
          role: 'OWNER',
          resource_type: 'GIT_REPO_ASSIGNMENT_GRADER',
          action: 'CREATE',
          data: {
            via: 'mcp',
            tool: 'staff_remove',
            value: keeperId,
            grader_id: keeperId,
            grader_login: login('keeper'),
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        },
        {
          user_id: Z.ownerId,
          classroom_id: Z.classroomId,
          role: 'OWNER',
          resource_type: 'GIT_REPO_ASSIGNMENT_GRADER',
          action: 'DELETE',
          data: {
            via: 'mcp',
            tool: 'staff_remove',
            value: fromId,
            grader_id: fromId,
            grader_login: login(fromId === goneInline ? 'gone-inline' : 'gone-queued'),
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        },
      ];
      expect(await graderRows(inlineSlot)).toEqual(expected(goneInline));

      // Queued: more slots than are moved inline, so each goes out as a run.
      const goneQueued = await makeMember(Z, 'gone-queued', 'ASSISTANT');
      const slots: string[] = [];
      for (let i = 0; i < 11; i++) slots.push(await makeSlot(Z, goneQueued));
      await membershipService.remove(Z.classroomId, goneQueued, 'ASSISTANT', {});

      const queued = await HelperService.settleUngradedSlots({
        classroomId: Z.classroomId,
        graderId: goneQueued,
        choice: 'reassign',
        departingName: 'Gone',
        expectedCount: 11,
        actor,
      });
      expect(queued).toMatchObject({ queued: true, audit: { written: 0, missed: 0 } });
      const items = (
        trigger.batchTrigger.mock.calls[0] as unknown as [
          string,
          Array<{ payload: Record<string, unknown> }>,
        ]
      )[1];
      expect(items).toHaveLength(11);

      // What each `move_grader_slot` run does with its payload.
      const first = items[0].payload;
      const ran = await HelperService.moveGraderSlot({
        ...(first as unknown as MoveGraderSlotPayload),
        actor: parseAuditActor(first.actor),
      });
      expect(ran).toMatchObject({ status: 'moved', audit: { written: 2, missed: 0 } });
      expect(await graderRows(first.gitRepoAssignmentId as string)).toEqual(expected(goneQueued));

      // A run queued before the actor existed records nothing.
      const { actor: _dropped, ...old } = items[1].payload;
      const oldRun = await HelperService.moveGraderSlot({
        ...(old as unknown as MoveGraderSlotPayload),
        actor: parseAuditActor((old as Record<string, unknown>).actor),
      });
      expect(oldRun).toMatchObject({ status: 'moved', audit: { written: 0, missed: 0 } });
      expect(await rowsFor(old.gitRepoAssignmentId as string)).toHaveLength(0);
    });

    it('a web actor: the queued run writes the same rows as the inline move', async () => {
      const W = await makeClassroom('w');
      const keeperId = await makeMember(W, 'w-keeper', 'TEACHER');
      const actor = webActor(W, 'web:staff.remove');
      const expected = (fromId: string, fromLabel: string) => [
        {
          user_id: W.ownerId,
          classroom_id: W.classroomId,
          role: 'OWNER',
          resource_type: 'GIT_REPO_ASSIGNMENT_GRADER',
          action: 'CREATE',
          data: {
            tool: 'web:staff.remove',
            value: keeperId,
            grader_id: keeperId,
            grader_login: login('w-keeper'),
          },
        },
        {
          user_id: W.ownerId,
          classroom_id: W.classroomId,
          role: 'OWNER',
          resource_type: 'GIT_REPO_ASSIGNMENT_GRADER',
          action: 'DELETE',
          data: {
            tool: 'web:staff.remove',
            value: fromId,
            grader_id: fromId,
            grader_login: login(fromLabel),
          },
        },
      ];

      // Inline: one slot, moved in the request.
      const goneInline = await makeMember(W, 'w-gone-inline', 'ASSISTANT');
      const inlineSlot = await makeSlot(W, goneInline);
      await membershipService.remove(W.classroomId, goneInline, 'ASSISTANT', {});
      const inline = await HelperService.settleUngradedSlots({
        classroomId: W.classroomId,
        graderId: goneInline,
        choice: 'reassign',
        departingName: 'Gone',
        expectedCount: 1,
        actor,
      });
      expect(inline).toMatchObject({ queued: false, audit: { written: 2, missed: 0 } });
      expect(await graderRows(inlineSlot)).toEqual(expected(goneInline, 'w-gone-inline'));

      // Queued: the run reads the actor back from its stored payload.
      const goneQueued = await makeMember(W, 'w-gone-queued', 'ASSISTANT');
      for (let i = 0; i < 11; i++) await makeSlot(W, goneQueued);
      await membershipService.remove(W.classroomId, goneQueued, 'ASSISTANT', {});
      const queued = await HelperService.settleUngradedSlots({
        classroomId: W.classroomId,
        graderId: goneQueued,
        choice: 'reassign',
        departingName: 'Gone',
        expectedCount: 11,
        actor,
      });
      expect(queued).toMatchObject({ queued: true, audit: { written: 0, missed: 0 } });
      const [, items] = trigger.batchTrigger.mock.calls[0] as unknown as [
        string,
        Array<{ payload: Record<string, unknown> }>,
      ];
      const stored = JSON.parse(JSON.stringify(items[0].payload)) as Record<string, unknown>;
      const ran = await HelperService.moveGraderSlot({
        ...(stored as unknown as MoveGraderSlotPayload),
        actor: parseAuditActor(stored.actor),
      });
      expect(ran).toMatchObject({ status: 'moved', audit: { written: 2, missed: 0 } });
      expect(await graderRows(stored.gitRepoAssignmentId as string)).toEqual(
        expected(goneQueued, 'w-gone-queued')
      );
    });

    it('actor null moves the slots and records nothing', async () => {
      await makeMember(X, 'keeper-2', 'TEACHER');
      const gone = await makeMember(X, 'gone-null', 'ASSISTANT');
      const slot = await makeSlot(X, gone);
      await membershipService.remove(X.classroomId, gone, 'ASSISTANT', {});
      const outcome = await HelperService.settleUngradedSlots({
        classroomId: X.classroomId,
        graderId: gone,
        choice: 'unassign',
        departingName: 'Gone',
        expectedCount: 1,
        actor: null,
      });
      expect(outcome).toMatchObject({ unassigned: 1, audit: { written: 0, missed: 0 } });
      expect(await rowsFor(slot)).toHaveLength(0);
    });
  });

  // ─── students ──────────────────────────────────────────────────────────────

  describe('a student removal completed by the run (classroomMembership.remove)', () => {
    it('writes one row for the owner who asked; a repeat writes none', async () => {
      const studentId = await makeMember(X, 'leaving-student', 'STUDENT');
      const remove = () =>
        membershipService.remove(X.classroomId, studentId, 'STUDENT', {
          audit: webActor(X, 'web:students.remove'),
          hadAcceptedInvite: false,
        });

      expect(await remove()).toEqual({ count: 1, audit: { written: 1, missed: 0 } });
      expect(await rowsFor(studentId)).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'STUDENT_ROSTER',
          resource_id: studentId,
          action: 'DELETE',
          data: {
            tool: 'web:students.remove',
            user_id: studentId,
            role: 'STUDENT',
            had_accepted_invite: false,
            removal: 'completed',
          },
        },
      ]);
      expect(await remove()).toEqual({ count: 0, audit: { written: 0, missed: 0 } });
      expect(await rowsFor(studentId)).toHaveLength(1);
    });

    it('the MCP actor, carried through the run payload, under View as', async () => {
      const studentId = await makeMember(X, 'mcp-student', 'STUDENT');
      const payload = buildRemoveUserPayload({
        user: { id: studentId, login: login('mcp-student'), has_accepted_invite: true },
        classroom: { id: X.classroomId, slug: 'x' },
        role: 'STUDENT',
        auditActor: mcpActor(X, 'roster_remove_student'),
      });
      // What the run reads back from its stored payload.
      const actor = parseAuditActor(JSON.parse(JSON.stringify(payload)).auditActor);
      expect(actor).toEqual(mcpActor(X, 'roster_remove_student'));

      await membershipService.remove(X.classroomId, studentId, 'STUDENT', {
        audit: actor,
        hadAcceptedInvite: true,
      });
      expect(await rowsFor(studentId)).toEqual([
        expect.objectContaining({
          user_id: X.ownerId,
          resource_type: 'STUDENT_ROSTER',
          action: 'DELETE',
          data: {
            via: 'mcp',
            tool: 'roster_remove_student',
            user_id: studentId,
            role: 'STUDENT',
            had_accepted_invite: true,
            removal: 'completed',
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        }),
      ]);
    });

    it('a retried run with the actor in its payload writes the completion row once', async () => {
      const studentId = await makeMember(X, 'retried-student', 'STUDENT');
      const stored = JSON.parse(
        JSON.stringify(
          buildRemoveUserPayload({
            user: { id: studentId, login: login('retried-student'), has_accepted_invite: true },
            classroom: { id: X.classroomId, slug: 'x' },
            role: 'STUDENT',
            auditActor: mcpActor(X, 'roster_remove_student'),
          })
        )
      );
      // Each attempt reads the actor back from the same stored payload, as the
      // run does, and hands it to the delete.
      const attempt = () =>
        membershipService.remove(X.classroomId, studentId, 'STUDENT', {
          audit: parseAuditActor(stored.auditActor),
          hadAcceptedInvite: true,
        });

      expect(await attempt()).toEqual({ count: 1, audit: { written: 1, missed: 0 } });
      // The retry finds nothing to delete and writes nothing.
      expect(await attempt()).toEqual({ count: 0, audit: { written: 0, missed: 0 } });
      expect(await rowsFor(studentId)).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'STUDENT_ROSTER',
          resource_id: studentId,
          action: 'DELETE',
          data: {
            via: 'mcp',
            tool: 'roster_remove_student',
            user_id: studentId,
            role: 'STUDENT',
            had_accepted_invite: true,
            removal: 'completed',
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        },
      ]);
    });

    it('no actor (a run queued without one) and a row that cannot be written', async () => {
      const a = await makeMember(X, 'quiet-student', 'STUDENT');
      expect(await membershipService.remove(X.classroomId, a, 'STUDENT', {})).toEqual({
        count: 1,
        audit: { written: 0, missed: 0 },
      });
      expect(await rowsFor(a)).toHaveLength(0);

      const b = await makeMember(X, 'missed-student', 'STUDENT');
      const { value, misses } = await quietly(() =>
        membershipService.remove(X.classroomId, b, 'STUDENT', {
          audit: ghost('web:students.remove'),
        })
      );
      expect(value).toEqual({ count: 1, audit: { written: 0, missed: 1 } });
      expect(misses).toHaveLength(1);
      expect(await membershipOf(X, b, 'STUDENT')).toBeNull();
      expect(await rowsFor(b)).toHaveLength(0);
    });

    it('a student of Y removed in X: nothing is deleted or written', async () => {
      const studentY = await makeMember(Y, 'student-y', 'STUDENT');
      expect(
        await membershipService.remove(X.classroomId, studentY, 'STUDENT', {
          audit: webActor(X, 'web:students.remove'),
        })
      ).toEqual({ count: 0, audit: { written: 0, missed: 0 } });
      expect(await membershipOf(Y, studentY, 'STUDENT')).not.toBeNull();
      expect(await rowsFor(studentY)).toHaveLength(0);
    });

    it('parseAuditActor keeps only a valid actor', () => {
      expect(parseAuditActor(undefined)).toBeNull();
      expect(parseAuditActor({ userId: 'u', role: 'NOBODY', tool: 't' })).toBeNull();
      expect(parseAuditActor({ userId: 'u', role: 'OWNER', tool: '' })).toBeNull();
      expect(parseAuditActor({ userId: 'u', role: 'OWNER', tool: 't', via: 3 })).toBeNull();
      expect(parseAuditActor({ userId: 'u', role: 'OWNER', tool: 't', extra: 'dropped' })).toEqual({
        userId: 'u',
        role: 'OWNER',
        tool: 't',
      });
    });
  });

  describe('roster.addStudents', () => {
    it('one row per add for the web actor; an add that changes nothing writes none', async () => {
      const known = `known-${suite}@example.test`;
      const knownId = await makeUser('known', { email: known });
      const add = (students: Array<{ email: string }>, actor: AuditActor | null, f = X) =>
        roster.addStudents({
          classroomId: f.classroomId,
          students,
          signInvite: email => `token-for-${email}`,
          actor,
        });

      const first = await add(
        [{ email: known }, { email: `new-${suite}@example.test` }, { email: 'not-an-email' }],
        webActor(X, 'web:students.add')
      );
      expect(first.audit).toEqual({ written: 1, missed: 0 });
      const rows = await prisma.auditLog.findMany({
        where: {
          classroom_id: X.classroomId,
          resource_type: 'STUDENT_ROSTER',
          action: 'CREATE',
        },
        select: SELECT,
      });
      expect(rows).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'STUDENT_ROSTER',
          resource_id: null,
          action: 'CREATE',
          data: {
            tool: 'web:students.add',
            added: 1,
            invited: 1,
            already_enrolled: 0,
            invalid: 1,
          },
        },
      ]);
      expect(await membershipOf(X, knownId, 'STUDENT')).not.toBeNull();

      // Already enrolled: nothing changed, nothing recorded.
      const again = await add([{ email: known }], mcpActor(X, 'roster_add_student'));
      expect(again).toMatchObject({ addedExistingUsers: 0, invitedNewUsers: 0 });
      expect(again.audit).toEqual({ written: 0, missed: 0 });

      // In Y, by Y's owner over the MCP: a row of Y's.
      await add([{ email: known }], mcpActor(Y, 'roster_add_student'), Y);
      const rowsY = await prisma.auditLog.findMany({
        where: { classroom_id: Y.classroomId, resource_type: 'STUDENT_ROSTER', action: 'CREATE' },
        select: SELECT,
      });
      expect(rowsY).toEqual([
        expect.objectContaining({
          user_id: Y.ownerId,
          data: {
            via: 'mcp',
            tool: 'roster_add_student',
            added: 1,
            invited: 0,
            already_enrolled: 0,
            invalid: 0,
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        }),
      ]);
      const countX = await prisma.auditLog.count({
        where: { classroom_id: X.classroomId, resource_type: 'STUDENT_ROSTER', action: 'CREATE' },
      });
      expect(countX).toBe(1);
    });
  });

  describe('roster.addStudents without a row', () => {
    it('actor null and a row that cannot be written: the students are added either way', async () => {
      const add = (email: string, actor: AuditActor | null) =>
        roster.addStudents({
          classroomId: Y.classroomId,
          students: [{ email }],
          signInvite: address => `token-for-${address}`,
          actor,
        });
      const countY = () =>
        prisma.auditLog.count({
          where: { classroom_id: Y.classroomId, resource_type: 'STUDENT_ROSTER', action: 'CREATE' },
        });
      const before = await countY();

      const quiet = `quiet-add-${suite}@example.test`;
      const quietId = await makeUser('quiet-add', { email: quiet });
      expect((await add(quiet, null)).audit).toEqual({ written: 0, missed: 0 });
      expect(await membershipOf(Y, quietId, 'STUDENT')).not.toBeNull();

      const missed = `missed-add-${suite}@example.test`;
      const missedId = await makeUser('missed-add', { email: missed });
      const { value, misses } = await quietly(() => add(missed, ghost('web:students.add')));
      expect(value.audit).toEqual({ written: 0, missed: 1 });
      expect(misses).toHaveLength(1);
      expect(await membershipOf(Y, missedId, 'STUDENT')).not.toBeNull();
      expect(await countY()).toBe(before);
    });
  });

  // ─── invites ───────────────────────────────────────────────────────────────

  describe('classroomInvite.deleteInviteInClassroom', () => {
    it('records a revoke in its own classroom only; another classroom’s id records nothing', async () => {
      const inviteX = await prisma.classroomInvite.create({
        data: {
          classroom_id: X.classroomId,
          school_email: `revoke-x-${suite}@example.test`,
          student_name: '',
        },
      });
      const inviteY = await prisma.classroomInvite.create({
        data: {
          classroom_id: Y.classroomId,
          school_email: `revoke-y-${suite}@example.test`,
          student_name: '',
        },
      });
      const actor = webActor(X, 'web:roster.revoke_invite');

      expect(await invites.deleteInviteInClassroom(X.classroomId, inviteY.id, actor)).toEqual({
        deleted: false,
        audit: { written: 0, missed: 0 },
      });
      expect(await rowsFor(inviteY.id)).toHaveLength(0);

      expect(await invites.deleteInviteInClassroom(X.classroomId, inviteX.id, actor)).toEqual({
        deleted: true,
        audit: { written: 1, missed: 0 },
      });
      expect(await rowsFor(inviteX.id)).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'STUDENT_ROSTER',
          resource_id: inviteX.id,
          action: 'DELETE',
          data: { tool: 'web:roster.revoke_invite' },
        },
      ]);
    });
  });

  describe('classroomInvite.deleteInviteInClassroom without a row', () => {
    it('actor null and a row that cannot be written: the invite is gone either way', async () => {
      const make = (label: string) =>
        prisma.classroomInvite.create({
          data: {
            classroom_id: X.classroomId,
            school_email: `${label}-${suite}@example.test`,
            student_name: '',
          },
        });
      const quiet = await make('revoke-quiet');
      expect(await invites.deleteInviteInClassroom(X.classroomId, quiet.id, null)).toEqual({
        deleted: true,
        audit: { written: 0, missed: 0 },
      });
      const missed = await make('revoke-missed');
      const { value, misses } = await quietly(() =>
        invites.deleteInviteInClassroom(X.classroomId, missed.id, ghost('web:roster.revoke_invite'))
      );
      expect(value).toEqual({ deleted: true, audit: { written: 0, missed: 1 } });
      expect(misses).toHaveLength(1);
      for (const id of [quiet.id, missed.id]) {
        expect(await prisma.classroomInvite.findUnique({ where: { id } })).toBeNull();
        expect(await rowsFor(id)).toHaveLength(0);
      }
    });
  });

  describe('classroomInvite.claimPendingInvites', () => {
    it('one row per membership created, for the person as a STUDENT; a repeat writes none', async () => {
      const email = `claimer-${suite}@example.test`;
      const claimer = await makeUser('claimer', { email });
      const inviteBoth = () =>
        prisma.classroomInvite.createMany({
          data: [X, Y].map(f => ({
            classroom_id: f.classroomId,
            school_email: email,
            student_name: '',
          })),
          skipDuplicates: true,
        });
      await inviteBoth();

      const claim = await invites.claimPendingInvites(claimer, {
        tool: 'web:roster.invite_email',
        impersonatedBy: ADMIN,
      });
      expect(claim).toMatchObject({ claimed: 2, audit: { written: 2, missed: 0 } });

      const rows = await rowsFor(claimer);
      const membershipX = await membershipOf(X, claimer, 'STUDENT');
      const membershipY = await membershipOf(Y, claimer, 'STUDENT');
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining(
          [
            [X, membershipX],
            [Y, membershipY],
          ].map(([f, membership]) => ({
            user_id: claimer,
            classroom_id: (f as Fixture).classroomId,
            role: 'STUDENT',
            resource_type: 'CLASSROOM_MEMBERSHIP',
            resource_id: claimer,
            action: 'CREATE',
            data: {
              tool: 'web:roster.invite_email',
              membership_id: (membership as { id: string }).id,
              impersonated_by: ADMIN,
            },
          }))
        )
      );

      // Invited again while already enrolled: the invites go, no membership is
      // created, nothing is recorded.
      await inviteBoth();
      const again = await invites.claimPendingInvites(claimer, { tool: 'web:roster.invite_email' });
      expect(again).toMatchObject({ claimed: 2, audit: { written: 0, missed: 0 } });
      expect(await rowsFor(claimer)).toHaveLength(2);
    });

    it('a row that cannot be written: the membership stands and the miss is reported', async () => {
      const email = `claim-missed-${suite}@example.test`;
      const claimer = await makeUser('claim-missed', { email });
      await prisma.classroomInvite.create({
        data: { classroom_id: X.classroomId, school_email: email, student_name: '' },
      });
      // The audit table refuses every write for this call.
      const refuse = vi
        .spyOn(prisma.auditLog, 'create')
        .mockRejectedValue(new Error('audit_logs unavailable'));
      try {
        const { value, misses } = await quietly(() =>
          invites.claimPendingInvites(claimer, { tool: 'web:roster.invite_email' })
        );
        expect(value).toMatchObject({ claimed: 1, audit: { written: 0, missed: 1 } });
        expect(misses).toHaveLength(1);
      } finally {
        refuse.mockRestore();
      }
      expect(await membershipOf(X, claimer, 'STUDENT')).not.toBeNull();
      expect(await rowsFor(claimer)).toHaveLength(0);
    });

    it('leaves out the classroom its caller records, and records nothing for null', async () => {
      const email = `joiner-${suite}@example.test`;
      const joiner = await makeUser('joiner', { email });
      await prisma.classroomInvite.createMany({
        data: [X, Y].map(f => ({
          classroom_id: f.classroomId,
          school_email: email,
          student_name: '',
        })),
      });
      const claim = await invites.claimPendingInvites(
        joiner,
        { tool: 'web:roster.invite_email' },
        { exceptClassroomId: X.classroomId }
      );
      expect(claim.audit).toEqual({ written: 1, missed: 0 });
      expect((await rowsFor(joiner)).map(r => r.classroom_id)).toEqual([Y.classroomId]);

      const silent = `silent-${suite}@example.test`;
      const quiet = await makeUser('silent', { email: silent });
      await prisma.classroomInvite.create({
        data: { classroom_id: X.classroomId, school_email: silent, student_name: '' },
      });
      expect((await invites.claimPendingInvites(quiet, null)).audit).toEqual({
        written: 0,
        missed: 0,
      });
      expect(await membershipOf(X, quiet, 'STUDENT')).not.toBeNull();
      expect(await rowsFor(quiet)).toHaveLength(0);
    });
  });
});
