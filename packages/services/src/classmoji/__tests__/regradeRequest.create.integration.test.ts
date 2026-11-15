/**
 * `regradeRequest.create` against a REAL Postgres: at most one open
 * (IN_REVIEW) request per submission, enforced under the per-submission
 * advisory lock, so two submits at once (a double click, a client retry,
 * two tabs) leave one row and one grader notification.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * `afterAll` by deleting the git organization (cascades classroom → repos →
 * submissions → requests) and the users. Nothing is truncated.
 *
 * Skipped unless DATABASE_URL names a LOCAL database, and the SHARED dev
 * database only with CONTENT_INDEX_INTEGRATION=1 (the house rule; see
 * contentIndex.integration.test.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const optedIn = process.env.CONTENT_INDEX_INTEGRATION === '1';
const RUN = Boolean(DATABASE_URL) && isLocal && (!isSharedDevDb || optedIn);

const getPrisma = (await import('@classmoji/database')).default;
const regrades = await import('../regradeRequest.service.ts');

describe.skipIf(!RUN)(
  'regradeRequest.create: one open request per submission (integration)',
  () => {
    const suite = randomUUID().slice(0, 8);
    const prisma = getPrisma();
    let orgId: string;
    let classroomId: string;
    let studentId: string;
    let graderId: string;
    let submissionA: string;
    let submissionB: string;

    const submission = async (assignmentId: string, repoId: string) =>
      (
        await prisma.gitRepoAssignment.create({
          data: { provider: 'GITHUB', git_repo_id: repoId, assignment_id: assignmentId },
        })
      ).id;

    beforeAll(async () => {
      const org = await prisma.gitOrganization.create({
        data: { provider: 'GITHUB', provider_id: `rgc-${suite}`, login: `rgc-${suite}` },
      });
      orgId = org.id;
      classroomId = (
        await prisma.classroom.create({
          data: {
            slug: `rgc-${suite}`,
            git_org_id: org.id,
            name: `Regrade Create ${suite}`,
            content_namespace: `rgc-${suite}`,
            content_repo: `content-rgc-${suite}`,
          },
        })
      ).id;
      studentId = (
        await prisma.user.create({
          data: { email: `rgc-s-${suite}@example.test`, name: `Student ${suite}` },
        })
      ).id;
      graderId = (
        await prisma.user.create({
          data: { email: `rgc-g-${suite}@example.test`, name: `Grader ${suite}` },
        })
      ).id;
      const repository = await prisma.repository.create({
        data: {
          classroom_id: classroomId,
          title: `lab-${suite}`,
          template: 't',
          type: 'INDIVIDUAL',
        },
      });
      const module = await prisma.module.create({
        data: { classroom_id: classroomId, title: `Week ${suite}` },
      });
      const assignment = await prisma.assignment.create({
        data: {
          module_id: module.id,
          type: 'REPO',
          title: `Part 1 ${suite}`,
          repository_id: repository.id,
        },
      });
      const repo = await prisma.gitRepo.create({
        data: {
          provider: 'GITHUB',
          provider_id: `rgc-repo-${suite}`,
          name: `lab-${suite}-student`,
          classroom_id: classroomId,
          repository_id: repository.id,
          student_id: studentId,
        },
      });
      submissionA = await submission(assignment.id, repo.id);
      const assignmentB = await prisma.assignment.create({
        data: {
          module_id: module.id,
          type: 'REPO',
          title: `Part 2 ${suite}`,
          repository_id: repository.id,
        },
      });
      submissionB = await submission(assignmentB.id, repo.id);
      await prisma.gitRepoAssignmentGrader.create({
        data: { git_repo_assignment_id: submissionA, grader_id: graderId },
      });
    });

    afterAll(async () => {
      if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
      for (const id of [studentId, graderId]) {
        if (id) await prisma.user.delete({ where: { id } }).catch(() => {});
      }
    });

    const ask = (gitRepoAssignmentId: string, comment: string) =>
      regrades.create({
        classroom_id: classroomId,
        git_repo_assignment_id: gitRepoAssignmentId,
        student_id: studentId,
        student_comment: comment,
        previous_grade: ['eyes'],
      });

    const openRows = (gitRepoAssignmentId: string) =>
      prisma.regradeRequest.findMany({
        where: { git_repo_assignment_id: gitRepoAssignmentId, status: 'IN_REVIEW' },
      });

    it('leaves one open request when two submits race, and notifies the graders once', async () => {
      const [one, two] = await Promise.all([ask(submissionA, 'first'), ask(submissionA, 'again')]);
      expect([one.created, two.created].sort()).toEqual([false, true]);
      expect(one.id).toBe(two.id);
      expect(await openRows(submissionA)).toHaveLength(1);
      // One notification per grader: the winner notifies, the loser nobody.
      const notices = await prisma.notification.findMany({
        where: { resource_type: 'regrade_request', resource_id: one.id },
      });
      expect(notices.filter(n => n.user_id === graderId)).toHaveLength(1);
    });

    it('returns the open request unchanged on a later submit', async () => {
      const [open] = await openRows(submissionA);
      const again = await ask(submissionA, 'third try');
      expect(again).toMatchObject({
        id: open.id,
        created: false,
        student_comment: open.student_comment,
      });
      expect(await openRows(submissionA)).toHaveLength(1);
    });

    it('takes a new request once the open one is resolved, and keeps submissions apart', async () => {
      const [open] = await openRows(submissionA);
      await prisma.regradeRequest.update({ where: { id: open.id }, data: { status: 'APPROVED' } });
      const next = await ask(submissionA, 'after resolution');
      expect(next.created).toBe(true);
      expect(next.id).not.toBe(open.id);
      // Another submission of the same student is its own request.
      const other = await ask(submissionB, 'part 2');
      expect(other.created).toBe(true);
      expect(await openRows(submissionB)).toHaveLength(1);
    });
  }
);
