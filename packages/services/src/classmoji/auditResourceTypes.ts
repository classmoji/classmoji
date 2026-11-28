/**
 * The audit log's vocabulary for `audit_logs.resource_type`: every name the
 * product writes, in one list, so a new name is a deliberate addition here and
 * not a string a route made up. The audit service and every funnel (webapp,
 * MCP, pages, collab, the gates, services, tasks) take `AuditResourceType`.
 *
 * Where the web and the MCP once named the same thing differently, the MCP's
 * name is the one written now; the older names are kept in
 * `RETIRED_AUDIT_RESOURCE_TYPES`, because rows already written keep them. A
 * reader that matches on a resource type asks `auditResourceTypeNames` for
 * every name the thing has had, and a list that prints one uses
 * `auditResourceLabel`, so an old row and a new one read the same.
 *
 * No imports: types and helpers usable anywhere (browser bundles included),
 * by subpath `@classmoji/services/audit-resource-types` or, re-exported,
 * `@classmoji/services/audit`.
 */

export const AUDIT_RESOURCE_TYPES = [
  // ── Course content ──
  'ASSIGNMENT',
  'CALENDAR',
  'FORMS',
  'MEDIA',
  'MODULES',
  'MODULE_ITEM',
  'PAGES',
  'QUIZ',
  'REPOSITORIES',
  'RESOURCES',
  'SLIDES',
  'TAGS',
  'TEAMS',
  'TEAM_SETS',
  // ── Coursework and grading ──
  'GIT_REPO_ASSIGNMENT',
  'GIT_REPO_ASSIGNMENT_GRADER',
  'GRADES',
  'QUIZ_ATTEMPT',
  'QUIZ_CHAT_SESSION',
  'QUIZ_CHAT_SESSION_UNAUTHORIZED',
  'QUIZ_DETAILS',
  'QUIZ_LATE_WAIVER',
  'QUIZ_PREVIEW',
  'QUIZ_PREVIEW_ATTEMPTS',
  'REGRADE_REQUEST',
  'REPOSITORY',
  // ── People ──
  'CLASSROOM_MEMBERSHIP',
  'STAFF',
  'STUDENT_ROSTER',
  // ── Tokens ──
  'TOKEN_BALANCE',
  'TOKEN_GRANT',
  'TOKEN_HISTORY',
  'TOKEN_PURCHASE',
  'TOKEN_TRANSACTION',
  'TOKEN_TRANSACTIONS',
  // ── Classroom and its settings ──
  'CLASSROOM',
  'CLASSROOM_JOIN_LINK',
  'CLASSROOM_SUBSCRIPTION',
  'CONTENT_SETTINGS',
  'GIT_ORGANIZATION',
  'GITHUB_CLASSROOM_IMPORT',
  'GITHUB_PROJECTS',
  'GITHUB_REPOS',
  'IMPORT_JOB',
  'QUIZ_SETTINGS',
  'REPO_SETTINGS',
  'SETTINGS',
  'SITE_SETTINGS',
  // ── Ask Moji ──
  'ASK_MOJI',
  'ASK_MOJI_CONVERSATION',
  'ASK_MOJI_FEEDBACK',
  'ASK_MOJI_INSIGHTS',
  // ── Screens (a gate's refusal, or a VIEW of a whole screen) ──
  'ADMIN_NAMESPACE',
  'ADMIN_QUIZ_ACCESS',
  'ADMIN_QUIZ_ACTION',
  'ADMIN_QUIZ_FORM',
  'ASSISTANT_LAYOUT',
  'CLASS_GRADES_SCREEN',
  'DASHBOARD',
  'GRADING_QUEUE',
  'QUIZ_API_ACTION',
  'STAFF_DASHBOARD',
  'STUDENT_ASSIGNMENTS',
  'STUDENT_DASHBOARD',
  'STUDENT_GRADES_SCREEN',
  'STUDENT_QUIZ_ACCESS',
  'STUDENT_REPOSITORIES',
  'TEACHER_LAYOUT',
  // ── A gate's default when its caller names nothing ──
  'ADMIN_SETTINGS',
  'CLASSROOM_ACCESS',
  'CLASSROOM_RESOURCE',
  'STAFF_RESOURCE',
  'STUDENT_RESOURCE',
  'TEACHING_RESOURCE',
] as const;

/** A `resource_type` the product writes. */
export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];

/**
 * Names rows were written under before the vocabulary converged, and the name
 * each thing is written under now. Never written again; rows that carry them
 * stay as they are.
 */
export const RETIRED_AUDIT_RESOURCE_TYPES = {
  // The web's names for what the MCP calls ASSIGNMENT, MODULES, REGRADE_REQUEST, STAFF.
  ASSIGNMENTS: 'ASSIGNMENT',
  MODULE: 'MODULES',
  REGRADE_REQUESTS: 'REGRADE_REQUEST',
  TEACHING_STAFF: 'STAFF',
  TEACHING_STAFF_DETAILS: 'STAFF',
  // A submission (GitRepoAssignment), as the web's analytics gates named it.
  REPOSITORY_ASSIGNMENT: 'GIT_REPO_ASSIGNMENT',
  // A student's own team, as their team page's gate named it.
  TEAM: 'TEAMS',
  // A slide deck: the slide gate's and the slides app's gate's names.
  SLIDE: 'SLIDES',
  SLIDE_CONTENT: 'SLIDES',
  // Collab's refused joins, before they took the joins' own names.
  collab_page: 'PAGES',
  collab_deck: 'SLIDES',
} as const satisfies Record<string, AuditResourceType>;

/**
 * Rows of a name that is still written, for something now written under
 * another name, told apart by their `data.tool`: tags were written as TEAMS.
 */
const RETIRED_BY_TOOL: Partial<Record<AuditResourceType, Record<string, AuditResourceType>>> = {
  TEAMS: { tag_create: 'TAGS', 'web:settings.team.delete_tag': 'TAGS' },
};

/** Whether `value` is a name the product writes now. */
export const isAuditResourceType = (value: unknown): value is AuditResourceType =>
  typeof value === 'string' && (AUDIT_RESOURCE_TYPES as readonly string[]).includes(value);

/**
 * Every name rows about `type` carry: the name written now, then each retired
 * one. A reader matching on a resource type filters with `{ in: names }`.
 */
export const auditResourceTypeNames = (type: AuditResourceType): string[] => [
  type,
  ...Object.entries(RETIRED_AUDIT_RESOURCE_TYPES)
    .filter(([, current]) => current === type)
    .map(([retired]) => retired),
];

/**
 * The name a stored row's thing is written under now: a retired name maps to
 * its successor (by `tool` where the old name is still written for other
 * things); any other name is returned unchanged.
 */
export const currentAuditResourceType = (stored: string, tool?: string | null): string => {
  const byTool = tool ? RETIRED_BY_TOOL[stored as AuditResourceType]?.[tool] : undefined;
  if (byTool) return byTool;
  return (RETIRED_AUDIT_RESOURCE_TYPES as Record<string, string>)[stored] ?? stored;
};

/**
 * A row's resource type as a list prints it ("git repo assignment"): the name
 * it is written under now, lower case, underscores as spaces, so an old row
 * and a new one about the same thing read the same.
 */
export const auditResourceLabel = (stored: string, tool?: string | null): string =>
  currentAuditResourceType(stored, tool).replace(/_/g, ' ').toLowerCase();
