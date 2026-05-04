import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../auth/context.ts';
import { isStaffInAny, isStudentInAny, isTeachingInAny } from '../auth/roles.ts';
import { hasAnyScope } from '../auth/scopes.ts';

import { registerClassroomsList, registerSetActiveClassroom } from './classrooms.ts';
import { registerAssignmentsUpcoming } from './assignments.ts';
import { registerSearchContent } from './search.ts';
import { registerPageContentRead, registerSlideContentRead } from './content.ts';
import { registerCalendarIcsUrl } from './calendar.ts';
import { registerGithubFeedback, registerGithubRepoIssues } from './github.ts';
import { registerGradesWrite } from './grades.ts';
import { registerRegradeCreate, registerRegradeResolve } from './regrade.ts';
import { registerAssignmentsWrite } from './assignments.ts';
import { registerModulesWrite } from './modules.ts';
import { registerCalendarWrite } from './calendar.ts';
import { registerRosterWrite } from './roster.ts';
import { registerPagesWrite } from './content.ts';
import { registerQuizzesWrite } from './quizzes.ts';
import { registerTokensAssign, registerTokensPurchaseExtension } from './tokens.ts';
import { registerTeamsWrite } from './teams.ts';
import { registerClassroomSettingsUpdate } from './settings.ts';
import { registerGradersWrite } from './graders.ts';
import { registerMappingsWrite } from './mappings.ts';

export const TOOL_SCOPES = {
  // Cross-classroom and identity-only — registered for any authenticated user
  classrooms_list: ['openid'],
  set_active_classroom: ['openid'],
  assignments_upcoming: ['assignments:read'],
  // Shared
  search_content: [
    'assignments:read',
    'modules:read',
    'content:read',
    'quizzes:read',
    'calendar:read',
  ],
  page_content_read: ['content:read'],
  slide_content_read: ['content:read'],
  calendar_ics_url: ['calendar:read'],
  github_feedback: ['feedback:read'],
  github_repo_issues: ['feedback:read'],
  // Teaching team
  grades_write: ['grades:write'],
  regrade_resolve: ['regrade:write'],
  // Admin
  assignments_write: ['assignments:write'],
  modules_write: ['modules:write'],
  calendar_write: ['calendar:write'],
  roster_write: ['roster:write'],
  pages_write: ['content:write'],
  quizzes_write: ['quizzes:write'],
  tokens_assign: ['tokens:write'],
  teams_write: ['teams:write'],
  classroom_settings_update: ['settings:write'],
  graders_write: ['roster:write'],
  mappings_write: ['settings:write'],
  // Student
  tokens_purchase_extension: ['tokens:write'],
  regrade_create: ['regrade:write'],
} as const satisfies Record<string, readonly string[]>;

export function registerTools(server: McpServer, ctx: AuthContext): void {
  // Cross-classroom — bootstrap tools require an identity scope. A token with
  // *only* resource scopes (e.g. `calendar:read`) and no identity claim should
  // not enumerate the user's classroom list.
  if (hasAnyScope(ctx.scopes, TOOL_SCOPES.classrooms_list)) {
    registerClassroomsList(server, ctx);
    registerSetActiveClassroom(server, ctx);
  }
  if (hasAnyScope(ctx.scopes, TOOL_SCOPES.assignments_upcoming))
    registerAssignmentsUpcoming(server, ctx);

  // Shared (any role) — content / search / feedback
  if (hasAnyScope(ctx.scopes, TOOL_SCOPES.search_content)) registerSearchContent(server, ctx);
  if (hasAnyScope(ctx.scopes, TOOL_SCOPES.page_content_read))
    registerPageContentRead(server, ctx);
  if (hasAnyScope(ctx.scopes, TOOL_SCOPES.slide_content_read))
    registerSlideContentRead(server, ctx);
  if (hasAnyScope(ctx.scopes, TOOL_SCOPES.calendar_ics_url))
    registerCalendarIcsUrl(server, ctx);
  if (hasAnyScope(ctx.scopes, TOOL_SCOPES.github_feedback))
    registerGithubFeedback(server, ctx);

  // Teaching team
  if (isTeachingInAny(ctx.roles)) {
    if (hasAnyScope(ctx.scopes, TOOL_SCOPES.grades_write)) registerGradesWrite(server, ctx);
    if (hasAnyScope(ctx.scopes, TOOL_SCOPES.regrade_resolve))
      registerRegradeResolve(server, ctx);
    if (hasAnyScope(ctx.scopes, TOOL_SCOPES.github_repo_issues))
      registerGithubRepoIssues(server, ctx);
  }

  // Admin
  if (isStaffInAny(ctx.roles)) {
    if (hasAnyScope(ctx.scopes, TOOL_SCOPES.assignments_write))
      registerAssignmentsWrite(server, ctx);
    if (hasAnyScope(ctx.scopes, TOOL_SCOPES.modules_write))
      registerModulesWrite(server, ctx);
    if (hasAnyScope(ctx.scopes, TOOL_SCOPES.calendar_write))
      registerCalendarWrite(server, ctx);
    if (hasAnyScope(ctx.scopes, TOOL_SCOPES.roster_write))
      registerRosterWrite(server, ctx);
    if (hasAnyScope(ctx.scopes, TOOL_SCOPES.pages_write)) registerPagesWrite(server, ctx);
    if (hasAnyScope(ctx.scopes, TOOL_SCOPES.quizzes_write))
      registerQuizzesWrite(server, ctx);
    if (hasAnyScope(ctx.scopes, TOOL_SCOPES.tokens_assign))
      registerTokensAssign(server, ctx);
    if (hasAnyScope(ctx.scopes, TOOL_SCOPES.teams_write)) registerTeamsWrite(server, ctx);
    if (hasAnyScope(ctx.scopes, TOOL_SCOPES.classroom_settings_update))
      registerClassroomSettingsUpdate(server, ctx);
    if (hasAnyScope(ctx.scopes, TOOL_SCOPES.graders_write))
      registerGradersWrite(server, ctx);
    if (hasAnyScope(ctx.scopes, TOOL_SCOPES.mappings_write))
      registerMappingsWrite(server, ctx);
  }

  // Student
  if (isStudentInAny(ctx.roles)) {
    if (hasAnyScope(ctx.scopes, TOOL_SCOPES.tokens_purchase_extension))
      registerTokensPurchaseExtension(server, ctx);
    if (hasAnyScope(ctx.scopes, TOOL_SCOPES.regrade_create))
      registerRegradeCreate(server, ctx);
  }
}
