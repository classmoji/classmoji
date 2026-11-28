/**
 * Every write tool is classified for the audit log, so a new one cannot ship
 * without someone deciding who writes its row.
 *
 * Registry-driven, like readAudit.manifest.test.ts: the whole manifest is
 * registered and each `scope: 'write'` tool must appear in WRITES below; an
 * entry naming a tool that is not registered fails too.
 *
 *   tool    — the handler writes its row itself (`writeAudit` /
 *             `writeAuditOrFail`), directly or through a function of its own
 *             file that it calls.
 *   service — a shared service writes the row because the tool passes an actor
 *             (`fn` names it; its rows are pinned by its own tests in
 *             @classmoji/services). The handler calls `fn`; a grading tool
 *             (`actor: 'serviceActor'`) builds the actor with `serviceActor` and
 *             writes no row itself, while the services that wrote their own
 *             rows before (`actor: 'own'`) take the caller in their own shape.
 *   both    — one mode is `service`, another `tool`; both checks run.
 *   exempt  — writes no row, for the reason given.
 *
 * The `tool` and `service` checks read the handler's source (and the bodies of
 * same-file functions it calls, two levels down): a check of the text, not of
 * a run, but enough that a write tool which never reaches a writer fails here.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../registry.ts';

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

type Entry =
  | { kind: 'tool' }
  | { kind: 'service'; fn: string; actor: 'serviceActor' | 'own' }
  | { kind: 'both'; fn: string }
  | { kind: 'exempt'; reason: string };

const TOOL: Entry = { kind: 'tool' };
const grading = (fn: string): Entry => ({ kind: 'service', fn, actor: 'serviceActor' });

const WRITES: Record<string, Entry> = {
  // ── grading: the shared service writes the row for the actor ──
  grade_add: grading('HelperService.addGradeToGitRepoAssignment'),
  grade_remove: grading('HelperService.removeGradeFromGitRepoAssignment'),
  grade_remove_all: grading('HelperService.removeGradeFromGitRepoAssignment'),
  grader_assign: grading('HelperService.addGraderInClassroom'),
  grader_unassign: grading('HelperService.removeGraderInClassroom'),
  grader_assign_bulk: grading('gitRepoAssignmentGrader.assignGradersToAssignment'),
  // Repo mode: gitRepoAssignment.setLateOverrideInClassroom; quiz mode writes
  // its QUIZ_LATE_WAIVER row itself.
  submission_late_override: { kind: 'both', fn: 'setLateOverrideInClassroom' },
  // quizGradeAdjust writes the QUIZ_ATTEMPT row inside its change, for the
  // actor the tool hands quizAttempt.adjust / revert.
  quiz_attempt_adjust: { kind: 'service', fn: 'quizAttempt.adjust', actor: 'own' },
  // A quiz request: regradeRequest.resolveQuiz; a repo request: the
  // update_regrade_request run (regradeRequest.resolveRepo), told the tool.
  regrade_resolve: { kind: 'service', fn: 'regradeRequest.resolveQuiz', actor: 'own' },
  // classroomLifecycle.setLifecycle writes the CLASSROOM row (viewingAs).
  classroom_status_update: {
    kind: 'service',
    fn: 'classroomLifecycle.setLifecycle',
    actor: 'own',
  },
  // ── the tool writes its own row ──
  assignment_create: TOOL,
  // grades_released is one of its fields: still the tool's row (the web's
  // release goes through assignment.setGradesReleased).
  assignment_update: TOOL,
  assignment_delete: TOOL,
  calendar_event_create: TOOL,
  calendar_event_update: TOOL,
  calendar_event_delete: TOOL,
  calendar_event_links_set: TOOL,
  deck_apply: TOOL,
  deck_preview_accept: TOOL,
  deck_preview_discard: TOOL,
  extension_purchase: TOOL,
  form_teams_run: TOOL,
  form_teams_create: TOOL,
  form_create: TOOL,
  form_update: TOOL,
  form_publish: TOOL,
  form_delete: TOOL,
  form_response_create: TOOL,
  form_response_update: TOOL,
  emoji_mapping_upsert: TOOL,
  letter_grade_mapping_upsert: TOOL,
  media_delete: TOOL,
  file_upload_start: TOOL,
  file_upload_finish: TOOL,
  file_import_url: TOOL,
  module_create: TOOL,
  module_update: TOOL,
  module_publish: TOOL,
  module_item_add: TOOL,
  module_item_remove: TOOL,
  module_item_move: TOOL,
  module_delete: TOOL,
  module_reorder: TOOL,
  page_comment_create: TOOL,
  page_comment_update: TOOL,
  page_comment_delete: TOOL,
  page_comment_react: TOOL,
  page_comment_resolve: TOOL,
  page_content_apply: TOOL,
  page_preview_accept: TOOL,
  page_preview_discard: TOOL,
  page_asset_upload: TOOL,
  page_cover_set: TOOL,
  page_section_unlock: TOOL,
  page_section_check: TOOL,
  page_create: TOOL,
  page_update: TOOL,
  page_delete: TOOL,
  quiz_create: TOOL,
  quiz_update: TOOL,
  quiz_publish: TOOL,
  quiz_delete: TOOL,
  regrade_create: TOOL,
  repo_contributions_calculate: TOOL,
  repo_publish: TOOL,
  repo_sync: TOOL,
  repo_unpublish: TOOL,
  repo_create: TOOL,
  repo_update: TOOL,
  repo_delete: TOOL,
  resource_link_add: TOOL,
  resource_link_remove: TOOL,
  roster_add_student: TOOL,
  roster_remove_student: TOOL,
  classroom_settings_update: TOOL,
  org_repo_settings_update: TOOL,
  slide_create: TOOL,
  slide_update: TOOL,
  slide_delete: TOOL,
  staff_add: TOOL,
  staff_update: TOOL,
  staff_remove: TOOL,
  team_create: TOOL,
  team_delete: TOOL,
  team_rename: TOOL,
  team_members_add: TOOL,
  team_member_remove: TOOL,
  tag_create: TOOL,
  team_tag_add: TOOL,
  team_tag_remove: TOOL,
  token_grant: TOOL,
  // ── no row ──
  feedback_write: {
    kind: 'exempt',
    reason: 'the feedback board writes no audit rows, on the web or the MCP (decided for #739)',
  },
  feedback_delete: { kind: 'exempt', reason: 'the feedback board writes no audit rows (#739)' },
  page_cursor_set: { kind: 'exempt', reason: 'a live cursor is presence only: nothing is stored' },
  deck_cursor_set: { kind: 'exempt', reason: 'a live cursor is presence only: nothing is stored' },
};

const TOOLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools');
const SOURCES = readdirSync(TOOLS_DIR)
  .filter(file => file.endsWith('.ts'))
  .map(file => readFileSync(path.join(TOOLS_DIR, file), 'utf8'));

/** The text of a top-level function or const of the tools' files named `name`. */
function bodyOf(name: string): string | null {
  const start = new RegExp(
    `\\n(?:export )?(?:async )?(?:function ${name}\\b|const ${name}\\s*[=:])`
  );
  for (const source of SOURCES) {
    const match = start.exec(source);
    if (!match) continue;
    const rest = source.slice(match.index + 1);
    const end = rest.search(/\n\};?\n/);
    return end === -1 ? rest : rest.slice(0, end);
  }
  return null;
}

/** The handler's source with the bodies of the functions it calls, two levels down. */
function reachableSource(def: ToolDefinition<never>): string {
  let text = def.handler.toString();
  const seen = new Set<string>();
  for (let depth = 0; depth < 2; depth++) {
    const called = [...text.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map(m => m[1]);
    for (const name of called) {
      if (seen.has(name)) continue;
      seen.add(name);
      const body = bodyOf(name);
      if (body) text += `\n${body}`;
    }
  }
  return text;
}

/**
 * A call of `name`, as written or as the test transform rewrites an imported
 * one (`(0, __import__.name)(…)`).
 */
const calls = (source: string, name: string) => new RegExp(`\\b${name}\\)?\\s*\\(`).test(source);
const writesItsOwnRow = (source: string) =>
  calls(source, 'writeAudit') || calls(source, 'writeAuditOrFail');

let writes: ToolDefinition<never>[];

beforeAll(async () => {
  const { registerAllTools } = await import('../../tools/index.ts');
  const { listToolDefinitions } = await import('../registry.ts');
  registerAllTools();
  writes = listToolDefinitions().filter(def => def.scope === 'write');
}, 60_000);

describe('write audit manifest', () => {
  it('classifies every write tool, and nothing that is not registered', () => {
    const names = writes.map(def => def.name).sort();
    expect(names).toEqual(Object.keys(WRITES).sort());
  });

  it("each write's handler reaches the writer its entry names", () => {
    const problems: string[] = [];
    const check = (ok: boolean, problem: string) => {
      if (!ok) problems.push(problem);
    };
    const method = (fn: string) => fn.split('.').at(-1)!;
    for (const def of writes) {
      const entry = WRITES[def.name];
      const source = reachableSource(def);
      const name = def.name;
      if (entry.kind === 'tool') {
        check(writesItsOwnRow(source), `${name}: should call writeAudit`);
      } else if (entry.kind === 'service' || entry.kind === 'both') {
        check(calls(source, method(entry.fn)), `${name}: should call ${entry.fn}`);
        if (entry.kind === 'both' || entry.actor === 'serviceActor') {
          check(calls(source, 'serviceActor'), `${name}: should pass serviceActor(...)`);
        }
        if (entry.kind === 'both') {
          check(writesItsOwnRow(source), `${name}: should write its other mode's row`);
        } else if (entry.actor === 'serviceActor') {
          check(!writesItsOwnRow(source), `${name}: should write no row of its own`);
        }
      } else {
        check(entry.reason.length > 0, `${name}: needs a reason`);
        check(!writesItsOwnRow(source), `${name}: is exempt but writes a row`);
      }
    }
    expect(problems).toEqual([]);
  });
});
