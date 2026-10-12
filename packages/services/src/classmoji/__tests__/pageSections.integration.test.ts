/**
 * pageSections.service against a REAL Postgres: who can see whose checks and
 * unlocks.
 *
 * Two classrooms (X and Y), each with two students, an owner, and a person who
 * is both an assistant and a student. Every assertion is about isolation: a
 * student's state is theirs alone, a classroom's counts and lists never take in
 * another classroom's rows or answer for another classroom's page, removed
 * students and staff-who-are-students are not counted, a second unlock keeps the
 * first time, and the rows go with the page.
 *
 * SAFETY: fixtures are namespaced with a fresh uuid and torn down in afterAll by
 * deleting the git organization (cascades classrooms → pages → section rows),
 * then the users. Nothing is truncated. Skipped unless DATABASE_URL names a
 * LOCAL, non-shared database, like the other integration tests here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';

import getPrisma from '@classmoji/database';
import * as sections from '../pageSections.service.ts';
import * as audit from '../audit.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

describe.skipIf(!RUN)('pageSections.service (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const userIds: string[] = [];
  let orgId: string;

  type Fixture = {
    classroomId: string;
    pageId: string;
    page: { id: string; classroom_id: string };
    ownerId: string;
    studentA: string;
    studentB: string;
    staffStudent: string;
  };
  let X: Fixture;
  let Y: Fixture;

  const makeUser = async (label: string) => {
    const user = await prisma.user.create({
      data: {
        name: `Sections ${label} ${suite}`,
        email: `sections-${suite}-${label}@example.test`,
        image: `https://avatars.example/${suite}-${label}.png`,
        accounts: {
          create: {
            provider_id: 'github',
            account_id: `sections-${suite}-${label}`,
            username: `sections-${suite}-${label}`,
          },
        },
      },
    });
    userIds.push(user.id);
    return user.id;
  };

  const join = (classroomId: string, userId: string, role: Role, accepted = true) =>
    prisma.classroomMembership.create({
      data: { classroom_id: classroomId, user_id: userId, role, has_accepted_invite: accepted },
    });

  const makeClassroom = async (tag: string): Promise<Fixture> => {
    const classroom = await prisma.classroom.create({
      data: {
        slug: `sections-${suite}-${tag}`,
        git_org_id: orgId,
        name: `Sections ${tag} ${suite}`,
        content_namespace: `sections-${suite}-${tag}`,
        content_repo: `content-sections-${suite}-${tag}`,
      },
    });
    const ownerId = await makeUser(`${tag}-owner`);
    const studentA = await makeUser(`${tag}-a`);
    const studentB = await makeUser(`${tag}-b`);
    const staffStudent = await makeUser(`${tag}-ta`);
    await join(classroom.id, ownerId, 'OWNER');
    await join(classroom.id, studentA, 'STUDENT');
    await join(classroom.id, studentB, 'STUDENT');
    await join(classroom.id, staffStudent, 'STUDENT');
    await join(classroom.id, staffStudent, 'ASSISTANT');

    const page = await prisma.page.create({
      data: {
        classroom_id: classroom.id,
        title: `Lab ${tag} ${suite}`,
        content_path: `pages/lab-${tag}-${suite}`,
        created_by: ownerId,
        is_draft: false,
      },
      select: { id: true, classroom_id: true },
    });
    return {
      classroomId: classroom.id,
      pageId: page.id,
      page,
      ownerId,
      studentA,
      studentB,
      staffStudent,
    };
  };

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `sections-${suite}`,
        login: `sections-org-${suite}`,
      },
    });
    orgId = org.id;
    X = await makeClassroom('x');
    Y = await makeClassroom('y');
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  });

  it('reads the section viewer from memberships, highest role first', async () => {
    const viewer = (userId: string, classroomId = X.classroomId) =>
      sections.sectionViewer({ userId, classroomId });

    expect(await viewer(X.studentA)).toMatchObject({
      role: 'STUDENT',
      acceptedRole: 'STUDENT',
      student: true,
      revealAll: false,
      canUnlock: true,
      canSeeActivity: false,
    });
    expect(await viewer(X.staffStudent)).toMatchObject({
      acceptedRole: 'ASSISTANT',
      teachingTeam: true,
      student: false,
      revealAll: true,
      canUnlock: false,
    });
    expect(await viewer(X.ownerId)).toMatchObject({
      acceptedRole: 'OWNER',
      canEditAnyState: true,
      canSeeActivity: true,
    });
    // A student of X is nothing in Y.
    expect(await viewer(X.studentA, Y.classroomId)).toEqual(sections.NO_SECTION_VIEWER);

    // A student with a PENDING assistant invite stays a student.
    const pending = await makeUser('x-pending');
    await join(X.classroomId, pending, 'STUDENT');
    await join(X.classroomId, pending, 'ASSISTANT', false);
    expect(await viewer(pending)).toMatchObject({
      role: 'ASSISTANT',
      acceptedRole: 'STUDENT',
      student: true,
      revealAll: false,
      canUnlock: true,
    });

    // A student with a PENDING teacher invite edits, so reveals all and never unlocks.
    const pendingTeacher = await makeUser('x-pending-teacher');
    await join(X.classroomId, pendingTeacher, 'STUDENT');
    await join(X.classroomId, pendingTeacher, 'TEACHER', false);
    expect(await viewer(pendingTeacher)).toMatchObject({
      role: 'TEACHER',
      acceptedRole: 'STUDENT',
      canEditAnyState: true,
      revealAll: true,
      canUnlock: false,
      canSeeActivity: false,
    });
    await prisma.classroomMembership.deleteMany({
      where: { user_id: { in: [pending, pendingTeacher] } },
    });
  });

  it('logs every check toggle when dedupe is off (check, uncheck, check within 5s)', async () => {
    const blockId = `audit-toggle-${suite}`;
    try {
      for (const checked of [true, false, true]) {
        await audit.create(
          {
            user_id: X.studentA,
            classroom_id: X.classroomId,
            role: 'STUDENT',
            resource_type: 'PAGES',
            resource_id: X.pageId,
            action: checked ? 'CREATE' : 'DELETE',
            data: {
              tool: 'page_section_check',
              via: 'web',
              page_id: X.pageId,
              block_id: blockId,
              checked,
            },
          },
          { dedupe: false }
        );
      }
      const rows = await prisma.auditLog.findMany({
        where: { user_id: X.studentA, data: { path: ['block_id'], equals: blockId } },
        orderBy: { timestamp: 'asc' },
      });
      expect(rows.map(row => row.action)).toEqual(['CREATE', 'DELETE', 'CREATE']);

      // The default window still coalesces a genuine double-submit.
      const repeat = {
        user_id: X.studentA,
        classroom_id: X.classroomId,
        role: 'STUDENT',
        resource_type: 'PAGES',
        resource_id: X.pageId,
        action: 'VIEW' as const,
        data: { tool: 'page_section_unlocks', page_id: X.pageId, block_id: blockId },
      };
      expect(await audit.create(repeat)).not.toBeNull();
      expect(await audit.create(repeat)).toBeNull();
    } finally {
      await prisma.auditLog.deleteMany({
        where: { user_id: X.studentA, data: { path: ['block_id'], equals: blockId } },
      });
    }
  });

  it('counts by a page row without re-reading the page, and reads only what is asked', async () => {
    await sections.recordUnlock({ page: X.page, userId: X.studentB, blockId: 'lock-row' });
    const counts = await sections.unlockCounts({ page: X.page });
    expect(counts!.unlocks['lock-row']).toBe(1);
    const only = await sections.sectionActivity({
      page: X.page,
      blockId: 'lock-row',
      only: 'unlocks',
    });
    expect(only!.unlocks.map(entry => entry.userId)).toEqual([X.studentB]);
    expect(only!.checks).toEqual([]);
    await prisma.pageSectionUnlock.deleteMany({ where: { block_id: 'lock-row' } });
  });

  it("keeps each student's checks and unlocks to that student", async () => {
    await sections.setChecked({
      pageId: X.pageId,
      userId: X.studentA,
      blockId: 'heading-1',
      checked: true,
    });
    await sections.recordUnlock({ page: X.page, userId: X.studentA, blockId: 'lock-1' });

    const a = await sections.readerState({ pageId: X.pageId, userId: X.studentA });
    expect(a.checked).toEqual(['heading-1']);
    expect(Object.keys(a.unlocked)).toEqual(['lock-1']);

    expect(await sections.readerState({ pageId: X.pageId, userId: X.studentB })).toEqual({
      checked: [],
      unlocked: {},
    });
    // The same student on another classroom's page has nothing either.
    expect(await sections.readerState({ pageId: Y.pageId, userId: X.studentA })).toEqual({
      checked: [],
      unlocked: {},
    });
  });

  it('checks and unchecks idempotently', async () => {
    const args = { pageId: X.pageId, userId: X.studentB, blockId: 'heading-2' };
    await sections.setChecked({ ...args, checked: true });
    await sections.setChecked({ ...args, checked: true });
    expect(
      await prisma.pageSectionCheck.count({
        where: { page_id: X.pageId, user_id: X.studentB, block_id: 'heading-2' },
      })
    ).toBe(1);
    await sections.setChecked({ ...args, checked: false });
    await sections.setChecked({ ...args, checked: false });
    expect((await sections.readerState(args)).checked).toEqual([]);
  });

  it('keeps the first unlock time, including under concurrent unlocks', async () => {
    const first = await sections.recordUnlock({
      page: X.page,
      userId: X.studentB,
      blockId: 'lock-2',
    });
    expect(first.created).toBe(true);
    const again = await sections.recordUnlock({
      page: X.page,
      userId: X.studentB,
      blockId: 'lock-2',
    });
    expect(again).toEqual({ unlockedAt: first.unlockedAt, created: false });

    const racing = await Promise.all(
      Array.from({ length: 6 }, () =>
        sections.recordUnlock({ page: X.page, userId: X.studentB, blockId: 'lock-race' })
      )
    );
    expect(racing.filter(r => r.created)).toHaveLength(1);
    expect(new Set(racing.map(r => r.unlockedAt.toISOString())).size).toBe(1);
  });

  it("stores the page's classroom on the unlock", async () => {
    const row = await prisma.pageSectionUnlock.findUniqueOrThrow({
      where: {
        page_id_user_id_block_id: { page_id: X.pageId, user_id: X.studentA, block_id: 'lock-1' },
      },
    });
    expect(row.classroom_id).toBe(X.classroomId);
  });

  it("counts a classroom's current students only, never another classroom's rows", async () => {
    // Activity in Y on the same block ids, and the staff-student in X.
    await sections.recordUnlock({ page: Y.page, userId: Y.studentA, blockId: 'lock-1' });
    await sections.recordUnlock({ page: Y.page, userId: Y.studentB, blockId: 'lock-1' });
    await sections.setChecked({
      pageId: Y.pageId,
      userId: Y.studentA,
      blockId: 'heading-1',
      checked: true,
    });
    await sections.recordUnlock({ page: X.page, userId: X.staffStudent, blockId: 'lock-1' });
    await sections.setChecked({
      pageId: X.pageId,
      userId: X.staffStudent,
      blockId: 'heading-1',
      checked: true,
    });

    expect(await sections.unlockCounts({ pageId: X.pageId, classroomId: X.classroomId })).toEqual({
      students: 2,
      unlocks: { 'lock-1': 1, 'lock-2': 1, 'lock-race': 1 },
    });
    expect(await sections.checkCounts({ pageId: X.pageId, classroomId: X.classroomId })).toEqual({
      students: 2,
      checks: { 'heading-1': 1 },
    });
    expect(await sections.unlockCounts({ pageId: Y.pageId, classroomId: Y.classroomId })).toEqual({
      students: 2,
      unlocks: { 'lock-1': 2 },
    });
  });

  it("refuses another classroom's page in every staff view", async () => {
    expect(
      await sections.unlockCounts({ pageId: Y.pageId, classroomId: X.classroomId })
    ).toBeNull();
    expect(await sections.checkCounts({ pageId: Y.pageId, classroomId: X.classroomId })).toBeNull();
    expect(
      await sections.sectionActivity({ pageId: Y.pageId, classroomId: X.classroomId })
    ).toBeNull();
  });

  it('lists who did what, newest first, without staff or other classrooms', async () => {
    const activity = await sections.sectionActivity({
      pageId: X.pageId,
      classroomId: X.classroomId,
    });
    expect(activity).not.toBeNull();
    const people = new Set([
      ...activity!.unlocks.map(u => u.userId),
      ...activity!.checks.map(c => c.userId),
    ]);
    expect([...people].sort()).toEqual([X.studentA, X.studentB].sort());

    const times = activity!.unlocks.map(u => u.at.getTime());
    expect(times).toEqual([...times].sort((p, q) => q - p));

    const entry = activity!.unlocks.find(u => u.userId === X.studentA && u.blockId === 'lock-1');
    expect(entry).toMatchObject({
      name: `Sections x-a ${suite}`,
      login: `sections-${suite}-x-a`,
      avatarUrl: `https://avatars.example/${suite}-x-a.png`,
    });

    const one = await sections.sectionActivity({
      pageId: X.pageId,
      classroomId: X.classroomId,
      blockId: 'lock-1',
    });
    expect(one!.unlocks.map(u => u.userId)).toEqual([X.studentA]);
    expect(one!.checks).toEqual([]);
  });

  it('drops a removed student from counts and lists but keeps their rows', async () => {
    const leaver = await makeUser('x-leaver');
    await join(X.classroomId, leaver, 'STUDENT');
    await sections.recordUnlock({ page: X.page, userId: leaver, blockId: 'lock-leaver' });
    expect(
      (await sections.unlockCounts({ pageId: X.pageId, classroomId: X.classroomId }))!.unlocks[
        'lock-leaver'
      ]
    ).toBe(1);

    await prisma.classroomMembership.deleteMany({
      where: { classroom_id: X.classroomId, user_id: leaver },
    });

    const counts = await sections.unlockCounts({ pageId: X.pageId, classroomId: X.classroomId });
    expect(counts!.students).toBe(2);
    expect(counts!.unlocks['lock-leaver']).toBeUndefined();
    const activity = await sections.sectionActivity({
      pageId: X.pageId,
      classroomId: X.classroomId,
      blockId: 'lock-leaver',
    });
    expect(activity!.unlocks).toEqual([]);
    expect(
      await prisma.pageSectionUnlock.count({ where: { page_id: X.pageId, user_id: leaver } })
    ).toBe(1);
  });

  it('does not count an unaccepted student', async () => {
    const invited = await makeUser('x-invited');
    await join(X.classroomId, invited, 'STUDENT', false);
    await sections.recordUnlock({ page: X.page, userId: invited, blockId: 'lock-invited' });
    const counts = await sections.unlockCounts({ pageId: X.pageId, classroomId: X.classroomId });
    expect(counts!.students).toBe(2);
    expect(counts!.unlocks['lock-invited']).toBeUndefined();
  });

  it('removes the rows with the page', async () => {
    const page = await prisma.page.create({
      data: {
        classroom_id: X.classroomId,
        title: `Doomed ${suite}`,
        content_path: `pages/doomed-${suite}`,
        created_by: X.ownerId,
      },
      select: { id: true, classroom_id: true },
    });
    await sections.recordUnlock({ page, userId: X.studentA, blockId: 'lock-1' });
    await sections.setChecked({
      pageId: page.id,
      userId: X.studentA,
      blockId: 'heading-1',
      checked: true,
    });

    await prisma.page.delete({ where: { id: page.id } });

    expect(await prisma.pageSectionUnlock.count({ where: { page_id: page.id } })).toBe(0);
    expect(await prisma.pageSectionCheck.count({ where: { page_id: page.id } })).toBe(0);
  });
});
