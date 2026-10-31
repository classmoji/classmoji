/**
 * Ask Moji owner tools: the MCP side of the usage view, the feedback review,
 * one rated exchange, and the owner's Ask Moji configuration.
 *
 * TIERS (the web's):
 *   - ask_moji_usage / ask_moji_feedback_list / ask_moji_exchange_get:
 *     OWNER+TEACHER, the insights pages' gate. Each refuses unless Ask Moji is
 *     available in the classroom (`askMojiSession.askMojiAvailable`: the
 *     runtime switch, Trigger configured, an Anthropic key, Pro,
 *     `syllabus_bot_enabled`), before any read, and each successful call is
 *     one VIEW row (`auditRead`): they read students' questions and activity.
 *   - ask_moji_settings_get: OWNER only, like the web AI settings page, which
 *     loads for the owner with Ask Moji off or without Pro (the toggles are
 *     disabled there). So it is not availability-gated; it reports the
 *     availability instead. The owner reading their own configuration writes
 *     no audit row. It never returns the API key, only whether one is set.
 *
 * Every read is by the classroom the registry resolved, never an id from the
 * arguments; the services scope every query by it, so a feedback id from
 * another classroom reads as not found.
 *
 * None of these is served to the Ask Moji client itself (registry.ts,
 * `hiddenFromClient`): its conversation must never carry other people's
 * questions.
 */

import { ClassmojiService } from '@classmoji/services';
import { ASK_MOJI_AVAILABILITY_COPY } from '@classmoji/utils/ask-moji/copy';
import {
  ASK_MOJI_INSIGHT_DEFAULT_WEEKS,
  FEEDBACK_REVIEW_MAX_LIMIT,
  INSIGHT_MAX_WEEKS,
} from '@classmoji/utils/ask-moji/limits';
import { z } from 'zod';
import { idArgs } from '../mcp/audit.ts';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import { ok, OWNER_ONLY, OWNER_TEACHER, requireClassroomCtx, scopedNotFound } from './shared.ts';

/** Weeks `ask_moji_usage` covers when the caller names none: the web usage view's. */
export const DEFAULT_USAGE_WEEKS = ASK_MOJI_INSIGHT_DEFAULT_WEEKS;

type FeedbackRow = Awaited<
  ReturnType<typeof ClassmojiService.askMojiInsights.feedbackReview>
>[number];
type Exchange = NonNullable<Awaited<ReturnType<typeof ClassmojiService.askMojiInsights.exchange>>>;
type Material = Awaited<
  ReturnType<typeof ClassmojiService.askMojiInsights.usage>
>['askedFrom'][number];

/** Refuse unless Ask Moji runs in this classroom; the reason is the staff line for it. */
async function assertAvailable(classroomId: string): Promise<void> {
  const availability = await ClassmojiService.askMojiSession.askMojiAvailable({ classroomId });
  if (!availability.available) {
    throw new ToolError(
      'forbidden',
      ASK_MOJI_AVAILABILITY_COPY[availability.reason] ?? 'Ask Moji is not available here.',
      availability.reason
    );
  }
}

const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : value);

const viewingOut = (viewing: FeedbackRow['viewing']) =>
  viewing
    ? {
        kind: viewing.kind,
        id: viewing.id,
        title: viewing.title,
        ...(viewing.slide !== undefined ? { slide: viewing.slide } : {}),
        ...(viewing.detail !== undefined ? { detail: viewing.detail } : {}),
      }
    : null;

const materialOut = (row: Material) => ({
  kind: row.kind,
  id: row.id,
  ...(row.path !== undefined ? { path: row.path } : {}),
  title: row.title,
  askers: row.askers,
  count: row.count,
});

const rowHead = (row: FeedbackRow | Exchange) => ({
  feedback_id: row.feedbackId,
  rating: row.rating,
  created_at: iso(row.createdAt),
  updated_at: iso(row.updatedAt),
  asker: { user_id: row.asker.userId, name: row.asker.name },
  asker_role: row.askerRole,
  viewing: viewingOut(row.viewing),
});

type Part = { type?: unknown; text?: unknown; state?: unknown; output?: unknown };

/** A projected message's text, its text parts joined in order. */
function messageText(message: { parts?: readonly unknown[] }): string {
  return (message.parts ?? [])
    .filter((p): p is Part => Boolean(p) && typeof p === 'object')
    .filter(p => p.type === 'text' && typeof p.text === 'string')
    .map(p => p.text as string)
    .join('\n\n');
}

/** An http(s) URL as the web shows it; anything else (or unparseable) is null. */
function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The citations the answer showed: successful `cite_content` results with a
 * title, each once (by title and URL), and a URL only when it is http(s). The
 * web exchange view's rule (`sourcesOf` in the insights view); `type` and `id`
 * are kept for MCP callers.
 */
function messageCites(message: { parts?: readonly unknown[] }) {
  const cites: Array<{ title: string; url: string | null; type?: string; id?: string }> = [];
  const seen = new Set<string>();
  for (const part of message.parts ?? []) {
    const p = part as Part;
    if (p?.type !== 'tool-cite_content' || p.state !== 'output-available') continue;
    const out = p.output as
      | { ok?: unknown; title?: unknown; url?: unknown; type?: unknown; id?: unknown }
      | undefined;
    if (!out || typeof out !== 'object' || out.ok !== true) continue;
    const title = typeof out.title === 'string' ? out.title : '';
    if (!title) continue;
    const url = httpUrl(out.url);
    const key = `${title}\n${url ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cites.push({
      title,
      url,
      ...(typeof out.type === 'string' ? { type: out.type } : {}),
      ...(typeof out.id === 'string' ? { id: out.id } : {}),
    });
  }
  return cites;
}

// ─── ask_moji_usage ─────────────────────────────────────────────────────────

interface UsageArgs {
  classroom: string;
  weeks?: number;
}

export const askMojiUsageTool: ToolDefinition<UsageArgs> = {
  name: 'ask_moji_usage',
  title: 'Ask Moji usage',
  description:
    "Ask Moji usage in this classroom, the numbers of the web usage view: per week (Monday start, in the course time zone, UTC when unset; this week included, oldest first) the questions current students asked, their conversations, active students, staff questions, and token totals. Also 'asked_from' (what students had open when asking) and 'most_cited' (materials answers cited), each listing only materials at least min_askers distinct students reached. Counts current students only. weeks: 1-" +
    `${INSIGHT_MAX_WEEKS}, default ${DEFAULT_USAGE_WEEKS}. OWNER and TEACHER only; needs Ask Moji on (Pro).`,
  scope: 'read',
  roles: OWNER_TEACHER,
  annotations: { openWorld: false },
  // Students' activity, aggregated. The web usage view's row: the classroom,
  // and the weeks it covered.
  auditRead: {
    resourceType: 'ASK_MOJI_INSIGHTS',
    ids: (args, classroom) => ({
      resourceId: classroom.classroomId,
      data: { weeks: typeof args.weeks === 'number' ? args.weeks : DEFAULT_USAGE_WEEKS },
    }),
  },
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    weeks: z
      .number()
      .int()
      .min(1)
      .max(INSIGHT_MAX_WEEKS)
      .optional()
      .describe(`Weeks to cover, this week included (default ${DEFAULT_USAGE_WEEKS})`),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    await assertAvailable(classroom.classroomId);
    // The course's own zone (the service falls back to UTC), never the
    // request's rendering hint: weeks are the course's weeks.
    const result = await ClassmojiService.askMojiInsights.usage({
      classroomId: classroom.classroomId,
      weeks: args.weeks ?? DEFAULT_USAGE_WEEKS,
      timeZone: classroom.timezone,
    });
    return ok({
      time_zone: result.timeZone,
      min_askers: result.minAskers,
      weeks: result.weeks.map(w => ({
        week_start: w.weekStart,
        questions: w.questions,
        conversations: w.conversations,
        active_students: w.activeStudents,
        staff_questions: w.staffQuestions,
        tokens_in: w.tokensIn,
        tokens_out: w.tokensOut,
        cache_read: w.cacheRead,
        cache_write: w.cacheWrite,
      })),
      asked_from: result.askedFrom.map(materialOut),
      most_cited: result.mostCited.map(materialOut),
    });
  },
};

// ─── ask_moji_feedback_list ─────────────────────────────────────────────────

interface FeedbackListArgs {
  classroom: string;
  rating?: 'UP' | 'DOWN';
  since?: string;
  limit?: number;
}

export const askMojiFeedbackListTool: ToolDefinition<FeedbackListArgs> = {
  name: 'ask_moji_feedback_list',
  title: 'Ask Moji feedback review',
  description:
    "The rated Ask Moji answers in this classroom, newest first, the rows of the web feedback review: the rating (UP/DOWN), who asked and as which role, the question and the start of the rated answer (answer_preview; each cut to 500 characters), and what they had open. Students' questions show, and a staff member's only when asked as a role at or below yours. Current members only. Filters: rating, since (ISO date-time, rated at or after), limit (default 50, max " +
    `${FEEDBACK_REVIEW_MAX_LIMIT}). Read one in full with ask_moji_exchange_get. OWNER and TEACHER only; needs Ask Moji on (Pro).`,
  scope: 'read',
  roles: OWNER_TEACHER,
  annotations: { openWorld: false },
  // Other people's questions. The web review's row (the classroom); only the
  // rating filter is recorded: `since` is free input, not an id.
  auditRead: {
    resourceType: 'ASK_MOJI_FEEDBACK',
    ids: (args, classroom) => ({
      resourceId: classroom.classroomId,
      data: idArgs(args, ['rating']),
    }),
  },
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    rating: z.enum(['UP', 'DOWN']).optional().describe('Only this rating'),
    since: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe('Only ratings made at or after this ISO 8601 date-time'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(FEEDBACK_REVIEW_MAX_LIMIT)
      .optional()
      .describe('Rows to return (default 50)'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    await assertAvailable(classroom.classroomId);
    const rows = await ClassmojiService.askMojiInsights.feedbackReview({
      classroomId: classroom.classroomId,
      // The role the registry resolved: under a role ceiling, the capped one.
      viewerRole: classroom.role,
      ...(args.rating ? { rating: args.rating } : {}),
      ...(args.since ? { since: new Date(args.since) } : {}),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });
    return ok({
      total: rows.length,
      rows: rows.map(row => ({
        ...rowHead(row),
        question: row.question,
        answer_preview: row.answerPreview,
      })),
    });
  },
};

// ─── ask_moji_exchange_get ──────────────────────────────────────────────────

interface ExchangeGetArgs {
  classroom: string;
  feedback_id: string;
}

export const askMojiExchangeGetTool: ToolDefinition<ExchangeGetArgs> = {
  name: 'ask_moji_exchange_get',
  title: 'Ask Moji rated exchange',
  description:
    'One rated Ask Moji exchange in full: the question, the rated answer (its text and the course materials it cited), the rating, who asked and as which role, and what they had open. feedback_id comes from ask_moji_feedback_list. The same visibility rule as that list applies, and an id that is not a rating in this classroom you may see is not found. OWNER and TEACHER only; needs Ask Moji on (Pro).',
  scope: 'read',
  roles: OWNER_TEACHER,
  annotations: { openWorld: false },
  // One person's question and answer.
  auditRead: {
    resourceType: 'ASK_MOJI_FEEDBACK',
    ids: args => ({
      resourceId: typeof args.feedback_id === 'string' ? args.feedback_id : null,
    }),
  },
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    feedback_id: z
      .string()
      .min(1)
      .max(128)
      .describe('The feedback id, from ask_moji_feedback_list'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    await assertAvailable(classroom.classroomId);
    const exchange = await ClassmojiService.askMojiInsights.exchange({
      classroomId: classroom.classroomId,
      viewerRole: classroom.role,
      feedbackId: args.feedback_id,
    });
    // One answer for missing, another classroom's, and above the viewer's role.
    if (!exchange) throw scopedNotFound('Rated exchange');
    return ok({
      ...rowHead(exchange),
      question: messageText(exchange.question),
      answer: messageText(exchange.answer),
      cites: messageCites(exchange.answer),
    });
  },
};

// ─── ask_moji_settings_get ──────────────────────────────────────────────────

interface SettingsGetArgs {
  classroom: string;
}

export const askMojiSettingsGetTool: ToolDefinition<SettingsGetArgs> = {
  name: 'ask_moji_settings_get',
  title: 'Ask Moji settings',
  description:
    "This classroom's Ask Moji configuration: whether it is switched on (syllabus_bot_enabled), the owner's instructions to it, the stored model and effort (they apply only with the classroom's own Anthropic key; has_own_key says whether one is set, the key itself is never returned), and whether Ask Moji is available now, with the reason when not. Change the switch and the instructions with classroom_settings_update; the model, effort and key are managed in the web app. Owner only.",
  scope: 'read',
  roles: OWNER_ONLY,
  annotations: { openWorld: false },
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
  },
  handler: async (_args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const [settings, availability] = await Promise.all([
      ClassmojiService.classroom.getClassroomSettingsForServer(classroom.classroomId),
      ClassmojiService.askMojiSession.askMojiAvailable({ classroomId: classroom.classroomId }),
    ]);
    // An explicit pick: the row carries the API keys.
    return ok({
      syllabus_bot_enabled: settings?.syllabus_bot_enabled === true,
      instructions: settings?.syllabus_bot_instructions?.trim() || null,
      model: settings?.syllabus_bot_model ?? null,
      effort: settings?.syllabus_bot_effort ?? null,
      has_own_key: Boolean(settings?.anthropic_api_key?.trim()),
      available: availability.available,
      ...(availability.available
        ? {}
        : {
            unavailable_reason: availability.reason,
            unavailable_message: ASK_MOJI_AVAILABILITY_COPY[availability.reason],
          }),
    });
  },
};

export const askMojiTools: ToolDefinition<never>[] = [
  askMojiUsageTool,
  askMojiFeedbackListTool,
  askMojiExchangeGetTool,
  askMojiSettingsGetTool,
];
