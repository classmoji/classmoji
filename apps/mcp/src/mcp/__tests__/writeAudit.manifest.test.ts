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
 *             (`fn` names it as the handler calls it, `<object>.<function>`;
 *             its rows are pinned by its own tests in @classmoji/services). The
 *             handler calls `fn` and writes no row itself (`writeAudit` /
 *             `writeAuditOrFail`), so the change is not recorded twice. A
 *             grading tool (`actor: 'serviceActor'`) builds the actor with
 *             `serviceActor`; the services that wrote their own rows before
 *             (`actor: 'own'`) take the caller in their own shape.
 *   both    — one mode is `service` (`fn`, `actor` as above), another `tool`:
 *             the handler calls `fn` and also writes a row itself.
 *   exempt  — writes no row, for the reason given.
 *
 * The `tool` and `service` checks read the handler's source (and the bodies of
 * the functions of its own file that it calls, two levels down), comments
 * left out: a check of the text, not of a run, but enough that a write tool
 * which never reaches a writer, or writes a second row, fails here.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../registry.ts';

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

type Actor = 'serviceActor' | 'own';
type Entry =
  | { kind: 'tool' }
  | { kind: 'service'; fn: string; actor: Actor }
  | { kind: 'both'; fn: string; actor: Actor }
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
  submission_late_override: {
    kind: 'both',
    fn: 'gitRepoAssignment.setLateOverrideInClassroom',
    actor: 'serviceActor',
  },
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
  // A quiz attempt: regradeRequest.createForQuizAttempt writes the
  // REGRADE_REQUEST row for the caller; a submission: the request_regrade run
  // (regradeRequest.create) writes it for the serviceActor in its payload.
  regrade_create: { kind: 'service', fn: 'regradeRequest.createForQuizAttempt', actor: 'own' },
  // ── tokens: the token service writes the row for the actor ──
  token_grant: { kind: 'service', fn: 'token.grantTokens', actor: 'serviceActor' },
  // A submission: token.purchaseExtensionHours; a quiz: the same row from
  // token.purchaseQuizExtensionHours (pinned by extensions.test.ts).
  extension_purchase: {
    kind: 'service',
    fn: 'token.purchaseExtensionHours',
    actor: 'serviceActor',
  },
  // ── people: the shared service writes the row for the actor ──
  staff_add: { kind: 'service', fn: 'staff.addStaff', actor: 'serviceActor' },
  staff_update: { kind: 'service', fn: 'staff.updateStaff', actor: 'serviceActor' },
  // staff.recordStaffRemoval writes the removal's row (with the follow-up
  // markers only this tool's rows carry), staff.recordLeftoverSettled the
  // follow-up's; the grader moves are recorded by settleUngradedSlots.
  staff_remove: { kind: 'service', fn: 'staff.recordStaffRemoval', actor: 'serviceActor' },
  roster_add_student: { kind: 'service', fn: 'roster.addStudents', actor: 'serviceActor' },
  // The tool records the request; the remove_user_from_organization run
  // records the completed removal (classroomMembership.remove) for the actor
  // the payload carries.
  roster_remove_student: { kind: 'both', fn: 'buildRemoveUserPayload', actor: 'serviceActor' },
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
  repo_contributions_calculate: TOOL,
  repo_publish: TOOL,
  repo_sync: TOOL,
  repo_unpublish: TOOL,
  repo_create: TOOL,
  repo_update: TOOL,
  repo_delete: TOOL,
  resource_link_add: TOOL,
  resource_link_remove: TOOL,
  classroom_settings_update: TOOL,
  org_repo_settings_update: TOOL,
  slide_create: TOOL,
  slide_update: TOOL,
  slide_delete: TOOL,
  team_create: TOOL,
  team_delete: TOOL,
  team_rename: TOOL,
  team_members_add: TOOL,
  team_member_remove: TOOL,
  tag_create: TOOL,
  team_tag_add: TOOL,
  team_tag_remove: TOOL,
  // ── no row ──
  feedback_write: {
    kind: 'exempt',
    reason: 'the feedback board writes no audit rows, on the web or the MCP (decided for #739)',
  },
  feedback_delete: { kind: 'exempt', reason: 'the feedback board writes no audit rows (#739)' },
  page_cursor_set: { kind: 'exempt', reason: 'a live cursor is presence only: nothing is stored' },
  deck_cursor_set: { kind: 'exempt', reason: 'a live cursor is presence only: nothing is stored' },
};

/** Words after which a `/` starts a regular expression, not a division. */
const REGEX_AFTER = new Set([
  'return',
  'typeof',
  'instanceof',
  'case',
  'in',
  'of',
  'delete',
  'void',
  'throw',
  'new',
  'await',
  'yield',
  'else',
  'do',
]);

/**
 * `source` with its `//` and `/* *\/` comments removed. Strings, template
 * literals (their `${}` parts read as code) and regular expressions are kept
 * as written; line breaks are kept, so line-anchored searches still work.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let depth = 0;
  /** For each open `${`, the brace depth it started at. */
  const templates: number[] = [];
  /** The last character of code written, ignoring white space. */
  let prev = '';
  /** The last word written, when `prev` ends one. */
  let word = '';
  const wordAt = /[A-Za-z_$][\w$]*/y;
  const n = source.length;

  /** Copy a template chunk from `i` (just past a backtick or a `}`) to its end. */
  const templateChunk = () => {
    while (i < n && source[i] !== '`') {
      if (source[i] === '\\') {
        out += source.slice(i, i + 2);
        i += 2;
      } else if (source[i] === '$' && source[i + 1] === '{') {
        out += '${';
        i += 2;
        templates.push(depth);
        prev = '{';
        word = '';
        return;
      } else {
        out += source[i++];
      }
    }
    out += source[i++] ?? '';
    prev = '`';
    word = '';
  };

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      out += ` ${source.slice(i, end).replace(/[^\n]/g, '')}`;
      i = end;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
      prev = c;
      word = '';
    } else if (c === '`') {
      out += c;
      i++;
      templateChunk();
    } else if (c === '}' && templates.length > 0 && templates.at(-1) === depth) {
      templates.pop();
      out += c;
      i++;
      templateChunk();
    } else if (
      c === '/' &&
      (prev === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || REGEX_AFTER.has(word))
    ) {
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== '\n') {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(source[j])) j++;
      out += source.slice(i, j);
      i = j;
      prev = 'a';
      word = '';
    } else if (/[A-Za-z_$]/.test(c)) {
      wordAt.lastIndex = i;
      word = wordAt.exec(source)?.[0] ?? c;
      out += word;
      i += word.length;
      prev = 'a';
    } else {
      if (c === '{') depth++;
      else if (c === '}') depth--;
      out += c;
      i++;
      if (!/\s/.test(c)) {
        prev = c;
        word = '';
      }
    }
  }
  return out;
}

const TOOLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools');
const SOURCES = readdirSync(TOOLS_DIR)
  .filter(file => file.endsWith('.ts'))
  .map(file => stripComments(readFileSync(path.join(TOOLS_DIR, file), 'utf8')));

/** The source of the tools file that defines the tool named `tool`. */
function sourceOf(tool: string): string {
  const matches = SOURCES.filter(source => source.includes(`name: '${tool}',`));
  if (matches.length !== 1) throw new Error(`${tool}: defined in ${matches.length} files`);
  return matches[0];
}

/** The text of the top-level function or const named `name` in `source`. */
function bodyOf(source: string, name: string): string | null {
  const start = new RegExp(
    `\\n(?:export )?(?:async )?(?:function ${name}\\b|const ${name}\\s*[=:])`
  );
  const match = start.exec(source);
  if (!match) return null;
  const rest = source.slice(match.index + 1);
  const end = rest.search(/\n\};?\n/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The handler's source with the bodies of the functions of its own file that
 * it calls, two levels down, comments left out.
 */
function reachableSource(def: ToolDefinition<never>): string {
  const file = sourceOf(def.name);
  let text = stripComments(def.handler.toString());
  const seen = new Set<string>();
  for (let depth = 0; depth < 2; depth++) {
    const called = [...text.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map(m => m[1]);
    for (const name of called) {
      if (seen.has(name)) continue;
      seen.add(name);
      const body = bodyOf(file, name);
      if (body) text += `\n${body}`;
    }
  }
  return text;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A call of `name` as written: `object.fn(` for a member (preceded by nothing
 * that would make it part of a longer name), or a bare `fn(`, also as the test
 * transform rewrites an imported one (`(0, __import__.fn)(…)`).
 */
const calls = (source: string, name: string) =>
  name.includes('.')
    ? new RegExp(`(?<![\\w$])${escape(name)}\\s*\\(`).test(source)
    : new RegExp(`(?<![\\w$])${escape(name)}\\)?\\s*\\(`).test(source);
const writesItsOwnRow = (source: string) =>
  calls(source, 'writeAudit') || calls(source, 'writeAuditOrFail');

let writes: ToolDefinition<never>[];

beforeAll(async () => {
  const { registerAllTools } = await import('../../tools/index.ts');
  const { listToolDefinitions } = await import('../registry.ts');
  registerAllTools();
  writes = listToolDefinitions().filter(def => def.scope === 'write');
}, 60_000);

describe('the source check', () => {
  it('leaves comments out and keeps strings, templates and regular expressions', () => {
    const source = [
      'const url = "https://example.test/a"; // writeAudit(ctx)',
      '/* HelperService.addGradeToGitRepoAssignment(x) */ const re = /a\\/\\/b/g;',
      'const t = `x ${y /* writeAudit( */} // not a comment`;',
      'call(a / b); // writeAuditOrFail(',
    ].join('\n');
    const stripped = stripComments(source);
    expect(stripped).toContain('"https://example.test/a"');
    expect(stripped).toContain('/a\\/\\/b/g');
    expect(stripped).toContain('// not a comment`');
    expect(stripped).toContain('call(a / b);');
    expect(stripped.split('\n')).toHaveLength(4);
    expect(calls(stripped, 'writeAudit')).toBe(false);
    expect(calls(stripped, 'writeAuditOrFail')).toBe(false);
    expect(calls(stripped, 'HelperService.addGradeToGitRepoAssignment')).toBe(false);
  });

  it('matches the whole call: the object, the function and nothing longer', () => {
    const source = 'await __vi_import_0__.ClassmojiService.quizAttempt.adjust({ id });';
    expect(calls(source, 'quizAttempt.adjust')).toBe(true);
    expect(calls(source, 'attempt.adjust')).toBe(false);
    expect(calls(source, 'quizAttempt.adjus')).toBe(false);
    expect(calls(source, 'regradeRequest.adjust')).toBe(false);
    expect(calls('(0, __vi_import_1__.writeAudit)(ctx, row)', 'writeAudit')).toBe(true);
    expect(calls('rewriteAudit(ctx)', 'writeAudit')).toBe(false);
  });
});

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
    for (const def of writes) {
      const entry = WRITES[def.name];
      const source = reachableSource(def);
      const name = def.name;
      if (entry.kind === 'tool') {
        check(writesItsOwnRow(source), `${name}: should call writeAudit`);
      } else if (entry.kind === 'service' || entry.kind === 'both') {
        check(calls(source, entry.fn), `${name}: should call ${entry.fn}`);
        if (entry.actor === 'serviceActor') {
          check(calls(source, 'serviceActor'), `${name}: should pass serviceActor(...)`);
        }
        if (entry.kind === 'both') {
          check(writesItsOwnRow(source), `${name}: should write its other mode's row`);
        } else {
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
