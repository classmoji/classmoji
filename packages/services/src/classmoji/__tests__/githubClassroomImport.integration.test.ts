/**
 * The GitHub Classroom import against a REAL Postgres: which existing rows a
 * bundle's keys may update.
 *
 *   - A re-import updates an existing classroom in place only for an importer
 *     with an accepted OWNER membership in it, matched by either key (the
 *     course id, or a legacy row's org and slug).
 *   - Anyone else sending the same keys gets a new classroom of their own, and
 *     every row of the existing one (memberships, repositories, assignments,
 *     modules, teams, git repos, settings, its people and the organization) is
 *     left exactly as it was, `updated_at` included.
 *   - A membership that is not an accepted OWNER (teacher, assistant, student,
 *     pending owner invite) does not count.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * `afterAll` by deleting the git organizations (cascades classroom → modules,
 * repositories, memberships, git repos) and the users. Nothing is truncated.
 *
 * Skipped unless DATABASE_URL names a LOCAL database, and the SHARED dev
 * database only with CONTENT_INDEX_INTEGRATION=1 (the house rule; see
 * contentIndex.integration.test.ts).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type {
  ImportClassroomInput,
  ImportOrganizationVerification,
} from '../githubClassroomImport.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const optedIn = process.env.CONTENT_INDEX_INTEGRATION === '1';
const RUN = Boolean(DATABASE_URL) && isLocal && (!isSharedDevDb || optedIn);

const getPrisma = (await import('@classmoji/database')).default;
const { importGithubClassrooms } = await import('../githubClassroomImport.service.ts');
const { ensureDefaultScale } = await import('../emojiMapping.service.ts');

type Role = 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT';
type Key = 'course id' | 'legacy slug';

describe.skipIf(!RUN)('GitHub Classroom import: which classroom a re-import updates', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  // Numeric Github ids for this run (course ids are a 32-bit column).
  const base = 1_500_000_000 + Math.floor(Math.random() * 500_000_000);
  let worlds = 0;
  const orgProviderIds: string[] = [];
  const studentProviderIds: string[] = [];
  const userIds: string[] = [];

  afterAll(async () => {
    if (!RUN) return;
    await prisma.gitOrganization.deleteMany({
      where: { provider: 'GITHUB', provider_id: { in: orgProviderIds } },
    });
    const imported = await prisma.account.findMany({
      where: { provider_id: 'github', account_id: { in: studentProviderIds } },
      select: { user_id: true },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [...userIds, ...imported.map(a => a.user_id)] } },
    });
  });

  const makeUser = async (tag: string, data: { first_sign_in_at?: Date } = {}) => {
    const user = await prisma.user.create({ data: { name: `gci ${tag} ${suite}`, ...data } });
    userIds.push(user.id);
    return user.id;
  };

  /**
   * One GitHub Classroom course: its org, course id, slug, three students, an
   * individual assignment (a repo each) and a group assignment (one team repo).
   */
  const makeWorld = (key: Key) => {
    const n = ++worlds;
    const id = base + n * 100;
    const tag = `gci-${suite}-${n}`;
    orgProviderIds.push(String(id));
    const students = [1, 2, 3].map(i => {
      studentProviderIds.push(String(id + i));
      return { providerId: String(id + i), login: `${tag}-s${i}`, name: `Student ${i}` };
    });

    const bundle = (
      over: {
        name?: string;
        orgLogin?: string;
        githubId?: number;
        studentName?: string;
        extraStudent?: { providerId: string; login: string; name: string };
        /** This many more students, each with a repo of their own (at most 9). */
        moreStudents?: number;
        /** The organization id as the bundle gives it, when not this world's number. */
        orgId?: unknown;
        /** Students no one has imported yet, on the same repositories. */
        freshStudents?: boolean;
      } = {}
    ): ImportClassroomInput => {
      const roster = over.freshStudents
        ? students.map((s, i) => {
            const providerId = String(id + 90 + i);
            if (!studentProviderIds.includes(providerId)) studentProviderIds.push(providerId);
            return { ...s, providerId, login: `${tag}-f${i + 1}` };
          })
        : students;
      const people = roster.map(s => ({
        ...s,
        name: over.studentName ?? s.name,
        avatarUrl: over.studentName ? `https://example.com/${tag}.png` : null,
      }));
      const acceptances = people.map((s, i) => ({
        type: 'individual' as const,
        students: [s],
        repo: { providerId: String(id + 10 + i), name: `hw1-${s.login}` },
        commitCount: 3,
      }));
      for (let i = 0; i < (over.moreStudents ?? 0); i++) {
        const more = over.freshStudents
          ? { providerId: String(id + 95 + i), login: `${tag}-fm${i}`, name: `More ${i}` }
          : { providerId: String(id + 70 + i), login: `${tag}-m${i}`, name: `More ${i}` };
        if (!studentProviderIds.includes(more.providerId)) studentProviderIds.push(more.providerId);
        acceptances.push({
          type: 'individual' as const,
          students: [{ ...more, avatarUrl: null }],
          repo: { providerId: String(id + 80 + i), name: `hw1-${more.login}` },
          commitCount: 1,
        });
      }
      if (over.extraStudent) {
        acceptances.push({
          type: 'individual' as const,
          students: [{ ...over.extraStudent, avatarUrl: null }],
          repo: { providerId: String(id + 20), name: `hw1-${over.extraStudent.login}` },
          commitCount: 1,
        });
      }
      return {
        slug: tag,
        classroom: {
          // A legacy classroom is one imported before course ids were kept.
          githubId: over.githubId ?? (key === 'course id' ? id : 0),
          name: over.name ?? `Course ${tag}`,
          archived: false,
          organization: {
            id: ('orgId' in over ? over.orgId : id) as number,
            login: over.orgLogin ?? tag,
          },
          assignments: [
            {
              githubId: 1,
              title: 'HW 1',
              slug: 'hw1',
              type: 'individual',
              deadline: null,
              starterRepoFullName: `${tag}/hw1-starter`,
              acceptances,
            },
            {
              githubId: 2,
              title: 'Project',
              slug: 'proj',
              type: 'group',
              deadline: null,
              starterRepoFullName: `${tag}/proj-starter`,
              acceptances: [
                {
                  type: 'group',
                  students: people.slice(0, 2),
                  repo: { providerId: String(id + 30), name: 'proj-blue' },
                },
              ],
            },
          ],
          grades: [
            {
              assignmentTitle: 'HW 1',
              githubUsername: students[0].login,
              pointsAwarded: '9',
              pointsAvailable: '10',
            },
          ],
        },
      };
    };

    return { id, tag, students, bundle };
  };

  /**
   * What the route hands the service when Github says the importer owns each
   * input's organization, under `login` (else the bundle's).
   */
  const verifiedFor = (inputs: ImportClassroomInput[], login?: string) =>
    new Map<string, ImportOrganizationVerification>(
      inputs.map(input => {
        const githubId = String(input.classroom.organization.id);
        return [
          githubId,
          {
            githubId,
            verifiedAdmin: true,
            login: login ?? input.classroom.organization.login,
            reason: null,
          },
        ];
      })
    );

  const runImport = async (
    userId: string,
    input: ImportClassroomInput,
    /** `null`: the call carries no verification at all. */
    organizations: ReadonlyMap<string, ImportOrganizationVerification> | null = verifiedFor([input])
  ) => {
    const { results, errors } = await importGithubClassrooms(
      userId,
      [input],
      organizations ? { organizations } : {}
    );
    expect(errors).toEqual([]);
    expect(results).toHaveLength(1);
    // As the import route does next.
    await ensureDefaultScale(results[0].classroomId);
    return results[0];
  };

  const acceptedOwner = (classroomId: string, userId: string) =>
    prisma.classroomMembership.findFirst({
      where: {
        classroom_id: classroomId,
        user_id: userId,
        role: 'OWNER',
        has_accepted_invite: true,
      },
    });

  /** Every row of the classroom, its people and its organization, `updated_at` included. */
  const snapshot = async (classroomId: string) => {
    const byId = { orderBy: { id: 'asc' as const } };
    const classroom = await prisma.classroom.findUniqueOrThrow({
      where: { id: classroomId },
      include: {
        settings: true,
        git_organization: true,
        memberships: byId,
        modules: { ...byId, include: { assignments: byId } },
        repositories: { ...byId, include: { assignments: byId } },
        teams: { ...byId, include: { memberships: { orderBy: { user_id: 'asc' } } } },
        git_repos: byId,
      },
    });
    const people = await prisma.user.findMany({
      where: { id: { in: classroom.memberships.map(m => m.user_id) } },
      include: { accounts: byId },
      ...byId,
    });
    return JSON.parse(JSON.stringify({ classroom, people }));
  };

  /**
   * An existing classroom with data in it, imported by its owner. A placeholder
   * person (known by Github login only) is added to it, as the roster does.
   */
  const existingClassroom = async (key: Key) => {
    const world = makeWorld(key);
    const ownerId = await makeUser(`owner-${world.tag}`);
    const first = await runImport(ownerId, world.bundle());
    expect(first.reimported).toBe(false);
    const classroom = await prisma.classroom.findUniqueOrThrow({
      where: { id: first.classroomId },
    });
    expect(classroom.github_classroom_id).toBe(key === 'course id' ? world.id : null);

    const placeholderLogin = `${world.tag}-ph`;
    const placeholder = await prisma.user.create({
      data: {
        name: 'Placeholder',
        accounts: {
          create: {
            provider_id: 'github',
            account_id: `unresolved:${randomUUID()}`,
            username: placeholderLogin,
          },
        },
      },
    });
    userIds.push(placeholder.id);
    await prisma.classroomMembership.create({
      data: { classroom_id: classroom.id, user_id: placeholder.id, role: 'STUDENT' },
    });
    const placeholderStudent = {
      providerId: String(world.id + 40),
      login: placeholderLogin,
      name: 'Placeholder Renamed',
    };
    studentProviderIds.push(placeholderStudent.providerId);

    // The same keys as the first import, with every field a bundle can change
    // changed: the course name, the org login, the students' names and avatars,
    // and a placeholder's Github id.
    const changedBundle = (githubId?: number) =>
      world.bundle({
        name: `Renamed ${world.tag}`,
        orgLogin: `${world.tag}-renamed`,
        studentName: 'Renamed Student',
        extraStudent: placeholderStudent,
        ...(githubId != null ? { githubId } : {}),
      });

    return { world, ownerId, classroomId: classroom.id, placeholder, changedBundle };
  };

  /** Another user sends the existing classroom's keys: they get a classroom of their own. */
  const expectNewClassroomAndUnchanged = async (
    existing: Awaited<ReturnType<typeof existingClassroom>>,
    importerId: string,
    key: Key
  ) => {
    const before = await snapshot(existing.classroomId);

    // The legacy row carries no course id; the other import brings a new one.
    const result = await runImport(
      importerId,
      existing.changedBundle(key === 'legacy slug' ? existing.world.id + 50 : undefined)
    );

    expect(result.reimported).toBe(false);
    expect(result.classroomId).not.toBe(existing.classroomId);
    expect(await acceptedOwner(result.classroomId, importerId)).not.toBeNull();
    // Every person of the bundle already has an account, in the existing
    // classroom: none is enrolled here, and nothing is linked for them.
    expect(result.studentsEnrolled).toBe(0);
    expect(result.reposLinked).toBe(0);
    expect(result.groupReposLinked).toBe(0);
    expect(result.gradesRecorded).toBe(0);
    expect(result.teamsImported).toBe(0);
    expect(result.teamMembershipsImported).toBe(0);
    expect(result.existingAccountsNotEnrolled).toBe(existing.world.students.length + 1);
    for (const login of [
      ...existing.world.students.map(s => s.login),
      `${existing.world.tag}-ph`,
    ]) {
      expect(result.warnings).toContain(
        `@${login} is already on Classmoji; add them by email from Students.`
      );
    }
    expect(
      await prisma.classroomMembership.findMany({
        where: { classroom_id: result.classroomId },
        select: { user_id: true, role: true },
      })
    ).toEqual([{ user_id: importerId, role: 'OWNER' }]);
    expect(await prisma.team.count({ where: { classroom_id: result.classroomId } })).toBe(0);
    expect(await prisma.gitRepo.count({ where: { classroom_id: result.classroomId } })).toBe(0);

    const created = await prisma.classroom.findUniqueOrThrow({ where: { id: result.classroomId } });
    expect(created.name).toBe(`Renamed ${existing.world.tag}`);
    expect(created.created_by).toBe(importerId);
    expect(created.plan_owner_id).toBe(importerId);
    if (key === 'course id') expect(created.github_classroom_id).toBeNull();
    else expect(created.github_classroom_id).toBe(existing.world.id + 50);

    expect(await snapshot(existing.classroomId)).toEqual(before);
    return result;
  };

  describe.each<Key>(['course id', 'legacy slug'])('matched by %s', key => {
    it('an owner re-import updates the classroom in place', async () => {
      const existing = await existingClassroom(key);
      const before = await prisma.gitRepo.count({ where: { classroom_id: existing.classroomId } });

      const result = await runImport(existing.ownerId, existing.changedBundle());

      expect(result.reimported).toBe(true);
      expect(result.classroomId).toBe(existing.classroomId);
      expect(result.organizationLogin).toBe(`${existing.world.tag}-renamed`);
      expect(result.reposLinked).toBe(4);
      expect(result.groupReposLinked).toBe(1);
      const classroom = await prisma.classroom.findUniqueOrThrow({
        where: { id: existing.classroomId },
        include: { git_organization: true },
      });
      expect(classroom.name).toBe(`Renamed ${existing.world.tag}`);
      // The owner holds every classroom in the org, which has no installation.
      expect(classroom.git_organization.login).toBe(`${existing.world.tag}-renamed`);
      expect(await prisma.gitRepo.count({ where: { classroom_id: existing.classroomId } })).toBe(
        before + 1
      );

      // People the import made, only in the owner's classrooms, take the new profile.
      const s1 = await prisma.account.findUniqueOrThrow({
        where: {
          provider_id_account_id: {
            provider_id: 'github',
            account_id: existing.world.students[0].providerId,
          },
        },
        include: { user: true },
      });
      expect(s1.user.name).toBe('Renamed Student');
      // The placeholder in the owner's classroom takes its Github id.
      const placeholder = await prisma.account.findFirstOrThrow({
        where: { user_id: existing.placeholder.id },
      });
      expect(placeholder.account_id).toBe(String(existing.world.id + 40));
    });

    it('another user sending the same keys gets a new classroom, and the existing one is unchanged', async () => {
      const existing = await existingClassroom(key);
      const otherId = await makeUser(`other-${existing.world.tag}`);

      const result = await expectNewClassroomAndUnchanged(existing, otherId, key);

      expect(
        await prisma.classroomMembership.count({
          where: { classroom_id: existing.classroomId, user_id: otherId },
        })
      ).toBe(0);
      expect(result.warnings.some(w => w.startsWith('Skipped repository'))).toBe(false);
    });

    it.each<{ label: string; role: Role; accepted: boolean }>([
      { label: 'an accepted TEACHER', role: 'TEACHER', accepted: true },
      { label: 'an accepted ASSISTANT', role: 'ASSISTANT', accepted: true },
      { label: 'an accepted STUDENT', role: 'STUDENT', accepted: true },
      { label: 'a pending OWNER invite', role: 'OWNER', accepted: false },
    ])('$label of the classroom gets a new classroom of their own', async ({ role, accepted }) => {
      const existing = await existingClassroom(key);
      const memberId = await makeUser(`member-${role}-${existing.world.tag}`);
      await prisma.classroomMembership.create({
        data: {
          classroom_id: existing.classroomId,
          user_id: memberId,
          role,
          has_accepted_invite: accepted,
        },
      });

      await expectNewClassroomAndUnchanged(existing, memberId, key);
    });
  });

  it('two classrooms X and Y: each owner updates only their own', async () => {
    const x = await existingClassroom('course id');
    const y = await existingClassroom('legacy slug');
    const xBefore = await snapshot(x.classroomId);
    const yBefore = await snapshot(y.classroomId);

    // X's owner sends Y's keys, and Y's owner sends X's.
    const xIntoY = await runImport(x.ownerId, y.changedBundle(y.world.id + 50));
    const yIntoX = await runImport(y.ownerId, x.changedBundle());

    expect(xIntoY.reimported).toBe(false);
    expect(yIntoX.reimported).toBe(false);
    expect([x.classroomId, y.classroomId]).not.toContain(xIntoY.classroomId);
    expect([x.classroomId, y.classroomId]).not.toContain(yIntoX.classroomId);
    expect(await snapshot(x.classroomId)).toEqual(xBefore);
    expect(await snapshot(y.classroomId)).toEqual(yBefore);

    // Each owner's own re-import still lands on their own classroom.
    expect((await runImport(x.ownerId, x.changedBundle())).classroomId).toBe(x.classroomId);
    expect((await runImport(y.ownerId, y.changedBundle())).classroomId).toBe(y.classroomId);
  });

  it('a re-import keeps the login of an organization with the Github App installed', async () => {
    const existing = await existingClassroom('course id');
    const { git_org_id } = await prisma.classroom.findUniqueOrThrow({
      where: { id: existing.classroomId },
    });
    await prisma.gitOrganization.update({
      where: { id: git_org_id },
      data: { github_installation_id: String(existing.world.id + 60) },
    });

    const result = await runImport(existing.ownerId, existing.changedBundle());

    expect(result.reimported).toBe(true);
    expect(result.appInstalled).toBe(true);
    const org = await prisma.gitOrganization.findUniqueOrThrow({ where: { id: git_org_id } });
    expect(org.login).toBe(existing.world.tag);
    // The summary names the login the organization has, not the bundle's.
    expect(result.organizationLogin).toBe(existing.world.tag);
  });

  it("a re-import of the importer's classroom in another organization describes that organization", async () => {
    const world = makeWorld('course id');
    const ownerId = await makeUser(`owner-${world.tag}`);
    const first = await runImport(ownerId, world.bundle());
    // The owner's classroom for the course now lives in another organization,
    // one with the Classmoji Github app installed.
    const other = makeWorld('course id');
    const otherOrg = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: String(other.id),
        login: other.tag,
        github_installation_id: String(other.id + 60),
      },
    });
    await prisma.classroom.update({
      where: { id: first.classroomId },
      data: { git_org_id: otherOrg.id },
    });

    const result = await runImport(ownerId, world.bundle());

    expect(result.reimported).toBe(true);
    expect(result.classroomId).toBe(first.classroomId);
    expect(result.organizationLogin).toBe(other.tag);
    expect(result.appInstalled).toBe(true);
  });

  it('an import keeps the profile of a person who has signed in', async () => {
    const world = makeWorld('course id');
    const ownerId = await makeUser(`owner-${world.tag}`);
    const s1 = world.students[0];
    const personId = await makeUser(`person-${world.tag}`, { first_sign_in_at: new Date() });
    await prisma.account.create({
      data: {
        user_id: personId,
        provider_id: 'github',
        account_id: s1.providerId,
        username: `${s1.login}-own`,
        access_token: 'token',
      },
    });
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: personId },
      include: { accounts: true },
    });

    const result = await runImport(ownerId, world.bundle({ studentName: 'Renamed Student' }));

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: personId },
      include: { accounts: true },
    });
    expect(JSON.parse(JSON.stringify(after))).toEqual(JSON.parse(JSON.stringify(before)));
    // They have an account of their own: the import does not enroll them.
    expect(await prisma.classroomMembership.count({ where: { user_id: personId } })).toBe(0);
    expect(result.warnings).toContain(
      `@${s1.login} is already on Classmoji; add them by email from Students.`
    );
  });

  /** A person and their accounts, as stored. */
  const person = async (userId: string) =>
    JSON.parse(
      JSON.stringify(
        await prisma.user.findUniqueOrThrow({
          where: { id: userId },
          include: { accounts: { orderBy: { id: 'asc' } } },
        })
      )
    );

  const userIdOf = async (providerId: string) =>
    (
      await prisma.account.findUniqueOrThrow({
        where: { provider_id_account_id: { provider_id: 'github', account_id: providerId } },
      })
    ).user_id;

  it('an import keeps the profile and placeholder of a person in no classroom', async () => {
    const world = makeWorld('course id');
    const ownerId = await makeUser(`owner-${world.tag}`);
    const s1 = world.students[0];
    // Never signed in, no membership anywhere, known by Github id.
    const loneId = await makeUser(`lone-${world.tag}`);
    await prisma.account.create({
      data: {
        user_id: loneId,
        provider_id: 'github',
        account_id: s1.providerId,
        username: s1.login,
      },
    });
    // A placeholder known by Github login only, no membership anywhere.
    const placeholderLogin = `${world.tag}-ph`;
    const placeholder = await prisma.user.create({
      data: {
        name: 'Placeholder',
        accounts: {
          create: {
            provider_id: 'github',
            account_id: `unresolved:${randomUUID()}`,
            username: placeholderLogin,
          },
        },
      },
    });
    userIds.push(placeholder.id);
    const placeholderStudent = {
      providerId: String(world.id + 40),
      login: placeholderLogin,
      name: 'Placeholder Renamed',
    };
    studentProviderIds.push(placeholderStudent.providerId);
    const loneBefore = await person(loneId);
    const placeholderBefore = await person(placeholder.id);

    await runImport(
      ownerId,
      world.bundle({ studentName: 'Renamed Student', extraStudent: placeholderStudent })
    );

    expect(await person(loneId)).toEqual(loneBefore);
    expect(await person(placeholder.id)).toEqual(placeholderBefore);
    // Neither is enrolled: they have accounts the import may not update.
    expect(
      await prisma.classroomMembership.count({
        where: { user_id: { in: [loneId, placeholder.id] } },
      })
    ).toBe(0);
    // A classmate the import created takes the bundle's profile.
    expect((await person(await userIdOf(world.students[1].providerId))).name).toBe(
      'Renamed Student'
    );
  });

  it.each<{ label: string; mark: (userId: string, providerId: string) => Promise<unknown> }>([
    {
      label: 'has signed in once',
      mark: userId =>
        prisma.user.update({ where: { id: userId }, data: { first_sign_in_at: new Date() } }),
    },
    {
      label: 'has a session',
      mark: userId =>
        prisma.session.create({
          data: {
            user_id: userId,
            token: `gci-${randomUUID()}`,
            expires_at: new Date(Date.now() + 3_600_000),
          },
        }),
    },
    {
      label: 'has an account with an access token',
      mark: (_userId, providerId) =>
        prisma.account.update({
          where: { provider_id_account_id: { provider_id: 'github', account_id: providerId } },
          data: { access_token: 'token' },
        }),
    },
    {
      label: 'has a password',
      mark: userId =>
        prisma.account.create({
          data: {
            user_id: userId,
            provider_id: 'credential',
            account_id: userId,
            password: 'hash',
          },
        }),
    },
  ])('an owner re-import keeps the profile of a student who $label', async ({ mark }) => {
    const world = makeWorld('course id');
    const ownerId = await makeUser(`owner-${world.tag}`);
    await runImport(ownerId, world.bundle());
    const s1 = world.students[0];
    const s1Id = await userIdOf(s1.providerId);
    await mark(s1Id, s1.providerId);
    const before = await person(s1Id);

    const result = await runImport(ownerId, world.bundle({ studentName: 'Renamed Student' }));

    expect(result.reimported).toBe(true);
    expect(await person(s1Id)).toEqual(before);
    // A classmate who differs in nothing else takes the bundle's profile.
    const classmate = await person(await userIdOf(world.students[1].providerId));
    expect(classmate.name).toBe('Renamed Student');
    expect(classmate.image).toBe(`https://example.com/${world.tag}.png`);
  });

  it("re-imports land on the importer's one classroom when another classroom holds the course id", async () => {
    const world = makeWorld('course id');
    const holderId = await makeUser(`holder-${world.tag}`);
    // The holder's classroom carries the course id and the requested slug.
    const held = await runImport(holderId, world.bundle());
    const importerId = await makeUser(`importer-${world.tag}`);
    // The bundle's org login differs from the organization row's, which the
    // importer may not rename (the holder's classroom is in it).
    const bundle = world.bundle({ orgLogin: `${world.tag}-renamed` });

    const results = [];
    for (let i = 0; i < 12; i++) results.push(await runImport(importerId, bundle));
    results.push(
      await runImport(
        importerId,
        world.bundle({ orgLogin: `${world.tag}-renamed`, name: `Renamed ${world.tag}` })
      )
    );

    expect(new Set(results.map(r => r.classroomId)).size).toBe(1);
    expect(results[0].classroomId).not.toBe(held.classroomId);
    expect(results.map(r => r.reimported)).toEqual([false, ...Array(12).fill(true)]);
    expect(results.every(r => r.organizationLogin === world.tag)).toBe(true);
    const own = await prisma.classroom.findMany({ where: { created_by: importerId } });
    expect(own).toHaveLength(1);
    expect(own[0].slug).toBe(`${world.tag}-${world.tag}-renamed`);
    expect(own[0].github_classroom_id).toBeNull();
    // The last re-import renamed it in place.
    expect(own[0].name).toBe(`Renamed ${world.tag}`);
    const holder = await prisma.classroom.findUniqueOrThrow({ where: { id: held.classroomId } });
    expect(holder.github_classroom_id).toBe(world.id);
  }, 120_000);

  it('a classroom the importer owns but did not create is not matched on a slug candidate', async () => {
    const world = makeWorld('course id');
    const holderId = await makeUser(`holder-${world.tag}`);
    const held = await runImport(holderId, world.bundle());
    const importerId = await makeUser(`importer-${world.tag}`);
    const creatorId = await makeUser(`creator-${world.tag}`);
    // Another person's classroom in this organization, on a slug candidate and
    // without a course id, that the importer co-owns.
    const coOwned = await prisma.classroom.create({
      data: {
        git_org_id: (await prisma.classroom.findUniqueOrThrow({ where: { id: held.classroomId } }))
          .git_org_id,
        slug: `${world.tag}-2`,
        name: 'Co-owned',
        content_namespace: `${world.tag}-2`,
        content_repo: `${world.tag}-2-content`,
        created_by: creatorId,
        plan_owner_id: creatorId,
        memberships: {
          create: [
            { user_id: creatorId, role: 'OWNER', has_accepted_invite: true },
            { user_id: importerId, role: 'OWNER', has_accepted_invite: true },
          ],
        },
      },
    });
    const before = await snapshot(coOwned.id);

    const result = await runImport(importerId, world.bundle());

    expect(result.reimported).toBe(false);
    expect([held.classroomId, coOwned.id]).not.toContain(result.classroomId);
    expect(await snapshot(coOwned.id)).toEqual(before);
  });

  it.each([
    { label: 'five', more: 1, perRepo: true },
    { label: 'more than five', more: 3, perRepo: false },
  ])('$label repositories in another classroom', async ({ more, perRepo }) => {
    const world = makeWorld('course id');
    const holderId = await makeUser(`holder-${world.tag}`);
    await runImport(holderId, world.bundle({ moreStudents: more }));
    const otherId = await makeUser(`other-${world.tag}`);

    // New people, on the repositories the holder's classroom already has.
    const result = await runImport(
      otherId,
      world.bundle({ moreStudents: more, freshStudents: true })
    );

    const skipped = 3 + more + 1;
    const perRepoLines = result.warnings.filter(w => w.startsWith('Skipped repository "'));
    if (perRepo) {
      expect(perRepoLines).toHaveLength(skipped);
      expect(result.warnings.some(w => /^Skipped \d+ repositories/.test(w))).toBe(false);
    } else {
      expect(perRepoLines).toHaveLength(0);
      expect(result.warnings).toContain(
        `Skipped ${skipped} repositories (they belong to other classrooms).`
      );
    }
  });

  it.each<{ label: string; orgId: unknown }>([
    { label: 'zero', orgId: 0 },
    { label: 'negative', orgId: -5 },
    { label: 'fractional', orgId: 1.5 },
    { label: 'beyond a safe integer', orgId: Number.MAX_SAFE_INTEGER + 1 },
    { label: 'a leading-zero string', orgId: '0042' },
    { label: 'a non-numeric string', orgId: 'acme' },
    { label: 'an empty string', orgId: '' },
    { label: 'missing', orgId: undefined },
    { label: 'null', orgId: null },
  ])('refuses a classroom whose organization id is $label, before any write', async ({ orgId }) => {
    const world = makeWorld('course id');
    const ownerId = await makeUser(`owner-${world.tag}`);
    const input = world.bundle({ orgId });

    const { results, errors } = await importGithubClassrooms(ownerId, [input]);

    expect(results).toEqual([]);
    expect(errors).toEqual([
      {
        classroomName: input.classroom.name,
        message: `Classroom "${input.classroom.name}" has no valid Github organization id and can't be imported.`,
      },
    ]);
    expect(await prisma.gitOrganization.count({ where: { login: world.tag } })).toBe(0);
    expect(await prisma.classroom.count({ where: { name: input.classroom.name } })).toBe(0);
    expect(await prisma.classroomMembership.count({ where: { user_id: ownerId } })).toBe(0);
  });

  it('takes an organization id given as its digits as the same organization', async () => {
    const world = makeWorld('course id');
    const ownerId = await makeUser(`owner-${world.tag}`);

    const first = await runImport(ownerId, world.bundle({ orgId: String(world.id) }));
    const second = await runImport(ownerId, world.bundle());

    expect(second.reimported).toBe(true);
    expect(second.classroomId).toBe(first.classroomId);
    const org = await prisma.gitOrganization.findUniqueOrThrow({
      where: { provider_provider_id: { provider: 'GITHUB', provider_id: String(world.id) } },
      include: { classrooms: true },
    });
    expect(org.classrooms.map(c => c.id)).toEqual([first.classroomId]);
  });

  describe('the Github organization check', () => {
    /**
     * Every row an import of `input` could write that is not some other
     * test's: its organization and that organization's classrooms, classrooms
     * of its name or made by the importer, the importer's memberships, and the
     * people (with accounts) of its roster.
     */
    const footprint = async (input: ImportClassroomInput, importerId: string) => {
      const providerIds = input.classroom.assignments.flatMap(a =>
        a.acceptances.flatMap(acc => acc.students.map(st => st.providerId))
      );
      return JSON.parse(
        JSON.stringify({
          orgs: await prisma.gitOrganization.findMany({
            where: { provider: 'GITHUB', provider_id: String(input.classroom.organization.id) },
            include: { classrooms: { orderBy: { id: 'asc' } } },
          }),
          classrooms: await prisma.classroom.findMany({
            where: { OR: [{ name: input.classroom.name }, { created_by: importerId }] },
            orderBy: { id: 'asc' },
          }),
          memberships: await prisma.classroomMembership.findMany({
            where: { user_id: importerId },
            orderBy: { id: 'asc' },
          }),
          accounts: await prisma.account.findMany({
            where: { provider_id: 'github', account_id: { in: providerIds } },
            include: { user: true },
            orderBy: { id: 'asc' },
          }),
        })
      );
    };

    /** The refusal for an organization with the Classmoji Github app installed. */
    const ownerRefusal = (input: ImportClassroomInput) =>
      `You need to be an owner of the Github organization ${input.classroom.organization.login} to import this classroom.`;
    /** The refusal for an organization without an installation Classmoji knows of. */
    const refusal = (input: ImportClassroomInput) =>
      `Install the Classmoji Github app on ${input.classroom.organization.login} first (an organization owner can), then import again.`;

    it('refuses a classroom whose organization the importer is not verified for, writing nothing; the others import', async () => {
      const a = makeWorld('course id');
      const b = makeWorld('course id');
      const importerId = await makeUser(`importer-${b.tag}`);
      const inputA = a.bundle();
      const inputB = b.bundle();
      const organizations = verifiedFor([inputA]);
      organizations.set(String(b.id), {
        githubId: String(b.id),
        verifiedAdmin: false,
        login: null,
        reason: 'not_admin',
      });
      const before = await footprint(inputB, importerId);
      const bOnly = JSON.stringify(before.accounts);

      const { results, errors } = await importGithubClassrooms(importerId, [inputB, inputA], {
        organizations,
      });

      expect(errors).toEqual([{ classroomName: inputB.classroom.name, message: refusal(inputB) }]);
      expect(results.map(r => r.classroomName)).toEqual([inputA.classroom.name]);
      const after = await footprint(inputB, importerId);
      expect(after.orgs).toEqual(before.orgs);
      expect(JSON.stringify(after.accounts)).toBe(bOnly);
      // Only A's classroom (and the importer's membership in it) is new.
      expect(after.classrooms.map((c: { name: string }) => c.name)).toEqual([
        inputA.classroom.name,
      ]);
      expect(after.memberships).toHaveLength(1);
    });

    it.each<{ label: string; options: (input: ImportClassroomInput, otherId: string) => unknown }>([
      { label: 'no verification at all', options: () => ({}) },
      {
        label: 'a verification for another organization only',
        options: (_input, otherId) => ({
          organizations: new Map([
            [otherId, { githubId: otherId, verifiedAdmin: true, login: 'other', reason: null }],
          ]),
        }),
      },
      {
        label: "an entry whose Github id is not the export's",
        options: (input, otherId) => ({
          organizations: new Map([
            [
              String(input.classroom.organization.id),
              { githubId: otherId, verifiedAdmin: true, login: 'other', reason: null },
            ],
          ]),
        }),
      },
      {
        label: 'an entry that is not verified',
        options: input => ({
          organizations: new Map([
            [
              String(input.classroom.organization.id),
              {
                githubId: String(input.classroom.organization.id),
                verifiedAdmin: false,
                login: input.classroom.organization.login,
                reason: null,
              },
            ],
          ]),
        }),
      },
      {
        label: 'an entry with no usable login',
        options: input => ({
          organizations: new Map([
            [
              String(input.classroom.organization.id),
              {
                githubId: String(input.classroom.organization.id),
                verifiedAdmin: true,
                login: '<b>x</b>',
                reason: null,
              },
            ],
          ]),
        }),
      },
      {
        label: 'a plain object instead of a Map',
        options: input => ({
          organizations: {
            [String(input.classroom.organization.id)]: {
              githubId: String(input.classroom.organization.id),
              verifiedAdmin: true,
              login: input.classroom.organization.login,
              reason: null,
            },
          },
        }),
      },
    ])('refuses a new classroom with $label, writing nothing', async ({ options }) => {
      const world = makeWorld('course id');
      const importerId = await makeUser(`importer-${world.tag}`);
      const input = world.bundle();
      const before = await footprint(input, importerId);

      const { results, errors } = await importGithubClassrooms(
        importerId,
        [input],
        options(input, String(world.id + 99)) as Parameters<typeof importGithubClassrooms>[2]
      );

      expect(results).toEqual([]);
      expect(errors).toEqual([{ classroomName: input.classroom.name, message: refusal(input) }]);
      expect(await footprint(input, importerId)).toEqual(before);
    });

    it('says what to do when the check could not be made', async () => {
      const world = makeWorld('course id');
      const importerId = await makeUser(`importer-${world.tag}`);
      const input = world.bundle();
      const githubId = String(world.id);

      const { errors } = await importGithubClassrooms(importerId, [input], {
        organizations: new Map([
          [githubId, { githubId, verifiedAdmin: false, login: null, reason: 'no_github' }],
        ]),
      });

      expect(errors[0].message).toBe(`${ownerRefusal(input)} Sign in with Github, then try again.`);
    });

    it('says to try again when Github did not answer about an organization without the app', async () => {
      const world = makeWorld('course id');
      const importerId = await makeUser(`importer-${world.tag}`);
      const input = world.bundle();
      const githubId = String(world.id);

      const { errors } = await importGithubClassrooms(importerId, [input], {
        organizations: new Map([
          [githubId, { githubId, verifiedAdmin: false, login: null, reason: 'unreachable' }],
        ]),
      });

      expect(errors[0].message).toBe(
        `${ownerRefusal(input)} Classmoji could not reach Github; try again in a moment.`
      );
    });

    it.each<{ label: string; reason: ImportOrganizationVerification['reason']; hint: string }>([
      { label: 'not an owner', reason: 'not_admin', hint: '' },
      {
        label: 'not shown the organization',
        reason: 'no_access',
        hint: ' If you are an owner, grant Classmoji access to the organization on Github, then try again.',
      },
      { label: 'not checked', reason: null, hint: '' },
    ])(
      'an organization with the Classmoji Github app, importer $label: says to be an owner',
      async ({ reason, hint }) => {
        const world = makeWorld('course id');
        const holderId = await makeUser(`holder-${world.tag}`);
        const held = await runImport(holderId, world.bundle());
        const { git_org_id } = await prisma.classroom.findUniqueOrThrow({
          where: { id: held.classroomId },
        });
        await prisma.gitOrganization.update({
          where: { id: git_org_id },
          data: { github_installation_id: String(world.id + 60) },
        });
        const importerId = await makeUser(`importer-${world.tag}`);
        const input = world.bundle();
        const githubId = String(world.id);
        const before = await footprint(input, importerId);

        const { results, errors } = await importGithubClassrooms(importerId, [input], {
          organizations: new Map([
            [githubId, { githubId, verifiedAdmin: false, login: null, reason }],
          ]),
        });

        expect(results).toEqual([]);
        expect(errors).toEqual([
          { classroomName: input.classroom.name, message: `${ownerRefusal(input)}${hint}` },
        ]);
        expect(await footprint(input, importerId)).toEqual(before);
      }
    );

    it('an unverified import leaves an existing organization and its classroom as they are', async () => {
      const world = makeWorld('course id');
      const holderId = await makeUser(`holder-${world.tag}`);
      const held = await runImport(holderId, world.bundle());
      const importerId = await makeUser(`importer-${world.tag}`);
      const input = world.bundle({ orgLogin: `${world.tag}-renamed` });
      const heldBefore = await snapshot(held.classroomId);
      const before = await footprint(input, importerId);

      const { results, errors } = await importGithubClassrooms(importerId, [input]);

      expect(results).toEqual([]);
      expect(errors).toEqual([{ classroomName: input.classroom.name, message: refusal(input) }]);
      expect(await snapshot(held.classroomId)).toEqual(heldBefore);
      expect(await footprint(input, importerId)).toEqual(before);
    });

    describe.each<Key>(['course id', 'legacy slug'])('matched by %s', key => {
      it.each<{
        label: string;
        organizations: (id: string) => Map<string, ImportOrganizationVerification> | null;
      }>([
        { label: 'no verification', organizations: () => null },
        {
          label: 'a check that failed',
          organizations: id =>
            new Map([
              [id, { githubId: id, verifiedAdmin: false, login: null, reason: 'unreachable' }],
            ]),
        },
      ])(
        "an owner re-import with $label updates in place and keeps the organization's login",
        async ({ organizations }) => {
          const existing = await existingClassroom(key);
          const result = await runImport(
            existing.ownerId,
            existing.changedBundle(),
            organizations(String(existing.world.id))
          );

          expect(result.reimported).toBe(true);
          expect(result.classroomId).toBe(existing.classroomId);
          expect(result.organizationLogin).toBe(existing.world.tag);
          const classroom = await prisma.classroom.findUniqueOrThrow({
            where: { id: existing.classroomId },
            include: { git_organization: true },
          });
          expect(classroom.name).toBe(`Renamed ${existing.world.tag}`);
          expect(classroom.git_organization.login).toBe(existing.world.tag);
        }
      );
    });

    it("takes Github's login, not the export's, for the organization and the slug", async () => {
      const first = makeWorld('course id');
      const firstOwner = await makeUser(`owner-${first.tag}`);
      await runImport(firstOwner, first.bundle());
      const world = makeWorld('course id');
      const importerId = await makeUser(`importer-${world.tag}`);
      // The requested slug is taken, so the next candidate names the organization.
      const input = { ...world.bundle({ orgLogin: 'export-login' }), slug: first.tag };

      const result = await runImport(importerId, input, verifiedFor([input], `${world.tag}-gh`));

      expect(result.organizationLogin).toBe(`${world.tag}-gh`);
      expect(result.classroomSlug).toBe(`${first.tag}-${world.tag}-gh`);
      const org = await prisma.gitOrganization.findUniqueOrThrow({
        where: { provider_provider_id: { provider: 'GITHUB', provider_id: String(world.id) } },
      });
      expect(org.login).toBe(`${world.tag}-gh`);
    });
  });

  describe('people with an account of their own', () => {
    const peopleLine = (login: string) =>
      `@${login} is already on Classmoji; add them by email from Students.`;

    /** A person who has signed in, with the Github account `providerId`. */
    const signedIn = async (tag: string, providerId: string, login: string) => {
      const id = await makeUser(`signed-in-${tag}`, { first_sign_in_at: new Date() });
      await prisma.account.create({
        data: {
          user_id: id,
          provider_id: 'github',
          account_id: providerId,
          username: `${login}-own`,
          access_token: 'token',
        },
      });
      return id;
    };

    it('are not enrolled, and stay exactly as they were, over one, two and three runs', async () => {
      const world = makeWorld('course id');
      const ownerId = await makeUser(`owner-${world.tag}`);
      const [s1, s2, s3] = world.students;
      // s1 has signed in; s2 never signed in and is in no classroom.
      const signedInId = await signedIn(world.tag, s1.providerId, s1.login);
      const loneId = await makeUser(`lone-${world.tag}`);
      await prisma.account.create({
        data: {
          user_id: loneId,
          provider_id: 'github',
          account_id: s2.providerId,
          username: s2.login,
        },
      });
      // A placeholder known by Github login only, in no classroom.
      const placeholderLogin = `${world.tag}-ph`;
      const placeholder = await prisma.user.create({
        data: {
          name: 'Placeholder',
          accounts: {
            create: {
              provider_id: 'github',
              account_id: `unresolved:${randomUUID()}`,
              username: placeholderLogin,
            },
          },
        },
      });
      userIds.push(placeholder.id);
      const extraStudent = {
        providerId: String(world.id + 40),
        login: placeholderLogin,
        name: 'Placeholder Renamed',
      };
      studentProviderIds.push(extraStudent.providerId);
      const people = [signedInId, loneId, placeholder.id];
      const before = await Promise.all(people.map(person));
      const input = world.bundle({ studentName: 'Renamed Student', extraStudent });

      for (let run = 1; run <= 3; run++) {
        const result = await runImport(ownerId, input);

        expect(result.reimported).toBe(run > 1);
        expect(await Promise.all(people.map(person))).toEqual(before);
        expect(await prisma.classroomMembership.count({ where: { user_id: { in: people } } })).toBe(
          0
        );
        expect(await prisma.teamMembership.count({ where: { user_id: { in: people } } })).toBe(0);
        expect(await prisma.gitRepo.count({ where: { student_id: { in: people } } })).toBe(0);
        // Only s3, whom the import made, is enrolled and linked. The group is
        // s1 and s2 only: no team and no team repository.
        expect(result.studentsEnrolled).toBe(1);
        expect(result.reposLinked).toBe(1);
        expect(result.gradesRecorded).toBe(0);
        expect(result.teamsImported).toBe(0);
        expect(result.teamMembershipsImported).toBe(0);
        expect(result.groupReposLinked).toBe(0);
        expect(await prisma.team.count({ where: { classroom_id: result.classroomId } })).toBe(0);
        expect(
          await prisma.gitRepo.findMany({
            where: { classroom_id: result.classroomId },
            select: { student_id: true },
          })
        ).toEqual([{ student_id: await userIdOf(s3.providerId) }]);
        expect(result.warnings).toEqual(
          expect.arrayContaining([
            peopleLine(s1.login),
            peopleLine(s2.login),
            peopleLine(placeholderLogin),
          ])
        );
        // Their grades are not reported a second time.
        expect(result.warnings.some(w => w.startsWith('Grades for'))).toBe(false);
      }
    });

    it('a group keeps its enrolled members and leaves out the others', async () => {
      const world = makeWorld('course id');
      const ownerId = await makeUser(`owner-${world.tag}`);
      const signedInId = await signedIn(
        world.tag,
        world.students[0].providerId,
        world.students[0].login
      );

      const result = await runImport(ownerId, world.bundle());

      expect(result.teamsImported).toBe(1);
      expect(result.teamMembershipsImported).toBe(1);
      expect(result.groupReposLinked).toBe(1);
      expect(result.studentsEnrolled).toBe(2);
      expect(result.reposLinked).toBe(2);
      const team = await prisma.team.findFirstOrThrow({
        where: { classroom_id: result.classroomId },
        include: { memberships: true },
      });
      expect(team.memberships.map(m => m.user_id)).toEqual([
        await userIdOf(world.students[1].providerId),
      ]);
      expect(team.memberships.map(m => m.user_id)).not.toContain(signedInId);
    });

    it('more than five are named in one line with the count', async () => {
      const world = makeWorld('course id');
      const ownerId = await makeUser(`owner-${world.tag}`);
      const input = world.bundle({ moreStudents: 3 });
      const roster = input.classroom.assignments[0].acceptances.map(acc => acc.students[0]);
      for (const st of roster) await signedIn(`${world.tag}-${st.login}`, st.providerId, st.login);

      const result = await runImport(ownerId, input);

      expect(result.studentsEnrolled).toBe(0);
      expect(result.existingAccountsNotEnrolled).toBe(6);
      expect(result.warnings).toContain(
        '6 people are already on Classmoji; add them by email from Students.'
      );
      expect(result.warnings.some(w => w.startsWith('@'))).toBe(false);
    });

    it('a person already in this classroom is linked as before, with their profile kept', async () => {
      const world = makeWorld('course id');
      const ownerId = await makeUser(`owner-${world.tag}`);
      const first = await runImport(ownerId, world.bundle());
      const s1 = world.students[0];
      const s1Id = await userIdOf(s1.providerId);
      // s1 is also on the teaching team of another owner's classroom.
      const other = makeWorld('course id');
      const otherOwner = await makeUser(`owner-${other.tag}`);
      const otherClass = await runImport(otherOwner, other.bundle());
      await prisma.classroomMembership.create({
        data: { classroom_id: otherClass.classroomId, user_id: s1Id, role: 'TEACHER' },
      });
      const before = await person(s1Id);

      const result = await runImport(ownerId, world.bundle({ studentName: 'Renamed Student' }));

      expect(result.classroomId).toBe(first.classroomId);
      expect(await person(s1Id)).toEqual(before);
      expect(result.studentsEnrolled).toBe(3);
      expect(result.reposLinked).toBe(3);
      expect(result.gradesRecorded).toBe(1);
      expect(result.teamMembershipsImported).toBe(2);
      expect(result.warnings.some(w => w.includes('already on Classmoji'))).toBe(false);
      expect(result.existingAccountsNotEnrolled).toBe(0);
      expect(
        await prisma.gitRepo.count({
          where: { classroom_id: first.classroomId, student_id: s1Id },
        })
      ).toBe(1);
    });

    it('a pending invite to this classroom does not count; an accepted membership does', async () => {
      const world = makeWorld('course id');
      const ownerId = await makeUser(`owner-${world.tag}`);
      const [s1, s2, s3] = world.students;
      // s1 and s2 have signed in; the first import leaves them out.
      const teacherInvitee = await signedIn(`${world.tag}-t`, s1.providerId, s1.login);
      const studentInvitee = await signedIn(`${world.tag}-s`, s2.providerId, s2.login);
      // A person who has signed in and is an accepted student of the classroom.
      const accepted = {
        providerId: String(world.id + 41),
        login: `${world.tag}-acc`,
        name: 'Accepted',
      };
      studentProviderIds.push(accepted.providerId);
      const acceptedId = await signedIn(`${world.tag}-a`, accepted.providerId, accepted.login);
      const first = await runImport(ownerId, world.bundle());
      await prisma.classroomMembership.createMany({
        data: [
          { classroom_id: first.classroomId, user_id: teacherInvitee, role: 'TEACHER' },
          { classroom_id: first.classroomId, user_id: studentInvitee, role: 'STUDENT' },
          {
            classroom_id: first.classroomId,
            user_id: acceptedId,
            role: 'STUDENT',
            has_accepted_invite: true,
          },
        ],
      });
      const invitees = [teacherInvitee, studentInvitee];
      const memberships = async () =>
        JSON.parse(
          JSON.stringify(
            await prisma.classroomMembership.findMany({
              where: { user_id: { in: invitees } },
              orderBy: { id: 'asc' },
            })
          )
        );
      const membershipsBefore = await memberships();
      const peopleBefore = await Promise.all(invitees.map(person));

      const result = await runImport(ownerId, world.bundle({ extraStudent: accepted }));

      expect(result.classroomId).toBe(first.classroomId);
      // The invites stay exactly as they were, and nothing is written for them.
      expect(await memberships()).toEqual(membershipsBefore);
      expect(
        membershipsBefore
          .map((m: { user_id: string; role: string; has_accepted_invite: boolean }) => [
            m.user_id === teacherInvitee ? 'teacher invitee' : 'student invitee',
            m.role,
            m.has_accepted_invite,
          ])
          .sort()
      ).toEqual([
        ['student invitee', 'STUDENT', false],
        ['teacher invitee', 'TEACHER', false],
      ]);
      expect(await Promise.all(invitees.map(person))).toEqual(peopleBefore);
      expect(await prisma.gitRepo.count({ where: { student_id: { in: invitees } } })).toBe(0);
      expect(await prisma.teamMembership.count({ where: { user_id: { in: invitees } } })).toBe(0);
      // The group was s1 and s2 only: no team, no team repository, no grade.
      expect(await prisma.team.count({ where: { classroom_id: first.classroomId } })).toBe(0);
      expect(result.groupReposLinked).toBe(0);
      expect(result.gradesRecorded).toBe(0);
      expect(result.existingAccountsNotEnrolled).toBe(2);
      expect(result.warnings).toEqual(
        expect.arrayContaining([peopleLine(s1.login), peopleLine(s2.login)])
      );
      // s3, whom the import made, and the accepted student are linked.
      expect(result.studentsEnrolled).toBe(2);
      expect(result.reposLinked).toBe(2);
      expect(
        (
          await prisma.gitRepo.findMany({
            where: { classroom_id: first.classroomId },
            select: { student_id: true },
          })
        )
          .map(r => r.student_id)
          .sort()
      ).toEqual([await userIdOf(s3.providerId), acceptedId].sort());
      expect(result.warnings.some(w => w.includes(`@${accepted.login} `))).toBe(false);
    });

    it("a placeholder in this classroom and in another owner's is linked and stays a placeholder", async () => {
      const world = makeWorld('course id');
      const ownerId = await makeUser(`owner-${world.tag}`);
      const first = await runImport(ownerId, world.bundle());
      const other = makeWorld('course id');
      const otherOwner = await makeUser(`owner-${other.tag}`);
      const otherClass = await runImport(otherOwner, other.bundle());
      // Known by Github login only, an accepted student of both classrooms.
      const placeholderLogin = `${world.tag}-ph`;
      const placeholder = await prisma.user.create({
        data: {
          name: 'Placeholder',
          accounts: {
            create: {
              provider_id: 'github',
              account_id: `unresolved:${randomUUID()}`,
              username: placeholderLogin,
            },
          },
          classroom_memberships: {
            create: [first.classroomId, otherClass.classroomId].map(classroom_id => ({
              classroom_id,
              role: 'STUDENT' as const,
              has_accepted_invite: true,
            })),
          },
        },
      });
      userIds.push(placeholder.id);
      const extraStudent = {
        providerId: String(world.id + 40),
        login: placeholderLogin,
        name: 'Placeholder Renamed',
      };
      studentProviderIds.push(extraStudent.providerId);
      const before = await person(placeholder.id);

      const result = await runImport(ownerId, world.bundle({ extraStudent }));

      expect(result.classroomId).toBe(first.classroomId);
      // Linked as a member of this classroom...
      expect(
        await prisma.gitRepo.count({
          where: { classroom_id: first.classroomId, student_id: placeholder.id },
        })
      ).toBe(1);
      // ...but not given the Github id: it is in a classroom the importer does not own.
      expect(await person(placeholder.id)).toEqual(before);
      expect(before.accounts[0].account_id).toMatch(/^unresolved:/);
    });

    it('two classrooms of one request that share students enroll them in both', async () => {
      const a = makeWorld('course id');
      const b = makeWorld('course id');
      const ownerId = await makeUser(`owner-${a.tag}`);
      const inputA = a.bundle();
      // B's course has its own repositories, taken by A's students.
      const asA = new Map(b.students.map((st, i) => [st.providerId, a.students[i]]));
      const inputB = b.bundle();
      for (const assignment of inputB.classroom.assignments) {
        for (const acc of assignment.acceptances) {
          acc.students = acc.students.map(st => ({ ...st, ...asA.get(st.providerId)! }));
        }
      }

      const { results, errors } = await importGithubClassrooms(ownerId, [inputA, inputB], {
        organizations: verifiedFor([inputA, inputB]),
      });

      expect(errors).toEqual([]);
      expect(results.map(r => r.studentsEnrolled)).toEqual([3, 3]);
      expect(results.map(r => r.reposLinked)).toEqual([3, 3]);
      expect(results.flatMap(r => r.warnings).some(w => w.includes('already on Classmoji'))).toBe(
        false
      );
      for (const st of a.students) {
        expect(
          await prisma.classroomMembership.count({
            where: {
              user_id: await userIdOf(st.providerId),
              role: 'STUDENT',
              classroom_id: { in: results.map(r => r.classroomId) },
            },
          })
        ).toBe(2);
      }
    });

    it('an importer on their own roster is enrolled as a student, their profile kept', async () => {
      const world = makeWorld('course id');
      const s1 = world.students[0];
      const importerId = await signedIn(world.tag, s1.providerId, s1.login);
      const before = await person(importerId);

      const result = await runImport(importerId, world.bundle({ studentName: 'Renamed Student' }));

      expect(await person(importerId)).toEqual(before);
      expect(result.studentsEnrolled).toBe(3);
      expect(result.warnings.some(w => w.includes('already on Classmoji'))).toBe(false);
      expect(
        await prisma.classroomMembership.findMany({
          where: { classroom_id: result.classroomId, user_id: importerId },
          select: { role: true },
          orderBy: { role: 'asc' },
        })
      ).toEqual([{ role: 'OWNER' }, { role: 'STUDENT' }]);
    });
  });
});
