/**
 * The class invite link (`/join/<code>`), against a REAL Postgres: the unique
 * code, the membership unique key that makes a second join a no-op, and the
 * roster-invite claim all live in the database.
 *
 * What it pins: a code only ever joins the classroom it names (X's code never
 * lands anyone in Y), a link that is off, reset, locked, unpublished or
 * archived lets nobody in, staff are never given a student role by it, and an
 * unverified account is sent to registration rather than joined.
 *
 * SAFETY: fixtures are namespaced with a fresh uuid and torn down in afterAll
 * by deleting the git organization (cascading classrooms → memberships,
 * invites) and the fixture users. Skipped unless DATABASE_URL names a LOCAL,
 * non-shared database, like the other integration tests here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import * as joinLink from '../joinLink.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

describe.skipIf(!RUN)('class invite link (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let orgId: string;
  let classX: string;
  let classY: string;
  const userIds: string[] = [];

  const makeClassroom = async (label: string) =>
    (
      await prisma.classroom.create({
        data: {
          slug: `joinlink-${label}-${suite}`,
          git_org_id: orgId,
          name: `Join Link ${label} ${suite}`,
          content_namespace: `joinlink-${label}-${suite}`,
          content_repo: `content-joinlink-${label}-${suite}`,
        },
      })
    ).id;

  const makeUser = async (label: string, { verified = true } = {}) => {
    const user = await prisma.user.create({
      data: {
        email: `joinlink-${suite}-${label}@example.test`,
        emailVerified: verified,
        name: `Join Link ${label}`,
      },
    });
    userIds.push(user.id);
    return user.id;
  };

  const rolesIn = async (classroomId: string, userId: string) =>
    (
      await prisma.classroomMembership.findMany({
        where: { classroom_id: classroomId, user_id: userId },
        select: { role: true, has_accepted_invite: true },
      })
    ).map(m => `${m.role}:${m.has_accepted_invite}`);

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `joinlink-${suite}`, login: `joinlink-${suite}` },
    });
    orgId = org.id;
    classX = await makeClassroom('x');
    classY = await makeClassroom('y');
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  });

  it('is off with no code until the owner turns it on', async () => {
    expect(await joinLink.getJoinLink(classX)).toEqual({ enabled: false, code: null });
    const on = await joinLink.updateJoinLink(classX, { enabled: true });
    expect(on.enabled).toBe(true);
    expect(on.code).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it('joins user A into the classroom the code names, and only that one', async () => {
    const { code: codeX } = await joinLink.getJoinLink(classX);
    await joinLink.updateJoinLink(classY, { enabled: true });
    const a = await makeUser('a');

    const result = await joinLink.joinByCode({ userId: a, code: codeX! });
    expect(result.status).toBe('joined');
    expect(result.status === 'joined' && result.classroom.id).toBe(classX);
    expect(await rolesIn(classX, a)).toEqual(['STUDENT:false']);
    expect(await rolesIn(classY, a)).toEqual([]);
  });

  it("does not let user B's join touch user A, and a second join writes nothing", async () => {
    const { code } = await joinLink.getJoinLink(classX);
    const b = await makeUser('b');
    expect((await joinLink.joinByCode({ userId: b, code: code! })).status).toBe('joined');
    const again = await joinLink.joinByCode({ userId: b, code: code! });
    expect(again.status).toBe('already_member');
    expect(await rolesIn(classX, b)).toEqual(['STUDENT:false']);
    const members = await prisma.classroomMembership.count({ where: { classroom_id: classX } });
    expect(members).toBe(2);
  });

  it('never gives staff a student role', async () => {
    const { code } = await joinLink.getJoinLink(classX);
    const teacher = await makeUser('teacher');
    await prisma.classroomMembership.create({
      data: { classroom_id: classX, user_id: teacher, role: 'TEACHER', has_accepted_invite: true },
    });
    const result = await joinLink.joinByCode({ userId: teacher, code: code! });
    expect(result.status).toBe('already_member');
    expect(await rolesIn(classX, teacher)).toEqual(['TEACHER:true']);
  });

  it('sends an account without a verified email to registration', async () => {
    const { code } = await joinLink.getJoinLink(classX);
    const unverified = await makeUser('unverified', { verified: false });
    expect((await joinLink.joinByCode({ userId: unverified, code: code! })).status).toBe(
      'needs_email'
    );
    expect(await rolesIn(classX, unverified)).toEqual([]);
  });

  it('uses up a pasted-roster invite for the same address', async () => {
    const { code } = await joinLink.getJoinLink(classY);
    const rostered = await makeUser('rostered');
    await prisma.classroomInvite.create({
      data: {
        classroom_id: classY,
        school_email: `JoinLink-${suite}-rostered@example.test`,
        student_name: 'Rostered',
      },
    });
    const result = await joinLink.joinByCode({ userId: rostered, code: code! });
    expect(result.status === 'joined' && result.matchedRosterInvite).toBe(true);
    expect(await rolesIn(classY, rostered)).toEqual(['STUDENT:false']);
    expect(await prisma.classroomInvite.count({ where: { classroom_id: classY } })).toBe(0);
  });

  it('stops the old code on reset, and lets nobody in while off', async () => {
    const { code: oldCode } = await joinLink.getJoinLink(classX);
    const reset = await joinLink.updateJoinLink(classX, { reset: true });
    expect(reset.code).not.toBe(oldCode);
    const c = await makeUser('c');
    expect((await joinLink.joinByCode({ userId: c, code: oldCode! })).status).toBe('inactive');

    await joinLink.updateJoinLink(classX, { enabled: false });
    expect((await joinLink.joinByCode({ userId: c, code: reset.code! })).status).toBe('inactive');
    // Off keeps the code: back on, the same link works again.
    const back = await joinLink.updateJoinLink(classX, { enabled: true });
    expect(back.code).toBe(reset.code);
    expect((await joinLink.joinByCode({ userId: c, code: reset.code! })).status).toBe('joined');
  });

  it.each([
    ['LOCKED', { status: 'LOCKED' as const }],
    ['UNPUBLISHED', { status: 'UNPUBLISHED' as const }],
    ['archived', { is_archived: true }],
  ])('refuses a %s classroom', async (_label, change) => {
    const classroomId = await makeClassroom(`closed-${randomUUID().slice(0, 4)}`);
    const { code } = await joinLink.updateJoinLink(classroomId, { enabled: true });
    await prisma.classroom.update({ where: { id: classroomId }, data: change });
    const d = await makeUser(`closed-${randomUUID().slice(0, 4)}`);
    expect((await joinLink.joinByCode({ userId: d, code: code! })).status).toBe('inactive');
    expect(await rolesIn(classroomId, d)).toEqual([]);
  });

  it('refuses malformed and unknown codes alike', async () => {
    const e = await makeUser('e');
    for (const code of ['', 'short', '../../etc', 'A'.repeat(65), 'ZZZZZZZZZZZZZZZZ']) {
      expect((await joinLink.findJoinableClassroom(code)).ok).toBe(false);
      expect((await joinLink.joinByCode({ userId: e, code })).status).toBe('inactive');
    }
  });
});
