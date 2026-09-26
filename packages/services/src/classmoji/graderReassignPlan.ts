/**
 * Plan where a departing grader's UNGRADED slots go.
 *
 * Pure: no database, no provider. gitRepoAssignmentGrader.planUngradedReassignment
 * loads the inputs and HelperService.resolveUngradedSlots carries the plan out,
 * so the balancing rule can be pinned by deterministic tests on its own.
 *
 * THE RULE, per slot (a submission the departing grader is assigned to):
 *   1. Candidates are the classroom's other eligible graders, minus anyone who
 *      is already a grader on this submission (adding them would change
 *      nothing, and reporting them as the new grader would be untrue).
 *   2. Least-loaded first: the fewest grader rows on THIS assignment.
 *   3. Among those tied, prefer a grader who already holds another submission
 *      of the same student repository (git_repo) — either before the removal
 *      or earlier in this plan — so one student's work on one repository stays
 *      with one grader. Only among the tied: the pairing never worsens the
 *      per-assignment balance.
 *   4. Then the fewest grader rows in the whole classroom, then login, then id,
 *      so the result is the same every time for the same inputs.
 *
 * Load is ASSIGNED rows (graded or not) — the same number grading_report calls
 * assigned_count — for both the per-assignment and the classroom-wide count.
 *
 * No candidate at all → every slot is unassigned and `fallback` says why.
 * Candidates exist but all are already on this submission → the slot is only
 * removed (`covered`): the submission keeps the grader(s) it already has.
 */

export type UngradedChoice = 'reassign' | 'unassign' | 'keep';
export const UNGRADED_CHOICES = ['reassign', 'unassign', 'keep'] as const;

export interface PlanSlot {
  gitRepoAssignmentId: string;
  assignmentId: string;
  gitRepoId: string;
  /** Every grader currently on the submission, the departing one included. */
  graderIds: string[];
}

export interface PlanCandidate {
  id: string;
  login: string;
}

/** One existing grader row held by a candidate in this classroom. */
export interface CandidateLoadRow {
  graderId: string;
  assignmentId: string;
  gitRepoId: string;
}

export interface PlannedMove {
  gitRepoAssignmentId: string;
  /** null → the departing grader is removed with no replacement. */
  toGraderId: string | null;
  toLogin: string | null;
  reason: 'reassign' | 'covered' | 'no_eligible_graders';
}

export interface ReassignmentPlan {
  moves: PlannedMove[];
  fallback: 'no_eligible_graders' | null;
}

const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);

export const planGraderReassignment = ({
  slots,
  candidates,
  loadRows,
}: {
  slots: PlanSlot[];
  candidates: PlanCandidate[];
  loadRows: CandidateLoadRow[];
}): ReassignmentPlan => {
  // Deterministic walk: by assignment, then student repository, then submission.
  const ordered = [...slots].sort(
    (a, b) =>
      a.assignmentId.localeCompare(b.assignmentId) ||
      a.gitRepoId.localeCompare(b.gitRepoId) ||
      a.gitRepoAssignmentId.localeCompare(b.gitRepoAssignmentId)
  );

  if (candidates.length === 0) {
    return {
      moves: ordered.map(slot => ({
        gitRepoAssignmentId: slot.gitRepoAssignmentId,
        toGraderId: null,
        toLogin: null,
        reason: 'no_eligible_graders',
      })),
      fallback: 'no_eligible_graders',
    };
  }

  const candidateIds = new Set(candidates.map(c => c.id));
  const perAssignment = new Map<string, number>(); // `${assignmentId}:${graderId}`
  const total = new Map<string, number>();
  const repoGraders = new Map<string, Set<string>>();

  const noteRepoGrader = (gitRepoId: string, graderId: string) => {
    let set = repoGraders.get(gitRepoId);
    if (!set) repoGraders.set(gitRepoId, (set = new Set()));
    set.add(graderId);
  };

  for (const row of loadRows) {
    if (!candidateIds.has(row.graderId)) continue;
    bump(perAssignment, `${row.assignmentId}:${row.graderId}`);
    bump(total, row.graderId);
    noteRepoGrader(row.gitRepoId, row.graderId);
  }

  const moves: PlannedMove[] = [];

  for (const slot of ordered) {
    const onSubmission = new Set(slot.graderIds);
    const open = candidates.filter(c => !onSubmission.has(c.id));

    if (open.length === 0) {
      moves.push({
        gitRepoAssignmentId: slot.gitRepoAssignmentId,
        toGraderId: null,
        toLogin: null,
        reason: 'covered',
      });
      continue;
    }

    const loadOn = (c: PlanCandidate) => perAssignment.get(`${slot.assignmentId}:${c.id}`) ?? 0;
    const least = Math.min(...open.map(loadOn));
    const tied = open.filter(c => loadOn(c) === least);
    const siblings = repoGraders.get(slot.gitRepoId);
    const paired = siblings ? tied.filter(c => siblings.has(c.id)) : [];
    const pool = paired.length > 0 ? paired : tied;

    const pick = [...pool].sort(
      (a, b) =>
        (total.get(a.id) ?? 0) - (total.get(b.id) ?? 0) ||
        a.login.localeCompare(b.login) ||
        a.id.localeCompare(b.id)
    )[0];

    bump(perAssignment, `${slot.assignmentId}:${pick.id}`);
    bump(total, pick.id);
    noteRepoGrader(slot.gitRepoId, pick.id);

    moves.push({
      gitRepoAssignmentId: slot.gitRepoAssignmentId,
      toGraderId: pick.id,
      toLogin: pick.login,
      reason: 'reassign',
    });
  }

  return { moves, fallback: null };
};
