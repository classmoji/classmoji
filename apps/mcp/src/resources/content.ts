/**
 * Curriculum-content read surfaces:
 *   pages           — any member. There is no student-facing "list pages" web
 *                     loader; students only ever see the nav menu
 *                     (page.findForStudentMenu: is_draft=false +
 *                     show_in_student_menu). Staff pages listing
 *                     (admin.$class.pages) is OWNER+TEACHER and returns every
 *                     page. Mirrored: OWNER/TEACHER → full list;
 *                     ASSISTANT/STUDENT → student-menu list; students get
 *                     {enabled:false} when show_pages=false (nav parity).
 *   modules         — any member (mirrors student.$class.modules, which the
 *                     assistant route re-exports): show_modules=false →
 *                     {enabled:false}; staff see unpublished, students see
 *                     published modules with published items only.
 *   quizzes         — roles OWNER/ASSISTANT/STUDENT (TEACHER is genuinely
 *                     excluded by both quiz routes). Gate order mirrors the
 *                     routes: role check → Pro-tier → quizzes_enabled. NOTE:
 *                     the plan table lists isAIAgentConfigured() as a third
 *                     gate, but neither quiz LIST loader checks it (it only
 *                     gates the attempt/action flow + nav) — route wins, so
 *                     the list resource does not check it. Students get the
 *                     student route's field allowlist (no
 *                     system_prompt/rubric_prompt); staff get the admin one.
 *   calendar        — any member; calendar.getClassroomCalendar already
 *                     expands recurrence and merges assignment deadlines. The
 *                     parameterless URI covers the current UTC month (web
 *                     default); …/calendar/{start}/{end} takes ISO dates.
 */

import { ClassmojiService } from '@classmoji/services';
import { ToolError } from '../mcp/errors.ts';
import type { ResourceDefinition, ToolContext } from '../mcp/registry.ts';
import { MEMBER, QUIZ_ROLES, classroomCtx, isStaff, sanitizedSettings } from './shape.ts';

// ─── pages ───────────────────────────────────────────────────────────────────

interface PageRow {
  id: string;
  title: string;
  slug?: string | null;
  is_draft?: boolean;
  is_public?: boolean;
  show_in_student_menu?: boolean;
  menu_order?: number | null;
  created_at?: Date;
  updated_at?: Date;
}

export const pagesResource: ResourceDefinition = {
  name: 'pages',
  uriTemplate: 'classmoji://{org}/{slug}/pages',
  title: 'Pages',
  description:
    'Course pages. OWNER/TEACHER see every page incl. drafts; assistants and students see the ' +
    'published student-menu list, as the web app does.',
  scope: 'read',
  roles: MEMBER,
  handler: async (_vars, ctx) => {
    const { classroomId, role } = classroomCtx(ctx);

    // Full listing mirrors admin.$class.pages: OWNER + TEACHER (ASSISTANT excluded).
    if (role === 'OWNER' || role === 'TEACHER') {
      const pages = (await ClassmojiService.page.findByClassroomId(classroomId)) as PageRow[];
      return {
        enabled: true,
        pages: pages.map(p => ({
          id: p.id,
          title: p.title,
          slug: p.slug ?? null,
          is_draft: p.is_draft ?? false,
          is_public: p.is_public ?? false,
          show_in_student_menu: p.show_in_student_menu ?? false,
          menu_order: p.menu_order ?? null,
          updated_at: p.updated_at ?? null,
        })),
      };
    }

    if (role === 'STUDENT' && sanitizedSettings(ctx).show_pages === false) {
      return { enabled: false, pages: [] };
    }
    // Students + assistants: the published student-menu list (id/title/menu_order).
    const pages = (await ClassmojiService.page.findForStudentMenu(classroomId)) as PageRow[];
    return {
      enabled: true,
      pages: pages.map(p => ({ id: p.id, title: p.title, menu_order: p.menu_order ?? null })),
    };
  },
};

// ─── modules ─────────────────────────────────────────────────────────────────

interface ModuleItemRow {
  id: string;
  item_type: string;
  position: number;
  page?: { id: string; title?: string | null; is_draft?: boolean } | null;
  slide?: { id: string; title?: string | null; is_draft?: boolean } | null;
  quiz?: { id: string; name?: string | null; status?: string } | null;
  repository?: { id: string; title?: string | null; is_published?: boolean } | null;
}

interface ModuleRow {
  id: string;
  classroom_id: string;
  title: string;
  slug?: string | null;
  description?: string | null;
  position: number;
  is_published: boolean;
  items: ModuleItemRow[];
}

function moduleItemSummary(item: ModuleItemRow) {
  const target = item.page ?? item.slide ?? item.quiz ?? item.repository ?? null;
  const title =
    item.page?.title ?? item.slide?.title ?? item.quiz?.name ?? item.repository?.title ?? null;
  return {
    id: item.id,
    type: item.item_type,
    position: item.position,
    target_id: target?.id ?? null,
    title,
  };
}

export const modulesResource: ResourceDefinition = {
  name: 'modules',
  uriTemplate: 'classmoji://{org}/{slug}/modules',
  title: 'Modules (curriculum lists)',
  description:
    'Ordered curriculum modules with their content items (pages, repos, quizzes, slides). ' +
    'Students see published modules/items only; staff also see unpublished. Returns ' +
    '{enabled:false} when the classroom hides modules (show_modules).',
  scope: 'read',
  roles: MEMBER,
  handler: async (vars, ctx) => {
    const { classroomId, role } = classroomCtx(ctx);
    // The web route returns {enabled:false} for every role when the flag is off.
    if (sanitizedSettings(ctx).show_modules === false) {
      return { enabled: false, modules: [] };
    }

    const modules = (await ClassmojiService.module.listForClassroom(vars.slug, {
      includeUnpublished: isStaff(role),
    })) as ModuleRow[];

    // listForClassroom resolves by BARE slug (unique per git org only). Guard:
    // if the slug resolved to a different classroom, refuse rather than serve
    // another classroom's modules (S1).
    if (modules.some(m => m.classroom_id !== classroomId)) {
      throw new ToolError(
        'internal',
        `Classroom slug '${vars.slug}' is ambiguous across git orgs — modules unavailable for this classroom`
      );
    }

    return {
      enabled: true,
      modules: modules.map(m => ({
        id: m.id,
        title: m.title,
        slug: m.slug ?? null,
        description: m.description ?? null,
        position: m.position,
        ...(isStaff(role) ? { is_published: m.is_published } : {}),
        items: m.items.map(moduleItemSummary),
      })),
    };
  },
};

// ─── quizzes ─────────────────────────────────────────────────────────────────

interface QuizRow {
  id: string;
  name: string;
  status: string;
  due_date?: Date | null;
  weight: number;
  question_count: number;
  max_attempts: number;
  grading_strategy: string;
  include_code_context: boolean;
  repository_id?: string | null;
  system_prompt?: string | null;
  rubric_prompt?: string;
  subject?: string | null;
  difficulty_level?: string | null;
  attemptsCount?: number;
  avgScore?: number | null;
  attemptsSummary?: unknown;
  attemptCount?: number;
}

/** Mirror of the webapp's assertProTier (apps/webapp/app/utils/helpers.ts). */
async function assertProTier(classroomSlug: string, classroomId: string): Promise<void> {
  // subscription.getByClassroom resolves by BARE slug (unique per git org
  // only). Guard as the leaderboard/modules resources do: if the bare slug
  // resolves to a different classroom than the one the caller was authorized
  // for, refuse rather than gate quiz access on a twin classroom's Pro
  // subscription (S1 — Pro-gating bypass).
  const bySlug = await ClassmojiService.classroom.findBySlug(classroomSlug);
  if (!bySlug || bySlug.id !== classroomId) {
    throw new ToolError(
      'internal',
      `Classroom slug '${classroomSlug}' is ambiguous across git orgs — quizzes unavailable for this classroom`
    );
  }
  const subscription = await ClassmojiService.subscription.getByClassroom(classroomSlug);
  const isActive = subscription.ends_at ? new Date(subscription.ends_at) > new Date() : true;
  if (subscription.tier !== 'PRO' || !isActive) {
    throw new ToolError('forbidden', 'This feature requires a Pro subscription');
  }
}

export const quizzesResource: ResourceDefinition = {
  name: 'quizzes',
  uriTemplate: 'classmoji://{org}/{slug}/quizzes',
  title: 'Quizzes',
  description:
    'AI-graded quizzes. Staff (OWNER/ASSISTANT) see all quizzes incl. drafts and prompts; ' +
    'students see published quizzes with their own attempt summary. Requires a Pro ' +
    'subscription and quizzes_enabled. (TEACHER is excluded, matching the web routes.)',
  scope: 'read',
  roles: QUIZ_ROLES,
  handler: async (vars, ctx) => {
    const { classroomId, role, membership } = classroomCtx(ctx);

    // Gate order mirrors the routes: access (done) → Pro tier → quizzes_enabled.
    await assertProTier(vars.slug, classroomId);
    if (sanitizedSettings(ctx).quizzes_enabled === false) {
      throw new ToolError('forbidden', 'Quizzes are currently disabled for this classroom');
    }

    const base = (q: QuizRow) => ({
      id: q.id,
      name: q.name,
      status: q.status,
      due_date: q.due_date ?? null,
      weight: q.weight,
      question_count: q.question_count,
      max_attempts: q.max_attempts,
      grading_strategy: q.grading_strategy,
      include_code_context: q.include_code_context,
      repository_id: q.repository_id ?? null,
    });

    if (role === 'STUDENT') {
      const quizzes = (await ClassmojiService.quiz.getQuizzesForStudent(
        classroomId,
        ctx.viewer.userId,
        membership as never
      )) as QuizRow[];
      // Student allowlist (mirrors the student route's .map): NO system_prompt,
      // rubric_prompt, subject, difficulty_level, or class-wide stats.
      return {
        quizzes: quizzes.map(q => ({
          ...base(q),
          my_attempts: q.attemptsSummary ?? null,
        })),
      };
    }

    const quizzes = (await ClassmojiService.quiz.findByClassroom(
      classroomId,
      membership as never
    )) as QuizRow[];
    return {
      quizzes: quizzes.map(q => ({
        ...base(q),
        subject: q.subject ?? null,
        difficulty_level: q.difficulty_level ?? null,
        system_prompt: q.system_prompt ?? null,
        rubric_prompt: q.rubric_prompt ?? null,
        attempts_count: q.attemptsCount ?? 0,
        avg_score: q.avgScore ?? null,
      })),
    };
  },
};

// ─── calendar ────────────────────────────────────────────────────────────────

interface CalendarLinkedPage {
  page?: { id: string; title?: string | null; is_draft?: boolean } | null;
}
interface CalendarLinkedSlide {
  slide?: { id: string; title?: string | null; is_draft?: boolean } | null;
}
interface CalendarLinkedAssignment {
  assignment?: { id: string; title?: string | null; slug?: string | null } | null;
  repository?: { id: string; title?: string | null; slug?: string | null } | null;
}

/** Union row shape: expanded CalendarEvents + synthesized deadline items. */
interface CalendarRow {
  id: string;
  event_type: string;
  title: string;
  description?: string | null;
  start_time: Date | string;
  end_time: Date | string;
  location?: string | null;
  meeting_link?: string | null;
  is_recurring?: boolean;
  recurrence_rule?: unknown;
  occurrence_date?: Date | string;
  creator?: { id: string; name?: string | null; login?: string | null } | null;
  is_deadline?: boolean;
  is_unpublished?: boolean;
  assignment_id?: string;
  repository_id?: string;
  github_issue_url?: string | null;
  pages?: CalendarLinkedPage[];
  slides?: CalendarLinkedSlide[];
  assignments?: CalendarLinkedAssignment[];
}

/**
 * Allowlist shaping for calendar rows. getClassroomCalendar returns raw
 * service rows whose `...event` spread carries the UNFILTERED
 * pageLinks/slideLinks/assignmentLinks include — draft/unpublished page and
 * slide titles a student must never see — plus overrides and other edit-UI
 * internals the web never renders. Emit only what the web calendar actually
 * shows: the event's own fields and the display-mapped linked content (which
 * the service already draft-filters for events); drafts are additionally
 * stripped for non-staff wherever the flag rides along.
 */
function shapeCalendarRow(row: CalendarRow, staff: boolean) {
  const pages = (row.pages ?? [])
    .map(l => l.page)
    .filter((p): p is NonNullable<CalendarLinkedPage['page']> =>
      Boolean(p && (staff || p.is_draft !== true))
    )
    .map(p => ({ id: p.id, title: p.title ?? null }));
  const slides = (row.slides ?? [])
    .map(l => l.slide)
    .filter((s): s is NonNullable<CalendarLinkedSlide['slide']> =>
      Boolean(s && (staff || s.is_draft !== true))
    )
    .map(s => ({ id: s.id, title: s.title ?? null }));
  const assignments = (row.assignments ?? []).flatMap(l =>
    l.assignment
      ? [
          {
            assignment: {
              id: l.assignment.id,
              title: l.assignment.title ?? null,
              slug: l.assignment.slug ?? null,
            },
            repository: l.repository
              ? {
                  id: l.repository.id,
                  title: l.repository.title ?? null,
                  slug: l.repository.slug ?? null,
                }
              : null,
          },
        ]
      : []
  );

  return {
    id: row.id,
    event_type: row.event_type,
    title: row.title,
    description: row.description ?? null,
    start_time: row.start_time,
    end_time: row.end_time,
    location: row.location ?? null,
    meeting_link: row.meeting_link ?? null,
    is_recurring: row.is_recurring ?? false,
    recurrence_rule: row.recurrence_rule ?? null,
    occurrence_date: row.occurrence_date ?? null,
    creator: row.creator
      ? { id: row.creator.id, name: row.creator.name ?? null, login: row.creator.login ?? null }
      : null,
    ...(row.is_deadline
      ? {
          is_deadline: true,
          assignment_id: row.assignment_id ?? null,
          repository_id: row.repository_id ?? null,
          github_issue_url: row.github_issue_url ?? null,
          ...(staff ? { is_unpublished: row.is_unpublished ?? false } : {}),
        }
      : {}),
    pages,
    slides,
    assignments,
  };
}

/** Current UTC month expanded to grid-week boundaries ±1 day (web default). */
function defaultCalendarRange(): { start: Date; end: Date } {
  const now = new Date();
  const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const start = new Date(firstOfMonth);
  start.setUTCDate(start.getUTCDate() - firstOfMonth.getUTCDay() - 1);
  const end = new Date(lastOfMonth);
  end.setUTCDate(end.getUTCDate() + (6 - lastOfMonth.getUTCDay()) + 1);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}

async function loadCalendar(ctx: ToolContext, start: Date, end: Date) {
  const { classroomId, role } = classroomCtx(ctx);
  const staff = isStaff(role);
  // Mirrors the routes: students get published-only deadlines scoped to
  // themselves; staff see unpublished too (raw link objects are edit-UI
  // concerns and stay off).
  const events = (await ClassmojiService.calendar.getClassroomCalendar(
    classroomId,
    start,
    end,
    staff ? null : ctx.viewer.userId,
    false,
    staff
  )) as CalendarRow[];
  return {
    range: { start: start.toISOString(), end: end.toISOString() },
    count: events.length,
    events: events.map(e => shapeCalendarRow(e, staff)),
  };
}

export const calendarResource: ResourceDefinition = {
  name: 'calendar',
  uriTemplate: 'classmoji://{org}/{slug}/calendar',
  title: 'Calendar (current month)',
  description:
    'Calendar events for the current month — recurring events expanded, assignment deadlines ' +
    'merged in. Use …/calendar/{start}/{end} (ISO dates) for another range.',
  scope: 'read',
  roles: MEMBER,
  handler: async (_vars, ctx) => {
    const { start, end } = defaultCalendarRange();
    return loadCalendar(ctx, start, end);
  },
};

export const calendarRangeResource: ResourceDefinition = {
  name: 'calendar-range',
  uriTemplate: 'classmoji://{org}/{slug}/calendar/{start}/{end}',
  title: 'Calendar (date range)',
  description:
    'Calendar events for an explicit date range; {start} and {end} are ISO dates ' +
    '(e.g. 2026-07-01/2026-08-31). Recurring events expanded, deadlines merged.',
  scope: 'read',
  roles: MEMBER,
  handler: async (vars, ctx) => {
    const start = new Date(vars.start);
    const end = new Date(vars.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
      throw new ToolError(
        'invalid_params',
        'start/end must be ISO dates (YYYY-MM-DD) with start before end'
      );
    }
    end.setUTCHours(23, 59, 59, 999);
    return loadCalendar(ctx, start, end);
  },
};
