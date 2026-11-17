/**
 * User rows that reads hand to someone other than that user, against a real
 * Postgres: no billing, moderation, sign-in or platform-role columns ever;
 * students' email and school id only in the staff-facing reads; graders (staff)
 * as anyone sees them. And a submission's classroom carries no organization
 * credential or invite link code.
 *
 * The fixture users have every private column set (twoClassrooms.ts), so a
 * column that rides along shows up here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as gitRepoAssignment from '../gitRepoAssignment.service.ts';
import * as gitRepoAssignmentGrader from '../gitRepoAssignmentGrader.service.ts';
import * as classroomMembership from '../classroomMembership.service.ts';
import * as gitRepo from '../gitRepo.service.ts';
import * as team from '../team.service.ts';
import * as token from '../token.service.ts';
import * as helper from '../helper.service.ts';
import * as quizAttempt from '../quizAttempt.service.ts';
import * as quizService from '../quiz.service.ts';
import * as regradeRequest from '../regradeRequest.service.ts';
import * as pageService from '../page.service.ts';
import getPrisma from '@classmoji/database';
import { RUN_DB_SUITES, createTwoClassrooms, type TwoClassrooms } from './helpers/twoClassrooms.ts';

/** Columns no user row read for someone else may carry. */
const NEVER = [
  'stripe_customer_id',
  'banned',
  'ban_reason',
  'ban_expires_at',
  'last_seen_at',
  'first_sign_in_at',
  'onboarding_completed_at',
  'role',
  'emailVerified',
  'created_at',
  'updated_at',
];

const staffView = (user: Record<string, unknown> | null | undefined) => {
  expect(user).toBeTruthy();
  for (const key of NEVER) expect(user, key).not.toHaveProperty(key);
  expect(user).toHaveProperty('email');
  expect(user).toHaveProperty('school_id');
  expect(user).toHaveProperty('login');
  // The client's computed avatar (image, or the default) stays on the row.
  expect(user!.avatar_url).toBe(user!.image);
};

const publicView = (user: Record<string, unknown> | null | undefined) => {
  expect(user).toBeTruthy();
  expect(Object.keys(user!).sort()).toEqual(['avatar_url', 'id', 'image', 'login', 'name']);
  expect(user!.avatar_url).toBe(user!.image);
};

describe.skipIf(!RUN_DB_SUITES)('user rows in reads for other people (integration)', () => {
  let fx: TwoClassrooms;

  beforeAll(async () => {
    fx = await createTwoClassrooms('userpayloads');
    await getPrisma().teamMembership.create({
      data: { team_id: fx.X.teamId, user_id: fx.X.studentId },
    });
    await getPrisma().tokenTransaction.create({
      data: {
        classroom_id: fx.X.id,
        student_id: fx.X.studentId,
        amount: 3,
        type: 'GAIN',
        balance_after: 3,
      },
    });
  });

  afterAll(async () => {
    await fx?.teardown();
  });

  it('gitRepoAssignment.findByClassroomId: students in the staff view, graders public', async () => {
    const [row] = await gitRepoAssignment.findByClassroomId(fx.X.id);
    staffView(row.git_repo.student as Record<string, unknown>);
    publicView(row.graders[0].grader as Record<string, unknown>);
    publicView(row.grades[0].grader as Record<string, unknown>);
  });

  it('gitRepoAssignmentGrader.findAssignedByGrader: the same', async () => {
    const [item] = await gitRepoAssignmentGrader.findAssignedByGrader(fx.X.assistantId, fx.X.id);
    const sub = item.git_repo_assignment;
    staffView(sub.git_repo.student as Record<string, unknown>);
    publicView(sub.graders[0].grader as Record<string, unknown>);
    publicView(sub.grades[0].grader as Record<string, unknown>);
  });

  it('helper.findAllAssignmentsForStudent: graders public, the classroom without credentials', async () => {
    const [row] = await helper.findAllAssignmentsForStudent(fx.X.studentId, fx.X.slug);
    publicView(row.graders[0].grader as Record<string, unknown>);
    publicView(row.grades[0].grader as Record<string, unknown>);
    const classroom = row.git_repo.classroom as Record<string, unknown>;
    expect(Object.keys(classroom).sort()).toEqual(
      ['git_namespace', 'git_organization', 'id', 'name', 'slug'].sort()
    );
    expect(Object.keys(classroom.git_organization as object).sort()).toEqual(
      ['base_url', 'id', 'login', 'provider', 'provider_id'].sort()
    );
  });

  it('classroomMembership.findUsersByRole(s) and findByClassroomId: the staff view', async () => {
    const [student] = await classroomMembership.findUsersByRole(fx.X.id, 'STUDENT');
    staffView(student as unknown as Record<string, unknown>);
    for (const user of await classroomMembership.findUsersByRoles(fx.X.id, ['ASSISTANT'])) {
      staffView(user as unknown as Record<string, unknown>);
    }
    for (const m of await classroomMembership.findByClassroomId(fx.X.id)) {
      staffView(m.user as unknown as Record<string, unknown>);
    }
  });

  it('gitRepo.findByRepository, team.findByClassroomId, token.findTransactions', async () => {
    const [repo] = await gitRepo.findByRepository(fx.X.slug, fx.X.repositoryId);
    staffView(repo.student as Record<string, unknown>);
    publicView(repo.assignments[0].graders[0].grader as Record<string, unknown>);

    const [xTeam] = await team.findByClassroomId(fx.X.id);
    staffView(xTeam.memberships[0].user as Record<string, unknown>);

    const [transaction] = await token.findTransactions({ classroom_id: fx.X.id });
    staffView(transaction.student as Record<string, unknown>);
  });

  it("quizAttempt.findByQuiz: each attempt's student in the staff view", async () => {
    const quiz = await getPrisma().quiz.create({
      data: { classroom_id: fx.X.id, name: `Quiz ${fx.suite}`, rubric_prompt: 'r' },
    });
    await getPrisma().quizAttempt.create({ data: { quiz_id: quiz.id, user_id: fx.X.studentId } });
    const [attempt] = await quizAttempt.findByQuiz(quiz.id);
    staffView(attempt.user as unknown as Record<string, unknown>);

    // The other quiz and attempt reads that carry the attempt's student.
    staffView((await quizAttempt.findById(attempt.id))!.user as unknown as Record<string, unknown>);
    staffView(
      (await quizAttempt.findInQuiz(quiz.id, attempt.id))!.user as unknown as Record<
        string,
        unknown
      >
    );
    const byId = await quizService.findById(quiz.id);
    staffView(byId!.attempts[0].user as unknown as Record<string, unknown>);
    const staffRow = await quizService.findOneForStaff(fx.X.id, quiz.id, {
      role: 'OWNER',
      classroom_id: fx.X.id,
    });
    staffView(staffRow!.attempts[0].user as unknown as Record<string, unknown>);
  });

  it('regradeRequest.findMany: graders public, the student as the list selects them', async () => {
    await getPrisma().regradeRequest.create({
      data: {
        classroom_id: fx.X.id,
        student_id: fx.X.studentId,
        git_repo_assignment_id: fx.X.submissionId,
      },
    });
    const [request] = await regradeRequest.findMany({ classroom_id: fx.X.id });
    publicView(request.git_repo_assignment!.graders[0].grader as Record<string, unknown>);
    publicView(request.git_repo_assignment!.grades[0].grader as Record<string, unknown>);
    const student = request.student as unknown as Record<string, unknown>;
    expect(Object.keys(student).sort()).toEqual(
      ['_count', 'email', 'id', 'image', 'login', 'name'].sort()
    );
  });

  it('page creators are public; team members and repo students in the staff view', async () => {
    await getPrisma().page.create({
      data: {
        classroom_id: fx.X.id,
        created_by: fx.X.ownerId,
        title: `Page ${fx.suite}`,
        content_path: `pages/page-${fx.suite}`,
      },
    });
    const [page] = await pageService.findByClassroomId(fx.X.id);
    publicView(page.creator as unknown as Record<string, unknown>);

    const xTeam = await team.findBySlugAndClassroomId(fx.X.teamSlug, fx.X.id);
    staffView(xTeam!.memberships[0].user as unknown as Record<string, unknown>);

    const [repo] = await gitRepo.findMany({ classroom_id: fx.X.id });
    staffView(repo.student as unknown as Record<string, unknown>);
    publicView(repo.assignments[0].graders[0].grader as unknown as Record<string, unknown>);
  });
});
