import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ClassmojiService } from '@classmoji/services';
import getPrisma from '@classmoji/database';
import type { AuthContext } from '../auth/context.ts';
import { hasAnyScope } from '../auth/scopes.ts';
import { isStaffInAny, isStudentInAny, isTeachingInAny } from '../auth/roles.ts';
import { getClassroom, jsonResource } from './_helpers.ts';

/**
 * Resource registration. URIs use the `classmoji://` scheme.
 *
 * Cross-classroom resources (no slug):
 *   classmoji://user/me
 *   classmoji://user/me/classrooms
 *   classmoji://user/me/deadlines
 *
 * Per-classroom resources (templates with {slug}):
 *   classmoji://{slug}                          — classroom info
 *   classmoji://{slug}/settings                 — sanitized settings
 *   classmoji://{slug}/modules                  — module list
 *   classmoji://{slug}/assignments              — assignment list
 *   classmoji://{slug}/assignments/upcoming     — upcoming deadlines
 *   classmoji://{slug}/calendar                 — events
 *   classmoji://{slug}/quizzes                  — quizzes (TEACHING_TEAM)
 *   classmoji://{slug}/pages                    — pages (students: non-draft)
 *   classmoji://{slug}/slides                   — slides (students: non-draft)
 *   classmoji://{slug}/teams                    — teams
 *   classmoji://{slug}/roster                   — memberships (TEACHING_TEAM)
 *   classmoji://{slug}/grades/my                — own grades (STUDENT)
 *   classmoji://{slug}/tokens/my                — own token balance + transactions
 *   classmoji://{slug}/regrade-requests/my      — own regrade requests (STUDENT)
 *   classmoji://{slug}/emoji-mappings           — emoji → score map
 *   classmoji://{slug}/letter-grade-mappings    — letter grade thresholds
 *   classmoji://{slug}/repositories/my          — own repositories (STUDENT)
 */
export function registerResources(server: McpServer, ctx: AuthContext): void {
  const prisma = getPrisma();
  const slugList = ctx.classroomSlugs;

  // ─── Cross-classroom ────────────────────────────────────────────────────
  // `user/me` and `user/me/classrooms` are the bootstrap resources Claude
  // clients fetch immediately after a session opens to ground the agent.
  // We register them whenever the token includes any identity scope —
  // `openid` is the OAuth standard for "this is who I am". Without an
  // identity scope, the token can't see anything here.
  if (hasAnyScope(ctx.scopes, ['openid', 'profile', 'email'])) {
    server.registerResource(
      'user/me',
      'classmoji://user/me',
      {
        title: 'Your Classmoji profile',
        description: 'Basic identity for the authenticated user.',
        mimeType: 'application/json',
      },
      async uri => {
        const user = await prisma.user.findUnique({
          where: { id: ctx.userId },
          select: { id: true, login: true, name: true, email: true, image: true },
        });
        return jsonResource(uri.href, { user });
      }
    );

    server.registerResource(
      'user/me/classrooms',
      'classmoji://user/me/classrooms',
      {
        title: 'Your classroom memberships',
        description: 'List of classrooms the user is in, with their role in each.',
        mimeType: 'application/json',
      },
      async uri => {
        const memberships = await prisma.classroomMembership.findMany({
          where: { user_id: ctx.userId, has_accepted_invite: true },
          include: { classroom: true },
        });
        return jsonResource(uri.href, {
          classrooms: memberships.map(m => ({
            slug: m.classroom.slug,
            name: m.classroom.name,
            role: m.role,
            term: m.classroom.term,
            year: m.classroom.year,
          })),
        });
      }
    );
  }

  server.registerResource(
    'user/me/deadlines',
    'classmoji://user/me/deadlines',
    {
      title: 'Upcoming deadlines across all classrooms',
      description: 'Aggregated upcoming assignment deadlines.',
      mimeType: 'application/json',
    },
    async uri => {
      if (!hasAnyScope(ctx.scopes, ['assignments:read'])) {
        return jsonResource(uri.href, { error: 'assignments:read scope required' });
      }
      const memberships = await prisma.classroomMembership.findMany({
        where: { user_id: ctx.userId, has_accepted_invite: true },
        include: { classroom: { select: { id: true, slug: true, name: true } } },
      });
      const seen = new Set<string>();
      const all: Array<Record<string, unknown>> = [];
      for (const m of memberships) {
        if (seen.has(m.classroom.id)) continue;
        seen.add(m.classroom.id);
        const upcoming = await ClassmojiService.assignment.findUpcoming(m.classroom.id);
        for (const a of upcoming.slice(0, 25)) {
          all.push({
            classroom_slug: m.classroom.slug,
            assignment_id: a.id,
            title: a.title,
            student_deadline: a.student_deadline?.toISOString() ?? '',
          });
        }
      }
      all.sort((a, b) => String(a.student_deadline).localeCompare(String(b.student_deadline)));
      return jsonResource(uri.href, { deadlines: all });
    }
  );

  if (slugList.length === 0) return; // nothing more to register

  // ─── Per-classroom templates ─────────────────────────────────────────────

  /**
   * Build a template + list callback that enumerates the user's classroom
   * slugs as the `{slug}` variable. This lets clients discover which
   * classrooms they can read each resource for.
   */
  const buildTemplate = (uriPattern: string) =>
    new ResourceTemplate(uriPattern, {
      list: async () => ({
        resources: slugList.map(slug => ({
          uri: uriPattern.replace('{slug}', slug),
          name: uriPattern.replace('{slug}', slug),
        })),
      }),
    });

  server.registerResource(
    'classroom-info',
    buildTemplate('classmoji://{slug}'),
    {
      title: 'Classroom info',
      description: 'Classroom metadata (name, term, year). Sanitized — no API keys.',
      mimeType: 'application/json',
    },
    async (uri, { slug }) => {
      const resolved = await getClassroom(ctx, String(slug));
      const full = await prisma.classroom.findUnique({
        where: { id: resolved.classroom.id },
        include: { settings: true },
      });
      const sanitized = ClassmojiService.classroom.getClassroomForUI(full);
      return jsonResource(uri.href, sanitized);
    }
  );

  server.registerResource(
    'classroom-settings',
    buildTemplate('classmoji://{slug}/settings'),
    {
      title: 'Classroom settings',
      description: 'Settings for the classroom (sanitized — strips API keys).',
      mimeType: 'application/json',
    },
    async (uri, { slug }) => {
      const resolved = await getClassroom(ctx, String(slug));
      const full = await prisma.classroom.findUnique({
        where: { id: resolved.classroom.id },
        include: { settings: true },
      });
      const sanitized = ClassmojiService.classroom.getClassroomForUI(full) as
        | { settings?: unknown }
        | null;
      return jsonResource(uri.href, { settings: sanitized?.settings });
    }
  );

  // ─── Modules / assignments (read scopes) ────────────────────────────────

  if (hasAnyScope(ctx.scopes, ['modules:read'])) {
    server.registerResource(
      'modules-list',
      buildTemplate('classmoji://{slug}/modules'),
      {
        title: 'Module list',
        description: 'Modules in the classroom. Students see published only.',
        mimeType: 'application/json',
      },
      async (uri, { slug }) => {
        const resolved = await getClassroom(ctx, String(slug));
        const modules = isTeachingInAny(resolved.roles)
          ? await ClassmojiService.module.findByClassroomId(resolved.classroom.id)
          : await ClassmojiService.module.findPublished(resolved.classroom.id);
        return jsonResource(uri.href, { modules });
      }
    );
  }

  if (hasAnyScope(ctx.scopes, ['assignments:read'])) {
    server.registerResource(
      'assignments-list',
      buildTemplate('classmoji://{slug}/assignments'),
      {
        title: 'Assignments',
        description: 'Assignments in the classroom. Students see published only.',
        mimeType: 'application/json',
      },
      async (uri, { slug }) => {
        const resolved = await getClassroom(ctx, String(slug));
        const isTT = isTeachingInAny(resolved.roles);
        const assignments = await prisma.assignment.findMany({
          where: {
            module: { classroom_id: resolved.classroom.id },
            ...(isTT ? {} : { is_published: true }),
          },
          include: { module: { select: { id: true, title: true } } },
          orderBy: { student_deadline: 'asc' },
        });
        return jsonResource(uri.href, { assignments });
      }
    );

    server.registerResource(
      'assignments-upcoming',
      buildTemplate('classmoji://{slug}/assignments/upcoming'),
      {
        title: 'Upcoming assignments',
        description: 'Assignments with future deadlines for this classroom.',
        mimeType: 'application/json',
      },
      async (uri, { slug }) => {
        const resolved = await getClassroom(ctx, String(slug));
        const upcoming = await ClassmojiService.assignment.findUpcoming(resolved.classroom.id);
        return jsonResource(uri.href, { upcoming });
      }
    );
  }

  // ─── Calendar ───────────────────────────────────────────────────────────

  if (hasAnyScope(ctx.scopes, ['calendar:read'])) {
    server.registerResource(
      'calendar-events',
      buildTemplate('classmoji://{slug}/calendar'),
      {
        title: 'Calendar events',
        description: 'Calendar events for the classroom.',
        mimeType: 'application/json',
      },
      async (uri, { slug }) => {
        const resolved = await getClassroom(ctx, String(slug));
        const events = await prisma.calendarEvent.findMany({
          where: { classroom_id: resolved.classroom.id },
          orderBy: { start_time: 'asc' },
          take: 200,
        });
        return jsonResource(uri.href, { events });
      }
    );
  }

  // ─── Quizzes (teaching team) ────────────────────────────────────────────

  if (hasAnyScope(ctx.scopes, ['quizzes:read']) && isTeachingInAny(ctx.roles)) {
    server.registerResource(
      'quizzes-list',
      buildTemplate('classmoji://{slug}/quizzes'),
      {
        title: 'Classroom quizzes',
        description: 'All quizzes in the classroom (teaching team).',
        mimeType: 'application/json',
      },
      async (uri, { slug }) => {
        const resolved = await getClassroom(ctx, String(slug));
        if (!isTeachingInAny(resolved.roles)) {
          return jsonResource(uri.href, { error: 'Teaching team role required' });
        }
        const quizzes = await prisma.quiz.findMany({
          where: { classroom_id: resolved.classroom.id },
          orderBy: { created_at: 'desc' },
        });
        return jsonResource(uri.href, { quizzes });
      }
    );
  }

  // ─── Content (pages + slides) ───────────────────────────────────────────

  if (hasAnyScope(ctx.scopes, ['content:read'])) {
    server.registerResource(
      'pages-list',
      buildTemplate('classmoji://{slug}/pages'),
      {
        title: 'Pages',
        description: 'Pages in the classroom. Students see non-draft only.',
        mimeType: 'application/json',
      },
      async (uri, { slug }) => {
        const resolved = await getClassroom(ctx, String(slug));
        const pages = await ClassmojiService.page.findByClassroomId(resolved.classroom.id, {
          ...(isTeachingInAny(resolved.roles) ? {} : { onlyPublished: true }),
        } as never);
        return jsonResource(uri.href, { pages });
      }
    );

    server.registerResource(
      'slides-list',
      buildTemplate('classmoji://{slug}/slides'),
      {
        title: 'Slide decks',
        description: 'Slide decks in the classroom. Students see non-draft only.',
        mimeType: 'application/json',
      },
      async (uri, { slug }) => {
        const resolved = await getClassroom(ctx, String(slug));
        const slides = await prisma.slide.findMany({
          where: {
            classroom_id: resolved.classroom.id,
            ...(isTeachingInAny(resolved.roles) ? {} : { is_draft: false }),
          },
          orderBy: { created_at: 'desc' },
        });
        return jsonResource(uri.href, { slides });
      }
    );
  }

  // ─── Teams ──────────────────────────────────────────────────────────────

  if (hasAnyScope(ctx.scopes, ['teams:read'])) {
    server.registerResource(
      'teams-list',
      buildTemplate('classmoji://{slug}/teams'),
      {
        title: 'Teams',
        description: 'Teams in the classroom.',
        mimeType: 'application/json',
      },
      async (uri, { slug }) => {
        const resolved = await getClassroom(ctx, String(slug));
        const teams = await ClassmojiService.team.findByClassroomId(resolved.classroom.id);
        return jsonResource(uri.href, { teams });
      }
    );
  }

  // ─── Roster (teaching team) ─────────────────────────────────────────────

  if (hasAnyScope(ctx.scopes, ['roster:read']) && isTeachingInAny(ctx.roles)) {
    server.registerResource(
      'roster-list',
      buildTemplate('classmoji://{slug}/roster'),
      {
        title: 'Roster',
        description: 'Full classroom membership list (teaching team only).',
        mimeType: 'application/json',
      },
      async (uri, { slug }) => {
        const resolved = await getClassroom(ctx, String(slug));
        if (!isTeachingInAny(resolved.roles)) {
          return jsonResource(uri.href, { error: 'Teaching team role required' });
        }
        const members = await ClassmojiService.classroomMembership.findByClassroomId(
          resolved.classroom.id
        );
        return jsonResource(uri.href, { members });
      }
    );
  }

  // ─── Grades — student's own ─────────────────────────────────────────────

  if (hasAnyScope(ctx.scopes, ['grades:read']) && isStudentInAny(ctx.roles)) {
    server.registerResource(
      'grades-my',
      buildTemplate('classmoji://{slug}/grades/my'),
      {
        title: 'Your grades',
        description: 'Your grades in the classroom.',
        mimeType: 'application/json',
      },
      async (uri, { slug }) => {
        const resolved = await getClassroom(ctx, String(slug));
        const repos = await prisma.repository.findMany({
          where: { classroom_id: resolved.classroom.id, student_id: ctx.userId },
          include: {
            assignments: { include: { grades: true, assignment: true } },
          } as never,
        });
        return jsonResource(uri.href, { repositories: repos });
      }
    );
  }

  // ─── Tokens — own balance ───────────────────────────────────────────────

  if (hasAnyScope(ctx.scopes, ['tokens:read'])) {
    server.registerResource(
      'tokens-my',
      buildTemplate('classmoji://{slug}/tokens/my'),
      {
        title: 'Your token balance + transactions',
        description: 'Your token balance and transaction history in this classroom.',
        mimeType: 'application/json',
      },
      async (uri, { slug }) => {
        const resolved = await getClassroom(ctx, String(slug));
        const balance = await ClassmojiService.token.getBalance(resolved.classroom.id, ctx.userId);
        const transactions = await ClassmojiService.token.findTransactions({
          classroom_id: resolved.classroom.id,
          student_id: ctx.userId,
        });
        return jsonResource(uri.href, { balance, transactions });
      }
    );
  }

  // ─── Regrade requests — own ─────────────────────────────────────────────

  if (hasAnyScope(ctx.scopes, ['regrade:read']) && isStudentInAny(ctx.roles)) {
    server.registerResource(
      'regrade-requests-my',
      buildTemplate('classmoji://{slug}/regrade-requests/my'),
      {
        title: 'Your regrade requests',
        description: 'Regrade requests you have submitted in this classroom.',
        mimeType: 'application/json',
      },
      async (uri, { slug }) => {
        const resolved = await getClassroom(ctx, String(slug));
        const requests = await ClassmojiService.regradeRequest.findMany({
          classroom_id: resolved.classroom.id,
          student_id: ctx.userId,
        });
        return jsonResource(uri.href, { requests });
      }
    );
  }

  // ─── Mappings ───────────────────────────────────────────────────────────

  if (hasAnyScope(ctx.scopes, ['settings:read', 'grades:read'])) {
    server.registerResource(
      'emoji-mappings',
      buildTemplate('classmoji://{slug}/emoji-mappings'),
      {
        title: 'Emoji → score mappings',
        description: 'Classroom emoji-to-score mappings used for grading.',
        mimeType: 'application/json',
      },
      async (uri, { slug }) => {
        const resolved = await getClassroom(ctx, String(slug));
        const mappings = await ClassmojiService.emojiMapping.findByClassroomId(
          resolved.classroom.id
        );
        return jsonResource(uri.href, { mappings });
      }
    );

    server.registerResource(
      'letter-grade-mappings',
      buildTemplate('classmoji://{slug}/letter-grade-mappings'),
      {
        title: 'Letter grade mappings',
        description: 'Letter grade thresholds for the classroom.',
        mimeType: 'application/json',
      },
      async (uri, { slug }) => {
        const resolved = await getClassroom(ctx, String(slug));
        const mappings = await ClassmojiService.letterGradeMapping.findByClassroomId(
          resolved.classroom.id
        );
        return jsonResource(uri.href, { mappings });
      }
    );
  }

  // ─── Repositories — own ─────────────────────────────────────────────────

  if (isStudentInAny(ctx.roles) && hasAnyScope(ctx.scopes, ['roster:read'])) {
    server.registerResource(
      'repositories-my',
      buildTemplate('classmoji://{slug}/repositories/my'),
      {
        title: 'Your repositories',
        description: 'Repositories the student owns in this classroom.',
        mimeType: 'application/json',
      },
      async (uri, { slug }) => {
        const resolved = await getClassroom(ctx, String(slug));
        const repos = await prisma.repository.findMany({
          where: { classroom_id: resolved.classroom.id, student_id: ctx.userId },
        });
        return jsonResource(uri.href, { repositories: repos });
      }
    );
  }

  // ─── Admin-only ─────────────────────────────────────────────────────────

  if (isStaffInAny(ctx.roles) && hasAnyScope(ctx.scopes, ['grades:read'])) {
    server.registerResource(
      'grades-leaderboard',
      buildTemplate('classmoji://{slug}/grades/leaderboard'),
      {
        title: 'Grade leaderboard',
        description: 'Sorted student grades for the classroom (admin only).',
        mimeType: 'application/json',
      },
      async (uri, { slug }) => {
        const resolved = await getClassroom(ctx, String(slug));
        if (!isStaffInAny(resolved.roles)) {
          return jsonResource(uri.href, { error: 'Admin role required' });
        }
        const memberships = await prisma.classroomMembership.findMany({
          where: { classroom_id: resolved.classroom.id, role: 'STUDENT' },
          include: { user: { select: { id: true, login: true, name: true } } },
          orderBy: { letter_grade: 'asc' },
        });
        return jsonResource(uri.href, { rankings: memberships });
      }
    );
  }
}
