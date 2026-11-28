/**
 * Every web action is classified for the audit log, so a new one cannot ship
 * without someone deciding who writes its row: the web counterpart of the
 * MCP's writeAudit.manifest.test.ts.
 *
 * Read from disk, like rolePrefixRouteExports.test.ts: every route module
 * under app/routes that exports an `action` (a re-export followed to its
 * source, so a /teacher or /assistant re-export needs no entry of its own),
 * and every intent that action handles (support/webActions.ts says how they
 * are found). Each (route, intent) appears in ACTIONS with one class:
 *
 *   service:<object.fn> — a shared service writes the row because the route
 *                         passes an actor (`auditActor(…)`; a service in
 *                         OWN_ACTOR takes the caller in its own shape). The
 *                         intent calls the service and writes no row itself.
 *   route:<tool>        — the route writes the row itself, through the funnel
 *                         (`addClassroomAuditLog` / `addAuditLog`, or
 *                         `ClassmojiService.audit.record`).
 *   task:<task id>      — a background run writes it, for the actor its
 *                         payload carries (`auditActor(…)`).
 *   exempt:<reason>     — writes no row, for the reason given.
 *   unclassified:<what> — what the action does, for an action still to
 *                         classify. Only the entries of UNCLASSIFIED may say
 *                         so, and that list may only shrink.
 *
 * The checks read the intent's own code (the local functions it calls, the
 * code the action runs before its intents, and a file WRITER_IN names),
 * comments left out: a check of the text, not of a run. A `service:` intent
 * must call its service and pass an actor built by `auditActor(…)` that it
 * can see (its own, or one built before the dispatch that it does not
 * redeclare); a `route:` one must reach the funnel and name its tool; a
 * `task:` one must start that run (by id, or by the task's export) and hand
 * it an actor; an exempt one must write no row and build no actor. A local
 * wrapper or actor counts only where the intent calls or uses it.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  ROUTES_DIR,
  type WebActionIntent,
  actionIntents,
  actionSource,
  declarationText,
  exportsAction,
  reachableText,
  routeModules,
  stripComments,
  webActionIntents,
} from '../../__tests__/support/webActions.ts';

type Entry =
  | `service:${string}`
  | `route:${string}`
  | `task:${string}`
  | `exempt:${string}`
  | `unclassified:${string}`;

const OWN_ACCOUNT = 'exempt:own account (sign-in, password, email, school id)';
const OWN_PINS = 'exempt:own classroom pins';
const FEEDBACK = 'exempt:the feedback board writes no audit rows (decided for #739)';
const REFUSES = 'exempt:refuses an intent it does not know';
const MEDIA = 'unclassified:media uploads and deletes';

/** Every (route, intent) the webapp handles, classified. Keys: `<route id>#<intent>`. */
const ACTIONS: Record<string, Entry> = {
  // ── account and platform ──
  '_user.create-classroom#create-gitlab': 'unclassified:classroom creation',
  '_user.create-classroom#*': 'unclassified:classroom creation',
  '_user.import-classroom#*': 'route:web:github_classroom.import',
  '_user.select-organization#*': 'route:select-organization',
  '_user.settings.billing#createCheckoutSession':
    'exempt:billing checkout session (the billing service keeps its own events)',
  '_user.settings.billing#createBillingPortalSession':
    'exempt:billing portal session (the billing service keeps its own events)',
  '_user.settings.general#set-password': OWN_ACCOUNT,
  '_user.settings.general#update-school-id': OWN_ACCOUNT,
  '_user.settings.general#send-code': OWN_ACCOUNT,
  '_user.settings.general#change-email': OWN_ACCOUNT,
  '_user.settings.general#*': REFUSES,
  '_user.settings.notifications#*': 'exempt:own notification preferences',
  'registration#send-code': OWN_ACCOUNT,
  'registration#verify-code': OWN_ACCOUNT,
  // The account's own fields; the classroom memberships its invites hold are
  // recorded by the invite claim.
  'registration#*': 'service:classroomInvite.claimPendingInvites',
  'join.$code#*': 'route:web:roster.join_link',
  'reset-fetcher#*': 'exempt:clears a form helper, stores nothing',
  'api.auth.$#*': 'exempt:the sign-in service (sessions, sign-out)',
  'api.auth.clear-cache#*': 'exempt:development-only token cache reset',
  'api.classroom-tour.complete#*': 'exempt:own tour flag',
  'api.onboarding.complete#*': 'exempt:own onboarding flag',
  'api.notifications.dismiss#*': 'exempt:own notification state',
  'api.notifications.read#*': 'exempt:own notification read state',
  'api.survey.answer#*': 'exempt:own survey answers',
  'api.unsplash#*': 'exempt:read-only image search',
  'api.content.token#*': 'exempt:read-only content token',
  'api.example-classroom#*': 'unclassified:example course provisioning',
  'api.classrooms.$id.pin#*': OWN_PINS,
  'api.classrooms.reorder-pins#*': OWN_PINS,
  'api.classrooms.$id.archive#*': 'service:classroomLifecycle.setLifecycle',
  'api.classrooms.$id.status#*': 'service:classroomLifecycle.setLifecycle',
  'api.classrooms.$class.github-installation#*': 'route:api.classrooms.github-installation',
  'api.import-jobs.$jobId#*': 'unclassified:import retry',
  'api.feedback#create-post': FEEDBACK,
  'api.feedback#vote': FEEDBACK,
  'api.feedback#comment-vote': FEEDBACK,
  'api.feedback#comment': FEEDBACK,
  'api.feedback#follow': FEEDBACK,
  'api.feedback#set-status': FEEDBACK,
  'api.feedback#mark-answered': FEEDBACK,
  'api.feedback#mark-duplicate': FEEDBACK,
  'api.feedback#delete-post': FEEDBACK,
  'api.feedback#delete-comment': FEEDBACK,

  // ── coursework structure ──
  'admin.$class.modules#create': 'service:module.create',
  'admin.$class.modules#update': 'service:module.updateForClassroom',
  'admin.$class.modules#delete': 'service:module.deleteById',
  'admin.$class.modules#setPublished': 'service:module.setPublished',
  'admin.$class.modules#setPublic': 'service:module.setPublic',
  'admin.$class.modules#addItem': 'service:module.addItem',
  'admin.$class.modules#removeItem': 'service:module.removeItem',
  'admin.$class.modules#reorderItems': 'service:module.reorderItems',
  'admin.$class.modules#reorderAssignments': 'service:assignment.reorderInModule',
  'admin.$class.modules#moveItem': 'service:module.moveItemToModule',
  'admin.$class.modules#moveAssignment': 'service:assignment.moveToModule',
  'admin.$class.modules#reorderModules': 'service:module.reorderModules',
  'admin.$class.assignments#createTag': 'service:organizationTag.findOrCreate',
  // The assignment's row; a repository it makes is recorded by repository.create.
  'admin.$class.assignments#create': 'route:web:assignments.create',
  'admin.$class.assignments#update': 'route:web:assignments.update',
  'admin.$class.assignments#delete': 'route:web:assignments.delete',
  'admin.$class.repos#delete': 'route:web:repos.delete',
  'admin.$class.repos#publish': 'route:web:repos.publish',
  'admin.$class.repos#publishAssignment': 'route:web:repos.publish_assignment',
  'admin.$class.repos#unpublish': 'route:web:repos.unpublish',
  'admin.$class.repos#sync': 'route:web:repos.sync',
  'admin.$class.repos#calculateContributions': 'route:web:repos.contributions.calculate',
  'admin.$class.repos.update#*': 'route:web:repos.update_student_repos',
  'admin.$class.repos_.$title.update#*': 'route:web:repos.update_student_repos',
  'admin.$class.repos_.$title#calculateContributions': 'route:web:repos.contributions.calculate',
  'admin.$class.repos_.$title#deleteRepo': 'service:HelperService.deleteRepository',
  'admin.$class.repos_.$title#addGrader': 'service:HelperService.addGraderInClassroom',
  'admin.$class.repos_.$title#removeGrader': 'service:HelperService.removeGraderInClassroom',
  'admin.$class.repos_.$title#createProjects': 'unclassified:project board creation',
  'admin.$class.repos_.form#createTag': 'service:organizationTag.findOrCreate',
  'admin.$class.repos_.form#create': 'service:repository.create',
  'admin.$class.repos_.form#update': 'service:repository.updateFromForm',
  'api.repos.$id.contributor-link#*': 'service:repoAnalytics.linkContributor',
  'api.repos.$id.refresh#*': 'unclassified:analytics refresh',
  'admin.$class.teams#*': 'service:teamAdmin.deleteTeam',
  'admin.$class.teams.new#createTag': 'service:organizationTag.findOrCreate',
  'admin.$class.teams.new#createTeam': 'service:teamAdmin.createTeam',
  'admin.$class.teams.$slug.edit#addMembersToTeam': 'service:teamAdmin.addTeamMembers',
  'admin.$class.teams.$slug.edit#removeMemberFromTeam': 'service:teamAdmin.removeTeamMember',
  'admin.$class.teams.$slug.edit#addTeamTags': 'service:teamAdmin.addTeamTags',
  'admin.$class.teams.$slug.edit#removeTeamTag': 'service:teamAdmin.removeTeamTag',
  'admin.$class.teams.$slug.edit#renameTeam': 'service:teamAdmin.renameTeam',
  'student.$class.repos_.$repo.team#create': 'service:team.createWithMembershipAndTag',
  'student.$class.repos_.$repo.team#join': 'service:teamMembership.addMemberToTeam',
  'student.$class.repos_.$repo.team#leave': 'service:teamMembership.removeMemberFromTeam',
  'admin.$class.calendar#create': 'route:web:calendar.create_event',
  'admin.$class.calendar#update': 'route:web:calendar.update_event',
  'admin.$class.calendar#delete': 'route:web:calendar.delete_event',
  'admin.$class.calendar#update_deadline': 'route:web:calendar.update_deadline',
  'admin.$class.calendar#*': REFUSES,
  'assistant.$class_.calendar#create': 'route:web:calendar.create_event',
  'assistant.$class_.calendar#update': 'route:web:calendar.update_event',
  'assistant.$class_.calendar#delete': 'route:web:calendar.delete_event',
  'assistant.$class_.calendar#*': REFUSES,

  // ── content ──
  'admin.$class.pages#delete': 'route:web:pages.delete',
  'admin.$class.pages#status': 'route:web:pages.status',
  'admin.$class.pages#show_in_student_menu': 'route:web:pages.show_in_student_menu',
  'admin.$class.pages#*': REFUSES,
  'admin.$class.pages.new#import': 'route:web:pages.create_import',
  'admin.$class.pages.new#*': 'route:web:pages.create_blank',
  'api.pages.batch#batch-init': 'unclassified:content repository setup',
  'api.pages.batch#batch-import-single': 'route:web:pages.create_batch',
  'api.pages.batch#*': REFUSES,
  'admin.$class.slides#status': 'route:web:slides.status',
  'admin.$class.slides#allow_team_edit': 'route:web:slides.allow_team_edit',
  'admin.$class.slides#show_speaker_notes': 'route:web:slides.show_speaker_notes',
  'admin.$class.slides#*': REFUSES,
  'admin.$class.forms#update-status': 'route:web:forms.status',
  'admin.$class.forms#delete': 'route:web:forms.delete',
  'admin.$class.forms#*': REFUSES,
  'api.media.$mediaId#*': MEDIA,
  'api.media.uploads#*': MEDIA,
  'api.media.uploads_.$mediaId.abort#*': MEDIA,
  'api.media.uploads_.$mediaId.complete#*': MEDIA,
  'api.media.uploads_.$mediaId.parts#*': MEDIA,
  'admin.$class.settings.media#*': 'exempt:read-only download link',

  // ── quizzes ──
  'admin.$class.quizzes#createQuiz': 'route:web:quizzes.create',
  'admin.$class.quizzes#updateQuiz': 'route:web:quizzes.update',
  'admin.$class.quizzes#deleteQuiz': 'route:web:quizzes.delete',
  'admin.$class.quizzes#publishQuiz': 'route:web:quizzes.publish',
  'admin.$class.quizzes#updateWeight': 'route:web:quizzes.update_weight',
  'admin.$class.quizzes#clearMyAttempts': 'route:web:quizzes.clear_my_attempts',
  'admin.$class.quizzes_.$quizId#clearMyAttempts': 'route:web:quiz.clear_my_attempts',
  'admin.$class.quizzes_.$quizId.attempt.$attemptId#resolve': 'service:regradeRequest.resolveQuiz',
  'admin.$class.quizzes_.$quizId.attempt.$attemptId#adjust': 'service:quizAttempt.adjust',
  'admin.$class.quizzes_.$quizId.attempt.$attemptId#revert': 'service:quizAttempt.revert',
  'admin.$class.quizzes_.$quizId.attempt.$attemptId#*': REFUSES,
  'assistant.$class_.regrade-requests#*': 'service:regradeRequest.resolveQuiz',
  'student.$class.quizzes.$quizId.attempt.$attemptId#*':
    'service:regradeRequest.createForQuizAttempt',
  'api.quiz#startQuiz': 'unclassified:quiz attempt start',
  'api.quiz#restartQuiz': 'unclassified:quiz attempt start',
  'api.quiz#updateMetrics': 'unclassified:quiz attempt timing',
  'api.quiz#recordModalClose': 'unclassified:quiz attempt timing',
  'api.quiz#recordModalOpen': 'unclassified:quiz attempt timing',
  'api.quiz-chat.session#*': 'route:web:quiz_chat.session',
  'api.quizLateWaiver.$class#*': 'route:web:quiz_late_waiver',

  // ── grading ──
  'api.gitRepoAssignment.$class#autograde': 'unclassified:autograde workflow dispatch',
  'api.gitRepoAssignment.$class#addGrade': 'service:HelperService.addGradeToGitRepoAssignment',
  'api.gitRepoAssignment.$class#removeGrade':
    'service:HelperService.removeGradeFromGitRepoAssignment',
  'api.gitRepoAssignment.$class#updateLateOverride':
    'service:gitRepoAssignment.setLateOverrideForSubmission',
  'api.gitRepoAssignment.$class#deleteSubmission': 'service:HelperService.deleteSubmission',
  'api.gitRepoAssignment.$class#updateGradeRelease': 'service:assignment.setGradesReleased',
  'admin.$class.assignments_.$id#addGrader': 'service:HelperService.addGraderInClassroom',
  'admin.$class.assignments_.$id#removeGrader': 'service:HelperService.removeGraderInClassroom',
  'admin.$class.assignments_.$id.assign-graders#*':
    'service:gitRepoAssignmentGrader.assignGradersToAssignment',
  'admin.$class.repos_.$title.assign-graders#*':
    'service:gitRepoAssignmentGrader.assignGradersToAssignment',
  'admin.$class.grades#set-final-grades-released': 'route:web:grades.release_final_grades',
  'admin.$class.grades#*': 'route:web:grades.update_letter_grade',
  'admin.$class.students_.$login#update-comment': 'route:web:student.update_comment',
  'admin.$class.students_.$login#update-letter-grade': 'route:web:student.update_letter_grade',
  'admin.$class.students_.$login#update-school-id': 'route:web:student.update_school_id',
  'api.$operation#updateRegradeRequest': 'task:update_regrade_request',
  'student.$class.regrade-requests.new#*': 'task:request_regrade',

  // ── people and tokens ──
  'admin.$class.staff#createStaff': 'service:staff.addStaff',
  'admin.$class.staff#updateStaff': 'service:staff.updateStaff',
  'admin.$class.staff#removeStaff': 'service:staff.recordStaffRemoval',
  'admin.$class.students#removeStudent': 'task:remove_user_from_organization',
  'admin.$class.students#updateJoinLink': 'route:web:roster.join_link',
  'admin.$class.students#revokeInvite': 'service:classroomInvite.deleteInviteInClassroom',
  'admin.$class.students.add#*': 'service:roster.addStudents',
  'admin.$class.tokens.new#assignTokens': 'task:assign_tokens_to_student',
  'api.$operation#cancelTokenTransaction': 'service:token.cancelPurchase',
  'student.$class.assignments#purchaseExtensionHours': 'service:token.purchaseExtensionHours',

  // ── settings ──
  'admin.$class.settings.general#saveProfile': 'service:classroom.updateClassroomSettings',
  'admin.$class.settings.general#saveRecentViewers': 'service:classroom.updateSettings',
  'admin.$class.settings.general#saveTimeZone': 'service:classroom.updateSettings',
  'admin.$class.settings.general#saveDefaultPage': 'service:classroom.updateSettings',
  'admin.$class.settings.ai#saveQuizSettings': 'service:classroom.updateSettings',
  'admin.$class.settings.ai#saveAskMojiSettings': 'service:classroom.updateSettings',
  'admin.$class.settings.ai#saveAskMojiInstructions': 'service:classroom.updateSettings',
  'admin.$class.settings.ai#saveLLMSettings': 'service:classroom.updateSettings',
  'admin.$class.settings.ai#clearLLMSettings': 'service:classroom.updateSettings',
  'admin.$class.settings.content#saveContentRepo': 'service:classroom.updateSettings',
  'admin.$class.settings.content#resetContentCache':
    'service:contentDelivery.bumpContentKeyVersion',
  'admin.$class.settings.content#saveLiveEditing': 'route:web:settings.live_editing',
  'admin.$class.settings.content#saveContentSettings': 'service:classroom.updateSettings',
  'admin.$class.settings.extension#saveExtensionSettings': 'service:classroom.updateSettings',
  'admin.$class.settings.grades#saveGradingSettings': 'service:classroom.updateSettings',
  'admin.$class.settings.grades#saveEmojiToGradeMapping': 'service:emojiMapping.saveEmojiMapping',
  'admin.$class.settings.grades#deleteEmojiToGradeMapping':
    'service:emojiMapping.deleteEmojiMapping',
  'admin.$class.settings.grades#saveLetterGradeMapping': 'service:letterGradeMapping.save',
  'admin.$class.settings.grades#deleteLetterGradeMapping': 'service:letterGradeMapping.delete',
  'admin.$class.settings.grades#populateDefaultMappings': 'service:emojiMapping.replaceScale',
  'admin.$class.settings.grades#populateScoreScaleMappings': 'service:emojiMapping.replaceScale',
  'admin.$class.settings.grades#populateDefaultLetterGradeMappings':
    'service:letterGradeMapping.replaceAll',
  'admin.$class.settings.grades#remapOrphanedEmojis':
    'route:web:settings.grades.remap_orphaned_emojis',
  'admin.$class.settings.repos#repairWebhooks': 'unclassified:webhook repair',
  'admin.$class.settings.repos#*': 'service:orgRepoSettings.updateOrgRepoSettings',
  'admin.$class.settings.team#createTag': 'service:organizationTag.findOrCreate',
  'admin.$class.settings.team#deleteTag': 'service:organizationTag.deleteInClassroom',
  'admin.$class.settings.website#claimSubdomain': 'service:site.validateAndClaimSubdomain',
  'admin.$class.settings.website#saveSettings': 'service:site.upsertSiteSettings',
  'admin.$class.settings.website#removeSite': 'service:site.deleteSiteForClassroom',
  'admin.$class.settings.website#saveCustomDomain': 'service:site.setCustomDomain',
  'admin.$class.settings.website#checkCustomDomainCert':
    'exempt:checks the certificate at the host and may request it there again; writes nothing to the database',
  'admin.$class.settings.website#removeCustomDomain': 'service:site.clearCustomDomain',
  'admin.$class.settings.danger-zone#removeClassroom': 'service:classroom.deleteById',

  // ── Ask Moji: the session service records its conversations and ratings ──
  'api.ask-moji.$class.start#*': 'service:askMojiSession.start',
  'api.ask-moji.$class.new#*': 'service:askMojiSession.newConversation',
  'api.ask-moji.$class.end#*': 'service:askMojiSession.end',
  'api.ask-moji.$class.feedback#*': 'service:askMojiSession.feedback',
  'api.ask-moji.$class.ensure-session#*': 'exempt:own conversation session',
  'api.ask-moji.$class.token#*': 'exempt:own conversation token',
  'api.ask-moji.$class.state#*': 'exempt:read-only own conversation state',
};

/**
 * The `unclassified` entries there may be. A new action is classified when it
 * is added, never added here. This list only shrinks.
 */
const UNCLASSIFIED = new Set([
  '_user.create-classroom#create-gitlab',
  '_user.create-classroom#*',
  'admin.$class.repos_.$title#createProjects',
  'admin.$class.settings.repos#repairWebhooks',
  'api.example-classroom#*',
  'api.gitRepoAssignment.$class#autograde',
  'api.import-jobs.$jobId#*',
  'api.media.$mediaId#*',
  'api.media.uploads#*',
  'api.media.uploads_.$mediaId.abort#*',
  'api.media.uploads_.$mediaId.complete#*',
  'api.media.uploads_.$mediaId.parts#*',
  'api.pages.batch#batch-init',
  'api.quiz#startQuiz',
  'api.quiz#restartQuiz',
  'api.quiz#updateMetrics',
  'api.quiz#recordModalClose',
  'api.quiz#recordModalOpen',
  'api.repos.$id.refresh#*',
]);

/**
 * Services that take the caller in their own shape (an actor id, a tool name,
 * the viewing admin) rather than an `auditActor`: the intent calls them and
 * builds no actor. As the MCP manifest's `actor: 'own'`.
 */
const OWN_ACTOR = new Set([
  'askMojiSession.start',
  'askMojiSession.newConversation',
  'askMojiSession.end',
  'askMojiSession.feedback',
  'classroom.deleteById',
  'classroomInvite.claimPendingInvites',
  'classroomLifecycle.setLifecycle',
  'quizAttempt.adjust',
  'quizAttempt.revert',
  'regradeRequest.createForQuizAttempt',
  'regradeRequest.resolveQuiz',
]);

/**
 * Runs whose payload names the person in its own shape (an id, the tool and
 * the viewing admin) rather than an `auditActor`.
 */
const OWN_ACTOR_TASKS = new Set(['update_regrade_request']);

/** Intents whose writer is in a helper file of their own, read with them. */
const WRITER_IN: Record<string, string> = {
  // The calendars' rows (and their tool names) come from one builder.
  'admin.$class.calendar#create': 'apps/webapp/app/utils/calendarAudit.ts',
  'admin.$class.calendar#update': 'apps/webapp/app/utils/calendarAudit.ts',
  'admin.$class.calendar#delete': 'apps/webapp/app/utils/calendarAudit.ts',
  'assistant.$class_.calendar#create': 'apps/webapp/app/utils/calendarAudit.ts',
  'assistant.$class_.calendar#update': 'apps/webapp/app/utils/calendarAudit.ts',
  'assistant.$class_.calendar#delete': 'apps/webapp/app/utils/calendarAudit.ts',
  'admin.$class.settings.content#saveLiveEditing':
    'apps/webapp/app/routes/admin.$class.settings.content/liveEditing.server.ts',
  '_user.select-organization#*': 'apps/webapp/app/utils/joinGitOrganization.server.ts',
  'admin.$class.repos#calculateContributions': 'apps/webapp/app/utils/repoContributions.server.ts',
  'admin.$class.repos_.$title#calculateContributions':
    'apps/webapp/app/utils/repoContributions.server.ts',
  'admin.$class.quizzes_.$quizId.attempt.$attemptId#resolve':
    'apps/webapp/app/routes/assistant.$class_.regrade-requests/resolveQuizRegrade.server.ts',
  'assistant.$class_.regrade-requests#*':
    'apps/webapp/app/routes/assistant.$class_.regrade-requests/resolveQuizRegrade.server.ts',
  'admin.$class.assignments_.$id.assign-graders#*':
    'apps/webapp/app/routes/admin.$class.assignments_.$id.assign-graders/utils.ts',
  'admin.$class.repos_.$title.assign-graders#*':
    'apps/webapp/app/routes/admin.$class.assignments_.$id.assign-graders/utils.ts',
};

const REPO_ROOT = resolve(ROUTES_DIR, '../../../..');
const helperText = (key: string) =>
  WRITER_IN[key] ? stripComments(readFileSync(resolve(REPO_ROOT, WRITER_IN[key]), 'utf8')) : '';

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The audit funnels a route writes its own row through. */
const FUNNEL = /(?<![\w$])(?:addClassroomAuditLog|addAuditLog)\s*\(|\baudit\.record\s*\(/;
const ACTOR = /(?<![\w$])auditActor\s*\(/;

/**
 * A call of the service function `object.fn` as written: in full
 * (`ClassmojiService.module.create(`), or by its method when the object is
 * held under another name (`const lifecycle = ClassmojiService.classroomLifecycle`).
 */
const callsService = (text: string, fn: string) => {
  const [object, method] = fn.includes('.') ? fn.split('.') : [null, fn];
  if (new RegExp(`(?<![\\w$])${escape(fn)}\\s*\\(`).test(text)) return true;
  return (
    object !== null &&
    new RegExp(`\\.${escape(method)}\\s*\\(`).test(text) &&
    new RegExp(`\\b${escape(object)}\\b`).test(text)
  );
};

/**
 * The names of the consts and functions declared in `text` whose own code
 * matches `pattern` (a `const audit = (…) => addClassroomAuditLog(…)` wrapper,
 * a `const actor = await auditActor(…)`).
 */
const localWriters = (text: string, pattern: RegExp): string[] =>
  [
    ...new Set(
      [
        ...text.matchAll(
          /(?:^|\n)\s*(?:const|let|function|async\s+function)\s+([A-Za-z_$][\w$]*)/g
        ),
      ].map(m => m[1])
    ),
  ].filter(name => {
    try {
      const declared = declarationText(text, name);
      // The function an action hands its whole request to holds every
      // intent: it is the intents' code, not a writer of one of them.
      return pattern.test(declared) && !/\b(?:intent|_action)\s*===/.test(declared);
    } catch {
      return false;
    }
  });

/** `text` without the declarations of `names` (as `text` declares them). */
const withoutDeclarations = (text: string, names: string[]) => {
  let out = text;
  for (const name of names) {
    try {
      out = out.split(declarationText(out, name)).join('');
    } catch {
      // Not declared in a form this reader follows: left as it is.
    }
  }
  return out;
};

/** Whether `text` declares `name` itself (a `const`, `let` or function). */
const declaresName = (text: string, name: string) =>
  new RegExp(`(?:^|[\\s;{(])(?:const|let|var|function)\\s+${escape(name)}\\b`).test(text);

/**
 * Whether an intent's `text` reaches `pattern`: directly, or through a writer
 * it calls (`audit(…)`) or, for the actor, a value it uses (`actor`). A writer
 * counts only where it is used: one the intent declares itself, or one
 * declared in the code before the dispatch (`shared`) that the intent does
 * not redeclare (a `const actor = null` of its own hides the shared one). A
 * writer's declaration never satisfies the check by itself.
 */
const reaches = (text: string, shared: string, pattern: RegExp) => {
  // The declaration the intent's text starts with is the intent itself (an
  // action with no dispatch, or a shorthand key's function), not a writer.
  const own = localWriters(text, pattern).filter(
    name => !text.trimStart().startsWith(declarationText(text, name).trimStart())
  );
  const bare = withoutDeclarations(text, own);
  if (pattern.test(bare)) return true;
  const used = (name: string) =>
    new RegExp(
      pattern === ACTOR ? `\\b${escape(name)}\\b` : `(?<![\\w$.])${escape(name)}\\s*\\(`
    ).test(bare);
  if (own.some(used)) return true;
  return localWriters(shared, pattern).some(name => used(name) && !declaresName(bare, name));
};

/** `task(` exports of packages/tasks, by export name: the id each one has. */
const TASK_IDS: Map<string, string> = (() => {
  const ids = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.ts$/.test(entry.name)) {
        const text = readFileSync(path, 'utf8');
        for (const m of text.matchAll(
          /export\s+const\s+(\w+)\s*=\s*(?:schemaTask|task)\s*\(\s*\{\s*id:\s*['"]([^'"]+)['"]/g
        )) {
          ids.set(m[1], m[2]);
        }
      }
    }
  };
  walk(resolve(REPO_ROOT, 'packages/tasks/src'));
  return ids;
})();

/** Whether `text` starts the run `id`: by its id, or through the task export that has it. */
const startsTask = (text: string, id: string) => {
  if (!/\b(?:trigger|batchTrigger|triggerAndWait|batchTriggerAndWait)\s*\(/.test(text)) {
    return false;
  }
  if (new RegExp(`['"\`]${escape(id)}['"\`]`).test(text)) return true;
  return [...TASK_IDS].some(
    ([name, taskId]) =>
      taskId === id &&
      new RegExp(`\\b${escape(name)}\\s*\\.\\s*(?:batchTrigger|trigger)\\w*\\s*\\(`).test(text)
  );
};

/**
 * Whether an intent's `text` names the tool `tool`: as written (`'web:x.y'`),
 * through a constant of its file that holds it (`QUIZ_LATE_WAIVER_TOOL`), or
 * as a template whose `${…}` is the intent itself (`web:slides.${field}`).
 */
const namesTool = (intent: WebActionIntent, text: string, tool: string) => {
  if (new RegExp(`['"\`]${escape(tool)}['"\`]`).test(text)) return true;
  const file = stripComments(readFileSync(resolve(REPO_ROOT, intent.file), 'utf8'));
  const constants = [
    ...file.matchAll(
      new RegExp(
        `(?:^|\\n)\\s*(?:export\\s+)?const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*['"]${escape(tool)}['"]`,
        'g'
      )
    ),
  ].map(m => m[1]);
  if (constants.some(name => new RegExp(`(?<![\\w$.])${escape(name)}\\b`).test(text))) return true;
  return [...text.matchAll(/`([^`]*)`/g)].some(
    m => m[1].includes('${') && m[1].replace(/\$\{[^}]*\}/g, intent.intent) === tool
  );
};

/**
 * What is wrong with one intent's code for its entry: [] when it reaches the
 * writer the entry names. `helper` is the text of a file WRITER_IN names.
 */
function problemsFor(intent: WebActionIntent, entry: Entry, helper = ''): string[] {
  const key = `${intent.routeId}#${intent.intent}`;
  const problems: string[] = [];
  const [kind, ...rest] = entry.split(':');
  const name = rest.join(':');
  const text = `${intent.text}\n${helper}`;
  const writesRow = reaches(intent.text, intent.shared, FUNNEL);
  if (kind === 'service') {
    if (!callsService(text, name)) problems.push(`${key}: should call ${name}`);
    if (!OWN_ACTOR.has(name) && !reaches(text, intent.shared, ACTOR)) {
      problems.push(`${key}: should pass auditActor(…) to ${name}`);
    }
    if (writesRow) problems.push(`${key}: ${name} writes the row; the route writes one too`);
  } else if (kind === 'route') {
    if (!reaches(text, intent.shared, FUNNEL)) {
      problems.push(`${key}: should write its row through the audit funnel`);
    }
    if (!namesTool(intent, text, name)) problems.push(`${key}: should name its tool '${name}'`);
  } else if (kind === 'task') {
    if (!startsTask(text, name)) problems.push(`${key}: should start the ${name} run`);
    if (!OWN_ACTOR_TASKS.has(name) && !reaches(text, intent.shared, ACTOR)) {
      problems.push(`${key}: should hand the ${name} run its auditActor(…)`);
    }
  } else if (kind === 'exempt') {
    if (writesRow || reaches(intent.text, intent.shared, ACTOR)) {
      problems.push(`${key}: is exempt but records a row`);
    }
  }
  return problems;
}

const intents = webActionIntents();
const keyOf = (i: { routeId: string; intent: string }) => `${i.routeId}#${i.intent}`;

/** Route modules written to a temporary routes folder, for the reader's own tests. */
const fixtureDirs: string[] = [];
const fixtureRoutes = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'web-actions-'));
  fixtureDirs.push(dir);
  const routes = join(dir, 'routes');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(routes, path)), { recursive: true });
    writeFileSync(join(routes, path), text);
  }
  return routes;
};
afterAll(() => {
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
});
/** The intent read under `key`; a missing one fails the test that asked for it. */
const readIntent = (intents: Map<string, WebActionIntent>, key: string): WebActionIntent => {
  const intent = intents.get(key);
  if (!intent) throw new Error(`no intent ${key} was read`);
  return intent;
};

describe('the web-action reader', () => {
  const sample = stripComments(`
    export const action = async ({ request }) => {
      // namedAction(request, { notAnIntent() {} })
      return namedAction(request, {
        async create() { await audit('CREATE'); },
        update: async () => ({ ok: true }),
        'remove-item'() { return null; },
      });
    };
  `);

  it('reads the keys handed to namedAction, each with its own body, comments left out', () => {
    const found = actionIntents(declarationText(sample, 'action'));
    expect(found.map(i => i.intent)).toEqual(['create', 'update', 'remove-item']);
    expect(found[0].text).toContain("audit('CREATE')");
    expect(found[1].text).not.toContain('audit');
  });

  it('reads switch cases and comparisons on an intent field, with a path for the rest', () => {
    const switched = stripComments(`
      export async function action({ request }) {
        const body = await request.json();
        switch (body.intent) {
          case 'a': return one();
          case "b": return two();
        }
        if (request.method === 'DELETE') return gone();
      }
    `);
    expect(actionIntents(declarationText(switched, 'action')).map(i => i.intent)).toEqual([
      'a',
      'b',
    ]);
    const compared = stripComments(`
      export const action = async ({ request }) => {
        const intent = (await request.formData()).get('intent');
        if (intent === 'create') { return addClassroomAuditLog({}); }
        if (intent === 'delete') { return remove(); }
        return save();
      };
    `);
    const found = actionIntents(declarationText(compared, 'action'));
    expect(found.map(i => i.intent)).toEqual(['create', 'delete', '*']);
    expect(found[0].text).toContain('addClassroomAuditLog');
    expect(found[1].text).not.toContain('addClassroomAuditLog');
  });

  it('reads an action with no intent as one, and follows the local function it hands off to', () => {
    const delegated = stripComments(`
      const createPage = async (args) => { await addClassroomAuditLog({}); };
      export const action = async (args) => createPage(args);
    `);
    const found = actionIntents(reachableText(delegated, 'action'));
    expect(found.map(i => i.intent)).toEqual(['*']);
    expect(FUNNEL.test(found[0].text)).toBe(true);
  });

  it('finds local writers and a service call held under another name', () => {
    const action = stripComments(`
      const audit = (row) => addClassroomAuditLog({ request, ...row });
      const actor = await auditActor(request, gate, 'web:x');
      const lifecycle = ClassmojiService.classroomLifecycle;
      await lifecycle.setLifecycle(args);
    `);
    expect(localWriters(action, FUNNEL)).toEqual(['audit']);
    expect(localWriters(action, ACTOR)).toContain('actor');
    expect(callsService(action, 'classroomLifecycle.setLifecycle')).toBe(true);
    expect(callsService(action, 'classroomLifecycle.archive')).toBe(false);
    expect(callsService('ClassmojiService.module.create(x)', 'module.create')).toBe(true);
    expect(callsService('ClassmojiService.module.creates(x)', 'module.create')).toBe(false);
  });

  it('finds an index route, a local export under another name, an export *, and shorthand keys', () => {
    const routes = fixtureRoutes({
      'a.index/index.tsx': `export const action = async () => ({ ok: true });`,
      'b.handler/route.tsx': `
        const handler = async ({ request }) => {
          await addClassroomAuditLog({ metadata: { tool: 'web:b' } });
        };
        export { handler as action };
      `,
      'c.star/route.tsx': `export * from './action';`,
      'c.star/action.ts': `export async function action() { return null; }`,
      'd.shorthand/route.tsx': `
        async function create() {
          await addClassroomAuditLog({ metadata: { tool: 'web:d.create' } });
        }
        const remove = async () => ({ ok: true });
        export const action = ({ request }) => namedAction(request, { create, remove });
      `,
    });
    const found = webActionIntents(routes);
    expect(found.map(keyOf).sort()).toEqual([
      'a.index#*',
      'b.handler#*',
      'c.star#*',
      'd.shorthand#create',
      'd.shorthand#remove',
    ]);
    const byKey = new Map(found.map(i => [keyOf(i), i]));
    expect(problemsFor(readIntent(byKey, 'b.handler#*'), 'route:web:b')).toEqual([]);
    expect(problemsFor(readIntent(byKey, 'd.shorthand#create'), 'route:web:d.create')).toEqual([]);
    expect(problemsFor(readIntent(byKey, 'd.shorthand#remove'), 'route:web:d.create')).toHaveLength(
      2
    );
    for (const module of routeModules(routes)) {
      expect(exportsAction(module.file, routes)).toBe(true);
      expect(actionSource(module.file, 'action', routes)).not.toBeNull();
    }
  });

  it("bounds each intent to the dispatching body: the last intent and '*' do not borrow a helper's write", () => {
    const route = (lastWrites: boolean) =>
      fixtureRoutes({
        'x.audit/route.tsx': `
          export const action = async ({ request }) => {
            const intent = (await request.formData()).get('intent');
            if (intent === 'create') {
              await save();
              await audit({ tool: 'web:x.create' });
              return { ok: true };
            }
            if (intent === 'delete') {
              await remove();
              ${lastWrites ? "await audit({ tool: 'web:x.delete' });" : ''}
              return { ok: true };
            }
            return { error: 'unknown' };
          };
          const audit = (metadata) => addClassroomAuditLog({ metadata });
          const save = async () => {};
          const remove = async () => {};
        `,
      });
    const read = (dir: string) => new Map(webActionIntents(dir).map(i => [i.intent, i]));
    const writes = read(route(true));
    expect(problemsFor(readIntent(writes, 'create'), 'route:web:x.create')).toEqual([]);
    expect(problemsFor(readIntent(writes, 'delete'), 'route:web:x.delete')).toEqual([]);
    expect(problemsFor(readIntent(writes, '*'), 'exempt:refuses')).toEqual([]);

    const missing = read(route(false));
    expect(problemsFor(readIntent(missing, 'delete'), 'route:web:x.delete')).toEqual([
      'x.audit#delete: should write its row through the audit funnel',
      "x.audit#delete: should name its tool 'web:x.delete'",
    ]);
    // The fall-through path writes nothing of its own either.
    expect(problemsFor(readIntent(missing, '*'), 'route:web:x.create')).toContain(
      'x.audit#*: should write its row through the audit funnel'
    );
  });

  it('takes an actor only from what the intent can see, not a name another part declares', () => {
    const route = (deleteActor: string) =>
      fixtureRoutes({
        'y.actor/route.tsx': `
          export const action = async ({ request }) => {
            const gate = await requireClassroomAdmin(request);
            const actor = await auditActor(request, gate, 'web:y');
            const intent = (await request.formData()).get('intent');
            if (intent === 'create') {
              return ClassmojiService.module.create({ actor });
            }
            if (intent === 'delete') {
              ${deleteActor}
              return ClassmojiService.module.deleteById({ actor });
            }
          };
        `,
      });
    const read = (dir: string) => new Map(webActionIntents(dir).map(i => [i.intent, i]));
    const shared = read(route(''));
    expect(problemsFor(readIntent(shared, 'create'), 'service:module.create')).toEqual([]);
    expect(problemsFor(readIntent(shared, 'delete'), 'service:module.deleteById')).toEqual([]);

    const nulled = read(route('const actor = null;'));
    expect(problemsFor(readIntent(nulled, 'delete'), 'service:module.deleteById')).toEqual([
      'y.actor#delete: should pass auditActor(…) to module.deleteById',
    ]);
    expect(problemsFor(readIntent(nulled, 'create'), 'service:module.create')).toEqual([]);

    // An actor built inside one intent is not another's.
    const inner = fixtureRoutes({
      'z.inner/route.tsx': `
        export const action = async ({ request }) => {
          const intent = (await request.formData()).get('intent');
          if (intent === 'create') {
            const actor = await auditActor(request, gate, 'web:z');
            return ClassmojiService.module.create({ actor });
          }
          if (intent === 'delete') {
            return ClassmojiService.module.deleteById({ actor });
          }
        };
      `,
    });
    const z = read(inner);
    expect(problemsFor(readIntent(z, 'create'), 'service:module.create')).toEqual([]);
    expect(problemsFor(readIntent(z, 'delete'), 'service:module.deleteById')).toEqual([
      'z.inner#delete: should pass auditActor(…) to module.deleteById',
    ]);
  });

  it('checks the tool a route: entry names and the run a task: entry names', () => {
    const routes = fixtureRoutes({
      't.tools/route.tsx': `
        export const action = async ({ request }) => {
          const intent = (await request.formData()).get('intent');
          if (intent === 'save') {
            await addClassroomAuditLog({ metadata: { tool: 'web:t.save' } });
          }
          if (intent === 'run') {
            const actor = await auditActor(request, gate, 'web:t.run');
            await tasks.trigger('do_the_thing', { actor });
          }
        };
      `,
    });
    const byIntent = new Map(webActionIntents(routes).map(i => [i.intent, i]));
    expect(problemsFor(readIntent(byIntent, 'save'), 'route:web:t.save')).toEqual([]);
    expect(problemsFor(readIntent(byIntent, 'save'), 'route:web:t.other')).toEqual([
      "t.tools#save: should name its tool 'web:t.other'",
    ]);
    expect(problemsFor(readIntent(byIntent, 'run'), 'task:do_the_thing')).toEqual([]);
    expect(problemsFor(readIntent(byIntent, 'run'), 'task:another_thing')).toEqual([
      't.tools#run: should start the another_thing run',
    ]);
  });
});

describe('web action audit manifest', () => {
  it('finds the route actions, so this file cannot pass by finding nothing', () => {
    expect(new Set(intents.map(i => i.routeId)).size).toBeGreaterThanOrEqual(80);
    expect(intents.length).toBeGreaterThanOrEqual(190);
  });

  it('reads an action and at least one intent from every route module that exports one', () => {
    const unread: string[] = [];
    for (const module of routeModules()) {
      if (!exportsAction(module.file)) continue;
      const source = actionSource(module.file);
      if (!source) {
        unread.push(`${module.id}: exports an action this reader does not find`);
        continue;
      }
      const routeId = source.routeId && source.routeId !== module.id ? source.routeId : module.id;
      if (!intents.some(i => i.routeId === routeId)) unread.push(`${module.id}: no intent read`);
    }
    expect(unread).toEqual([]);
  });

  it('classifies every (route, intent), and nothing that no longer exists', () => {
    const found = [...new Set(intents.map(keyOf))].sort();
    expect(found).toEqual(Object.keys(ACTIONS).sort());
  });

  it('gives every entry a known class and a reason', () => {
    const bad = Object.entries(ACTIONS).filter(
      ([, entry]) => !/^(service|route|task|exempt|unclassified):\S/.test(entry)
    );
    expect(bad).toEqual([]);
  });

  it('the list of actions still to classify only shrinks', () => {
    const unclassified = Object.entries(ACTIONS)
      .filter(([, entry]) => entry.startsWith('unclassified:'))
      .map(([key]) => key)
      .sort();
    expect(unclassified.filter(key => !UNCLASSIFIED.has(key))).toEqual([]);
    // An allow-list entry whose action is now classified otherwise goes too.
    expect([...UNCLASSIFIED].filter(key => !unclassified.includes(key))).toEqual([]);
  });

  it('names a helper file only for an intent that exists', () => {
    expect(Object.keys(WRITER_IN).filter(key => !ACTIONS[key])).toEqual([]);
  });

  it("each intent's code reaches the writer its entry names", () => {
    const problems: string[] = [];
    for (const intent of intents) {
      const key = keyOf(intent);
      const entry = ACTIONS[key];
      if (!entry) continue;
      problems.push(...problemsFor(intent, entry, helperText(key)));
    }
    expect(problems).toEqual([]);
  });
});
