import * as repositoryTasks from './workflows/repository.ts';
import * as repositoryAssignmentTasks from './workflows/repositoryAssignment.ts';
import * as organizationTasks from './workflows/organization.ts';
import * as emailTasks from './workflows/email.ts';
import * as extensionTasks from './workflows/extension.ts';
import * as installationTasks from './workflows/installation.ts';
import * as tokenTasks from './workflows/token.ts';
import * as contributionTasks from './workflows/contribution.ts';
import * as repoAnalyticsTasks from './workflows/repoAnalytics.ts';
import * as notificationTasks from './workflows/notifications.ts';

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
  ...repoAnalyticsTasks,
  ...notificationTasks,
};

export default Tasks;
