interface RepoAssignmentForGithub {
  git_repo?: { name: string } | null;
  provider_issue_number?: number;
}

interface RepoAssignmentWithModule {
  assignment: { id: string; repository_id?: string };
}

export const openRepositoryAssignmentInGithub = (
  org: string,
  repositoryAssignment: RepoAssignmentForGithub
) =>
  window.open(
    `https://github.com/${org}/${repositoryAssignment.git_repo?.name}/issues/${repositoryAssignment.provider_issue_number}`,
    '_blank'
  );

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
    const repositoryId = item.assignment.repository_id!;

    if (!acc[repositoryId]) {
      acc[repositoryId] = [];
    }

    acc[repositoryId].push(item);

    return acc;
  }, {});
};
