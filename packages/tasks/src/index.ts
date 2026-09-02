import * as repositoryTasks from './workflows/gitRepo.ts';
import * as repositoryAssignmentTasks from './workflows/gitRepoAssignment.ts';
import * as organizationTasks from './workflows/organization.ts';
import * as autogradeTasks from './workflows/autograde.ts';
import * as emailTasks from './workflows/email.ts';
import * as extensionTasks from './workflows/extension.ts';
import * as installationTasks from './workflows/installation.ts';
import * as tokenTasks from './workflows/token.ts';
import * as contributionTasks from './workflows/contribution.ts';
import * as repoAnalyticsTasks from './workflows/repoAnalytics.ts';
import * as notificationTasks from './workflows/notifications.ts';
import * as importGithubClassroomTasks from './workflows/importGithubClassroom.ts';
import * as classroomImportTasks from './workflows/classroomImport.ts';
import * as customDomainTasks from './workflows/customDomains.ts';

// comment to trigger a build

const Tasks = {
  ...repositoryTasks,
  ...repositoryAssignmentTasks,
  ...organizationTasks,
  ...autogradeTasks,
  ...emailTasks,
  ...extensionTasks,
  ...installationTasks,
  ...tokenTasks,
  ...contributionTasks,
  ...repoAnalyticsTasks,
  ...notificationTasks,
  ...importGithubClassroomTasks,
  ...classroomImportTasks,
  ...customDomainTasks,
};

export default Tasks;
