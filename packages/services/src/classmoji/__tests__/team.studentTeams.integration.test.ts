/**
 * The student report's "Teams" rows against a REAL Postgres: a student's teams
 * in ONE classroom, each with its team set (from `TeamSet.tag_id`, never a
 * plain tag), its members and its repositories.
 *
 * Leak checks: a team in classroom Y is never listed for classroom X, and a
 * team the student is not in is never listed.
 *
 * SAFETY: fixtures are namespaced with a fresh uuid and torn down by deleting
 * the git organization (cascading classrooms, teams, tags, repos) and the
 * users. Skipped unless DATABASE_URL names a LOCAL, non-shared database.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import * as teams from '../team.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

describe.skipIf(!RUN)('team.findTeamsForStudentInClassroom (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let orgId: string;
  let classX: string;
  let classY: string;
  let maya: string;
  let sam: string;
  let other: string;
  let atlas: string;

  const makeUser = async (name: string) =>
    (await prisma.user.create({ data: { name: `${name} ${suite}` }, select: { id: true } })).id;

  const makeClassroom = async (label: string) =>
    (
      await prisma.classroom.create({
        data: {
          slug: `teams-${label}-${suite}`,
          git_org_id: orgId,
          name: `Teams ${label} ${suite}`,
          content_namespace: `teams-${label}-${suite}`,
          content_repo: `content-teams-${label}-${suite}`,
        },
      })
    ).id;

  const makeTeam = (classroomId: string, name: string, memberIds: string[]) =>
    prisma.team
      .create({
        data: {
          classroom_id: classroomId,
          name: `${name} ${suite}`,
          slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${suite}`,
          memberships: { create: memberIds.map(user_id => ({ user_id })) },
        },
        select: { id: true },
      })
      .then(t => t.id);

  beforeAll(async () => {
    orgId = (
      await prisma.gitOrganization.create({
        data: { provider: 'GITHUB', provider_id: `teams-${suite}`, login: `teams-${suite}` },
      })
    ).id;
    classX = await makeClassroom('x');
    classY = await makeClassroom('y');
    maya = await makeUser('maya');
    sam = await makeUser('sam');
    other = await makeUser('other');

    // Team Atlas in X: tagged with a team set's tag AND a plain tag.
    atlas = await makeTeam(classX, 'Team Atlas', [maya, sam]);
    const setTag = await prisma.tag.create({ data: { classroom_id: classX, name: `p1-${suite}` } });
    const plainTag = await prisma.tag.create({
      data: { classroom_id: classX, name: `plain-${suite}` },
    });
    await prisma.teamTag.createMany({
      data: [
        { team_id: atlas, tag_id: setTag.id },
        { team_id: atlas, tag_id: plainTag.id },
      ],
    });
    const form = await prisma.form.create({
      data: {
        classroom_id: classX,
        title: `Team form ${suite}`,
        slug: `team-form-${suite}`,
        created_by: maya,
      },
    });
    await prisma.teamSet.create({
      data: {
        classroom_id: classX,
        form_id: form.id,
        name: `Project 1 teams ${suite}`,
        config: {},
        tag_id: setTag.id,
        created_by: maya,
      },
    });
    const repository = await prisma.repository.create({
      data: {
        classroom_id: classX,
        title: `Project 1 ${suite}`,
        type: 'GROUP',
        template: `template-${suite}`,
      },
    });
    await prisma.gitRepo.create({
      data: {
        provider: 'GITHUB',
        provider_id: `repo-${suite}`,
        name: `project-1-atlas-${suite}`,
        classroom_id: classX,
        repository_id: repository.id,
        team_id: atlas,
      },
    });

    // Maya is also in a team in classroom Y, and a team in X she is not in exists.
    await makeTeam(classY, 'Team Elsewhere', [maya]);
    await makeTeam(classX, 'Team Other', [other]);
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [maya, sam, other] } } }).catch(() => {});
  });

  it("lists only the student's teams in that classroom, with set, members and repos", async () => {
    const found = await teams.findTeamsForStudentInClassroom(classX, maya);
    expect(found.map(t => t.id)).toEqual([atlas]);
    const [team] = found;
    // The set's name, not the plain tag.
    expect(team.teamSets.map(s => s.name)).toEqual([`Project 1 teams ${suite}`]);
    expect(team.members.map(m => m.id).sort()).toEqual([maya, sam].sort());
    expect(team.repositories).toEqual([
      { name: `project-1-atlas-${suite}`, title: `Project 1 ${suite}` },
    ]);
  });

  it('never returns a team from another classroom', async () => {
    const inY = await teams.findTeamsForStudentInClassroom(classY, maya);
    expect(inY.map(t => t.name)).toEqual([`Team Elsewhere ${suite}`]);
    expect(inY[0].teamSets).toEqual([]);
  });

  it('is empty for a student in no team there', async () => {
    expect(await teams.findTeamsForStudentInClassroom(classY, sam)).toEqual([]);
  });
});
