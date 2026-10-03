import * as repositoryTasks from './workflows/gitRepo.ts';
import * as repositoryAssignmentTasks from './workflows/gitRepoAssignment.ts';
import * as organizationTasks from './workflows/organization.ts';
import * as autogradeTasks from './workflows/autograde.ts';
import * as emailTasks from './workflows/email.ts';
import * as extensionTasks from './workflows/extension.ts';
import * as installationTasks from './workflows/installation.ts';
import * as gitOrgInstallationRepairTasks from './workflows/gitOrgInstallationRepair.ts';
import * as tokenTasks from './workflows/token.ts';
import * as contributionTasks from './workflows/contribution.ts';
import * as repoAnalyticsTasks from './workflows/repoAnalytics.ts';
import * as notificationTasks from './workflows/notifications.ts';
import * as classroomImportTasks from './workflows/classroomImport.ts';
import * as customDomainTasks from './workflows/customDomains.ts';
import * as contentAssetTasks from './workflows/contentAssets.ts';
import * as contentIndexTasks from './workflows/contentIndexReconcile.ts';
import * as docsIndexTasks from './workflows/docsIndexReconcile.ts';
import * as deckThumbnailTasks from './workflows/deckThumbnail.ts';
import * as instructorContactTasks from './workflows/instructorContacts.ts';
import * as exampleClassroomCleanupTasks from './workflows/exampleClassroomCleanup.ts';
// team-set-solve and team-set-apply (workflows/teamSet*.ts) are deliberately NOT
// here: Trigger finds them through `dirs`, the service triggers them by string
// id, and importing them would pull @trigger.dev/python into every app bundle
// that imports this index.

// comment to trigger a build

const Tasks = {
  ...repositoryTasks,
  ...repositoryAssignmentTasks,
  ...organizationTasks,
  ...autogradeTasks,
  ...emailTasks,
  ...extensionTasks,
  ...installationTasks,
  ...gitOrgInstallationRepairTasks,
  ...tokenTasks,
  ...contributionTasks,
  ...repoAnalyticsTasks,
  ...notificationTasks,
  ...classroomImportTasks,
  ...customDomainTasks,
  ...contentAssetTasks,
  ...contentIndexTasks,
  ...docsIndexTasks,
  ...deckThumbnailTasks,
  ...instructorContactTasks,
  ...exampleClassroomCleanupTasks,
};

export default Tasks;
