import { tasks } from '@trigger.dev/sdk';
import { Prisma } from '@classmoji/database/client';
import { reportError } from '@classmoji/utils/error-report';
import getPrisma from '@classmoji/database';
import { GITLAB_PROJECTS_SUBGROUP, parseScoreEmoji } from '@classmoji/utils';
import { getGitProvider } from '../git/index.ts';
import ClassmojiService from '../classmoji/index.ts';
import {
  NO_SERVICE_AUDIT,
  addServiceAudit,
  recordForActor,
  type AuditActor,
  type ServiceAudit,
} from '../classmoji/audit.service.ts';
import {
  StaffServiceError,
  type RemoveStaffResult,
  type StaffRole,
} from '../classmoji/staff.service.ts';
import type { PlannedMove, UngradedChoice } from '../classmoji/graderReassignPlan.ts';

/**
 * At or below this many slots the move runs inside the request; above it, one
 * background run per slot (the grader_assign_bulk fan-out pattern). Each slot
 * is up to two GitHub calls plus a few queries; the web removal already waits
 * on its own background run, so ten slots at UNGRADED_INLINE_CONCURRENCY cost a
 * few seconds, while a TA holding a whole assignment's worth would not.
 */
export const UNGRADED_INLINE_LIMIT = 10;
const UNGRADED_INLINE_CONCURRENCY = 4;
/** Trigger.dev caps a batch at 500 items before SDK 4.3.1 and 1,000 after. */
const BATCH_CHUNK = 500;

export interface MoveGraderSlotPayload {
  classroomId: string;
  gitRepoAssignmentId: string;
  fromGraderId: string;
  /** null → only remove the departing grader. */
  toGraderId: string | null;
  /**
   * The owner chose reassign: if the planned grader has left the pool by the
   * time this slot moves, unassign the departing grader instead of leaving
   * the slot with someone who can no longer grade it.
   */
  fallbackToUnassign?: boolean;
  /**
   * Who the add and the removal are recorded for, when the move belongs to a
   * person's action (the owner removing a grader). Absent in runs queued
   * before it existed: those record nothing.
   */
  actor?: AuditActor | null;
}

export type MoveGraderSlotResult =
  | { status: 'moved'; toLogin: string }
  | { status: 'unassigned'; reason?: 'grader_not_eligible' }
  | {
      status:
        | 'already_removed'
        | 'graded_since'
        | 'submission_not_found'
        | 'grader_not_eligible'
        | 'no_git_organization';
    };

export interface UngradedSlotsOutcome {
  choice: UngradedChoice;
  /** Ungraded slots found when the decision ran. */
  total: number;
  /** Per new grader. With `queued`, the plan the background runs carry out. */
  reassigned: Array<{ graderId: string; login: string; count: number }>;
  /** Every slot left without the departing grader and no replacement. */
  unassigned: number;
  /**
   * Of `unassigned`: reassign planned a grader who had left the grader pool by
   * the time the slot moved, so the slot was unassigned instead.
   */
  unassignedIneligible: number;
  /** Removed with no replacement because every other grader is already on it. */
  alreadyCovered: number;
  kept: number;
  failed: number;
  queued: boolean;
  fallback: 'no_eligible_graders' | null;
  /** The grader rows the moves made in this request owed (queued runs write their own). */
  audit: ServiceAudit;
}

/** What `startStaffRemoval` hands back: the queued removal plus what is at stake. */
export interface StaffRemovalStart extends RemoveStaffResult {
  name: string | null;
  /** Ungraded slots that need the owner's decision (0 while a grader role remains). */
  ungradedCount: number;
  /**
   * Ungraded slots they hold at all. Non-zero means a LATER removal of their
   * other role could put these at stake, so callers wait for this run first.
   */
  heldUngradedCount: number;
  /** The decision to apply once the removal has finished; null when none is needed. */
  choice: UngradedChoice | null;
}

interface ResolveUngradedSlotsArgs {
  classroomId: string;
  graderId: string;
  choice: UngradedChoice;
  departingName?: string;
  /**
   * Who the slot moves are recorded for (a grader row for each add and each
   * removal), made here or by the `move_grader_slot` runs, which carry it in
   * their payload; null records none.
   */
  actor: AuditActor | null;
}

const emptyOutcome = (choice: UngradedChoice, total: number): UngradedSlotsOutcome => ({
  choice,
  total,
  reassigned: [],
  unassigned: 0,
  unassignedIneligible: 0,
  alreadyCovered: 0,
  kept: 0,
  failed: 0,
  queued: false,
  fallback: null,
  audit: NO_SERVICE_AUDIT,
});

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Run `fn` over `items`, at most `limit` at a time, keeping order. */
const mapPool = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) => {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};

interface HelperGitOrganization {
  provider: string;
  login: string;
  github_installation_id?: string | null;
  access_token?: string | null;
  base_url?: string | null;
  gitlab_group_id?: string | null;
  [key: string]: unknown;
}

interface DeleteRepositoryPayload {
  id?: string;
  name: string;
  gitOrganization: HelperGitOrganization;
  deleteFromGithub?: boolean;
  /** Where the repo lives when not the org itself (a GitLab class subgroup). */
  repoOwner?: string | null;
  /**
   * When set, the row is deleted with `gitRepo.deleteInClassroom`, so it is
   * only removed if it belongs to this classroom.
   */
  classroomId?: string;
  /** The Repository the student repo was made from, for the audit row. */
  repositoryId?: string | null;
  /**
   * Who the delete is recorded for, once the row is gone in `classroomId`:
   * REPOSITORY / DELETE on the student repo, with `repository_id` and
   * `deleted_from_provider`. `null` (or no classroom): no row.
   */
  actor: AuditActor | null;
}

interface DeleteSubmissionPayload {
  classroomId: string;
  /** The submission as the caller loaded it from this classroom. */
  submission: { id: string; assignment_id: string; git_repo: { id: string; name: string } };
  /**
   * Also delete the student's repository, on the provider too. Its row goes
   * with it, and every submission on it by cascade, not just this one.
   */
  repository?: { gitOrganization: HelperGitOrganization } | null;
  /** Who the deletion is recorded for; null writes no audit row. */
  actor: AuditActor | null;
}

/**
 * Add or remove one grader on one submission of a classroom. Only ids come in;
 * the repo name, the issue number and the grader's login are read from the
 * stored rows.
 */
interface ClassroomGraderPayload {
  classroomId: string;
  /** The classroom's own git organization — the one its repos live in. */
  gitOrganization: HelperGitOrganization;
  gitRepoAssignmentId: unknown;
  graderId: unknown;
  /** Narrow the submission to one Repository (the repository page). */
  repositoryId?: string;
  /** Narrow the submission to one Assignment (the assignment page). */
  assignmentId?: string;
  /**
   * false → no per-submission TA_GRADING_ASSIGNED notification (the caller
   * sends one summary instead). Defaults to true.
   */
  notify?: boolean;
  /** Who the change is recorded for; null writes no audit row (no person acting). */
  actor: AuditActor | null;
}

export type AddGraderInClassroomResult =
  | { status: 'added'; graderLogin: string; audit: ServiceAudit }
  | { status: 'already_assigned'; graderLogin: string }
  | { status: 'submission_not_found' | 'grader_not_eligible' };

export type RemoveGraderInClassroomResult =
  | { status: 'removed'; graderLogin: string; audit: ServiceAudit }
  | { status: 'submission_not_found' | 'grader_not_assigned' };

interface GitRepoAssignmentGraderPayload {
  repoName: string;
  gitOrganization: HelperGitOrganization;
  /** Null for a REPO-mode submission: there is no issue to assign on GitHub. */
  githubIssueNumber: number | null;
  graderLogin: string;
  graderId: string;
  gitRepoAssignmentId: string;
  /** false → skip the per-submission notification. Defaults to true. */
  notify?: boolean;
}

interface HelperClassroomRef {
  id: string;
}

interface GitRepoAssignmentRef {
  id: string;
  studentId?: string | null;
  teamId?: string | null;
}

interface GradeAssignmentPayload {
  classroom: HelperClassroomRef;
  gitRepoAssignment: GitRepoAssignmentRef;
  graderId: string;
  grade: string;
  studentId?: string;
  teamId?: string;
  /** Who the change is recorded for; null writes no audit row (no person acting). */
  actor: AuditActor | null;
}

interface EmojiMappingWithTokens {
  emoji: string;
  extra_tokens: number;
}

interface TokenTransactionRef {
  id: string;
  amount: number;
}

interface GradeWithTokenTransaction {
  id: string;
  emoji: string;
  token_transaction?: TokenTransactionRef | null;
}

/** A grade row a grade transaction removed. */
export interface RemovedGrade {
  id: string;
  emoji: string;
  grader_id: string | null;
}

/**
 * What one `addGradeToGitRepoAssignment` call changed, read inside its
 * transaction: the grades it removed (pre-regrade grades, the grader's
 * previous score) and the grade it created, if any. Both empty when the grade
 * was already there, including when a concurrent identical call added it
 * first.
 */
export interface AddGradeOutcome {
  removed: RemovedGrade[];
  created: { id: string; emoji: string } | null;
  /** The audit row of the change (none when nothing changed or `actor` is null). */
  audit: ServiceAudit;
}

interface RemoveGradePayload {
  classroom: HelperClassroomRef;
  gitRepoAssignment: GitRepoAssignmentRef;
  grade: GradeWithTokenTransaction;
  /** Who the removal is recorded for; null writes no audit row (no person acting). */
  actor: AuditActor | null;
}

/** What one `removeGradeFromGitRepoAssignment` call did. */
export interface RemoveGradeOutcome {
  /** False, having changed nothing, when the grade was already gone. */
  removed: boolean;
  audit: ServiceAudit;
}

/**
 * Options for a grade transaction. Read committed, which the ledger locks rely
 * on (see lockLedger in token.service), and a longer timeout than Prisma's 5 s
 * default, since a team grade writes one ledger row per member. `maxWait` is
 * how long to wait for a pooled connection (Prisma's default is 2 s), so a
 * burst of grade changes queued on the same locks does not fail other requests
 * waiting for a connection.
 */
const GRADE_TX = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 5_000,
  timeout: 15_000,
};

/** One grade transaction's submission and the students its rewards go to. */
interface GradeScope {
  classroomId: string;
  gitRepoAssignmentId: string;
  /** The repo's student, or its team's members; sorted, each once. */
  recipients: string[];
}

/**
 * Start a grade transaction on a submission: lock the submission, read from
 * the database who its token rewards go to (the student who owns the repo, or
 * every current member of the team that owns it), then lock those ledgers for
 * the rest of the transaction. Grades, their token rows and the link between
 * them then commit together, and no other grade change on this submission or
 * ledger write on these students interleaves. The submission lock comes
 * first, then `lockLedgers` in sorted order, so the lock order is the same in
 * every transaction.
 */
async function openGradeScope(
  tx: Prisma.TransactionClient,
  classroomId: string,
  gitRepoAssignmentId: string
): Promise<GradeScope> {
  // Taken even when the submission pays nobody (no ledger locks follow), so
  // two identical grade changes on it never run side by side.
  await ClassmojiService.token.lockSubmission(tx, gitRepoAssignmentId);
  const submission = await tx.gitRepoAssignment.findUnique({
    where: { id: gitRepoAssignmentId },
    select: { git_repo: { select: { student_id: true, team_id: true } } },
  });
  const repo = submission?.git_repo;
  let recipients: string[] = [];
  if (repo?.student_id) {
    recipients = [repo.student_id];
  } else if (repo?.team_id) {
    const members = await tx.teamMembership.findMany({
      where: { team_id: repo.team_id },
      select: { user_id: true },
    });
    recipients = members.map(member => member.user_id);
  }
  recipients = [...new Set(recipients)].sort();
  await ClassmojiService.token.lockLedgers(tx, classroomId, recipients);
  return { classroomId, gitRepoAssignmentId, recipients };
}

/**
 * Delete one grade of the scope's submission and reverse its token reward for
 * every recipient, answering the row it removed. The delete is conditional:
 * when the grade is already gone (another request removed it first), nothing
 * is reversed and this returns null. The reward amount is read here, inside
 * the transaction.
 */
async function removeGradeRowInScope(
  tx: Prisma.TransactionClient,
  scope: GradeScope,
  gradeId: string
): Promise<RemovedGrade | null> {
  const where = { id: gradeId, git_repo_assignment_id: scope.gitRepoAssignmentId };
  const grade = await tx.assignmentGrade.findFirst({
    where,
    select: { emoji: true, grader_id: true, token_transaction: { select: { amount: true } } },
  });
  if (!grade) return null;

  const { count } = await tx.assignmentGrade.deleteMany({ where });
  if (count === 0) return null;
  const removed = { id: gradeId, emoji: grade.emoji, grader_id: grade.grader_id };
  if (!grade.token_transaction) return removed;

  for (const studentId of scope.recipients) {
    await ClassmojiService.token.assignToStudent(
      {
        classroomId: scope.classroomId,
        studentId,
        amount: grade.token_transaction.amount * -1,
        description: `Removing ${grade.emoji}.`,
        repositoryAssignmentId: scope.gitRepoAssignmentId,
        type: 'REMOVAL',
      },
      tx
    );
  }
  return removed;
}

/**
 * If the submission has an open (IN_REVIEW) regrade request, remove the grades
 * that predate it, with their token rewards, inside the caller's transaction.
 * Answers the rows it removed.
 */
async function clearStaleGradesInScope(
  tx: Prisma.TransactionClient,
  scope: GradeScope
): Promise<RemovedGrade[]> {
  const openRequest = await ClassmojiService.regradeRequest.findOpenByAssignmentId(
    scope.gitRepoAssignmentId,
    tx
  );
  if (!openRequest) return [];

  const grades = await ClassmojiService.assignmentGrade.findByAssignmentId(
    scope.gitRepoAssignmentId,
    tx
  );
  const removed: RemovedGrade[] = [];
  for (const grade of grades) {
    if (grade.created_at <= openRequest.created_at) {
      const row = await removeGradeRowInScope(tx, scope, grade.id);
      if (row) removed.push(row);
    }
  }
  return removed;
}

class HelperService {
  static async deleteRepository(
    payload: DeleteRepositoryPayload
  ): Promise<{ audit: ServiceAudit }> {
    let deleted = false;
    try {
      const { name: repoName, gitOrganization, deleteFromGithub } = payload;
      if (deleteFromGithub) {
        const gitProvider = getGitProvider(gitOrganization);
        // GitLab student projects live in the class subgroup's `projects`
        // subgroup, not the group.
        let owner = payload.repoOwner ?? gitOrganization.login;
        if (!payload.repoOwner && gitOrganization.provider === 'GITLAB' && payload.id) {
          const row = await ClassmojiService.gitRepo.find({ id: payload.id });
          const classroom = row?.classroom_id
            ? await ClassmojiService.classroom.findById(row.classroom_id)
            : null;
          if (classroom?.git_namespace) {
            owner = `${classroom.git_namespace}/${GITLAB_PROJECTS_SUBGROUP}`;
          }
        }
        await gitProvider.deleteRepository(owner, repoName);
      }
      if (payload?.id && payload.classroomId) {
        await ClassmojiService.gitRepo.deleteInClassroom(payload.id, payload.classroomId);
        deleted = true;
      } else if (payload?.id) {
        await ClassmojiService.gitRepo.deleteById(payload.id);
      }
    } catch (error: unknown) {
      console.error('Error deleting git_repo:', error);
      throw error;
    }
    if (!deleted || !payload.id || !payload.classroomId) return { audit: NO_SERVICE_AUDIT };
    const audit = await recordForActor(payload.actor, {
      classroomId: payload.classroomId,
      resourceType: 'REPOSITORY',
      resourceId: payload.id,
      action: 'DELETE',
      data: {
        repository_id: payload.repositoryId ?? null,
        deleted_from_provider: Boolean(payload.deleteFromGithub),
      },
    });
    return { audit };
  }

  /**
   * Delete one submission (Classmoji's record of an assignment on a student's
   * repository; its grades go with it by cascade), or, with `repository`, the
   * whole student repository. Then one audit row for `actor`
   * (GIT_REPO_ASSIGNMENT, DELETE: the assignment, the repository row and
   * whether the repository went too).
   */
  static async deleteSubmission(
    payload: DeleteSubmissionPayload
  ): Promise<{ audit: ServiceAudit }> {
    const { classroomId, submission, repository, actor } = payload;
    if (repository) {
      await this.deleteRepository({
        id: submission.git_repo.id,
        name: submission.git_repo.name,
        gitOrganization: repository.gitOrganization,
        deleteFromGithub: true,
        // The row goes only if it belongs to this classroom.
        classroomId,
        // The submission's own row below records the repository's delete.
        actor: null,
      });
    } else {
      await ClassmojiService.gitRepoAssignment.deleteById(submission.id);
    }
    const audit = await recordForActor(actor, {
      classroomId,
      resourceType: 'GIT_REPO_ASSIGNMENT',
      resourceId: submission.id,
      action: 'DELETE',
      data: {
        assignment_id: submission.assignment_id,
        git_repo_id: submission.git_repo.id,
        repository_deleted: Boolean(repository),
      },
    });
    return { audit };
  }

  static async addGraderToGitRepoAssignment(
    payload: GitRepoAssignmentGraderPayload
  ): Promise<unknown> {
    const {
      repoName,
      gitOrganization,
      githubIssueNumber,
      graderLogin,
      graderId,
      gitRepoAssignmentId,
    } = payload;

    if (githubIssueNumber != null) {
      const gitProvider = getGitProvider(gitOrganization);
      await gitProvider.addIssueAssignees(gitOrganization.login, repoName, githubIssueNumber, [
        graderLogin,
      ]);
    }

    return ClassmojiService.gitRepoAssignmentGrader.addGraderToAssignment(
      gitRepoAssignmentId,
      graderId,
      { notify: payload.notify ?? true }
    );
  }

  static async removeGraderFromGitRepoAssignment(
    payload: GitRepoAssignmentGraderPayload
  ): Promise<unknown> {
    const {
      repoName,
      gitOrganization,
      githubIssueNumber,
      graderLogin,
      graderId,
      gitRepoAssignmentId,
    } = payload;

    if (githubIssueNumber != null) {
      const gitProvider = getGitProvider(gitOrganization);
      await gitProvider.removeIssueAssignees(gitOrganization.login, repoName, githubIssueNumber, [
        graderLogin,
      ]);
    }

    return ClassmojiService.gitRepoAssignmentGrader.removeGraderFromAssignment(
      gitRepoAssignmentId,
      graderId
    );
  }

  /**
   * Add a grader to a submission of this classroom, from ids alone.
   *
   * The submission is loaded from this classroom (optionally narrowed to a
   * repository or an assignment); its stored repo name and issue number are the
   * ones the provider call uses. The grader must be in this classroom's grader
   * pool (`gitRepoAssignmentGrader.findEligibleGrader`), and their stored login
   * is the one assigned. Nothing reaches the provider or the database unless
   * both checks pass. Someone already on the submission is left as is,
   * including when a concurrent add inserts the row first (P2002).
   *
   * An added grader is recorded for `actor` after the write
   * (GIT_REPO_ASSIGNMENT_GRADER on the submission, CREATE); nothing else is.
   */
  static async addGraderInClassroom(
    payload: ClassroomGraderPayload
  ): Promise<AddGraderInClassroomResult> {
    const { classroomId, gitOrganization, gitRepoAssignmentId, graderId } = payload;

    const submission = await ClassmojiService.gitRepoAssignment.findByIdInClassroom(
      gitRepoAssignmentId,
      classroomId,
      { repositoryId: payload.repositoryId, assignmentId: payload.assignmentId }
    );
    if (!submission) return { status: 'submission_not_found' };

    const grader = await ClassmojiService.gitRepoAssignmentGrader.findEligibleGrader(
      classroomId,
      graderId
    );
    if (!grader?.login) return { status: 'grader_not_eligible' };

    if (submission.graders.some(g => g.grader_id === grader.id)) {
      return { status: 'already_assigned', graderLogin: grader.login };
    }

    try {
      await this.addGraderToGitRepoAssignment({
        repoName: submission.git_repo.name,
        gitOrganization,
        githubIssueNumber: submission.provider_issue_number,
        graderLogin: grader.login,
        graderId: grader.id,
        gitRepoAssignmentId: submission.id,
        notify: payload.notify ?? true,
      });
    } catch (error) {
      // A concurrent add of the same grader won the race between the check
      // above and the insert: the (submission, grader) row is unique, so the
      // grader is on the submission either way. Adding the same GitHub
      // assignee twice is a no-op there too.
      if ((error as { code?: string })?.code === 'P2002') {
        return { status: 'already_assigned', graderLogin: grader.login };
      }
      throw error;
    }
    const audit = await recordForActor(payload.actor, {
      classroomId,
      resourceType: 'GIT_REPO_ASSIGNMENT_GRADER',
      resourceId: submission.id,
      action: 'CREATE',
      // `value`: the grader assigned.
      data: { value: grader.id, grader_id: grader.id, grader_login: grader.login },
    });
    return { status: 'added', graderLogin: grader.login, audit };
  }

  /**
   * Remove a grader from a submission of this classroom, from ids alone.
   *
   * The submission is loaded from this classroom as in `addGraderInClassroom`;
   * the grader is taken from the submission's own grader rows (so someone who
   * has since left the grader pool can still be removed), and their stored
   * login is the one unassigned on the provider.
   *
   * A removed grader is recorded for `actor` after the write
   * (GIT_REPO_ASSIGNMENT_GRADER on the submission, DELETE).
   */
  static async removeGraderInClassroom(
    payload: ClassroomGraderPayload
  ): Promise<RemoveGraderInClassroomResult> {
    const { classroomId, gitOrganization, gitRepoAssignmentId, graderId } = payload;

    const submission = await ClassmojiService.gitRepoAssignment.findByIdInClassroom(
      gitRepoAssignmentId,
      classroomId,
      { repositoryId: payload.repositoryId, assignmentId: payload.assignmentId }
    );
    if (!submission) return { status: 'submission_not_found' };

    const assigned =
      typeof graderId === 'string' && graderId
        ? submission.graders.find(g => g.grader_id === graderId)
        : undefined;
    if (!assigned?.grader?.login) return { status: 'grader_not_assigned' };

    await this.removeGraderFromGitRepoAssignment({
      repoName: submission.git_repo.name,
      gitOrganization,
      githubIssueNumber: submission.provider_issue_number,
      graderLogin: assigned.grader.login,
      graderId: assigned.grader_id,
      gitRepoAssignmentId: submission.id,
    });
    const audit = await recordForActor(payload.actor, {
      classroomId,
      resourceType: 'GIT_REPO_ASSIGNMENT_GRADER',
      resourceId: submission.id,
      action: 'DELETE',
      data: {
        value: assigned.grader_id,
        grader_id: assigned.grader_id,
        grader_login: assigned.grader.login,
      },
    });
    return { status: 'removed', graderLogin: assigned.grader.login, audit };
  }

  /**
   * Move ONE slot off a departing grader: add the new grader first, then remove
   * the old one, so the submission is never left without a grader. Both steps
   * go through the classroom-scoped helpers above, so the submission is
   * re-loaded from this classroom and the new grader re-checked against the
   * pool. The provider calls use the classroom's own installation, never the
   * departing person's credentials — their login only appears as the assignee
   * being removed.
   *
   * Safe to repeat (a background retry): the add reports already_assigned and
   * a second removal reports already_removed. A slot graded since the plan was
   * made is left alone — graded slots are the record of who graded — and that
   * is checked again right before the removal, so a grade that lands while the
   * new grader is being added still keeps the old one on the record.
   *
   * No per-submission notification: the caller sends one summary per grader.
   */
  static async moveGraderSlot(
    payload: MoveGraderSlotPayload & {
      gitOrganization?: HelperGitOrganization | null;
      /** Who the add and the removal are recorded for; null records neither. */
      actor: AuditActor | null;
    }
  ): Promise<MoveGraderSlotResult & { audit: ServiceAudit }> {
    let audit = NO_SERVICE_AUDIT;
    const result = await this.moveGraderSlotRecorded(payload, owed => {
      audit = addServiceAudit(audit, owed);
    });
    return { ...result, audit };
  }

  private static async moveGraderSlotRecorded(
    payload: MoveGraderSlotPayload & {
      gitOrganization?: HelperGitOrganization | null;
      actor: AuditActor | null;
    },
    owed: (audit: ServiceAudit) => void
  ): Promise<MoveGraderSlotResult> {
    const { classroomId, gitRepoAssignmentId, fromGraderId, toGraderId, actor } = payload;

    let gitOrganization = payload.gitOrganization ?? null;
    if (!gitOrganization) {
      const classroom = await ClassmojiService.classroom.findById(classroomId);
      gitOrganization = (classroom?.git_organization as HelperGitOrganization | null) ?? null;
    }
    if (!gitOrganization) return { status: 'no_git_organization' };

    const isGraded = async () =>
      (await ClassmojiService.assignmentGrade.findByAssignmentId(gitRepoAssignmentId)).length > 0;

    if (await isGraded()) return { status: 'graded_since' };

    let toLogin: string | null = null;
    let ineligible = false;
    if (toGraderId) {
      const added = await this.addGraderInClassroom({
        classroomId,
        gitOrganization,
        gitRepoAssignmentId,
        graderId: toGraderId,
        notify: false,
        actor,
      });
      if ('audit' in added) owed(added.audit);
      if ('graderLogin' in added) {
        toLogin = added.graderLogin;
      } else if (added.status === 'grader_not_eligible') {
        // A retry after a partial success: the add went through last time and
        // the grader has left the pool since. They are on the slot, so this is
        // still a move — finish it by removing the departing grader.
        const submission = await ClassmojiService.gitRepoAssignment.findByIdInClassroom(
          gitRepoAssignmentId,
          classroomId
        );
        const onSlot = submission?.graders.find(g => g.grader_id === toGraderId);
        if (onSlot?.grader?.login) {
          toLogin = onSlot.grader.login;
        } else if (payload.fallbackToUnassign) {
          // The planned grader left the pool after the plan was made. Leaving
          // the slot with the departing grader would strand it; unassign instead.
          ineligible = true;
        } else {
          return { status: 'grader_not_eligible' };
        }
      } else {
        return { status: added.status };
      }
    }

    if (await isGraded()) return { status: 'graded_since' };

    const removed = await this.removeGraderInClassroom({
      classroomId,
      gitOrganization,
      gitRepoAssignmentId,
      graderId: fromGraderId,
      actor,
    });
    if ('audit' in removed) owed(removed.audit);
    if (removed.status === 'submission_not_found') return { status: 'submission_not_found' };
    if (removed.status === 'grader_not_assigned') {
      // Already gone (a retry, or a concurrent move). With the new grader on the
      // slot this is a completed move, and it belongs in the summary.
      return toLogin ? { status: 'moved', toLogin } : { status: 'already_removed' };
    }

    if (toLogin) return { status: 'moved', toLogin };
    return ineligible
      ? { status: 'unassigned', reason: 'grader_not_eligible' }
      : { status: 'unassigned' };
  }

  /**
   * One TA_GRADING_ASSIGNED notification per receiving grader, instead of one
   * per submission. Same type, resource and title shape as the per-submission
   * one (gitRepoAssignmentGrader.notifyGraderAssigned), so the bell links to
   * the grading queue and the email renders "You've been assigned to grade …".
   */
  static async notifyReassignedGraders({
    classroomId,
    reassigned,
    departingName,
    firstSubmissionByGrader,
    queued,
  }: {
    classroomId: string;
    reassigned: UngradedSlotsOutcome['reassigned'];
    departingName: string;
    firstSubmissionByGrader: Map<string, string>;
    queued: boolean;
  }): Promise<void> {
    for (const { graderId, count } of reassigned) {
      const resourceId = firstSubmissionByGrader.get(graderId);
      if (!resourceId || count <= 0) continue;
      const what = plural(count, 'submission', 'submissions');
      await ClassmojiService.notification.runSafely('reassigned grading notification', () =>
        ClassmojiService.notification.createNotifications({
          type: 'TA_GRADING_ASSIGNED',
          classroomId,
          recipientUserIds: [graderId],
          resourceType: 'git_repo_assignment',
          resourceId,
          title: queued
            ? `New grading: ${what} from ${departingName} (being assigned now)`
            : `New grading: ${what} from ${departingName}`,
          metadata: { reassigned_count: count, from: departingName },
        })
      );
    }
  }

  /**
   * Carry out the owner's decision for a departing grader's UNGRADED slots.
   *
   *   keep     — nothing changes (the behaviour before this existed).
   *   unassign — their rows on those submissions are removed.
   *   reassign — spread across the other eligible graders
   *              (gitRepoAssignmentGrader.planUngradedReassignment); with no
   *              other eligible grader it falls back to unassign and says so
   *              in `fallback`.
   *
   * Slots are re-read here rather than taken from the caller. Up to
   * UNGRADED_INLINE_LIMIT they are moved in this request, each one in its own
   * try so one provider failure does not abort the rest; above it they go out
   * as one `move_grader_slot` run per slot and the outcome reports the plan
   * with `queued: true`. Each receiving grader gets ONE summary notification.
   * `audit` counts every grader row attempted in this request, including the
   * add of a slot whose removal then failed.
   */
  static async resolveUngradedSlots(args: ResolveUngradedSlotsArgs): Promise<UngradedSlotsOutcome> {
    return this.resolveUngradedSlotsRecorded(args, () => {});
  }

  /**
   * `resolveUngradedSlots`, also handing each grader row's audit result to
   * `owed` as soon as it is attempted, so a caller that catches a later
   * failure still knows every row written or missed before it.
   */
  private static async resolveUngradedSlotsRecorded(
    {
      classroomId,
      graderId,
      choice,
      departingName = 'a departing grader',
      actor,
    }: ResolveUngradedSlotsArgs,
    owed: (audit: ServiceAudit) => void
  ): Promise<UngradedSlotsOutcome> {
    const slots = await ClassmojiService.gitRepoAssignmentGrader.findUngradedSlotsForGrader(
      classroomId,
      graderId
    );
    const outcome = emptyOutcome(choice, slots.length);
    if (slots.length === 0) return outcome;

    if (choice === 'keep') {
      outcome.kept = slots.length;
      return outcome;
    }

    let moves: PlannedMove[];
    if (choice === 'reassign') {
      const plan = await ClassmojiService.gitRepoAssignmentGrader.planUngradedReassignment({
        classroomId,
        fromGraderId: graderId,
        slots,
      });
      moves = plan.moves;
      outcome.fallback = plan.fallback;
    } else {
      moves = slots.map(slot => ({
        gitRepoAssignmentId: slot.git_repo_assignment.id,
        toGraderId: null,
        toLogin: null,
        reason: 'no_eligible_graders' as const,
      }));
    }

    const tally = new Map<string, { graderId: string; login: string; count: number }>();
    const firstSubmissionByGrader = new Map<string, string>();
    const record = (move: PlannedMove, login: string | null) => {
      if (move.toGraderId && login) {
        const entry = tally.get(move.toGraderId) ?? {
          graderId: move.toGraderId,
          login,
          count: 0,
        };
        entry.count += 1;
        tally.set(move.toGraderId, entry);
        if (!firstSubmissionByGrader.has(move.toGraderId)) {
          firstSubmissionByGrader.set(move.toGraderId, move.gitRepoAssignmentId);
        }
      } else if (move.reason === 'covered') {
        outcome.alreadyCovered += 1;
      } else {
        outcome.unassigned += 1;
      }
    };
    const finish = async () => {
      outcome.reassigned = [...tally.values()].sort((a, b) => a.login.localeCompare(b.login));
      await this.notifyReassignedGraders({
        classroomId,
        reassigned: outcome.reassigned,
        departingName,
        firstSubmissionByGrader,
        queued: outcome.queued,
      });
      return outcome;
    };

    if (moves.length > UNGRADED_INLINE_LIMIT) {
      // Chunk by chunk: a chunk that fails to queue fails its slots and every
      // later one, while the chunks already queued are reported as such.
      for (let i = 0; i < moves.length; i += BATCH_CHUNK) {
        const chunk = moves.slice(i, i + BATCH_CHUNK);
        try {
          await tasks.batchTrigger(
            'move_grader_slot',
            chunk.map(move => ({
              payload: {
                classroomId,
                gitRepoAssignmentId: move.gitRepoAssignmentId,
                fromGraderId: graderId,
                toGraderId: move.toGraderId,
                fallbackToUnassign: choice === 'reassign',
                ...(actor ? { actor } : {}),
              } satisfies MoveGraderSlotPayload,
            }))
          );
        } catch (error) {
          console.error(
            `[ungraded-slots] could not queue ${moves.length - i} slot moves off ${graderId}:`,
            error
          );
          reportError(error, {
            surface: 'staff.ungraded_slots',
            tags: { step: 'queue' },
            extra: { slots: moves.length - i },
          });
          outcome.failed += moves.length - i;
          break;
        }
        for (const move of chunk) record(move, move.toLogin);
        outcome.queued = true;
      }
      return finish();
    }

    const classroom = await ClassmojiService.classroom.findById(classroomId);
    const gitOrganization = (classroom?.git_organization as HelperGitOrganization | null) ?? null;

    await mapPool(moves, UNGRADED_INLINE_CONCURRENCY, async move => {
      try {
        // Each row is counted as it is attempted, so a move that fails after
        // its add still reports the add's row.
        const result = await this.moveGraderSlotRecorded(
          {
            classroomId,
            gitOrganization,
            gitRepoAssignmentId: move.gitRepoAssignmentId,
            fromGraderId: graderId,
            toGraderId: move.toGraderId,
            fallbackToUnassign: choice === 'reassign',
            actor,
          },
          audit => {
            outcome.audit = addServiceAudit(outcome.audit, audit);
            owed(audit);
          }
        );
        if (result.status === 'moved') record(move, result.toLogin);
        else if (result.status === 'unassigned' && result.reason === 'grader_not_eligible') {
          outcome.unassigned += 1;
          outcome.unassignedIneligible += 1;
        } else if (result.status === 'unassigned') record(move, null);
        // already_removed / graded_since are correct skips, not failures: the
        // slot is gone, or it is now the record of who graded.
        else if (result.status !== 'already_removed' && result.status !== 'graded_since') {
          outcome.failed += 1;
        }
      } catch (error) {
        console.error(
          `[ungraded-slots] could not move submission ${move.gitRepoAssignmentId} off ${graderId}:`,
          error
        );
        reportError(error, { surface: 'staff.ungraded_slots', tags: { step: 'move' } });
        outcome.failed += 1;
      }
    });

    return finish();
  }

  /**
   * Step 1 of removing a staff role — shared by the web Teaching Staff action
   * and MCP staff_remove. Queues the removal; moves nothing.
   *
   *   1. previewRemoval — who they are, the refusals (not found, last owner)
   *      and whether their ungraded slots need a decision (only when no
   *      grader-flagged ASSISTANT/TEACHER role remains). The refusals come
   *      first, so an owner is never asked a question that ends in "no".
   *   2. With slots at stake and no choice: `requireChoice` (MCP) refuses with
   *      `ungraded_choice_required` BEFORE anything is queued; otherwise the
   *      choice is `keep`, which is what removal did before.
   *   3. staff.removeStaff queues the removal run.
   *
   * The caller then waits for that run and, ONLY if it succeeded, calls
   * settleUngradedSlots with the returned choice. Settling first would move
   * slots off someone whose removal then failed.
   */
  static async startStaffRemoval({
    classroomId,
    login,
    role,
    ungradedSubmissions,
    requireChoice = false,
    actor,
  }: {
    classroomId: string;
    login: string;
    role: StaffRole;
    ungradedSubmissions?: UngradedChoice | null;
    requireChoice?: boolean;
    /**
     * The owner asking for the removal, for the audit of any plan-owner
     * hand-off it causes. The removal's own row is the caller's, written with
     * `staff.recordStaffRemoval` once it knows the outcome.
     */
    actor: AuditActor | null;
  }): Promise<StaffRemovalStart> {
    const preview = await ClassmojiService.staff.previewRemoval({ classroomId, login, role });

    if (preview.ungradedCount > 0 && !ungradedSubmissions && requireChoice) {
      throw new StaffServiceError(
        'ungraded_choice_required',
        `[staff] ${preview.login} is assigned ${preview.ungradedCount} ungraded submissions`,
        { ungradedCount: preview.ungradedCount }
      );
    }

    const removal = await ClassmojiService.staff.removeStaff({
      classroomId,
      login,
      role,
      actor,
    });

    return {
      ...removal,
      name: preview.name,
      ungradedCount: preview.ungradedCount,
      heldUngradedCount: preview.heldUngradedCount,
      choice: preview.ungradedCount > 0 ? (ungradedSubmissions ?? 'keep') : null,
    };
  }

  /**
   * Step 2: after the removal run has SUCCEEDED, carry out the choice. Never
   * throws — the removal is already done, so a failure here is reported in the
   * outcome (every expected slot counted as failed) for the caller to say so.
   */
  static async settleUngradedSlots({
    classroomId,
    graderId,
    choice,
    departingName,
    expectedCount,
    actor,
  }: {
    classroomId: string;
    graderId: string;
    choice: UngradedChoice;
    departingName: string;
    expectedCount: number;
    /** See `resolveUngradedSlots`. */
    actor: AuditActor | null;
  }): Promise<UngradedSlotsOutcome> {
    // The rows attempted before a failure are still reported with it.
    let audit = NO_SERVICE_AUDIT;
    try {
      return await this.resolveUngradedSlotsRecorded(
        { classroomId, graderId, choice, departingName, actor },
        owed => {
          audit = addServiceAudit(audit, owed);
        }
      );
    } catch (error) {
      console.error(`[staff] ungraded slots of ${graderId} were not handled:`, error);
      reportError(error, {
        surface: 'staff.ungraded_slots',
        tags: { step: 'settle' },
        extra: { classroomId, slots: expectedCount },
      });
      return { ...emptyOutcome(choice, expectedCount), failed: expectedCount, audit };
    }
  }

  /**
   * If the assignment has an open (IN_REVIEW) regrade request, remove the grades
   * that predate the request so a fresh grade replaces — rather than averages
   * with — the original. Grades applied after the request (deliberate multi-emoji
   * grading during the re-grade) are left untouched. Each grade's token reward is
   * reversed with it, in one transaction.
   */
  static async clearGradesForOpenRegradeRequest(
    classroom: HelperClassroomRef,
    gitRepoAssignment: GitRepoAssignmentRef
  ): Promise<void> {
    await getPrisma().$transaction(async tx => {
      const scope = await openGradeScope(tx, classroom.id, gitRepoAssignment.id);
      await clearStaleGradesInScope(tx, scope);
    }, GRADE_TX);
  }

  /**
   * Add a grade and pay its token reward, as one transaction: clearing grades
   * that predate an open regrade request, replacing the grader's previous
   * numeric score, creating the grade, its GAIN row(s) and the link to them
   * either all commit or none do. The recipients come from the submission's
   * repo; `studentId`/`teamId` in the payload are accepted but not used.
   * Answers what this call changed (see `AddGradeOutcome`), read inside the
   * transaction.
   *
   * Once the transaction has committed, and only when it changed something,
   * one audit row is written for `actor` (GIT_REPO_ASSIGNMENT, CREATE): the
   * grade given, the created grade's id, the caller's own grades it replaced
   * and every grade it removed. A failed write is logged and reported in
   * `audit`; the grade stands.
   */
  static async addGradeToGitRepoAssignment(
    payload: GradeAssignmentPayload
  ): Promise<AddGradeOutcome> {
    const { classroom, gitRepoAssignment, graderId, grade, actor } = payload;
    const change = await this.addGradeInTransaction(payload);
    if (!change.created && change.removed.length === 0) {
      return { ...change, audit: NO_SERVICE_AUDIT };
    }
    // The grader's own grades this call removed (their previous score on the
    // numeric scale, their pre-regrade grades), so the change reads back.
    const replaced = change.removed.filter(g => g.grader_id === graderId).map(g => g.emoji);
    const audit = await recordForActor(actor, {
      classroomId: classroom.id,
      resourceType: 'GIT_REPO_ASSIGNMENT',
      resourceId: gitRepoAssignment.id,
      action: 'CREATE',
      data: {
        emoji: grade,
        ...(change.created ? { grade_id: change.created.id } : {}),
        ...(replaced.length > 0 ? { replaced } : {}),
        ...(change.removed.length > 0 ? { removed_grade_ids: change.removed.map(g => g.id) } : {}),
      },
    });
    return { ...change, audit };
  }

  /** `addGradeToGitRepoAssignment`'s scale check and transaction, without the audit row. */
  private static async addGradeInTransaction(
    payload: GradeAssignmentPayload
  ): Promise<Omit<AddGradeOutcome, 'audit'>> {
    const { classroom, gitRepoAssignment, graderId, grade } = payload;

    // Only emojis in the classroom's grading scale are grades. A classroom
    // with no scale yet (fresh import) accepts anything, as before.
    const scale = (await ClassmojiService.emojiMapping.findByClassroomId(
      classroom.id,
      true
    )) as EmojiMappingWithTokens[];
    if (scale.length > 0 && !scale.some(mapping => mapping.emoji === grade)) {
      throw new Error(`"${grade}" is not in this classroom's grading scale`);
    }
    const reward = scale.find(mapping => mapping.emoji === grade)?.extra_tokens ?? 0;

    return getPrisma().$transaction(async (tx): Promise<Omit<AddGradeOutcome, 'audit'>> => {
      const scope = await openGradeScope(tx, classroom.id, gitRepoAssignment.id);

      // When a submission has an open resubmit (regrade) request, a new grade
      // should replace the original grade rather than be averaged with it.
      // Clear the grades captured at request time before adding the new one.
      // The request's `previous_grade` snapshot keeps those emojis visible in
      // the "Previous Grade" column for reference.
      const removed = await clearStaleGradesInScope(tx, scope);

      // A numeric score is one number per grader, never a stack: a grader's new
      // score replaces the score they gave before (tokens reversed with it).
      // Other graders' scores stay and average, as separate opinions should.
      if (parseScoreEmoji(grade) !== null) {
        const existing = await ClassmojiService.assignmentGrade.findByAssignmentId(
          gitRepoAssignment.id,
          tx
        );
        for (const previous of existing) {
          if (previous.grader_id !== graderId) continue;
          if (parseScoreEmoji(previous.emoji) === null) continue;
          if (previous.emoji === grade) return { removed, created: null };
          // A score already removed by a concurrent request (a double submit
          // from the same field) deletes nothing and reverses nothing.
          const row = await removeGradeRowInScope(tx, scope, previous.id);
          if (row) removed.push(row);
        }
      }

      if (await ClassmojiService.assignmentGrade.doesGradeExist(gitRepoAssignment.id, grade, tx)) {
        return { removed, created: null };
      }

      const assignmentGrade = await ClassmojiService.assignmentGrade.addGrade(
        gitRepoAssignment.id,
        graderId,
        grade,
        tx
      );
      const created = { id: assignmentGrade.id, emoji: assignmentGrade.emoji };

      if (reward <= 0) return { removed, created };

      // One GAIN row per recipient; the grade links to the first, whose amount
      // is what a removal reverses for each of them.
      let firstTransaction: { id: string } | null = null;
      for (const studentId of scope.recipients) {
        const tokenTransaction = await ClassmojiService.token.assignToStudent(
          {
            classroomId: classroom.id,
            studentId,
            amount: reward,
            description: `Tokens for getting a ${grade}.`,
            repositoryAssignmentId: gitRepoAssignment.id,
          },
          tx
        );
        firstTransaction ??= tokenTransaction;
      }

      if (firstTransaction) {
        await ClassmojiService.assignmentGrade.update(
          assignmentGrade.id,
          { token_transaction_id: firstTransaction.id },
          tx
        );
      }
      return { removed, created };
    }, GRADE_TX);
  }

  /**
   * Remove a grade and reverse its token reward for the submission's student
   * or every member of its team, as one transaction. `removed` is false,
   * having changed nothing, when the grade was already removed (a concurrent
   * remove got there first); the reversal is written exactly once. The
   * recipients and the reward amount are read from the database, not from the
   * payload.
   *
   * After the commit, when the grade was removed, one audit row is written for
   * `actor` (GIT_REPO_ASSIGNMENT, DELETE: the grade's id and emoji, as stored).
   */
  static async removeGradeFromGitRepoAssignment(
    payload: RemoveGradePayload
  ): Promise<RemoveGradeOutcome> {
    const { classroom, gitRepoAssignment, grade, actor } = payload;

    const row = await getPrisma().$transaction(async tx => {
      const scope = await openGradeScope(tx, classroom.id, gitRepoAssignment.id);
      return removeGradeRowInScope(tx, scope, grade.id);
    }, GRADE_TX);
    if (!row) return { removed: false, audit: NO_SERVICE_AUDIT };

    const audit = await recordForActor(actor, {
      classroomId: classroom.id,
      resourceType: 'GIT_REPO_ASSIGNMENT',
      resourceId: gitRepoAssignment.id,
      action: 'DELETE',
      data: { emoji: row.emoji, grade_id: row.id },
    });
    return { removed: true, audit };
  }
}

export default HelperService;
