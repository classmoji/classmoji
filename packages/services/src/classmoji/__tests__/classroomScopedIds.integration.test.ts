/**
 * Ids from a request act only on rows of the caller's classroom, against a
 * real Postgres: classroom X's owner names rows of classroom Y and nothing in Y
 * changes.
 *
 *   - organizationTag.deleteInClassroom: a tag is deleted only in its own
 *     classroom;
 *   - classroomInvite.deleteInviteInClassroom: likewise for a pending invite;
 *   - classroomMembership.studentsInClassroomByIds: only this classroom's
 *     STUDENT members come back (not its staff, not another classroom's
 *     students, not a user in no classroom).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import getPrisma from '@classmoji/database';
import * as organizationTag from '../organizationTag.service.ts';
import * as classroomInvite from '../classroomInvite.service.ts';
import * as classroomMembership from '../classroomMembership.service.ts';
import { RUN_DB_SUITES, createTwoClassrooms, type TwoClassrooms } from './helpers/twoClassrooms.ts';

describe.skipIf(!RUN_DB_SUITES)('ids are scoped to their classroom (integration)', () => {
  let fx: TwoClassrooms;
  const prisma = getPrisma();

  beforeAll(async () => {
    fx = await createTwoClassrooms('scopedids');
  });

  afterAll(async () => {
    await fx?.teardown();
  });

  describe('organizationTag.deleteInClassroom', () => {
    it('deletes nothing when the tag belongs to another classroom', async () => {
      const before = await prisma.teamTag.count({ where: { tag_id: fx.Y.tagId } });

      expect((await organizationTag.deleteInClassroom(fx.X.id, fx.Y.tagId, null)).tag).toBeNull();

      expect(await prisma.tag.findUnique({ where: { id: fx.Y.tagId } })).not.toBeNull();
      expect(await prisma.teamTag.count({ where: { tag_id: fx.Y.tagId } })).toBe(before);
      const repo = await prisma.repository.findUnique({ where: { id: fx.Y.repositoryId } });
      expect(repo?.tag_id).toBe(fx.Y.tagId);
    });

    it.each([[undefined], [''], [{ not: '' }], [42]])('deletes nothing for %j', async id => {
      expect((await organizationTag.deleteInClassroom(fx.X.id, id, null)).tag).toBeNull();
      expect(await prisma.tag.count({ where: { id: { in: [fx.X.tagId, fx.Y.tagId] } } })).toBe(2);
    });

    it('deletes a tag of its own classroom', async () => {
      const extra = await prisma.tag.create({ data: { classroom_id: fx.X.id, name: 'extra' } });

      expect((await organizationTag.deleteInClassroom(fx.X.id, extra.id, null)).tag).toEqual({
        id: extra.id,
        name: 'extra',
      });
      expect(await prisma.tag.findUnique({ where: { id: extra.id } })).toBeNull();
    });
  });

  describe('classroomInvite.deleteInviteInClassroom', () => {
    it('deletes nothing when the invite belongs to another classroom', async () => {
      expect(
        (await classroomInvite.deleteInviteInClassroom(fx.X.id, fx.Y.inviteId, null)).deleted
      ).toBe(false);
      expect(
        await prisma.classroomInvite.findUnique({ where: { id: fx.Y.inviteId } })
      ).not.toBeNull();
    });

    it('deletes an invite of its own classroom', async () => {
      expect(
        (await classroomInvite.deleteInviteInClassroom(fx.X.id, fx.X.inviteId, null)).deleted
      ).toBe(true);
      expect(await prisma.classroomInvite.findUnique({ where: { id: fx.X.inviteId } })).toBeNull();
    });
  });

  describe('classroomMembership.studentsInClassroomByIds', () => {
    it("returns only this classroom's students, in the order asked, each once", async () => {
      const result = await classroomMembership.studentsInClassroomByIds(fx.X.id, [
        fx.Y.studentId,
        fx.X.studentId,
        fx.X.assistantId,
        fx.outsiderId,
        fx.X.studentId,
        null,
      ]);

      expect(result).toEqual([
        { id: fx.X.studentId, name: 'User x-student', login: fx.X.studentLogin },
      ]);
    });

    it('returns nothing for ids of another classroom only', async () => {
      expect(
        await classroomMembership.studentsInClassroomByIds(fx.X.id, [fx.Y.studentId, fx.Y.ownerId])
      ).toEqual([]);
    });
  });
});
