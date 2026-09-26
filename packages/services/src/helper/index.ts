import { tasks } from '@trigger.dev/sdk';
import { parseScoreEmoji } from '@classmoji/utils';
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

interface TokenAssignmentPayload {
  organization: HelperClassroomRef;
  gitRepoAssignment: GitRepoAssignmentRef;
  grade: string;
  studentId: string;
}

interface TeamTokenAssignmentPayload extends Omit<TokenAssignmentPayload, 'studentId'> {
  teamId: string;
}

interface EmojiMappingWithTokens {
  emoji: string;
  extra_tokens: number;
}

interface AssignmentGradeRef {
  id: string;
}

interface TokenTransactionRef {
  id: string;
  amount: number;
}

interface TeamMembershipRef {
  user_id: string;
}

interface TeamWithMemberships {
  memberships?: TeamMembershipRef[] | null;
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

class HelperService {
  static async deleteRepository(payload: DeleteRepositoryPayload): Promise<unknown> {
    try {
      const { name: repoName, gitOrganization, deleteFromGithub } = payload;
      if (deleteFromGithub) {
        const gitProvider = getGitProvider(gitOrganization);
        await gitProvider.deleteRepository(gitOrganization.login, repoName);
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
      if (added.status === 'grader_not_eligible' && payload.fallbackToUnassign) {
        // The planned grader left the pool after the plan was made. Leaving the
        // slot with the departing grader would strand it; unassign instead.
        ineligible = true;
      } else if (!('graderLogin' in added)) {
        return { status: added.status };
      } else {
        toLogin = added.graderLogin;
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
    if (removed.status === 'grader_not_assigned') return { status: 'already_removed' };

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
   * grading during the re-grade) are left untouched. Token rewards are reversed via
   * `removeGradeFromGitRepoAssignment`.
   */
  static async clearGradesForOpenRegradeRequest(
    classroom: HelperClassroomRef,
    gitRepoAssignment: GitRepoAssignmentRef
  ): Promise<void> {
    const openRequest = await ClassmojiService.regradeRequest.findOpenByAssignmentId(
      gitRepoAssignment.id
    );
    if (!openRequest) return;

    const grades = await ClassmojiService.assignmentGrade.findByAssignmentId(gitRepoAssignment.id);
    const staleGrades = grades.filter(grade => grade.created_at <= openRequest.created_at);

    for (const grade of staleGrades) {
      await this.removeGradeFromGitRepoAssignment({ classroom, gitRepoAssignment, grade });
    }
  }

  static async addGradeToGitRepoAssignment(payload: GradeAssignmentPayload): Promise<void> {
    const { classroom, gitRepoAssignment, graderId, grade, studentId, teamId } = payload;

    // When a submission has an open resubmit (regrade) request, a new grade should
    // replace the original grade rather than be averaged with it. Clear the grades
    // captured at request time before adding the new one. The request's
    // `previous_grade` snapshot keeps those emojis visible in the "Previous Grade"
    // column for reference.
    await this.clearGradesForOpenRegradeRequest(classroom, gitRepoAssignment);

    // Only emojis in the classroom's grading scale are grades. A classroom
    // with no scale yet (fresh import) accepts anything, as before.
    const scale = (await ClassmojiService.emojiMapping.findByClassroomId(
      classroom.id,
      true
    )) as EmojiMappingWithTokens[];
    if (scale.length > 0 && !scale.some(mapping => mapping.emoji === grade)) {
      throw new Error(`"${grade}" is not in this classroom's grading scale`);
    }

    // A numeric score is one number per grader, never a stack: a grader's new
    // score replaces the score they gave before (tokens reversed with it).
    // Other graders' scores stay and average, as separate opinions should.
    if (parseScoreEmoji(grade) !== null) {
      const existing = await ClassmojiService.assignmentGrade.findByAssignmentId(
        gitRepoAssignment.id
      );
      for (const previous of existing) {
        if (previous.grader_id !== graderId) continue;
        if (parseScoreEmoji(previous.emoji) === null) continue;
        if (previous.emoji === grade) return;
        try {
          await this.removeGradeFromGitRepoAssignment({
            classroom,
            gitRepoAssignment: { id: gitRepoAssignment.id, studentId, teamId },
            grade: previous,
          });
        } catch (error) {
          // Already removed by a concurrent request (a double submit from the
          // same field): nothing to replace any more, carry on.
          if ((error as { code?: string })?.code !== 'P2025') throw error;
        }
      }
    }

    if (await ClassmojiService.assignmentGrade.doesGradeExist(gitRepoAssignment.id, grade)) {
      return;
    }

    const assignmentGrade = await ClassmojiService.assignmentGrade.addGrade(
      gitRepoAssignment.id,
      graderId,
      grade
    );

    if (studentId) {
      this.assignTokensToStudent(
        {
          organization: classroom,
          gitRepoAssignment,
          grade,
          studentId,
        },
        assignmentGrade
      );
    } else if (teamId) {
      this.assignTokensToTeam(
        {
          organization: classroom,
          gitRepoAssignment,
          grade,
          teamId,
        },
        assignmentGrade
      );
    }
  }

  static async assignTokensToStudent(
    payload: TokenAssignmentPayload,
    assignmentGrade: AssignmentGradeRef
  ): Promise<void> {
    const { organization, gitRepoAssignment, grade } = payload;

    const emojiMapping = (await ClassmojiService.emojiMapping.findByClassroomId(
      organization.id,
      true
    )) as EmojiMappingWithTokens[];
    const emoji = emojiMapping.find(mapping => mapping.emoji === grade);

    if (!emoji) return;

    if (emoji.extra_tokens > 0) {
      const data = {
        classroomId: organization.id,
        studentId: payload.studentId,
        amount: emoji.extra_tokens,
        description: `Tokens for getting a ${grade}.`,
        repositoryAssignmentId: gitRepoAssignment.id,
      };

      const tokenTransaction = await ClassmojiService.token.assignToStudent(data);

      await ClassmojiService.assignmentGrade.update(assignmentGrade.id, {
        token_transaction_id: tokenTransaction.id,
      });
    }
  }

  static async assignTokensToTeam(
    payload: TeamTokenAssignmentPayload,
    assignmentGrade: AssignmentGradeRef
  ): Promise<void> {
    const { organization, gitRepoAssignment, grade, teamId } = payload;

    const emojiMapping = (await ClassmojiService.emojiMapping.findByClassroomId(
      organization.id,
      true
    )) as EmojiMappingWithTokens[];
    const emoji = emojiMapping.find(mapping => mapping.emoji === grade);

    if (!emoji) return;

    if (emoji.extra_tokens > 0) {
      const team = (await ClassmojiService.team.findById(teamId)) as TeamWithMemberships | null;
      if (!team || !team.memberships || team.memberships.length === 0) return;

      let firstTransaction = null;

      for (const membership of team.memberships) {
        const data = {
          classroomId: organization.id,
          studentId: membership.user_id,
          amount: emoji.extra_tokens,
          description: `Tokens for getting a ${grade}.`,
          repositoryAssignmentId: gitRepoAssignment.id,
        };

        const tokenTransaction = await ClassmojiService.token.assignToStudent(data);

        if (!firstTransaction) {
          firstTransaction = tokenTransaction;
        }
      }

      if (firstTransaction) {
        await ClassmojiService.assignmentGrade.update(assignmentGrade.id, {
          token_transaction_id: firstTransaction.id,
        });
      }
    }
  }

  static async removeGradeFromGitRepoAssignment(payload: RemoveGradePayload): Promise<void> {
    const { classroom, gitRepoAssignment, grade } = payload;

    await ClassmojiService.assignmentGrade.removeGrade(grade.id);
    // Remove tokens
    if (!grade.token_transaction) return;

    const studentId = gitRepoAssignment.studentId;
    const teamId = gitRepoAssignment.teamId;

    if (studentId) {
      const data = {
        classroomId: classroom.id,
        studentId,
        amount: grade.token_transaction.amount * -1,
        description: `Removing ${grade.emoji}.`,
        repositoryAssignmentId: gitRepoAssignment.id,
        type: 'REMOVAL',
      };

      ClassmojiService.token.assignToStudent(data);
    } else if (teamId) {
      const team = (await ClassmojiService.team.findById(teamId)) as TeamWithMemberships | null;
      if (!team || !team.memberships) return;

      for (const membership of team.memberships) {
        const data = {
          classroomId: classroom.id,
          studentId: membership.user_id,
          amount: grade.token_transaction.amount * -1,
          description: `Removing ${grade.emoji}.`,
          repositoryAssignmentId: gitRepoAssignment.id,
          type: 'REMOVAL',
        };

        ClassmojiService.token.assignToStudent(data);
      }
    }
  }
}

export default HelperService;
