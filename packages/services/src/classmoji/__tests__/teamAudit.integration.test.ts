/**
 * The team services write the audit row of what they saved, against a REAL
 * Postgres: one TEAMS row with exactly the actor's fields (a web actor, and an
 * MCP one under View as), written after the save; the members' user ids on a
 * membership change; no row when nothing was saved (a member already on the
 * team, a membership already gone, a tag already attached, a rename to the
 * same name); none and no throw for `actor: null`; and a saved change that
 * reports `missed` when its row could not be written (an actor with no user
 * row, which the `audit_logs.user_id` foreign key refuses). Owner A in
 * classroom X cannot create a team under classroom Y's tag nor add Y's student
 * to a team of X, and rows stay in the classroom changed.
 *
 * Covers teamAdmin.createTeam, deleteTeam, renameTeam, addTeamMembers,
 * removeTeamMember, addTeamTags and removeTeamTag, and the self-formed teams
 * of the student team page: team.createWithMembershipAndTag and
 * teamMembership.addMemberToTeam / removeMemberFromTeam.
 *
 * The git provider is faked (every call succeeds); everything else is the
 * database. SAFETY: fixtures are namespaced with a fresh uuid and torn down in
 * afterAll (deleting the git organization cascades classrooms, teams, tags,
 * memberships and audit rows). Skipped unless DATABASE_URL names a LOCAL,
 * non-shared database, like the other integration tests here.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import type { AuditActor } from '../audit.service.ts';

const provider = vi.hoisted(() => ({
  slugOf: (name: string) => name.trim().toLowerCase().replace(/\s+/g, '-'),
}));
vi.mock('../../git/index.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../git/index.ts')>()),
  getGitProvider: () => ({
    getTeam: async () => {
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
    createTeam: async (_org: string, name: string) => ({
      id: Math.floor(Math.random() * 1e9),
      name,
      slug: provider.slugOf(name),
    }),
    updateTeam: async (_org: string, _slug: string, { name }: { name: string }) => ({
      name,
      slug: provider.slugOf(name),
    }),
    deleteTeam: async () => undefined,
    deleteRepository: async () => undefined,
    updateRepo: async () => undefined,
    addTeamMember: async () => undefined,
    removeTeamMember: async () => undefined,
    // The stored Github login is the current one.
    getLoginById: async (id: string) => `login-${id}`,
  }),
}));

const teamAdmin = await import('../teamAdmin.service.ts');
const teamService = await import('../team.service.ts');
const teamMembership = await import('../teamMembership.service.ts');

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

describe.skipIf(!RUN)('team services write their audit rows (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const userIds: string[] = [];
  let orgId: string;
  let serial = 0;

  interface Person {
    id: string;
    login: string;
  }
  interface Fixture {
    label: string;
    classroomId: string;
    owner: Person;
    student: Person;
    other: Person;
    tagId: string;
  }
  let X: Fixture;
  let Y: Fixture;

  /** A user with a Github account whose stored login is `login-<account id>`. */
  const makeUser = async (label: string): Promise<Person> => {
    const accountId = `${suite}${++serial}`;
    const user = await prisma.user.create({
      data: {
        email: `teamaudit-${label}-${serial}-${suite}@example.test`,
        accounts: {
          create: {
            provider_id: 'github',
            account_id: accountId,
            username: `login-${accountId}`,
          },
        },
      },
      select: { id: true },
    });
    userIds.push(user.id);
    return { id: user.id, login: `login-${accountId}` };
  };

  const makeClassroom = async (label: string): Promise<Fixture> => {
    const row = await prisma.classroom.create({
      data: {
        slug: `teamaudit-${label}-${suite}`,
        git_org_id: orgId,
        name: `Team audit ${label} ${suite}`,
        content_namespace: `teamaudit-${label}-${suite}`,
        content_repo: `content-teamaudit-${label}-${suite}`,
      },
      select: { id: true },
    });
    const owner = await makeUser(`owner-${label}`);
    const student = await makeUser(`student-${label}`);
    const other = await makeUser(`other-${label}`);
    await prisma.classroomMembership.createMany({
      data: [
        { classroom_id: row.id, user_id: owner.id, role: 'OWNER', has_accepted_invite: true },
        { classroom_id: row.id, user_id: student.id, role: 'STUDENT', has_accepted_invite: true },
        { classroom_id: row.id, user_id: other.id, role: 'STUDENT', has_accepted_invite: true },
      ],
    });
    const tag = await prisma.tag.create({
      data: { classroom_id: row.id, name: `Projects ${suite}` },
      select: { id: true },
    });
    return { label, classroomId: row.id, owner, student, other, tagId: tag.id };
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
  const rowsIn = (classroomId: string) =>
    prisma.auditLog.findMany({
      where: { classroom_id: classroomId },
      orderBy: { timestamp: 'asc' },
      select: SELECT,
    });
  const newRows = async <T>(f: Fixture, fn: () => Promise<T>) => {
    const before = (await rowsIn(f.classroomId)).length;
    const value = await fn();
    return { value, rows: (await rowsIn(f.classroomId)).slice(before) };
  };

  const webActor = (f: Fixture, tool: string): AuditActor => ({
    userId: f.owner.id,
    role: 'OWNER',
    tool,
    impersonatedBy: null,
  });
  const ADMIN = randomUUID();
  const mcpActor = (f: Fixture, tool: string): AuditActor => ({
    userId: f.owner.id,
    role: 'OWNER',
    tool,
    impersonatedBy: ADMIN,
    clientId: 'client-1',
    via: 'mcp',
  });
  const MCP_KEYS = { via: 'mcp', client_id: 'client-1', impersonated_by: ADMIN };
  const ghost = (tool: string): AuditActor => ({ userId: randomUUID(), role: 'OWNER', tool });
  const quietly = async <T>(fn: () => Promise<T>) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      return await fn();
    } finally {
      logged.mockRestore();
    }
  };

  const createTeam = (f: Fixture, name: string, actor: AuditActor | null) =>
    teamAdmin.createTeam({
      classroomId: f.classroomId,
      name: `${name} ${suite}`,
      tagIds: [f.tagId],
      actor,
    });

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `teamaudit-${suite}`,
        login: `ta-${suite}`,
        github_installation_id: `inst-${suite}`,
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

  describe('createTeam', () => {
    it('one TEAMS / CREATE row for a web actor', async () => {
      const { value, rows } = await newRows(X, () =>
        createTeam(X, 'Red', webActor(X, 'web:teams.create'))
      );
      expect(value.audit).toEqual({ written: 1, missed: 0 });
      expect(rows).toEqual([
        {
          user_id: X.owner.id,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'TEAMS',
          resource_id: value.team.id,
          action: 'CREATE',
          data: {
            tool: 'web:teams.create',
            team_id: value.team.id,
            slug: value.team.slug,
            is_visible: false,
            tags_added: 1,
            tags_failed: 0,
          },
        },
      ]);
    });

    it('an MCP actor under View as; a tag of another classroom counts as failed', async () => {
      const { value, rows } = await newRows(X, () =>
        teamAdmin.createTeam({
          classroomId: X.classroomId,
          name: `Blue ${suite}`,
          isVisible: true,
          tagIds: [X.tagId, Y.tagId],
          actor: mcpActor(X, 'team_create'),
        })
      );
      expect(rows).toEqual([
        {
          user_id: X.owner.id,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'TEAMS',
          resource_id: value.team.id,
          action: 'CREATE',
          data: {
            ...MCP_KEYS,
            tool: 'team_create',
            team_id: value.team.id,
            slug: value.team.slug,
            is_visible: true,
            tags_added: 1,
            tags_failed: 1,
          },
        },
      ]);
    });

    it('owner A cannot create a team in X under Y’s tag: refused, no row anywhere', async () => {
      const beforeY = (await rowsIn(Y.classroomId)).length;
      const { rows } = await newRows(X, async () =>
        expect(
          teamAdmin.createTeam({
            classroomId: X.classroomId,
            name: `Foreign ${suite}`,
            tagIds: [Y.tagId],
            actor: webActor(X, 'web:teams.create'),
          })
        ).rejects.toMatchObject({ code: 'tag_required' })
      );
      expect(rows).toEqual([]);
      expect((await rowsIn(Y.classroomId)).length).toBe(beforeY);
    });

    it('no row for actor: null; the team stands when its row cannot be written', async () => {
      const nulled = await newRows(X, () => createTeam(X, 'Quiet', null));
      expect(nulled.value.audit).toEqual({ written: 0, missed: 0 });
      expect(nulled.rows).toEqual([]);

      const lost = await quietly(() => createTeam(X, 'Lost', ghost('web:teams.create')));
      expect(lost.audit).toEqual({ written: 0, missed: 1 });
      expect(await prisma.team.findUnique({ where: { id: lost.team.id } })).not.toBeNull();
    });
  });

  describe('members', () => {
    it('records the user ids it added, and nothing for a member already on the team', async () => {
      const { team } = await createTeam(X, 'Members', null);
      const first = await newRows(X, () =>
        teamAdmin.addTeamMembers({
          classroomId: X.classroomId,
          slugOrId: team.slug,
          logins: [X.student.login],
          actor: mcpActor(X, 'team_members_add'),
        })
      );
      expect(first.value.audit).toEqual({ written: 1, missed: 0 });
      expect(first.rows).toEqual([
        {
          user_id: X.owner.id,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'TEAMS',
          resource_id: team.id,
          action: 'UPDATE',
          data: {
            ...MCP_KEYS,
            tool: 'team_members_add',
            team_id: team.id,
            slug: team.slug,
            succeeded: [X.student.login],
            failed: [],
            user_ids: [X.student.id],
          },
        },
      ]);

      // Again, with a newcomer: only the newcomer is recorded as added.
      const second = await newRows(X, () =>
        teamAdmin.addTeamMembers({
          classroomId: X.classroomId,
          slugOrId: team.slug,
          logins: [X.student.login, X.other.login],
          actor: webActor(X, 'web:teams.add_members'),
        })
      );
      expect(second.rows.map(r => (r.data as { user_ids: string[] }).user_ids)).toEqual([
        [X.other.id],
      ]);

      const repeat = await newRows(X, () =>
        teamAdmin.addTeamMembers({
          classroomId: X.classroomId,
          slugOrId: team.slug,
          logins: [X.student.login],
          actor: webActor(X, 'web:teams.add_members'),
        })
      );
      expect(repeat.value.audit).toEqual({ written: 0, missed: 0 });
      expect(repeat.rows).toEqual([]);
    });

    it('does not add classroom Y’s student to a team of X, and writes no row', async () => {
      const { team } = await createTeam(X, 'Closed', null);
      const { value, rows } = await newRows(X, () =>
        teamAdmin.addTeamMembers({
          classroomId: X.classroomId,
          slugOrId: team.slug,
          logins: [Y.student.login],
          actor: webActor(X, 'web:teams.add_members'),
        })
      );
      expect(value.succeeded).toEqual([]);
      expect(value.failed).toEqual([{ login: Y.student.login, error: 'invalid' }]);
      expect(rows).toEqual([]);
      expect(await prisma.teamMembership.count({ where: { team_id: team.id } })).toBe(0);
    });

    it('records a removal with the user id, and nothing for a membership already gone', async () => {
      const { team } = await createTeam(X, 'Leaving', null);
      await teamAdmin.addTeamMembers({
        classroomId: X.classroomId,
        slugOrId: team.slug,
        logins: [X.student.login],
        actor: null,
      });
      const removed = await newRows(X, () =>
        teamAdmin.removeTeamMember({
          classroomId: X.classroomId,
          slugOrId: team.slug,
          login: X.student.login,
          actor: webActor(X, 'web:teams.remove_member'),
        })
      );
      expect(removed.rows).toEqual([
        {
          user_id: X.owner.id,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'TEAMS',
          resource_id: team.id,
          action: 'UPDATE',
          data: {
            tool: 'web:teams.remove_member',
            team_id: team.id,
            login: X.student.login,
            removed: true,
            user_id: X.student.id,
          },
        },
      ]);
      const again = await newRows(X, () =>
        teamAdmin.removeTeamMember({
          classroomId: X.classroomId,
          slugOrId: team.slug,
          login: X.student.login,
          actor: webActor(X, 'web:teams.remove_member'),
        })
      );
      expect(again.value.removed).toBe(false);
      expect(again.rows).toEqual([]);
    });
  });

  describe('tags, rename, delete', () => {
    it('records the links it wrote, a tag removal, a rename and a delete', async () => {
      const { team } = await createTeam(X, 'Tagged', null);
      const extra = await prisma.tag.create({
        data: { classroom_id: X.classroomId, name: `Extra ${suite}` },
        select: { id: true },
      });

      const added = await newRows(X, () =>
        teamAdmin.addTeamTags({
          classroomId: X.classroomId,
          slugOrId: team.slug,
          tagIds: [X.tagId, extra.id, Y.tagId],
          actor: webActor(X, 'web:teams.add_tags'),
        })
      );
      expect(added.rows.map(r => [r.resource_id, r.data])).toEqual([
        [
          team.id,
          {
            tool: 'web:teams.add_tags',
            team_id: team.id,
            added: [X.tagId, extra.id],
            failed: [Y.tagId],
            attached: [extra.id],
          },
        ],
      ]);
      const again = await newRows(X, () =>
        teamAdmin.addTeamTags({
          classroomId: X.classroomId,
          slugOrId: team.slug,
          tagIds: [extra.id],
          actor: webActor(X, 'web:teams.add_tags'),
        })
      );
      expect(again.rows).toEqual([]);

      const link = await prisma.teamTag.findFirstOrThrow({
        where: { team_id: team.id, tag_id: extra.id },
      });
      const unlinked = await newRows(X, () =>
        teamAdmin.removeTeamTag({
          classroomId: X.classroomId,
          teamTagId: link.id,
          actor: mcpActor(X, 'team_tag_remove'),
        })
      );
      expect(unlinked.rows.map(r => r.data)).toEqual([
        {
          ...MCP_KEYS,
          tool: 'team_tag_remove',
          team_id: team.id,
          tag_id: extra.id,
          team_tag_id: link.id,
        },
      ]);

      const renamed = await newRows(X, () =>
        teamAdmin.renameTeam({
          classroomId: X.classroomId,
          slugOrId: team.slug,
          newName: `Renamed ${suite}`,
          actor: webActor(X, 'web:teams.rename'),
        })
      );
      expect(renamed.rows.map(r => r.data)).toEqual([
        {
          tool: 'web:teams.rename',
          team_id: team.id,
          new_slug: renamed.value.newSlug,
          previous_slug: team.slug,
          renamed_repos: 0,
          failed_repos: [],
        },
      ]);
      const same = await newRows(X, () =>
        teamAdmin.renameTeam({
          classroomId: X.classroomId,
          slugOrId: renamed.value.newSlug,
          newName: `Renamed ${suite}`,
          actor: webActor(X, 'web:teams.rename'),
        })
      );
      expect(same.rows).toEqual([]);

      const deleted = await newRows(X, () =>
        teamAdmin.deleteTeam({
          classroomId: X.classroomId,
          slugOrId: team.id,
          actor: webActor(X, 'web:teams.delete'),
        })
      );
      expect(deleted.rows).toEqual([
        {
          user_id: X.owner.id,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'TEAMS',
          resource_id: team.id,
          action: 'DELETE',
          data: {
            tool: 'web:teams.delete',
            team_id: team.id,
            slug: renamed.value.newSlug,
            removed_from_provider: false,
            repos_deleted: 0,
            deleted_repo_names: [],
          },
        },
      ]);
    });
  });

  describe('self-formed teams (the student team page)', () => {
    const studentActor = (f: Fixture, person: Person, tool: string): AuditActor => ({
      userId: person.id,
      role: 'STUDENT',
      tool,
      impersonatedBy: null,
    });

    it('records the create, a join and a leave as the student; a repeat records nothing', async () => {
      const created = await newRows(X, () =>
        teamService.createWithMembershipAndTag(
          {
            name: `Self ${suite}`,
            slug: `self-${suite}`,
            classroomId: X.classroomId,
            providerId: 42,
            userId: X.student.id,
            tagId: X.tagId,
          },
          studentActor(X, X.student, 'web:team_formation.create')
        )
      );
      const team = created.value.team;
      expect(created.rows).toEqual([
        {
          user_id: X.student.id,
          classroom_id: X.classroomId,
          role: 'STUDENT',
          resource_type: 'TEAMS',
          resource_id: team.id,
          action: 'CREATE',
          data: {
            tool: 'web:team_formation.create',
            team_id: team.id,
            slug: `self-${suite}`,
            is_visible: true,
            tags_added: 1,
            tags_failed: 0,
            user_id: X.student.id,
          },
        },
      ]);

      const joined = await newRows(X, () =>
        teamMembership.addMemberToTeam(
          team,
          X.other.id,
          studentActor(X, X.other, 'web:team_formation.join')
        )
      );
      expect(joined.value.added).toBe(true);
      expect(joined.rows.map(r => [r.user_id, r.role, r.data])).toEqual([
        [
          X.other.id,
          'STUDENT',
          {
            tool: 'web:team_formation.join',
            team_id: team.id,
            slug: team.slug,
            user_id: X.other.id,
            added: true,
          },
        ],
      ]);
      const rejoin = await newRows(X, () =>
        teamMembership.addMemberToTeam(
          team,
          X.other.id,
          studentActor(X, X.other, 'web:team_formation.join')
        )
      );
      expect(rejoin.value).toEqual({ added: false, audit: { written: 0, missed: 0 } });
      expect(rejoin.rows).toEqual([]);

      const left = await newRows(X, () =>
        teamMembership.removeMemberFromTeam(
          team,
          X.other.id,
          studentActor(X, X.other, 'web:team_formation.leave')
        )
      );
      expect(left.rows.map(r => r.data)).toEqual([
        {
          tool: 'web:team_formation.leave',
          team_id: team.id,
          slug: team.slug,
          user_id: X.other.id,
          removed: true,
        },
      ]);
      const again = await newRows(X, () =>
        teamMembership.removeMemberFromTeam(
          team,
          X.other.id,
          studentActor(X, X.other, 'web:team_formation.leave')
        )
      );
      expect(again.value.count).toBe(0);
      expect(again.rows).toEqual([]);
    });
  });
});
