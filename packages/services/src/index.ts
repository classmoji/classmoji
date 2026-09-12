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
  ClassroomSettingsEntitlementError,
} from './classmoji/index.ts';

export { ClassmojiService, HelperService, StripeService, FlyCertService, MarkdownImporter };

// GitHub App installation repair, shared by the "Check again" action, the
// create-classroom guard, the uninstall webhook and the operator sweep task.
export {
  GitHubRateLimitedError,
  validateInstallationIdentity,
  lookupInstallationForOrg,
  listAppInstallations,
  claimInstallationIfNull,
  clearInstallationIfMatches,
  repairInstallation,
} from './classmoji/gitOrganization.service.ts';
export type {
  InstallationLike,
  InstallationAccountLike,
  InstallationRejection,
  InstallationValidation,
  InstallationLookup,
  RepairInstallationResult,
  RepairInstallationOptions,
} from './classmoji/gitOrganization.service.ts';

// Admin service result/error shapes shared by the web routes and the MCP tools.
export { StaffServiceError } from './classmoji/staff.service.ts';
export type { AddStaffResult, RemoveStaffResult, StaffRole } from './classmoji/staff.service.ts';
// Quiz authorization refusal, so routes can answer 403 instead of 500.
export { QuizAccessError, QUIZ_STAFF_ROLES } from './classmoji/quiz.service.ts';
// "No such attempt", so routes can answer 404 for that and only that — a query
// that failed for any other reason has to keep its 500 and its log line.
export { QuizAttemptNotFoundError } from './classmoji/quizAttempt.service.ts';
// One builder for the remove_user_from_organization payload, so every caller
// sends the same fields.
export { buildRemoveUserPayload } from './classmoji/removeUserPayload.ts';
export type { RemoveUserPayload } from './classmoji/removeUserPayload.ts';
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
export { ResourceLinkServiceError } from './classmoji/resourceLink.service.ts';
export type {
  ResourceLinkResourceType,
  ResourceLinkTargetType,
  CreatedResourceLink,
  RemovedResourceLink,
  ResourceLinkSummary,
} from './classmoji/resourceLink.service.ts';
export { AssignGradersError } from './classmoji/gitRepoAssignmentGrader.service.ts';
export type {
  AssignGradersMethod,
  AssignGradersResult,
  GradingReportRow,
} from './classmoji/gitRepoAssignmentGrader.service.ts';

// Course-content search: the permission-joined vector query behind the MCP's
// `content_search` / `content_list` / `content_get`, plus the ONE draft-
// visibility predicate they all share. Exported flat rather than only through
// `ClassmojiService.contentSearch` because the MCP tool layer consumes the
// predicate and the argument types directly, and a second copy of "who may see
// a draft" is exactly the drift this lane exists to prevent.
//
// CONSTRAINT ON `contentSearch.service.ts`, stated here because THIS block is
// what enforces it: that module must never statically import `./content/extract`
// (which pulls in cheerio) or `./helpers/workersAi`. This barrel is on the
// startup path of every app in the monorepo — webapp, slides, admin, mcp,
// hook-station, tasks — so anything it reaches transitively is paid for on
// every cold boot, by processes that will never run a search. The module needs
// neither today: it takes an already-embedded `queryVector` from its caller and
// reads `text` straight back out of the index, so both stay on the WRITE side.
// `workersAi` is dependency-free and costs nothing; `content/extract` pulls in
// cheerio, which is why even `contentIndex.service` reaches it through a
// dynamic `await import()`. If this module ever needs either, do the same —
// a static edge here puts a parser into every app's boot.
export {
  contentVisibility,
  canSeeDrafts,
  isMemberRole,
  searchContent,
  listContent,
  getContentText,
  toVectorLiteral,
  ContentNotFoundError,
  CONTENT_STAFF_ROLES,
  EMBEDDING_DIMENSIONS,
  SNIPPET_CHARS,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
} from './classmoji/contentSearch.service.ts';
export type {
  ContentViewerRole,
  ContentDocKind,
  ContentVisibility,
  ContentVisibilityFlags,
  ViewerFlags,
  ContentSearchHit,
  SearchContentArgs,
  ContentListEntry,
  ListContentArgs,
  ContentDocumentText,
  GetContentTextArgs,
} from './classmoji/contentSearch.service.ts';

// PRODUCT DOCUMENTATION search: the second, classroom-independent corpus behind
// the same three MCP tools under `scope: 'docs'`. Exported flat for the same
// reason `contentSearch` is — the tool layer consumes the argument and result
// types directly.
//
// THE SAME CONSTRAINT APPLIES, for the same reason: `docsSearch.service.ts`
// must never statically import `./content/extract` (cheerio) or
// `./helpers/workersAi`. It takes an already-embedded vector and reads `text`
// straight back out of the index, so it needs neither.
//
// The WRITE side (`docsIndex.service.ts`) is deliberately NOT here. It reaches
// the extractor and the embedding client, and only the Trigger task calls it —
// through `ClassmojiService.docsIndex`.
export {
  searchDocs,
  listDocs,
  getDocText,
  docsIndexIsEmpty,
  DocsNotFoundError,
  DEFAULT_DOCS_SEARCH_LIMIT,
  MAX_DOCS_SEARCH_LIMIT,
  DEFAULT_DOCS_LIST_LIMIT,
  MAX_DOCS_LIST_LIMIT,
  DOCS_SNIPPET_CHARS,
} from './classmoji/docsSearch.service.ts';
export type {
  DocsSearchHit,
  SearchDocsArgs,
  DocsListEntry,
  ListDocsArgs,
  DocsListPage,
  DocsDocumentText,
} from './classmoji/docsSearch.service.ts';

// Instructor audience for the newsletter segment. The mail-provider mechanics
// that act on the answer live in the scheduled task that consumes it.
export {
  listInstructorContacts,
  type InstructorContact,
} from './classmoji/instructorAudience.service.ts';

// One-off product questions asked on the classroom picker. The catalog itself
// is in @classmoji/utils so the client can render it.
export {
  pendingQuestions as pendingSurveyQuestions,
  recordAnswer as recordSurveyAnswer,
  deriveSurveyContext,
  SurveyValidationError,
  type SurveyContext,
} from './classmoji/survey.service.ts';

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
