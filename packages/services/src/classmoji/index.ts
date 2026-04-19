// Core services (new schema)
import * as gitOrganizationService from './gitOrganization.service.ts';
import * as classroomService from './classroom.service.ts';
import * as classroomMembershipService from './classroomMembership.service.ts';
import * as moduleService from './module.service.ts';
import * as assignmentService from './assignment.service.ts';
import * as repositoryAssignmentService from './repositoryAssignment.service.ts';
import * as repositoryAssignmentGraderService from './repositoryAssignmentGrader.service.ts';
import * as assignmentGradeService from './assignmentGrade.service.ts';

// Supporting services
import * as auditService from './audit.service.ts';
import * as calendarService from './calendar.service.ts';
import * as icsGeneratorService from './icsGenerator.service.ts';
import * as pageService from './page.service.ts';
import * as emojiMappingService from './emojiMapping.service.ts';
import * as helperService from './helper.service.ts';
import * as letterGradeMappingService from './letterGradeMapping.service.ts';
import * as organizationTagService from './organizationTag.service.ts';
import * as regradeRequestService from './regradeRequest.service.ts';
import * as repositoryService from './repository.service.ts';
import * as subscriptionService from './subscription.service.ts';
import * as teamMembershipService from './teamMembership.service.ts';
import * as teamService from './team.service.ts';
import * as teamTagService from './teamTag.service.ts';
import * as tokenService from './token.service.ts';
import * as userService from './user.service.ts';
import * as quizService from './quiz.service.ts';
import * as quizAttemptService from './quizAttempt.service.ts';
import * as moduleImportService from './moduleImport.service.ts';
import * as classroomInviteService from './classroomInvite.service.ts';
import * as contentManifestService from './contentManifest.service.ts';
import * as resourceViewService from './resourceView.service.ts';
import * as repoAnalyticsService from './repoAnalytics.service.ts';
import * as dashboardService from './dashboard.service.ts';

const ClassmojiService = {
  // All services namespaced for consistency
  gitOrganization: gitOrganizationService,
  classroom: classroomService,
  classroomMembership: classroomMembershipService,
  module: moduleService,
  assignment: assignmentService,
  repositoryAssignment: repositoryAssignmentService,
  repositoryAssignmentGrader: repositoryAssignmentGraderService,
  assignmentGrade: assignmentGradeService,
  audit: auditService,
  calendar: calendarService,
  icsGenerator: icsGeneratorService,
  page: pageService,
  emojiMapping: emojiMappingService,
  helper: helperService,
  letterGradeMapping: letterGradeMappingService,
  organizationTag: organizationTagService,
  regradeRequest: regradeRequestService,
  repository: repositoryService,
  subscription: subscriptionService,
  teamMembership: teamMembershipService,
  team: teamService,
  teamTag: teamTagService,
  token: tokenService,
  user: userService,
  quiz: quizService,
  quizAttempt: quizAttemptService,
  moduleImport: moduleImportService,
  classroomInvite: classroomInviteService,
  contentManifest: contentManifestService,
  resourceView: resourceViewService,
  repoAnalytics: repoAnalyticsService,
  dashboard: dashboardService,
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
  moduleService,
  assignmentService,
  repositoryAssignmentService,
  repositoryAssignmentGraderService,
  assignmentGradeService,
  auditService,
  calendarService,
  icsGeneratorService,
  pageService,
  emojiMappingService,
  helperService,
  letterGradeMappingService,
  organizationTagService,
  regradeRequestService,
  repositoryService,
  subscriptionService,
  teamMembershipService,
  teamService,
  teamTagService,
  tokenService,
  userService,
  quizService,
  quizAttemptService,
  moduleImportService,
  classroomInviteService,
  contentManifestService,
  resourceViewService,
  repoAnalyticsService,
  dashboardService,
};
