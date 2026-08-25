import ClassmojiService from './classmoji/index.ts';
import HelperService from './helper/index.ts';
import StripeService from './stripe/index.ts';
import FlyCertService from './fly/index.ts';
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

export { ClassmojiService, HelperService, StripeService, FlyCertService, MarkdownImporter };

// Admin service result/error shapes shared by the web routes and the MCP tools.
export { AssistantServiceError } from './classmoji/assistant.service.ts';
export type { AddAssistantResult, RemoveAssistantResult } from './classmoji/assistant.service.ts';
export {
  TeamServiceError,
  describeTeamFailureReason,
  isReservedSlug,
  predictTeamSlug,
} from './classmoji/teamAdmin.service.ts';
export type {
  TeamFailureReason,
  CreateTeamResult,
  DeleteTeamResult,
  RenameTeamResult,
  AddTeamMembersResult,
  RemoveTeamMemberResult,
  AddTeamTagsResult,
  RemoveTeamTagResult,
  MemberFailure,
  TagFailure,
  RepoRenameFailure,
} from './classmoji/teamAdmin.service.ts';
export { AssignGradersError } from './classmoji/gitRepoAssignmentGrader.service.ts';
export type {
  AssignGradersMethod,
  AssignGradersResult,
  GradingReportRow,
} from './classmoji/gitRepoAssignmentGrader.service.ts';

// Fly certificate automation for class-site custom domains. Every method throws
// a typed FlyCertError when the credentials are absent, so importing this in a
// deployment that has none is safe.
export {
  isFlyCertsConfigured,
  FlyCertError,
  FLY_CERT_ERROR,
  type FlyCertErrorCode,
  type FlyCertificate,
  type FlyDnsRequirements,
} from './fly/index.ts';

// Re-exported from `@classmoji/utils` for `@classmoji/tasks`, which depends on
// this package but not on utils. The nightly reconcile sweep needs the same "is
// this hostname one of ours?" test the claim path uses, and a second copy of the
// platform-domain list is exactly the drift that would put our own wildcard back
// into a delete list.
export { isPlatformDomain, PLATFORM_DOMAINS } from '@classmoji/utils';

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
