import ClassmojiService from './classmoji/index.js';
import HelperService from './helper/index.js';
import StripeService from './stripe/index.js';
import * as MarkdownImporter from './content/markdownImporter.js';

export {
  appendQuestionResult,
  getEmojiMappingsForAttempt,
  calculatePercentagesFromResults,
  getQuestionResults,
} from './classmoji/quizAttempt.service.js';

// Git provider abstraction layer
export {
  GitProvider,
  GitHubProvider,
  GitLabProvider,
  getGitProvider,
  getGitHubProvider,
  getTeamNameForClassroom,
  ensureClassroomTeam,
  getTermCode,
  Octokit,
} from './git/index.js';

// New Classroom architecture services (named exports)
export {
  gitOrganizationService,
  classroomService,
  classroomMembershipService,
  moduleService,
  assignmentService,
  repositoryAssignmentService,
} from './classmoji/index.js';

export { ClassmojiService, HelperService, StripeService, MarkdownImporter };

// Models list (moved from @classmoji/llm)
export { getAllModels, getAnthropicModels } from './classmoji/modelsList.js';

// Quiz prompts and examples (moved from @classmoji/llm)
export { examplePrompts, assessmentGuidelines, getExamplePrompts } from './classmoji/quizPrompts.js';
