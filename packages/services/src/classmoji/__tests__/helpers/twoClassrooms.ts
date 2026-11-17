/**
 * Two classrooms, X and Y, in one throwaway git organization, for suites that
 * check a read or write stays inside its own classroom (and that one person's
 * rows are not handed to another).
 *
 * Each classroom has an owner, an assistant who grades, a student with one
 * graded submission (on a repository with a tag), a team carrying that tag,
 * and a pending invite. Every username and slug is namespaced with a fresh
 * suite id; `teardown` deletes the organization (cascading classrooms and
 * everything under them) and the users, and touches nothing else.
 *
 * Integration only: the suites using it are skipped unless DATABASE_URL names
 * a LOCAL database other than the shared `classmoji` dev one.
 */
import { randomUUID } from 'node:crypto';
import getPrisma from '@classmoji/database';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
export const RUN_DB_SUITES = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

export interface ClassroomFixture {
  id: string;
  slug: string;
  ownerId: string;
  assistantId: string;
  studentId: string;
  studentLogin: string;
  repositoryId: string;
  assignmentId: string;
  submissionId: string;
  tagId: string;
  teamId: string;
  teamSlug: string;
  inviteId: string;
}

export interface TwoClassrooms {
  suite: string;
  orgId: string;
  X: ClassroomFixture;
  Y: ClassroomFixture;
  /** A signed-up user who belongs to neither classroom. */
  outsiderId: string;
  outsiderLogin: string;
  teardown(): Promise<void>;
}

/** Profile columns a user row carries beyond what other people are shown. */
const privateProfile = (suite: string, who: string) => ({
  email: `${suite}-${who}@example.test`,
  school_id: `sid-${suite}-${who}`,
  stripe_customer_id: `cus_${suite}_${who}`,
  banned: false,
  ban_reason: `reason-${suite}-${who}`,
  last_seen_at: new Date('2026-11-01T00:00:00.000Z'),
  first_sign_in_at: new Date('2026-09-01T00:00:00.000Z'),
  onboarding_completed_at: new Date('2026-09-01T00:00:00.000Z'),
  role: 'user',
});

export async function createTwoClassrooms(prefix: string): Promise<TwoClassrooms> {
  const prisma = getPrisma();
  const suite = `${prefix}-${randomUUID().slice(0, 8)}`;

  const user = async (who: string) => {
    const login = `${suite}-${who}`;
    const row = await prisma.user.create({
      data: {
        name: `User ${who}`,
        image: `https://avatars.example.test/${login}.png`,
        ...privateProfile(suite, who),
        accounts: {
          create: {
            provider_id: 'github',
            account_id: `acct-${login}`,
            username: login,
            email: `${login}@users.noreply.example.test`,
          },
        },
      },
    });
    return { id: row.id, login };
  };

  const org = await prisma.gitOrganization.create({
    data: { provider: 'GITHUB', provider_id: `org-${suite}`, login: `org-${suite}` },
  });

  const classroom = async (letter: 'x' | 'y'): Promise<ClassroomFixture> => {
    const owner = await user(`${letter}-owner`);
    const assistant = await user(`${letter}-ta`);
    const student = await user(`${letter}-student`);
    const slug = `${suite}-${letter}`;
    const room = await prisma.classroom.create({
      data: {
        slug,
        git_org_id: org.id,
        name: `Class ${letter.toUpperCase()} ${suite}`,
        content_namespace: slug,
        content_repo: `content-${slug}`,
        join_code: `join-${slug}`,
        plan_owner_id: owner.id,
        created_by: owner.id,
      },
    });
    await prisma.classroomMembership.createMany({
      data: [
        { classroom_id: room.id, user_id: owner.id, role: 'OWNER', has_accepted_invite: true },
        {
          classroom_id: room.id,
          user_id: assistant.id,
          role: 'ASSISTANT',
          is_grader: true,
          has_accepted_invite: true,
        },
        { classroom_id: room.id, user_id: student.id, role: 'STUDENT', has_accepted_invite: true },
      ],
    });
    const tag = await prisma.tag.create({ data: { classroom_id: room.id, name: `tag-${letter}` } });
    const repository = await prisma.repository.create({
      data: {
        classroom_id: room.id,
        title: `Repo ${letter}`,
        template: `template-${letter}`,
        type: 'INDIVIDUAL',
        is_published: true,
        tag_id: tag.id,
      },
    });
    const module = await prisma.module.create({
      data: { classroom_id: room.id, title: `Module ${letter}`, is_published: true },
    });
    const assignment = await prisma.assignment.create({
      data: {
        module_id: module.id,
        type: 'REPO',
        repository_id: repository.id,
        title: `HW ${letter.toUpperCase()}`,
        is_published: true,
        student_deadline: new Date('2026-10-01T00:00:00.000Z'),
      },
    });
    const gitRepo = await prisma.gitRepo.create({
      data: {
        provider: 'GITHUB',
        provider_id: `repo-${slug}`,
        name: `repo-${letter}-${student.login}`,
        classroom_id: room.id,
        repository_id: repository.id,
        student_id: student.id,
      },
    });
    const submission = await prisma.gitRepoAssignment.create({
      data: {
        provider: 'GITHUB',
        git_repo_id: gitRepo.id,
        assignment_id: assignment.id,
        status: 'CLOSED',
        closed_at: new Date('2026-09-30T00:00:00.000Z'),
      },
    });
    await prisma.gitRepoAssignmentGrader.create({
      data: { git_repo_assignment_id: submission.id, grader_id: assistant.id },
    });
    await prisma.assignmentGrade.create({
      data: { git_repo_assignment_id: submission.id, grader_id: assistant.id, emoji: 'score-80' },
    });
    const team = await prisma.team.create({
      data: { classroom_id: room.id, name: `Team ${letter}`, slug: `team-${slug}` },
    });
    await prisma.teamTag.create({ data: { team_id: team.id, tag_id: tag.id } });
    const invite = await prisma.classroomInvite.create({
      data: {
        classroom_id: room.id,
        school_email: `invitee-${slug}@example.test`,
        student_name: `Invitee ${letter}`,
      },
    });
    return {
      id: room.id,
      slug,
      ownerId: owner.id,
      assistantId: assistant.id,
      studentId: student.id,
      studentLogin: student.login,
      repositoryId: repository.id,
      assignmentId: assignment.id,
      submissionId: submission.id,
      tagId: tag.id,
      teamId: team.id,
      teamSlug: team.slug,
      inviteId: invite.id,
    };
  };

  const X = await classroom('x');
  const Y = await classroom('y');
  const outsider = await user('outsider');

  return {
    suite,
    orgId: org.id,
    X,
    Y,
    outsiderId: outsider.id,
    outsiderLogin: outsider.login,
    async teardown() {
      await prisma.gitOrganization.delete({ where: { id: org.id } }).catch(() => {});
      await prisma.user
        .deleteMany({
          where: {
            accounts: { some: { provider_id: 'github', username: { startsWith: `${suite}-` } } },
          },
        })
        .catch(() => {});
    },
  };
}
