/**
 * Reusable seed fixture helpers for role-gated authorization tests (MCP + e2e).
 * Called from seed.js and importable by integration tests via
 * `@classmoji/database/seed-fixtures`.
 *
 * CRITICAL (test integrity): prof-classmoji holds OWNER + ASSISTANT + STUDENT,
 * so it passes EVERY role gate. Non-owner denial tests MUST use the
 * single-role identities — fake-ta (ASSISTANT), fake-teacher (TEACHER),
 * fake-student-1..3 (STUDENT) — never prof-classmoji, or a "denied for
 * non-owner" assertion passes vacuously via the OWNER membership.
 *
 * Every helper is idempotent (stable upsert keys) and purely additive —
 * safe to re-run against a live dev database.
 */

/**
 * Team + GROUP-repository fixture for group-grading and team-scoped tests.
 *
 * Creates (all in the given classroom):
 *   - Team "Team Alpha" (slug `team-alpha`)
 *   - TeamMembership rows for the given students
 *   - GROUP-type Repository `group-project` (the assignment CONTAINER — not a git repo)
 *   - a team-owned GitRepo under that container (team_id set, student_id null)
 *   - Assignment "Group Project Part 1" in the container
 *   - a GitRepoAssignment linking the GitRepo to the Assignment (ungraded —
 *     a live target for group-grading tests)
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ classroom: { id: string }, students: { id: string, login: string }[] }} opts
 */
export async function seedTeamWithGroupRepo(prisma, { classroom, students }) {
  if (!students?.length || students.length < 2) {
    throw new Error('seedTeamWithGroupRepo requires at least 2 students');
  }

  const team = await prisma.team.upsert({
    where: { classroom_id_slug: { classroom_id: classroom.id, slug: 'team-alpha' } },
    update: {},
    create: {
      classroom_id: classroom.id,
      name: 'Team Alpha',
      slug: 'team-alpha',
      is_visible: true,
    },
  });

  for (const student of students) {
    await prisma.teamMembership.upsert({
      where: { team_id_user_id: { team_id: team.id, user_id: student.id } },
      update: {},
      create: { team_id: team.id, user_id: student.id },
    });
  }

  // Repository = assignment container (NOT a git repo); type GROUP → team-owned GitRepos
  const repository = await prisma.repository.upsert({
    where: { classroom_id_title: { classroom_id: classroom.id, title: 'group-project' } },
    update: {},
    create: {
      classroom_id: classroom.id,
      title: 'group-project',
      template: 'dev-org/group-project-template',
      weight: 100,
      type: 'GROUP',
      is_published: true,
    },
  });

  const assignment = await prisma.assignment.upsert({
    where: { repository_id_title: { repository_id: repository.id, title: 'Group Project Part 1' } },
    update: {},
    create: {
      repository_id: repository.id,
      title: 'Group Project Part 1',
      weight: 100,
      is_published: true,
    },
  });

  // GitRepo = the actual git repository, owned by the team (student_id stays null).
  // The upsert key (provider, provider_id) is GLOBAL, not classroom-scoped — the
  // update clause repoints the row at the canonical chain in case an earlier run
  // created it under a different classroom (self-healing, no rows destroyed).
  const gitRepo = await prisma.gitRepo.upsert({
    where: { provider_provider_id: { provider: 'GITHUB', provider_id: 'fake-repo-team-alpha' } },
    update: {
      classroom_id: classroom.id,
      repository_id: repository.id,
      team_id: team.id,
      student_id: null,
    },
    create: {
      classroom_id: classroom.id,
      repository_id: repository.id,
      provider: 'GITHUB',
      provider_id: 'fake-repo-team-alpha',
      name: 'team-alpha-group-project',
      team_id: team.id,
    },
  });

  // Submitted but ungraded — a target for group-grading tests
  const gitRepoAssignment = await prisma.gitRepoAssignment.upsert({
    where: { provider_provider_id: { provider: 'GITHUB', provider_id: 'fake-issue-team-alpha' } },
    update: { git_repo_id: gitRepo.id, assignment_id: assignment.id },
    create: {
      git_repo_id: gitRepo.id,
      assignment_id: assignment.id,
      provider: 'GITHUB',
      provider_id: 'fake-issue-team-alpha',
      provider_issue_number: 300,
      status: 'CLOSED',
    },
  });

  return { team, repository, assignment, gitRepo, gitRepoAssignment };
}

/**
 * Foreign classroom fixture: a second classroom (`classmoji-other-class`) where
 * NONE of the primary test identities (prof-classmoji, fake-ta, fake-teacher,
 * fake-student-*) hold ANY membership. Never add memberships for them here —
 * this classroom exists to exercise:
 *   (a) the "not a member" denial branch, distinct from "insufficient role"
 *   (b) cross-classroom UUID rejection (S1) — its container/GitRepo/
 *       GitRepoAssignment chain provides real foreign records to aim at
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {{ org: { id: string } }} opts
 */
export async function seedForeignClassroom(prisma, { org }) {
  const classroom = await prisma.classroom.upsert({
    where: { git_org_id_slug: { git_org_id: org.id, slug: 'classmoji-other-class' } },
    update: {},
    create: {
      git_org_id: org.id,
      slug: 'classmoji-other-class',
      name: 'Other Class',
      content_namespace: 'classmoji-other-class',
    },
  });

  await prisma.classroomSettings.upsert({
    where: { classroom_id: classroom.id },
    update: {},
    create: { classroom_id: classroom.id },
  });

  // Its own owner + student — fully fake, memberships ONLY in this classroom
  const foreignUsers = [
    {
      login: 'fake-other-owner',
      name: 'Other Owner',
      email: 'other-owner@dev.local',
      provider_id: '10000006',
      role: 'OWNER',
    },
    {
      login: 'fake-other-student',
      name: 'Other Student',
      email: 'other-student@dev.local',
      provider_id: '10000007',
      role: 'STUDENT',
    },
  ].map(u => ({ ...u, image: `https://github.com/identicons/${u.login}.png` }));

  let ownerUser = null;
  let studentUser = null;

  for (const u of foreignUsers) {
    const user = await prisma.user.upsert({
      where: { login: u.login },
      update: { image: u.image },
      create: {
        provider: 'GITHUB',
        provider_id: u.provider_id,
        login: u.login,
        name: u.name,
        email: u.email,
        image: u.image,
        school_id: 'dev',
      },
    });

    await prisma.classroomMembership.upsert({
      where: {
        classroom_id_user_id_role: { classroom_id: classroom.id, user_id: user.id, role: u.role },
      },
      update: {},
      create: {
        classroom_id: classroom.id,
        user_id: user.id,
        role: u.role,
        has_accepted_invite: true,
      },
    });

    if (u.role === 'OWNER') ownerUser = user;
    if (u.role === 'STUDENT') studentUser = user;
  }

  // Container → Assignment → GitRepo → GitRepoAssignment chain (foreign UUIDs
  // at every tier for S1 cross-classroom rejection tests)
  const repository = await prisma.repository.upsert({
    where: { classroom_id_title: { classroom_id: classroom.id, title: 'other-hello-world' } },
    update: {},
    create: {
      classroom_id: classroom.id,
      title: 'other-hello-world',
      template: 'dev-org/hello-world-template',
      weight: 100,
      type: 'INDIVIDUAL',
      is_published: true,
    },
  });

  const assignment = await prisma.assignment.upsert({
    where: { repository_id_title: { repository_id: repository.id, title: 'Other Assignment 1' } },
    update: {},
    create: {
      repository_id: repository.id,
      title: 'Other Assignment 1',
      weight: 100,
      is_published: true,
    },
  });

  // Same self-healing update clauses as seedTeamWithGroupRepo — the (provider,
  // provider_id) upsert keys are global, so repoint to the canonical chain.
  const gitRepo = await prisma.gitRepo.upsert({
    where: {
      provider_provider_id: { provider: 'GITHUB', provider_id: 'fake-repo-fake-other-student' },
    },
    update: {
      classroom_id: classroom.id,
      repository_id: repository.id,
      student_id: studentUser.id,
    },
    create: {
      classroom_id: classroom.id,
      repository_id: repository.id,
      provider: 'GITHUB',
      provider_id: 'fake-repo-fake-other-student',
      name: 'fake-other-student-other-hello-world',
      student_id: studentUser.id,
    },
  });

  const gitRepoAssignment = await prisma.gitRepoAssignment.upsert({
    where: {
      provider_provider_id: { provider: 'GITHUB', provider_id: 'fake-issue-fake-other-student' },
    },
    update: { git_repo_id: gitRepo.id, assignment_id: assignment.id },
    create: {
      git_repo_id: gitRepo.id,
      assignment_id: assignment.id,
      provider: 'GITHUB',
      provider_id: 'fake-issue-fake-other-student',
      provider_issue_number: 400,
      status: 'CLOSED',
    },
  });

  return {
    classroom,
    owner: ownerUser,
    student: studentUser,
    repository,
    assignment,
    gitRepo,
    gitRepoAssignment,
  };
}
