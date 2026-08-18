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

// Content management for GitHub-backed storage (moved from @classmoji/content;
// that package is now a thin re-export shim over these)
export { ContentService } from './content/ContentService.ts';
export { getContentUrl, getRawContentUrl } from './content/urls.ts';
export {
  validateFile,
  sanitizeFilename,
  MAX_FILE_SIZE,
  ALLOWED_EXTENSIONS,
} from './content/utils/validateFile.ts';
export { getMimeType, isBinaryFile, isImageFile } from './content/utils/contentType.ts';

// Git provider abstraction layer
export {
  GitProvider,
  GitHubProvider,
  GitLabProvider,
  getGitProvider,
  getGitHubProvider,
  getTeamNameForClassroom,
  ensureClassroomTeam,
  describeTokenMintError,
  redactAccessTokens,
  Octokit,
} from './git/index.ts';

// New Classroom architecture services (named exports)
export {
  gitOrganizationService,
  classroomService,
  classroomMembershipService,
  moduleService,
  repositoryService,
  assignmentService,
  gitRepoAssignmentService,
  notificationService,
} from './classmoji/index.ts';

export { ClassmojiService, HelperService, StripeService, MarkdownImporter };

// Autograding: workflow (classroom.yml) generator (pure, client-safe)
export { generateClassroomWorkflow } from './autograding/generateClassroomWorkflow.ts';
export type {
  WorkflowTestInput,
  GenerateWorkflowOptions,
} from './autograding/generateClassroomWorkflow.ts';

// Autograding: per-classroom HMAC token (server-only; uses crypto + env)
export {
  signAutogradeCallbackToken,
  verifyAutogradeCallbackToken,
} from './autograding/callbackToken.ts';

// Example-classroom provisioning (server-only; touches Prisma)
export { provisionExampleClassroom } from './classmoji/exampleClassroom.service.ts';

// Classroom slug rules: normalization, deterministic collision candidates, and
// the constraint-and-retry wrapper every slug-creating path goes through
// (pure — no Prisma; the caller supplies the write).
export {
  slugify,
  classroomSlugCandidates,
  createWithUniqueClassroomSlug,
  isClassroomSlugConflict,
  ClassroomSlugUnavailableError,
  MAX_CLASSROOM_SLUG_SUFFIX,
} from './classmoji/classroomSlug.ts';

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

// Repo analytics service entry points (server-only; touches Prisma)
export { aggregateForTeam } from './classmoji/repoAnalytics.service.ts';
export type { TeamAggregate, TeamRepoSnapshot } from './classmoji/repoAnalytics.service.ts';

// Email helpers. Resend injects template variables raw, so every
// user-controlled value must be escaped before it becomes one.
export { appUrl, escapeHtml, escapeVars } from './emails/escape.ts';

// Repo analytics flag heuristics (pure, client-safe)
export {
  lateCommitRatio,
  isMegaCommit,
  commitMessageQuality,
  averageCommitQuality,
  busFactor,
  dumpAndRun,
  aggregateByContributor,
  commitsPerDayByContributor,
} from './classmoji/repoAnalytics.flags.ts';
