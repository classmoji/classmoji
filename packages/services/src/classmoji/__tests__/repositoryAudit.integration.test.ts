/**
 * The repository services write the audit row of each change they make,
 * against a REAL Postgres: one row with exactly the actor's fields (a web
 * actor, and an MCP one under View as), written after the change; the changed
 * columns with their old and new values (a description by name and length
 * only); no row when nothing changed; none and no throw for `actor: null`;
 * and a saved change that reports `missed` when its row could not be written
 * (an actor with no user row, which the `audit_logs.user_id` foreign key
 * refuses). An owner of classroom X cannot edit classroom Y's repository, and
 * rows stay in the classroom changed.
 *
 * Covers repository.create, update, updateFromForm and deleteIfUnprovisioned,
 * autogradingTest.replaceForRepository, HelperService.deleteRepository (a
 * student repo, kept on the provider here) and repoAnalytics.linkContributor.
 *
 * SAFETY: fixtures are namespaced with a fresh uuid and torn down in afterAll
 * (deleting the git organization cascades classrooms, repositories, git repos
 * and audit rows). Skipped unless DATABASE_URL names a LOCAL, non-shared
 * database, like the other integration tests here.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import type { AuditActor } from '../audit.service.ts';

const repository = await import('../repository.service.ts');
const autogradingTest = await import('../autogradingTest.service.ts');
const repoAnalytics = await import('../repoAnalytics.service.ts');
const { default: HelperService } = await import('../../helper/index.ts');

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

describe.skipIf(!RUN)('repository services write their audit rows (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const userIds: string[] = [];
  let orgId: string;
  let serial = 0;

  interface Fixture {
    classroomId: string;
    ownerId: string;
    studentId: string;
  }
  let X: Fixture;
  let Y: Fixture;

  const makeUser = async (label: string) => {
    const user = await prisma.user.create({
      data: { email: `repoaudit-${label}-${++serial}-${suite}@example.test` },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  };

  const makeClassroom = async (label: string): Promise<Fixture> => {
    const row = await prisma.classroom.create({
      data: {
        slug: `repoaudit-${label}-${suite}`,
        git_org_id: orgId,
        name: `Repository audit ${label} ${suite}`,
        content_namespace: `repoaudit-${label}-${suite}`,
        content_repo: `content-repoaudit-${label}-${suite}`,
      },
      select: { id: true },
    });
    const ownerId = await makeUser(`owner-${label}`);
    const studentId = await makeUser(`student-${label}`);
    await prisma.classroomMembership.createMany({
      data: [
        { classroom_id: row.id, user_id: ownerId, role: 'OWNER', has_accepted_invite: true },
        { classroom_id: row.id, user_id: studentId, role: 'STUDENT', has_accepted_invite: true },
      ],
    });
    return { classroomId: row.id, ownerId, studentId };
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

  const makeRepository = async (f: Fixture, title = `Lab ${++serial}`) =>
    (
      await repository.create(
        {
          classroom_id: f.classroomId,
          title: `${title} ${suite}`,
          template: 'org/template',
          type: 'INDIVIDUAL',
        },
        null
      )
    ).repository;

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `repoaudit-${suite}`,
        login: `ra-${suite}`,
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

  it('create: REPOSITORIES / CREATE with the title and type, web and MCP actors', async () => {
    const web = await newRows(X, () =>
      repository.create(
        {
          classroom_id: X.classroomId,
          title: `Web ${suite}`,
          template: 'org/template',
          type: 'GROUP',
        },
        webActor(X, 'web:repos.create')
      )
    );
    expect(web.value.audit).toEqual({ written: 1, missed: 0 });
    expect(web.rows).toEqual([
      {
        user_id: X.ownerId,
        classroom_id: X.classroomId,
        role: 'OWNER',
        resource_type: 'REPOSITORIES',
        resource_id: web.value.repository.id,
        action: 'CREATE',
        data: { tool: 'web:repos.create', title: `Web ${suite}`, type: 'GROUP' },
      },
    ]);
    const mcp = await newRows(X, () =>
      repository.create(
        {
          classroom_id: X.classroomId,
          title: `Mcp ${suite}`,
          template: 'org/template',
          type: 'INDIVIDUAL',
        },
        mcpActor(X, 'repo_create')
      )
    );
    expect(mcp.rows.map(r => r.data)).toEqual([
      { ...MCP_KEYS, tool: 'repo_create', title: `Mcp ${suite}`, type: 'INDIVIDUAL' },
    ]);
    const nulled = await newRows(X, () => makeRepository(X));
    expect(nulled.rows).toEqual([]);
  });

  it('update: the changed columns, old and new, the description by length only', async () => {
    const repo = await makeRepository(X);
    const { value, rows } = await newRows(X, () =>
      repository.update(
        repo.id,
        { description: 'Pair up with a partner.', max_team_size: 3, template: 'org/template' },
        X.classroomId,
        mcpActor(X, 'repo_update')
      )
    );
    expect(value.repository?.max_team_size).toBe(3);
    expect(rows).toEqual([
      {
        user_id: X.ownerId,
        classroom_id: X.classroomId,
        role: 'OWNER',
        resource_type: 'REPOSITORIES',
        resource_id: repo.id,
        action: 'UPDATE',
        data: {
          ...MCP_KEYS,
          tool: 'repo_update',
          // template was sent at its current value: not a change.
          fields: ['description', 'max_team_size'],
          values: { max_team_size: 3 },
          previous: { max_team_size: null },
          value: JSON.stringify({ max_team_size: 3 }),
          description_length: 'Pair up with a partner.'.length,
        },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain('Pair up');

    const same = await newRows(X, () =>
      repository.update(repo.id, { max_team_size: 3 }, X.classroomId, mcpActor(X, 'repo_update'))
    );
    expect(same.value.audit).toEqual({ written: 0, missed: 0 });
    expect(same.rows).toEqual([]);
  });

  it('updateFromForm: the same row for the form, a renamed title with its old value', async () => {
    const repo = await makeRepository(X, 'Form');
    const { rows } = await newRows(X, () =>
      repository.updateFromForm(
        {
          id: repo.id,
          title: `Form renamed ${suite}`,
          type: 'INDIVIDUAL',
          template: 'org/template',
          team_formation_deadline: '2026-12-01T00:00:00.000Z',
        },
        X.classroomId,
        webActor(X, 'web:repos.update')
      )
    );
    expect(rows.map(r => r.data)).toEqual([
      {
        tool: 'web:repos.update',
        fields: ['title', 'team_formation_deadline'],
        values: {
          title: `Form renamed ${suite}`,
          team_formation_deadline: '2026-12-01T00:00:00.000Z',
        },
        previous: { title: `Form ${suite}`, team_formation_deadline: null },
        value: JSON.stringify({
          title: `Form renamed ${suite}`,
          team_formation_deadline: '2026-12-01T00:00:00.000Z',
        }),
      },
    ]);
  });

  it('an owner of X cannot edit Y’s repository: nothing changes, no row anywhere', async () => {
    const theirs = await makeRepository(Y);
    const beforeY = (await rowsIn(Y.classroomId)).length;
    const { rows } = await newRows(X, async () =>
      expect(
        repository.update(theirs.id, { max_team_size: 9 }, X.classroomId, webActor(X, 'x'))
      ).rejects.toThrow('Repository not found in classroom')
    );
    expect(rows).toEqual([]);
    expect((await rowsIn(Y.classroomId)).length).toBe(beforeY);
    expect(
      (await prisma.repository.findUniqueOrThrow({ where: { id: theirs.id } })).max_team_size
    ).toBeNull();
  });

  it('a saved edit whose row cannot be written reports it and stands', async () => {
    const repo = await makeRepository(X);
    const { audit } = await quietly(() =>
      repository.update(repo.id, { max_team_size: 4 }, X.classroomId, ghost('repo_update'))
    );
    expect(audit).toEqual({ written: 0, missed: 1 });
    expect(
      (await prisma.repository.findUniqueOrThrow({ where: { id: repo.id } })).max_team_size
    ).toBe(4);
  });

  it('autograding tests: a changed set by its counts, the same set again records nothing', async () => {
    const repo = await makeRepository(X);
    const tests = [{ name: 'compiles', run_command: 'make', expected_output: 'SECRET-OUTPUT' }];
    const first = await newRows(X, () =>
      autogradingTest.replaceForRepository(
        repo.id,
        tests,
        X.classroomId,
        webActor(X, 'web:repos.update')
      )
    );
    expect(first.rows.map(r => [r.resource_type, r.resource_id, r.data])).toEqual([
      [
        'REPOSITORIES',
        repo.id,
        {
          tool: 'web:repos.update',
          fields: ['autograding_tests'],
          autograding_tests: 1,
          previous_autograding_tests: 0,
        },
      ],
    ]);
    expect(JSON.stringify(first.rows)).not.toContain('SECRET-OUTPUT');
    const again = await newRows(X, () =>
      autogradingTest.replaceForRepository(
        repo.id,
        tests,
        X.classroomId,
        webActor(X, 'web:repos.update')
      )
    );
    expect(again.value.audit).toEqual({ written: 0, missed: 0 });
    expect(again.rows).toEqual([]);
  });

  it('replaceForRepository waits for the repository row, so overlapping saves each read the set they replace', async () => {
    const repo = await makeRepository(X);
    const test = (name: string) => ({ name, run_command: 'make' });
    const actor = webActor(X, 'web:repos.update');

    // Another transaction holds the repository row: the save waits for it.
    let settled = false;
    let save: ReturnType<typeof autogradingTest.replaceForRepository> | undefined;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM repositories WHERE id = ${repo.id} FOR UPDATE`;
      save = autogradingTest.replaceForRepository(repo.id, [test('a')], X.classroomId, actor);
      void save.then(() => {
        settled = true;
      });
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(settled).toBe(false);
    });
    await save;
    expect(settled).toBe(true);

    // Two saves at once: one runs after the other, and the second reads the
    // first one's set as what it replaced.
    const { rows } = await newRows(X, () =>
      Promise.all([
        autogradingTest.replaceForRepository(
          repo.id,
          [test('b1'), test('b2')],
          X.classroomId,
          actor
        ),
        autogradingTest.replaceForRepository(
          repo.id,
          [test('c1'), test('c2'), test('c3')],
          X.classroomId,
          actor
        ),
      ])
    );
    const stored = await prisma.autogradingTest.count({ where: { repository_id: repo.id } });
    expect([2, 3]).toContain(stored);
    // Each row is written after its own commit, so they may land in either
    // order: the one that replaced the single test above goes first here.
    const counts = rows
      .map(r => r.data as { autograding_tests: number; previous_autograding_tests: number })
      .map(d => [d.previous_autograding_tests, d.autograding_tests])
      .sort((p, q) => (p[0] === 1 ? -1 : q[0] === 1 ? 1 : 0));
    // From the one test saved above to one set, then from that set to the other.
    expect(counts).toHaveLength(2);
    expect(counts[0][0]).toBe(1);
    expect(counts[1][0]).toBe(counts[0][1]);
    expect(counts[1][1]).toBe(stored);
  });

  it('deleteIfUnprovisioned: what the cascade took; a refused delete writes none', async () => {
    const repo = await makeRepository(X, 'Doomed');
    const module = await prisma.module.create({
      data: { classroom_id: X.classroomId, title: `Mod ${suite}` },
      select: { id: true },
    });
    const assignment = await prisma.assignment.create({
      data: {
        module_id: module.id,
        type: 'REPO',
        repository_id: repo.id,
        title: `Checkpoint ${suite}`,
      },
      select: { id: true },
    });
    await autogradingTest.replaceForRepository(repo.id, [{ name: 't' }], X.classroomId, null);

    const published = await makeRepository(X, 'Live');
    await prisma.repository.update({ where: { id: published.id }, data: { is_published: true } });
    const refused = await newRows(X, () =>
      repository.deleteIfUnprovisioned(published.id, X.classroomId, mcpActor(X, 'repo_delete'))
    );
    expect(refused.value).toEqual({ status: 'published', audit: { written: 0, missed: 0 } });
    expect(refused.rows).toEqual([]);

    const { value, rows } = await newRows(X, () =>
      repository.deleteIfUnprovisioned(repo.id, X.classroomId, mcpActor(X, 'repo_delete'))
    );
    expect(value).toEqual({ status: 'deleted', audit: { written: 1, missed: 0 } });
    expect(rows).toEqual([
      {
        user_id: X.ownerId,
        classroom_id: X.classroomId,
        role: 'OWNER',
        resource_type: 'REPOSITORIES',
        resource_id: repo.id,
        action: 'DELETE',
        data: {
          ...MCP_KEYS,
          tool: 'repo_delete',
          title: `Doomed ${suite}`,
          slug: repo.slug,
          assignments_deleted: [{ id: assignment.id, title: `Checkpoint ${suite}` }],
          module_items_removed: 0,
          page_links_removed: 0,
          slide_links_removed: 0,
          assignment_page_links_removed: 0,
          assignment_slide_links_removed: 0,
          calendar_event_links_removed: 0,
          autograding_tests_deleted: 1,
          quizzes_unlinked: 0,
        },
      },
    ]);
  });

  describe('student repos', () => {
    const makeGitRepo = async (f: Fixture, repositoryId: string) =>
      prisma.gitRepo.create({
        data: {
          classroom_id: f.classroomId,
          repository_id: repositoryId,
          name: `lab-${++serial}-${suite}`,
          provider: 'GITHUB',
          provider_id: `${suite}-${serial}`,
          student_id: f.studentId,
        },
        select: { id: true, name: true },
      });

    it('HelperService.deleteRepository records the student repo it deleted in the classroom', async () => {
      const repo = await makeRepository(X);
      const gitRepo = await makeGitRepo(X, repo.id);
      const { value, rows } = await newRows(X, () =>
        HelperService.deleteRepository({
          id: gitRepo.id,
          name: gitRepo.name,
          gitOrganization: { login: `ra-${suite}`, provider: 'GITHUB' },
          classroomId: X.classroomId,
          deleteFromGithub: false,
          repositoryId: repo.id,
          actor: webActor(X, 'web:repos.delete_student_repo'),
        })
      );
      expect(value.audit).toEqual({ written: 1, missed: 0 });
      expect(rows).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'REPOSITORY',
          resource_id: gitRepo.id,
          action: 'DELETE',
          data: {
            tool: 'web:repos.delete_student_repo',
            repository_id: repo.id,
            deleted_from_provider: false,
          },
        },
      ]);
      // A student repo of Y named with X's classroom: refused, nothing deleted.
      const theirs = await makeGitRepo(Y, (await makeRepository(Y)).id);
      await expect(
        HelperService.deleteRepository({
          id: theirs.id,
          name: theirs.name,
          gitOrganization: { login: `ra-${suite}`, provider: 'GITHUB' },
          classroomId: X.classroomId,
          deleteFromGithub: false,
          actor: webActor(X, 'web:repos.delete_student_repo'),
        })
      ).rejects.toThrow();
      expect(await prisma.gitRepo.findUnique({ where: { id: theirs.id } })).not.toBeNull();
    });

    it('linkContributor records a mapping that changed, and nothing for the same one', async () => {
      const repo = await makeRepository(X);
      const gitRepo = await makeGitRepo(X, repo.id);
      const linked = await newRows(X, () =>
        repoAnalytics.linkContributor(
          gitRepo.id,
          'octocat',
          X.studentId,
          webActor(X, 'web:repos.link_contributor')
        )
      );
      expect(linked.rows).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'REPOSITORY',
          resource_id: gitRepo.id,
          action: 'UPDATE',
          data: {
            tool: 'web:repos.link_contributor',
            event: 'contributor_linked',
            github_login: 'octocat',
            user_id: X.studentId,
            previous_user_id: null,
          },
        },
      ]);
      const same = await newRows(X, () =>
        repoAnalytics.linkContributor(
          gitRepo.id,
          'octocat',
          X.studentId,
          webActor(X, 'web:repos.link_contributor')
        )
      );
      expect(same.rows).toEqual([]);
      const unlinked = await newRows(X, () =>
        repoAnalytics.linkContributor(
          gitRepo.id,
          'octocat',
          null,
          webActor(X, 'web:repos.link_contributor')
        )
      );
      expect(unlinked.rows.map(r => r.data)).toEqual([
        {
          tool: 'web:repos.link_contributor',
          event: 'contributor_linked',
          github_login: 'octocat',
          user_id: null,
          previous_user_id: X.studentId,
        },
      ]);
      // Y's student is no member of X: refused, no row.
      const refused = await newRows(X, async () =>
        expect(
          repoAnalytics.linkContributor(
            gitRepo.id,
            'other',
            Y.studentId,
            webActor(X, 'web:repos.link_contributor')
          )
        ).rejects.toThrow()
      );
      expect(refused.rows).toEqual([]);
    });
  });
  describe('every recording function: no row for actor: null; a change that stands when its row cannot be written', () => {
    interface Case {
      name: string;
      prepare: () => Promise<{
        act: (actor: AuditActor | null) => Promise<{ audit: { written: number; missed: number } }>;
        stood: () => Promise<boolean>;
      }>;
    }
    const gitRepoOf = async (repositoryId: string) =>
      prisma.gitRepo.create({
        data: {
          classroom_id: X.classroomId,
          repository_id: repositoryId,
          name: `case-${randomUUID().slice(0, 8)}`,
          provider: 'GITHUB',
          provider_id: randomUUID(),
          student_id: X.studentId,
        },
        select: { id: true, name: true },
      });
    const CASES: Case[] = [
      {
        name: 'repository.create',
        prepare: async () => {
          const title = `Case ${randomUUID().slice(0, 6)} ${suite}`;
          return {
            act: actor =>
              repository.create(
                { classroom_id: X.classroomId, title, template: 'org/t', type: 'INDIVIDUAL' },
                actor
              ),
            stood: async () => (await prisma.repository.count({ where: { title } })) === 1,
          };
        },
      },
      {
        name: 'repository.update',
        prepare: async () => {
          const repo = await makeRepository(X);
          return {
            act: actor => repository.update(repo.id, { max_team_size: 5 }, X.classroomId, actor),
            stood: async () =>
              (await prisma.repository.findUniqueOrThrow({ where: { id: repo.id } }))
                .max_team_size === 5,
          };
        },
      },
      {
        name: 'repository.updateFromForm',
        prepare: async () => {
          const repo = await makeRepository(X);
          return {
            act: actor =>
              repository.updateFromForm(
                { id: repo.id, type: 'INDIVIDUAL', max_team_size: 6 },
                X.classroomId,
                actor
              ),
            stood: async () =>
              (await prisma.repository.findUniqueOrThrow({ where: { id: repo.id } }))
                .max_team_size === 6,
          };
        },
      },
      {
        name: 'repository.deleteIfUnprovisioned',
        prepare: async () => {
          const repo = await makeRepository(X);
          return {
            act: actor => repository.deleteIfUnprovisioned(repo.id, X.classroomId, actor),
            stood: async () =>
              (await prisma.repository.findUnique({ where: { id: repo.id } })) === null,
          };
        },
      },
      {
        name: 'autogradingTest.replaceForRepository',
        prepare: async () => {
          const repo = await makeRepository(X);
          return {
            act: actor =>
              autogradingTest.replaceForRepository(repo.id, [{ name: 't' }], X.classroomId, actor),
            stood: async () =>
              (await prisma.autogradingTest.count({ where: { repository_id: repo.id } })) === 1,
          };
        },
      },
      {
        name: 'HelperService.deleteRepository',
        prepare: async () => {
          const repo = await makeRepository(X);
          const gitRepo = await gitRepoOf(repo.id);
          return {
            act: actor =>
              HelperService.deleteRepository({
                id: gitRepo.id,
                name: gitRepo.name,
                gitOrganization: { login: `ra-${suite}`, provider: 'GITHUB' },
                classroomId: X.classroomId,
                deleteFromGithub: false,
                actor,
              }),
            stood: async () =>
              (await prisma.gitRepo.findUnique({ where: { id: gitRepo.id } })) === null,
          };
        },
      },
      {
        name: 'repoAnalytics.linkContributor',
        prepare: async () => {
          const gitRepo = await gitRepoOf((await makeRepository(X)).id);
          return {
            act: actor => repoAnalytics.linkContributor(gitRepo.id, 'octo', X.studentId, actor),
            stood: async () =>
              (await prisma.gitRepoContributorLink.count({
                where: { git_repo_id: gitRepo.id },
              })) === 1,
          };
        },
      },
    ];

    it.each(CASES.map(c => [c.name, c] as const))('%s', async (_name, c) => {
      const nulled = await c.prepare();
      const quiet = await newRows(X, () => nulled.act(null));
      expect(quiet.value.audit).toEqual({ written: 0, missed: 0 });
      expect(quiet.rows).toEqual([]);
      expect(await nulled.stood()).toBe(true);

      const lost = await c.prepare();
      const value = await quietly(() => lost.act(ghost('web:repos.case')));
      expect(value.audit).toEqual({ written: 0, missed: 1 });
      expect(await lost.stood()).toBe(true);
    });
  });
});
