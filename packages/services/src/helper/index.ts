import { tasks } from '@trigger.dev/sdk';
import { Prisma } from '@prisma/client';
import getPrisma from '@classmoji/database';
import { GITLAB_PROJECTS_SUBGROUP, parseScoreEmoji } from '@classmoji/utils';
import { getGitProvider } from '../git/index.ts';
import ClassmojiService from '../classmoji/index.ts';
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
}

export type AddGraderInClassroomResult =
  | { status: 'added' | 'already_assigned'; graderLogin: string }
  | { status: 'submission_not_found' | 'grader_not_eligible' };

export type RemoveGraderInClassroomResult =
  | { status: 'removed'; graderLogin: string }
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

interface RemoveGradePayload {
  classroom: HelperClassroomRef;
  gitRepoAssignment: GitRepoAssignmentRef;
  grade: GradeWithTokenTransaction;
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
 * every recipient. The delete is conditional: when the grade is already gone
 * (another request removed it first), nothing is reversed and this returns
 * false. The reward amount is read here, inside the transaction.
 */
async function removeGradeInScope(
  tx: Prisma.TransactionClient,
  scope: GradeScope,
  gradeId: string
): Promise<boolean> {
  const where = { id: gradeId, git_repo_assignment_id: scope.gitRepoAssignmentId };
  const grade = await tx.assignmentGrade.findFirst({
    where,
    select: { emoji: true, token_transaction: { select: { amount: true } } },
  });
  if (!grade) return false;

  const { count } = await tx.assignmentGrade.deleteMany({ where });
  if (count === 0) return false;
  if (!grade.token_transaction) return true;

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
  return true;
}

/**
 * If the submission has an open (IN_REVIEW) regrade request, remove the grades
 * that predate it, with their token rewards, inside the caller's transaction.
 */
async function clearStaleGradesInScope(
  tx: Prisma.TransactionClient,
  scope: GradeScope
): Promise<void> {
  const openRequest = await ClassmojiService.regradeRequest.findOpenByAssignmentId(
    scope.gitRepoAssignmentId,
    tx
  );
  if (!openRequest) return;

  const grades = await ClassmojiService.assignmentGrade.findByAssignmentId(
    scope.gitRepoAssignmentId,
    tx
  );
  for (const grade of grades) {
    if (grade.created_at <= openRequest.created_at) {
      await removeGradeInScope(tx, scope, grade.id);
    }
  }
}

class HelperService {
  static async deleteRepository(payload: DeleteRepositoryPayload): Promise<unknown> {
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
        return ClassmojiService.gitRepo.deleteInClassroom(payload.id, payload.classroomId);
      }
      if (payload?.id) return ClassmojiService.gitRepo.deleteById(payload.id);
    } catch (error: unknown) {
      console.error('Error deleting git_repo:', error);
      throw error;
    }
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
    return { status: 'added', graderLogin: grader.login };
  }

  /**
   * Remove a grader from a submission of this classroom, from ids alone.
   *
   * The submission is loaded from this classroom as in `addGraderInClassroom`;
   * the grader is taken from the submission's own grader rows (so someone who
   * has since left the grader pool can still be removed), and their stored
   * login is the one unassigned on the provider.
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
    return { status: 'removed', graderLogin: assigned.grader.login };
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
    payload: MoveGraderSlotPayload & { gitOrganization?: HelperGitOrganization | null }
  ): Promise<MoveGraderSlotResult> {
    const { classroomId, gitRepoAssignmentId, fromGraderId, toGraderId } = payload;

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
      });
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
    });
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
   */
  static async resolveUngradedSlots({
    classroomId,
    graderId,
    choice,
    departingName = 'a departing grader',
  }: {
    classroomId: string;
    graderId: string;
    choice: UngradedChoice;
    departingName?: string;
  }): Promise<UngradedSlotsOutcome> {
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
              } satisfies MoveGraderSlotPayload,
            }))
          );
        } catch (error) {
          console.error(
            `[ungraded-slots] could not queue ${moves.length - i} slot moves off ${graderId}:`,
            error
          );
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
        const result = await this.moveGraderSlot({
          classroomId,
          gitOrganization,
          gitRepoAssignmentId: move.gitRepoAssignmentId,
          fromGraderId: graderId,
          toGraderId: move.toGraderId,
          fallbackToUnassign: choice === 'reassign',
        });
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
  }: {
    classroomId: string;
    login: string;
    role: StaffRole;
    ungradedSubmissions?: UngradedChoice | null;
    requireChoice?: boolean;
  }): Promise<StaffRemovalStart> {
    const preview = await ClassmojiService.staff.previewRemoval({ classroomId, login, role });

    if (preview.ungradedCount > 0 && !ungradedSubmissions && requireChoice) {
      throw new StaffServiceError(
        'ungraded_choice_required',
        `[staff] ${preview.login} is assigned ${preview.ungradedCount} ungraded submissions`,
        { ungradedCount: preview.ungradedCount }
      );
    }

    const removal = await ClassmojiService.staff.removeStaff({ classroomId, login, role });

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
  }: {
    classroomId: string;
    graderId: string;
    choice: UngradedChoice;
    departingName: string;
    expectedCount: number;
  }): Promise<UngradedSlotsOutcome> {
    try {
      return await this.resolveUngradedSlots({ classroomId, graderId, choice, departingName });
    } catch (error) {
      console.error(`[staff] ungraded slots of ${graderId} were not handled:`, error);
      return { ...emptyOutcome(choice, expectedCount), failed: expectedCount };
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
   */
  static async addGradeToGitRepoAssignment(payload: GradeAssignmentPayload): Promise<void> {
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

    await getPrisma().$transaction(async tx => {
      const scope = await openGradeScope(tx, classroom.id, gitRepoAssignment.id);

      // When a submission has an open resubmit (regrade) request, a new grade
      // should replace the original grade rather than be averaged with it.
      // Clear the grades captured at request time before adding the new one.
      // The request's `previous_grade` snapshot keeps those emojis visible in
      // the "Previous Grade" column for reference.
      await clearStaleGradesInScope(tx, scope);

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
          if (previous.emoji === grade) return;
          // A score already removed by a concurrent request (a double submit
          // from the same field) deletes nothing and reverses nothing.
          await removeGradeInScope(tx, scope, previous.id);
        }
      }

      if (await ClassmojiService.assignmentGrade.doesGradeExist(gitRepoAssignment.id, grade, tx)) {
        return;
      }

      const assignmentGrade = await ClassmojiService.assignmentGrade.addGrade(
        gitRepoAssignment.id,
        graderId,
        grade,
        tx
      );

      if (reward <= 0) return;

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
    }, GRADE_TX);
  }

  /**
   * Remove a grade and reverse its token reward for the submission's student
   * or every member of its team, as one transaction. Returns false, having
   * changed nothing, when the grade was already removed (a concurrent remove
   * got there first); the reversal is written exactly once. The recipients and
   * the reward amount are read from the database, not from the payload.
   */
  static async removeGradeFromGitRepoAssignment(payload: RemoveGradePayload): Promise<boolean> {
    const { classroom, gitRepoAssignment, grade } = payload;

    return getPrisma().$transaction(async tx => {
      const scope = await openGradeScope(tx, classroom.id, gitRepoAssignment.id);
      return removeGradeInScope(tx, scope, grade.id);
    }, GRADE_TX);
  }
}

export default HelperService;
