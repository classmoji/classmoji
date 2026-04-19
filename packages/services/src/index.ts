import ClassmojiService from './classmoji/index.ts';
import HelperService from './helper/index.ts';
import StripeService from './stripe/index.ts';
import * as MarkdownImporter from './content/markdownImporter.ts';

export {
  appendQuestionResult,
  getEmojiMappingsForAttempt,
  calculatePercentagesFromResults,
  getQuestionResults,
} from './classmoji/quizAttempt.service.ts';

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
} from './git/index.ts';

// New Classroom architecture services (named exports)
export {
  gitOrganizationService,
  classroomService,
  classroomMembershipService,
  moduleService,
  assignmentService,
  repositoryAssignmentService,
} from './classmoji/index.ts';

export { ClassmojiService, HelperService, StripeService, MarkdownImporter };

// Models list (moved from @classmoji/llm)
export { getAllModels, getAnthropicModels } from './classmoji/modelsList.ts';

// Quiz prompts and examples (moved from @classmoji/llm)
export {
  examplePrompts,
  assessmentGuidelines,
  getExamplePrompts,
} from './classmoji/quizPrompts.ts';

// Repo analytics snapshot payload types
export type {
  CommitRecord,
  ContributorRecord,
  LanguagesMap,
  PRSummary,
  SnapshotPayload,
} from './classmoji/repoAnalytics.types.ts';

// Repo analytics flag heuristics (pure, client-safe)
export {
  lateCommitRatio,
  isMegaCommit,
  commitMessageQuality,
  averageCommitQuality,
  busFactor,
  dumpAndRun,
} from './classmoji/repoAnalytics.flags.ts';
