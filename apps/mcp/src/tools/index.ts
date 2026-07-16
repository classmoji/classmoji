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
import { graderAssignTool, graderUnassignTool } from './graders.ts';
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
import { tokenGrantTool } from './tokens.ts';
import { extensionPurchaseTool } from './extensions.ts';
import { repoCreateTool, repoPublishTool, repoUnpublishTool } from './repos.ts';
import { rosterAddStudentTool, rosterRemoveStudentTool } from './roster.ts';

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

  // Grader assignment (OWNER — route-derived)
  registerToolDefinition(graderAssignTool);
  registerToolDefinition(graderUnassignTool);

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

  // Tokens (OWNER)
  registerToolDefinition(tokenGrantTool);

  // Roster (OWNER — add sends real emails; remove is destructive, confirm-gated)
  registerToolDefinition(rosterAddStudentTool);
  registerToolDefinition(rosterRemoveStudentTool);

  // Extensions (STUDENT self)
  registerToolDefinition(extensionPurchaseTool);

  // Repos: create container + publish/unpublish + provisioning (OWNER)
  registerToolDefinition(repoCreateTool);
  registerToolDefinition(repoPublishTool);
  registerToolDefinition(repoUnpublishTool);
}
