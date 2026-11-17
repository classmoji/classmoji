/**
 * `helper.findRegradeOptionsForStudent` against a real Postgres: the student's
 * own submissions (individual and team) in the named classroom, each as
 * `{ id, assignment: { title } }` and nothing more.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import getPrisma from '@classmoji/database';
import * as helper from '../helper.service.ts';
import { RUN_DB_SUITES, createTwoClassrooms, type TwoClassrooms } from './helpers/twoClassrooms.ts';

describe.skipIf(!RUN_DB_SUITES)('regrade options for a student (integration)', () => {
  let fx: TwoClassrooms;
  let teamSubmissionId: string;

  beforeAll(async () => {
    fx = await createTwoClassrooms('regradeopt');
    const prisma = getPrisma();
    // A team submission in X the student reaches through team membership.
    await prisma.teamMembership.create({
      data: { team_id: fx.X.teamId, user_id: fx.X.studentId },
    });
    const teamRepo = await prisma.gitRepo.create({
      data: {
        provider: 'GITHUB',
        provider_id: `team-repo-${fx.suite}`,
        name: `team-repo-${fx.suite}`,
        classroom_id: fx.X.id,
        repository_id: fx.X.repositoryId,
        team_id: fx.X.teamId,
      },
    });
    const teamSubmission = await prisma.gitRepoAssignment.create({
      data: { provider: 'GITHUB', git_repo_id: teamRepo.id, assignment_id: fx.X.assignmentId },
    });
    teamSubmissionId = teamSubmission.id;
  });

  afterAll(async () => {
    await fx?.teardown();
  });

  it("lists the student's individual and team submissions with id and assignment title only", async () => {
    const options = await helper.findRegradeOptionsForStudent(fx.X.studentId, fx.X.slug);

    expect(options).toEqual([
      { id: fx.X.submissionId, assignment: { title: 'HW X' } },
      { id: teamSubmissionId, assignment: { title: 'HW X' } },
    ]);
  });

  it('lists nothing from another classroom, nor another student', async () => {
    expect(await helper.findRegradeOptionsForStudent(fx.X.studentId, fx.Y.slug)).toEqual([]);
    const ys = await helper.findRegradeOptionsForStudent(fx.Y.studentId, fx.Y.slug);
    expect(ys.map(o => o.id)).toEqual([fx.Y.submissionId]);
  });
});
