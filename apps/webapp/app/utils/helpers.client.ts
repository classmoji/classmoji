interface RepoAssignmentForGithub {
  repository: { name: string; [key: string]: unknown } | null;
  provider_issue_number?: number;
  [key: string]: unknown;
}

interface RepoAssignmentWithModule {
  assignment: { id: string; module_id?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export const openRepositoryAssignmentInGithub = (org: string, repositoryAssignment: RepoAssignmentForGithub) =>
  window.open(
    `https://github.com/${org}/${repositoryAssignment.repository?.name}/issues/${repositoryAssignment.provider_issue_number}`,
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
    const moduleId = item.assignment.module_id!;

    if (!acc[moduleId]) {
      acc[moduleId] = [];
    }

    acc[moduleId].push(item);

    return acc;
  }, {});
};
