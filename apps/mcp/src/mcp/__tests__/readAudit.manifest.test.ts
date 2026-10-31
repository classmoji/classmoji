/**
 * Every read tool and every resource is classified for the read audit.
 *
 * Registry-driven, like submissionIds.registry.test.ts: the whole manifest is
 * registered and each `scope: 'read'` tool and each resource must appear in
 * READS below, and its `auditRead` declaration must match its entry. A new
 * read without an entry fails here, so whoever adds it decides whether it
 * returns other people's data.
 *
 *   audited  — returns other people's data on every call: `auditRead`, no `when`
 *   staff    — role-dependent: `auditRead` with a `when` (staff branch only)
 *   handler  — writes its own VIEW rows in the handler: no `auditRead`
 *   none     — course content or the caller's own data: no `auditRead`
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClassroomContext } from '../../authz/classroomContext.ts';
import type { ResourceDefinition, ToolDefinition } from '../registry.ts';

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

type Kind = 'audited' | 'staff' | 'handler' | 'none';

const READS: Record<string, Kind> = {
  // ── tools ──
  whoami: 'none', // the caller's identity
  billing_status: 'none', // the caller's own plan
  feedback_read: 'none', // the public feedback board (no classroom)
  my_classrooms: 'none', // the caller's memberships
  get_classroom_info: 'none', // classroom settings
  get_roster: 'audited', // every student, with contact fields for the owner
  list_teams: 'staff', // staff: every team and its members; a student: their own teams
  list_tags: 'none', // tag names and counts
  list_repos: 'none', // staff: definitions only; a student: their own submissions
  my_grades: 'none', // the caller's own grades
  list_submissions: 'audited', // every student's submissions and grades
  get_submission: 'audited', // one student's submission, grades, analytics
  get_leaderboard: 'audited', // every student's computed grade
  list_regrade_requests: 'audited', // students' regrade requests and comments
  my_regrade_requests: 'none', // the caller's own requests
  list_teaching_team: 'none', // the staff directory (the web staff list is not audited)
  grading_report: 'audited', // each TA's grading of students' work
  list_quizzes: 'none', // quiz configuration; class-wide counts and averages only
  list_quiz_attempts: 'handler', // every student's attempts on a quiz (QUIZ_DETAILS VIEW)
  get_quiz_attempt: 'handler', // one student's attempt and transcript (QUIZ_ATTEMPT VIEW)
  list_pages: 'none', // course content
  list_modules: 'none', // course content (a student: their own items)
  list_calendar: 'none', // course calendar
  list_calendar_range: 'none', // course calendar
  my_tokens: 'none', // the caller's own token balance
  page_content_outline: 'none', // course content
  page_content_get: 'none', // course content
  page_render: 'none', // course content
  media_list: 'none', // the class's media files (no uploader)
  file_upload_status: 'none', // the caller's own upload
  list_slides: 'none', // course content
  deck_outline: 'none', // course content
  deck_get: 'none', // course content
  deck_render: 'none', // course content
  content_search: 'none', // course content
  content_list: 'none', // course content
  content_get: 'none', // course content
  page_sections_status: 'handler', // VIEW row as the caller's accepted role
  page_comments_list: 'none', // the page's shared discussion every member sees, not a staff view of student activity (plan D8)
  resource_links_list: 'none', // course links
  list_forms: 'none', // form definitions and response counts
  form_get: 'none', // a form's definition and revisions
  list_form_responses: 'handler', // VIEW row with filters and identity disclosure
  form_response_get: 'handler', // VIEW row per response revealed
  form_teams_get: 'handler', // VIEW row when people's placements are read
  ask_moji_usage: 'audited', // students' Ask Moji activity, per week and per material
  ask_moji_feedback_list: 'audited', // other people's rated questions
  ask_moji_exchange_get: 'audited', // one person's question and answer
  ask_moji_settings_get: 'none', // the owner's own Ask Moji configuration (OWNER only)
  // ── resources ──
  me: 'none',
  'classroom-info': 'none',
  roster: 'audited',
  teams: 'staff',
  repos: 'none',
  'grades-mine': 'none',
  leaderboard: 'audited',
  'grading-queue': 'audited',
  submission: 'audited',
  'regrade-requests': 'audited',
  'regrade-requests-mine': 'none',
  quizzes: 'none',
  pages: 'none',
  modules: 'none',
  calendar: 'none',
  'calendar-range': 'none',
  tokens: 'none',
};

let reads: Array<ToolDefinition<never> | ResourceDefinition>;

beforeAll(async () => {
  const { registerAllTools } = await import('../../tools/index.ts');
  const { registerAllResources } = await import('../../resources/index.ts');
  const { listResourceDefinitions, listToolDefinitions } = await import('../registry.ts');
  registerAllTools();
  registerAllResources();
  reads = [
    ...listToolDefinitions().filter(def => def.scope === 'read'),
    ...listResourceDefinitions(),
  ];
}, 60_000);

const asClassroom = (role: ClassroomContext['role']) => ({ role }) as ClassroomContext;
/** The classroom an `ids` call is handed (the one the registry resolved). */
const CLASSROOM = { classroomId: 'class-1', role: 'OWNER' } as ClassroomContext;

describe('read audit manifest', () => {
  it('classifies every read tool and resource, and nothing that is not registered', () => {
    const names = reads.map(def => def.name).sort();
    expect(names).toEqual(Object.keys(READS).sort());
  });

  it("each read's auditRead matches its classification", () => {
    for (const def of reads) {
      const kind = READS[def.name];
      const audit = def.auditRead;
      if (kind === 'audited') {
        expect(audit, `${def.name} should declare auditRead`).toBeDefined();
        expect(audit?.when, `${def.name} audits every call`).toBeUndefined();
      } else if (kind === 'staff') {
        expect(audit?.when, `${def.name} should audit its staff branch`).toBeTypeOf('function');
        for (const role of ['OWNER', 'TEACHER', 'ASSISTANT'] as const) {
          expect(audit?.when?.(asClassroom(role)), `${def.name} as ${role}`).toBe(true);
        }
        expect(audit?.when?.(asClassroom('STUDENT')), `${def.name} as STUDENT`).toBe(false);
      } else {
        expect(audit, `${def.name} should not declare auditRead`).toBeUndefined();
      }
    }
  });

  it('mirror tools record the same ids as their resources', () => {
    const byName = new Map(reads.map(def => [def.name, def]));
    const tool = byName.get('get_submission');
    const resource = byName.get('submission');
    expect(tool?.auditRead?.resourceType).toBe(resource?.auditRead?.resourceType);
    expect(
      tool?.auditRead?.ids?.({ classroom: 'o/s', submission_id: '5482151816' }, CLASSROOM)
    ).toEqual({
      resourceId: '5482151816',
    });
    expect(
      resource?.auditRead?.ids?.({ org: 'o', slug: 's', submissionId: '5482151816' }, CLASSROOM)
    ).toEqual({ resourceId: '5482151816' });
  });

  it('list filters record only the id arguments', () => {
    const byName = new Map(reads.map(def => [def.name, def]));
    expect(
      byName.get('list_submissions')?.auditRead?.ids?.(
        {
          classroom: 'o/s',
          assignment_id: 'a-1',
          status: 'OPEN',
          limit: 10,
        },
        CLASSROOM
      )
    ).toEqual({ data: { assignment_id: 'a-1' } });
    expect(
      byName
        .get('grading_report')
        ?.auditRead?.ids?.({ classroom: 'o/s', grader_id: 'g-1' }, CLASSROOM)
    ).toEqual({ data: { grader_id: 'g-1' } });
  });

  it('Ask Moji reads match the web rows: the classroom or the feedback id, the rating, never since or a limit', () => {
    const byName = new Map(reads.map(def => [def.name, def]));
    expect(
      byName.get('ask_moji_feedback_list')?.auditRead?.ids?.(
        {
          classroom: 'o/s',
          rating: 'DOWN',
          since: '2026-10-01T00:00:00Z',
          limit: 10,
        },
        CLASSROOM
      )
    ).toEqual({ resourceId: 'class-1', data: { rating: 'DOWN' } });
    expect(
      byName.get('ask_moji_feedback_list')?.auditRead?.ids?.(
        {
          classroom: 'o/s',
          since: '2026-10-01T00:00:00Z',
        },
        CLASSROOM
      )
    ).toEqual({ resourceId: 'class-1', data: {} });
    expect(
      byName
        .get('ask_moji_exchange_get')
        ?.auditRead?.ids?.({ classroom: 'o/s', feedback_id: 'f-1' }, CLASSROOM)
    ).toEqual({ resourceId: 'f-1' });
    expect(
      byName.get('ask_moji_usage')?.auditRead?.ids?.({ classroom: 'o/s', weeks: 4 }, CLASSROOM)
    ).toEqual({ resourceId: 'class-1', data: { weeks: 4 } });
    expect(byName.get('ask_moji_usage')?.auditRead?.ids?.({ classroom: 'o/s' }, CLASSROOM)).toEqual(
      { resourceId: 'class-1', data: { weeks: 12 } }
    );
    expect(
      ['ask_moji_usage', 'ask_moji_feedback_list', 'ask_moji_exchange_get'].map(
        name => byName.get(name)?.auditRead?.resourceType
      )
    ).toEqual(['ASK_MOJI_INSIGHTS', 'ASK_MOJI_FEEDBACK', 'ASK_MOJI_FEEDBACK']);
  });
});
