// Core services (new schema)
import * as gitOrganizationService from './gitOrganization.service.ts';
import * as classroomService from './classroom.service.ts';
import * as classroomMembershipService from './classroomMembership.service.ts';
import * as rosterService from './roster.service.ts';
import * as staffService from './staff.service.ts';
import * as teamAdminService from './teamAdmin.service.ts';
import * as resourceLinkService from './resourceLink.service.ts';
import * as moduleService from './module.service.ts';
import * as repositoryService from './repository.service.ts';
import * as autogradingTestService from './autogradingTest.service.ts';
import * as autogradingResultService from './autogradingResult.service.ts';
import * as assignmentService from './assignment.service.ts';
import * as gitRepoAssignmentService from './gitRepoAssignment.service.ts';
import * as gitRepoAssignmentGraderService from './gitRepoAssignmentGrader.service.ts';
import * as assignmentGradeService from './assignmentGrade.service.ts';

// Supporting services
import * as auditService from './audit.service.ts';
import * as calendarService from './calendar.service.ts';
import * as icsGeneratorService from './icsGenerator.service.ts';
import * as formService from './form.service.ts';
import * as formResponseService from './formResponse.service.ts';
import * as pageService from './page.service.ts';
import * as pageContentService from './pageContent.service.ts';
import * as siteService from './site.service.ts';
import * as emojiMappingService from './emojiMapping.service.ts';
import * as helperService from './helper.service.ts';
import * as letterGradeMappingService from './letterGradeMapping.service.ts';
import * as organizationTagService from './organizationTag.service.ts';
import * as regradeRequestService from './regradeRequest.service.ts';
import * as gitRepoService from './gitRepo.service.ts';
import * as subscriptionService from './subscription.service.ts';
import * as entitlementService from './entitlement.service.ts';
export { ClassroomSettingsEntitlementError } from './classroom.service.ts';
import * as teamMembershipService from './teamMembership.service.ts';
import * as teamService from './team.service.ts';
import * as teamTagService from './teamTag.service.ts';
import * as tokenService from './token.service.ts';
import * as userService from './user.service.ts';
import * as quizService from './quiz.service.ts';
import * as quizAttemptService from './quizAttempt.service.ts';
import * as repositoryImportService from './repositoryImport.service.ts';
import * as contentImportService from './contentImport.service.ts';
import * as templateImportService from './templateImport.service.ts';
import * as classroomConfigImportService from './classroomConfigImport.service.ts';
import * as githubClassroomImportService from './githubClassroomImport.service.ts';
import * as githubClassroomApiService from './githubClassroomApi.service.ts';
import * as githubUserTokenService from './githubUserToken.service.ts';
import * as classroomInviteService from './classroomInvite.service.ts';
import * as contentManifestService from './contentManifest.service.ts';
import * as resourceViewService from './resourceView.service.ts';
import * as gitRepoAnalyticsService from './repoAnalytics.service.ts';
import * as dashboardService from './dashboard.service.ts';
import * as taDashboardService from './taDashboard.service.ts';
import * as notificationService from './notification.service.ts';

const ClassmojiService = {
  // All services namespaced for consistency
  gitOrganization: gitOrganizationService,
  classroom: classroomService,
  classroomMembership: classroomMembershipService,
  roster: rosterService,
  staff: staffService,
  resourceLink: resourceLinkService,
  module: moduleService,
  repository: repositoryService,
  autogradingTest: autogradingTestService,
  autogradingResult: autogradingResultService,
  assignment: assignmentService,
  gitRepoAssignment: gitRepoAssignmentService,
  gitRepoAssignmentGrader: gitRepoAssignmentGraderService,
  assignmentGrade: assignmentGradeService,
  audit: auditService,
  calendar: calendarService,
  icsGenerator: icsGeneratorService,
  form: formService,
  formResponse: formResponseService,
  page: pageService,
  pageContent: pageContentService,
  site: siteService,
  emojiMapping: emojiMappingService,
  helper: helperService,
  letterGradeMapping: letterGradeMappingService,
  organizationTag: organizationTagService,
  regradeRequest: regradeRequestService,
  gitRepo: gitRepoService,
  subscription: subscriptionService,
  entitlement: entitlementService,
  teamMembership: teamMembershipService,
  team: teamService,
  teamAdmin: teamAdminService,
  teamTag: teamTagService,
  token: tokenService,
  user: userService,
  quiz: quizService,
  quizAttempt: quizAttemptService,
  repositoryImport: repositoryImportService,
  contentImport: contentImportService,
  templateImport: templateImportService,
  classroomConfigImport: classroomConfigImportService,
  githubClassroomImport: githubClassroomImportService,
  githubClassroomApi: githubClassroomApiService,
  githubUserToken: githubUserTokenService,
  classroomInvite: classroomInviteService,
  contentManifest: contentManifestService,
  resourceView: resourceViewService,
  repoAnalytics: gitRepoAnalyticsService,
  dashboard: dashboardService,
  taDashboard: taDashboardService,
  notification: notificationService,
  // Alias for AI conversation functions (delegates to quizAttempt)
  aiConversation: {
    addMessage: quizAttemptService.addMessage,
  },
};

export default ClassmojiService;

// Named exports for all services
export {
  gitOrganizationService,
  classroomService,
  classroomMembershipService,
  rosterService,
  staffService,
  resourceLinkService,
  moduleService,
  repositoryService,
  autogradingTestService,
  autogradingResultService,
  assignmentService,
  gitRepoAssignmentService,
  gitRepoAssignmentGraderService,
  assignmentGradeService,
  auditService,
  calendarService,
  icsGeneratorService,
  formService,
  formResponseService,
  pageService,
  pageContentService,
  siteService,
  emojiMappingService,
  helperService,
  letterGradeMappingService,
  organizationTagService,
  regradeRequestService,
  gitRepoService,
  subscriptionService,
  entitlementService,
  teamMembershipService,
  teamService,
  teamAdminService,
  teamTagService,
  tokenService,
  userService,
  quizService,
  quizAttemptService,
  repositoryImportService,
  contentImportService,
  templateImportService,
  classroomConfigImportService,
  githubClassroomImportService,
  githubClassroomApiService,
  githubUserTokenService,
  classroomInviteService,
  contentManifestService,
  resourceViewService,
  gitRepoAnalyticsService,
  dashboardService,
  taDashboardService,
  notificationService,
};
