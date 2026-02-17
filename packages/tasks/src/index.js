import * as repositoryTasks from './workflows/repository.js';
import * as repositoryAssignmentTasks from './workflows/repositoryAssignment.js';
import * as organizationTasks from './workflows/organization.js';
import * as emailTasks from './workflows/email.js';
import * as extensionTasks from './workflows/extension.js';
import * as installationTasks from './workflows/installation.js';
import * as tokenTasks from './workflows/token.js';
import * as contributionTasks from './workflows/contribution.js';

// comment to trigger a build

const Tasks = {
  ...repositoryTasks,
  ...repositoryAssignmentTasks,
  ...organizationTasks,
  ...emailTasks,
  ...extensionTasks,
  ...installationTasks,
  ...tokenTasks,
  ...contributionTasks,
};

export default Tasks;
