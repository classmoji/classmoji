/**
 * Tool manifest. Registration order is listing order. Registration runs once
 * at startup and validates definitions (unique names; role-gated tools must
 * take a `classroom` arg).
 *
 * Phase 2c (write surface): every write tool declares scope 'write', takes a
 * `classroom` ('org/slug') argument, gets the registry's enforcement pipeline
 * (scope → rate limit → classroom/role → mutation gate), re-verifies target
 * ownership against the authorized classroom (S1), routes mutations through
 * packages/services orchestrators, and writes an audit-log row.
 */

import { registerToolDefinition } from '../mcp/registry.ts';
import { whoamiTool } from './whoami.ts';
import { readTools } from './reads.ts';
import { gradeAddTool, gradeRemoveTool, gradeRemoveAllTool } from './grades.ts';
import { graderAssignTool, graderUnassignTool, graderAssignBulkTool } from './graders.ts';
import { emojiMappingUpsertTool, letterGradeMappingUpsertTool } from './mappings.ts';
import { assignmentCreateTool, assignmentUpdateTool, assignmentDeleteTool } from './assignments.ts';
import { regradeCreateTool, regradeResolveTool } from './regrades.ts';
import {
  moduleCreateTool,
  moduleUpdateTool,
  modulePublishTool,
  moduleItemAddTool,
} from './modules.ts';
import {
  calendarEventCreateTool,
  calendarEventUpdateTool,
  calendarEventDeleteTool,
} from './calendar.ts';
import { pageCreateTool, pageUpdateTool, pageDeleteTool } from './pages.ts';
import {
  pageContentOutlineTool,
  pageContentGetTool,
  pageContentApplyTool,
  pagePreviewAcceptTool,
  pagePreviewDiscardTool,
} from './pageContent.ts';
import { listSlidesTool, slideCreateTool, slideUpdateTool, slideDeleteTool } from './slides.ts';
import {
  deckOutlineTool,
  deckGetTool,
  deckApplyTool,
  deckPreviewAcceptTool,
  deckPreviewDiscardTool,
} from './deck.ts';
import { tokenGrantTool } from './tokens.ts';
import { extensionPurchaseTool } from './extensions.ts';
import { repoCreateTool, repoPublishTool, repoUnpublishTool } from './repos.ts';
import { rosterAddStudentTool, rosterRemoveStudentTool } from './roster.ts';
import { assistantAddTool, assistantUpdateTool, assistantRemoveTool } from './assistants.ts';
import { quizCreateTool, quizUpdateTool, quizPublishTool, quizDeleteTool } from './quizzes.ts';
import {
  classroomSettingsUpdateTool,
  classroomStatusUpdateTool,
  orgRepoSettingsUpdateTool,
} from './settings.ts';
import {
  teamCreateTool,
  teamDeleteTool,
  teamRenameTool,
  teamMembersAddTool,
  teamMemberRemoveTool,
  teamTagAddTool,
  teamTagRemoveTool,
} from './teams.ts';

export function registerAllTools(): void {
  // Identity / bootstrap
  registerToolDefinition(whoamiTool);

  // Read surface mirrored as tools (tool-only clients like claude.ai cannot
  // list/read MCP resources). Each mirror reuses its resource's handler + tier;
  // list_submissions/list_teaching_team add filtering / staff-id resolution.
  for (const tool of readTools) registerToolDefinition(tool);

  // Grading (teaching team incl. TEACHER; remove-all OWNER)
  registerToolDefinition(gradeAddTool);
  registerToolDefinition(gradeRemoveTool);
  registerToolDefinition(gradeRemoveAllTool);

  // Grader assignment (OWNER — route-derived); bulk distributes across a whole
  // assignment in one call.
  registerToolDefinition(graderAssignTool);
  registerToolDefinition(graderUnassignTool);
  registerToolDefinition(graderAssignBulkTool);

  // Grading scale (OWNER)
  registerToolDefinition(emojiMappingUpsertTool);
  registerToolDefinition(letterGradeMappingUpsertTool);

  // Assignments (create/delete OWNER-only; update OWNER+TEACHER with per-field tiering)
  registerToolDefinition(assignmentCreateTool);
  registerToolDefinition(assignmentUpdateTool);
  registerToolDefinition(assignmentDeleteTool);

  // Regrades (student self-create; teaching-team resolve)
  registerToolDefinition(regradeCreateTool);
  registerToolDefinition(regradeResolveTool);

  // Curriculum modules (OWNER)
  registerToolDefinition(moduleCreateTool);
  registerToolDefinition(moduleUpdateTool);
  registerToolDefinition(modulePublishTool);
  registerToolDefinition(moduleItemAddTool);

  // Calendar (teaching team; assistants own-events-only)
  registerToolDefinition(calendarEventCreateTool);
  registerToolDefinition(calendarEventUpdateTool);
  registerToolDefinition(calendarEventDeleteTool);

  // Pages (OWNER+TEACHER)
  registerToolDefinition(pageCreateTool);
  registerToolDefinition(pageUpdateTool);
  registerToolDefinition(pageDeleteTool);

  // Page content: granular BlockNote editing + preview-branch workflow
  // (OWNER+TEACHER — parity with web page editing)
  registerToolDefinition(pageContentOutlineTool);
  registerToolDefinition(pageContentGetTool);
  registerToolDefinition(pageContentApplyTool);
  registerToolDefinition(pagePreviewAcceptTool);
  registerToolDefinition(pagePreviewDiscardTool);

  // Slides: list (all roles, students published-only) + metadata CRUD
  // (TEACHING_TEAM with the web's creator/allow_team_edit sub-gate)
  registerToolDefinition(listSlidesTool);
  registerToolDefinition(slideCreateTool);
  registerToolDefinition(slideUpdateTool);
  registerToolDefinition(slideDeleteTool);

  // Deck content: granular slide editing + preview-branch workflow
  // (TEACHING_TEAM + sub-gate on writes)
  registerToolDefinition(deckOutlineTool);
  registerToolDefinition(deckGetTool);
  registerToolDefinition(deckApplyTool);
  registerToolDefinition(deckPreviewAcceptTool);
  registerToolDefinition(deckPreviewDiscardTool);

  // Quizzes (OWNER+ASSISTANT — the quiz surface excludes TEACHER; each tool
  // also re-checks Pro tier + quizzes_enabled in-handler)
  registerToolDefinition(quizCreateTool);
  registerToolDefinition(quizUpdateTool);
  registerToolDefinition(quizPublishTool);
  registerToolDefinition(quizDeleteTool);

  // Tokens (OWNER)
  registerToolDefinition(tokenGrantTool);

  // Roster (OWNER — add sends real emails; remove is destructive, confirm-gated)
  registerToolDefinition(rosterAddStudentTool);
  registerToolDefinition(rosterRemoveStudentTool);

  // Assistants / TAs (OWNER — add sends a real GitHub org invite; remove is
  // destructive, confirm-gated, and can drop them from the org)
  registerToolDefinition(assistantAddTool);
  registerToolDefinition(assistantUpdateTool);
  registerToolDefinition(assistantRemoveTool);

  // Extensions (STUDENT self)
  registerToolDefinition(extensionPurchaseTool);

  // Repos: create container + publish/unpublish + provisioning (OWNER)
  registerToolDefinition(repoCreateTool);
  registerToolDefinition(repoPublishTool);
  registerToolDefinition(repoUnpublishTool);

  // Classroom settings + lifecycle status (OWNER). The org tool writes
  // ORGANIZATION-WIDE GitHub settings, so it sits beside the repo tools it
  // affects and carries a tighter rate limit.
  registerToolDefinition(classroomSettingsUpdateTool);
  registerToolDefinition(classroomStatusUpdateTool);
  registerToolDefinition(orgRepoSettingsUpdateTool);

  // Teams (OWNER — the write surface behind list_teams). create/rename/members
  // touch real GitHub teams; delete is destructive and confirm-gated; the tag
  // tools are Classmoji-only links.
  registerToolDefinition(teamCreateTool);
  registerToolDefinition(teamDeleteTool);
  registerToolDefinition(teamRenameTool);
  registerToolDefinition(teamMembersAddTool);
  registerToolDefinition(teamMemberRemoveTool);
  registerToolDefinition(teamTagAddTool);
  registerToolDefinition(teamTagRemoveTool);
}
