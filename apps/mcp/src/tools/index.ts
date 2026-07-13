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
import { gradeAddTool, gradeRemoveTool, gradeRemoveAllTool } from './grades.ts';
import { graderAssignTool, graderUnassignTool } from './graders.ts';
import { emojiMappingUpsertTool, letterGradeMappingUpsertTool } from './mappings.ts';
import { assignmentUpdateTool } from './assignments.ts';
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

export function registerAllTools(): void {
  // Identity / bootstrap
  registerToolDefinition(whoamiTool);

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

  // Assignments (OWNER+TEACHER with per-field tiering)
  registerToolDefinition(assignmentUpdateTool);

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
}
