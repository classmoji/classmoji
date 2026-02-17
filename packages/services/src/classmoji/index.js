// Core services (new schema)
import * as gitOrganizationService from './gitOrganization.service.js';
import * as classroomService from './classroom.service.js';
import * as classroomMembershipService from './classroomMembership.service.js';
import * as moduleService from './module.service.js';
import * as assignmentService from './assignment.service.js';
import * as repositoryAssignmentService from './repositoryAssignment.service.js';
import * as repositoryAssignmentGraderService from './repositoryAssignmentGrader.service.js';
import * as assignmentGradeService from './assignmentGrade.service.js';

// Supporting services
import * as auditService from './audit.service.js';
import * as calendarService from './calendar.service.js';
import * as icsGeneratorService from './icsGenerator.service.js';
import * as pageService from './page.service.js';
import * as emojiMappingService from './emojiMapping.service.js';
import * as helperService from './helper.service.js';
import * as letterGradeMappingService from './letterGradeMapping.service.js';
import * as organizationTagService from './organizationTag.service.js';
import * as regradeRequestService from './regradeRequest.service.js';
import * as repositoryService from './repository.service.js';
import * as subscriptionService from './subscription.service.js';
import * as teamMembershipService from './teamMembership.service.js';
import * as teamService from './team.service.js';
import * as teamTagService from './teamTag.service.js';
import * as tokenService from './token.service.js';
import * as userService from './user.service.js';
import * as quizService from './quiz.service.js';
import * as quizAttemptService from './quizAttempt.service.js';
import * as moduleImportService from './moduleImport.service.js';
import * as classroomInviteService from './classroomInvite.service.js';
import * as contentManifestService from './contentManifest.service.js';
import * as resourceViewService from './resourceView.service.js';

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
};
