export const openRepositoryAssignmentInGithub = (org, repositoryAssignment) =>
  window.open(
    `https://github.com/${org}/${repositoryAssignment.repository.name}/issues/${repositoryAssignment.provider_issue_number}`,
    '_blank'
  );

export const removeCircularReferences = obj => {
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

export const groupByAssignment = data => {
  return data.reduce((acc, item) => {
    const assignmentId = item.assignment.id;

    if (!acc[assignmentId]) {
      acc[assignmentId] = [];
    }

    acc[assignmentId].push(item);

    return acc;
  }, {}); // Initialize with an empty object
};

export const groupByModule = data => {
  return data.reduce((acc, item) => {
    const moduleId = item.assignment.module_id;

    if (!acc[moduleId]) {
      acc[moduleId] = [];
    }

    acc[moduleId].push(item);

    return acc;
  }, {});
};
