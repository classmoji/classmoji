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
 *   pending:<reason>    — what the action does, for an action whose row is
 *                         still to come. Only the entries of PENDING may say
 *                         so, and that list may only shrink.
 *
 * The checks read the intent's own code (and the action's helpers that it
 * calls, and a file WRITER_IN names), comments left out: a check of the text,
 * not of a run, but enough that a `service:` intent that builds no actor, a
 * `route:` one that reaches no funnel, or an exempt one that writes a row
 * fails here.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ROUTES_DIR,
  actionIntents,
  declarationText,
  reachableText,
  stripComments,
  webActionIntents,
} from '../../__tests__/support/webActions.ts';

type Entry =
  | `service:${string}`
  | `route:${string}`
  | `task:${string}`
  | `exempt:${string}`
  | `pending:${string}`;

const OWN_ACCOUNT = 'exempt:own account (sign-in, password, email, school id)';
const OWN_PINS = 'exempt:own classroom pins';
const FEEDBACK = 'exempt:the feedback board writes no audit rows (decided for #739)';
const REFUSES = 'exempt:refuses an intent it does not know';
const MEDIA = 'pending:media uploads and deletes (pages-app and MCP parity)';

/** Every (route, intent) the webapp handles, classified. Keys: `<route id>#<intent>`. */
const ACTIONS: Record<string, Entry> = {
  // ── account and platform ──
  '_user.create-classroom#create-gitlab': 'pending:classroom creation',
  '_user.create-classroom#*': 'pending:classroom creation',
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
  'api.example-classroom#*': 'pending:example course provisioning',
  'api.classrooms.$id.pin#*': OWN_PINS,
  'api.classrooms.reorder-pins#*': OWN_PINS,
  'api.classrooms.$id.archive#*': 'service:classroomLifecycle.setLifecycle',
  'api.classrooms.$id.status#*': 'service:classroomLifecycle.setLifecycle',
  'api.classrooms.$class.github-installation#*': 'route:api.classrooms.github-installation',
  'api.import-jobs.$jobId#*': 'pending:import retry',
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
  'admin.$class.repos_.$title#createProjects': 'pending:project board creation',
  'admin.$class.repos_.form#createTag': 'service:organizationTag.findOrCreate',
  'admin.$class.repos_.form#create': 'service:repository.create',
  'admin.$class.repos_.form#update': 'service:repository.updateFromForm',
  'api.repos.$id.contributor-link#*': 'service:repoAnalytics.linkContributor',
  'api.repos.$id.refresh#*': 'pending:analytics refresh',
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
  'api.pages.batch#batch-init': 'pending:content repository setup',
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
  'api.quiz#startQuiz': 'pending:quiz attempt start',
  'api.quiz#restartQuiz': 'pending:quiz attempt start',
  'api.quiz#updateMetrics': 'pending:quiz attempt timing',
  'api.quiz#recordModalClose': 'pending:quiz attempt timing',
  'api.quiz#recordModalOpen': 'pending:quiz attempt timing',
  'api.quiz-chat.session#*': 'route:web:quiz_chat.session',
  'api.quizLateWaiver.$class#*': 'route:web:quiz_late_waiver',

  // ── grading ──
  'api.gitRepoAssignment.$class#autograde': 'pending:autograde workflow dispatch',
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
  'admin.$class.settings.repos#repairWebhooks': 'pending:webhook repair',
  'admin.$class.settings.repos#*': 'service:orgRepoSettings.updateOrgRepoSettings',
  'admin.$class.settings.team#createTag': 'service:organizationTag.findOrCreate',
  'admin.$class.settings.team#deleteTag': 'service:organizationTag.deleteInClassroom',
  'admin.$class.settings.website#claimSubdomain': 'service:site.validateAndClaimSubdomain',
  'admin.$class.settings.website#saveSettings': 'service:site.upsertSiteSettings',
  'admin.$class.settings.website#removeSite': 'service:site.deleteSiteForClassroom',
  'admin.$class.settings.website#saveCustomDomain': 'service:site.setCustomDomain',
  'admin.$class.settings.website#checkCustomDomainCert': 'exempt:read-only certificate check',
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
 * The `pending` entries there may be. A new action cannot be added as one:
 * it is classified, or recorded. This list only shrinks.
 */
const PENDING = new Set([
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
 * The names of the action's local consts and functions whose own code matches
 * `pattern` (a `const audit = (…) => addClassroomAuditLog(…)` wrapper, a
 * `const actor = await auditActor(…)`), so an intent that uses one counts.
 */
const localWriters = (action: string, pattern: RegExp): string[] =>
  [...action.matchAll(/(?:^|\n)\s*(?:const|let|function|async\s+function)\s+([A-Za-z_$][\w$]*)/g)]
    .map(m => m[1])
    .filter(name => {
      try {
        const text = declarationText(action, name);
        // The function an action hands its whole request to holds every
        // intent: it is the intents' code, not a writer of one of them.
        return pattern.test(text) && !/\b(?:intent|_action)\s*===/.test(text);
      } catch {
        return false;
      }
    });

/**
 * Whether `text` reaches `pattern` directly, or through one of the action's
 * local writers: a wrapper it calls (`audit(…)`), or for the actor a value it
 * uses (`actor`, built once with `auditActor`).
 */
const reaches = (text: string, action: string, pattern: RegExp) =>
  pattern.test(text) ||
  localWriters(action, pattern).some(name =>
    new RegExp(
      pattern === ACTOR ? `\\b${escape(name)}\\b` : `(?<![\\w$.])${escape(name)}\\s*\\(`
    ).test(text)
  );

/** `text` without the declarations of the action's local writers. */
const withoutWriters = (text: string, action: string) => {
  let out = text;
  for (const name of [...localWriters(action, FUNNEL), ...localWriters(action, ACTOR)]) {
    try {
      out = out.split(declarationText(action, name)).join('');
    } catch {
      // Not declared in a form this reader follows: left as it is.
    }
  }
  return out;
};

const intents = webActionIntents();
const keyOf = (i: { routeId: string; intent: string }) => `${i.routeId}#${i.intent}`;

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
});

describe('web action audit manifest', () => {
  it('finds the route actions, so this file cannot pass by finding nothing', () => {
    expect(new Set(intents.map(i => i.routeId)).size).toBeGreaterThanOrEqual(80);
    expect(intents.length).toBeGreaterThanOrEqual(190);
  });

  it('classifies every (route, intent), and nothing that no longer exists', () => {
    const found = [...new Set(intents.map(keyOf))].sort();
    expect(found).toEqual(Object.keys(ACTIONS).sort());
  });

  it('gives every entry a known class and a reason', () => {
    const bad = Object.entries(ACTIONS).filter(
      ([, entry]) => !/^(service|route|task|exempt|pending):\S/.test(entry)
    );
    expect(bad).toEqual([]);
  });

  const pending = Object.entries(ACTIONS)
    .filter(([, entry]) => entry.startsWith('pending:'))
    .map(([key]) => key)
    .sort();
  it(`adds no pending entry: the list only shrinks (${pending.length} pending)`, () => {
    console.warn(`web actions pending an audit row: ${pending.length}`);
    expect(pending.filter(key => !PENDING.has(key))).toEqual([]);
    // An allow-list entry whose action is now classified otherwise goes too.
    expect([...PENDING].filter(key => !pending.includes(key))).toEqual([]);
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
      const [kind, ...rest] = entry.split(':');
      const name = rest.join(':');
      const text = `${intent.text}\n${helperText(key)}`;
      const action = `${intent.action}\n${helperText(key)}`;
      const writesRow = reaches(intent.text, intent.action, FUNNEL);
      if (kind === 'service') {
        if (!callsService(text, name)) problems.push(`${key}: should call ${name}`);
        if (!OWN_ACTOR.has(name) && !reaches(text, action, ACTOR)) {
          problems.push(`${key}: should pass auditActor(…) to ${name}`);
        }
        if (writesRow) problems.push(`${key}: ${name} writes the row; the route writes one too`);
      } else if (kind === 'route') {
        if (!reaches(text, action, FUNNEL)) {
          problems.push(`${key}: should write its row through the audit funnel`);
        }
      } else if (kind === 'task') {
        if (!/\b(?:trigger|batchTrigger)\s*\(/.test(text)) {
          problems.push(`${key}: should start the ${name} run`);
        }
        if (!OWN_ACTOR_TASKS.has(name) && !reaches(text, action, ACTOR)) {
          problems.push(`${key}: should hand the ${name} run its auditActor(…)`);
        }
      } else if (kind === 'exempt') {
        // The intent's own code: a writer the action declares for its other
        // intents is not this one's.
        const own = withoutWriters(intent.text, intent.action);
        if (reaches(own, intent.action, FUNNEL) || ACTOR.test(own)) {
          problems.push(`${key}: is exempt but records a row`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
