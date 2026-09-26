import { gitWeb, type GitWebContext } from './gitWeb';

interface RepoAssignmentForGithub {
  git_repo?: { name: string } | null;
  provider_issue_number?: number | null;
}

interface RepoAssignmentWithModule {
  /** repository_id is null for quiz/form assignments, which have no repo. */
  assignment: { id: string; repository_id?: string | null };
}

/**
 * The student's submission on its git host: their issue in ISSUE mode, their
 * repo in REPO mode (no issue exists). A bare org login means Github; pass a
 * GitWebContext (see ./gitWeb) for a classroom that may be on GitLab.
 */
export const repositoryAssignmentGithubUrl = (
  org: string | GitWebContext,
  repositoryAssignment: RepoAssignmentForGithub
) => {
  const web = gitWeb(typeof org === 'string' ? { provider: 'GITHUB', login: org } : org);
  const name = repositoryAssignment.git_repo?.name ?? '';
  return repositoryAssignment.provider_issue_number != null
    ? web.issue(name, repositoryAssignment.provider_issue_number)
    : web.repo(name);
};

export const openRepositoryAssignmentInGithub = (
  org: string | GitWebContext,
  repositoryAssignment: RepoAssignmentForGithub
) => window.open(repositoryAssignmentGithubUrl(org, repositoryAssignment), '_blank');

export const removeCircularReferences = (obj: unknown) => {
  const seen = new WeakSet();
  return JSON.parse(
    JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return; // Remove circular reference
        }
        seen.add(value);
      }
      return value;
    })
  );
};

export const groupByAssignment = (data: RepoAssignmentWithModule[]) => {
  return data.reduce((acc: Record<string, RepoAssignmentWithModule[]>, item) => {
    const assignmentId = item.assignment.id;

    if (!acc[assignmentId]) {
      acc[assignmentId] = [];
    }

    acc[assignmentId].push(item);

    return acc;
  }, {}); // Initialize with an empty object
};

export const groupByModule = (data: RepoAssignmentWithModule[]) => {
  return data.reduce((acc: Record<string, RepoAssignmentWithModule[]>, item) => {
    const repositoryId = item.assignment.repository_id ?? 'none';

    if (!acc[repositoryId]) {
      acc[repositoryId] = [];
    }

    acc[repositoryId].push(item);

    return acc;
  }, {});
};
