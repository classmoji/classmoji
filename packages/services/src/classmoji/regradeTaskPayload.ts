/**
 * The submission a `request_regrade` task payload carries (its
 * `gitRepoAssignment`): what the task reads to create the request and email
 * the assigned graders, nothing more. Pure, so the callers' tests can use it.
 */
export interface RegradeTaskSubmission {
  id: string;
  provider_issue_number: number | null;
  git_repo: { name: string };
  assignment: { title: string };
  graders: Array<{ grader: { name: string | null; email: string | null } }>;
}

/** A `gitRepoAssignment.findForRegradeRequest` row as the task payload carries it. */
export const regradeTaskSubmission = (row: {
  id: string;
  provider_issue_number: number | null;
  git_repo: { name: string };
  assignment: { title: string };
  graders: Array<{ grader: { name: string | null; email: string | null } }>;
}): RegradeTaskSubmission => ({
  id: row.id,
  provider_issue_number: row.provider_issue_number,
  git_repo: { name: row.git_repo.name },
  assignment: { title: row.assignment.title },
  graders: row.graders.map(({ grader }) => ({
    grader: { name: grader.name, email: grader.email },
  })),
});
