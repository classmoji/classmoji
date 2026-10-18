/**
 * Ask Moji insights for a classroom's owners and teachers (R11): weekly
 * usage, the feedback review list, and one rated exchange.
 *
 * Every read is by the classroom id the caller's gate resolved; the caller
 * (the webapp's insights routes, the MCP parity tools) checks OWNER/TEACHER,
 * Pro and `syllabus_bot_enabled`, and audits the read (VIEW, `data.tool`).
 *
 * Rules:
 * - Only this runtime's rows count: conversations of type SYLLABUS_BOT that
 *   carry a grant (`context ? 'grant'`), messages `format = ui_message_v1`.
 *   Legacy rows are excluded.
 * - Time is the message's own `created_at` (through the join), never the
 *   conversation's start.
 * - Askers are classified by the role stored on each question
 *   (`acting_role`) and their CURRENT membership (`currentMembers`): a
 *   student question is one asked as STUDENT by a current student; a staff
 *   question one asked by a current teaching-team member. People who left
 *   count nowhere. Never by `view_as`.
 * - Weeks start Monday 00:00 in the course zone (UTC when unset).
 * - A per-material row ("Asked from", "Most cited") shows only with at least
 *   `INSIGHT_MIN_ASKERS` distinct student askers.
 * - "Asked from" reads the stored resolved viewing, "Most cited" the stored
 *   cites; never the raw client `viewing`.
 * - The review list shows students' exchanges, and a staff exchange only when
 *   the role it was asked as ranks at or below the viewer's.
 *
 * Every statement is parameterised (`Prisma.sql`); id sets go in as
 * `= ANY($n::text[])`.
 */
import getPrisma from '@classmoji/database';
import { canonicalTimeZone } from '@classmoji/utils';
import {
  ASK_MOJI_ROLES,
  FEEDBACK_REVIEW_MAX_LIMIT,
  INSIGHT_MAX_WEEKS,
  INSIGHT_MIN_ASKERS,
  ROLE_RANK,
  isAskMojiRole,
  projectAskMojiMessage,
  type AskMojiRole,
  type AskMojiUIMessage,
  type AskMojiViewingKind,
} from '@classmoji/utils/ask-moji';
import { Prisma } from '@prisma/client';
import {
  CALENDAR_TITLE,
  resolve as resolveViewing,
  type ResolvedViewing,
} from './askMojiViewing.service.ts';
import type { AskMojiRating } from './askMojiFeedback.service.ts';
import { currentMembers } from './classroomStudents.ts';
import { isObject, toUIMessage } from './chatShared.ts';

/** Rows shown in "Asked from" and "Most cited". */
export const INSIGHT_TOP_MATERIALS = 10;

/** The longest question text a review row carries (the exchange has it in full). */
export const REVIEW_QUESTION_MAX_CHARS = 500;

export type UsageWeek = {
  /** Monday of the week in the course zone, `YYYY-MM-DD`. */
  weekStart: string;
  /** Questions asked as STUDENT by current students. */
  questions: number;
  /** Conversations with at least one such question that week. */
  conversations: number;
  /** Distinct current students who asked that week. */
  activeStudents: number;
  /** Questions by current teaching-team members (any acting role). */
  staffQuestions: number;
  /** Token sums over every answer that week (students' and staff's; the summarizer's included). */
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
};

export type MaterialRow = {
  kind: AskMojiViewingKind | 'platform_docs';
  id: string | null;
  path?: string;
  title: string;
  /** Distinct current students. */
  askers: number;
  /** Questions asked from it, or answers citing it. */
  count: number;
};

export type UsageInsights = {
  timeZone: string;
  weeks: UsageWeek[];
  askedFrom: MaterialRow[];
  mostCited: MaterialRow[];
  minAskers: number;
};

const toInt = (v: unknown): number => {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v !== '') return Number(v);
  // numeric columns come back as Decimal objects.
  if (typeof v === 'object' && v !== null) return Number(String(v)) || 0;
  return 0;
};

/** The roles an exchange may have been asked as for this viewer to see it. */
const rolesAtOrBelow = (viewer: AskMojiRole): AskMojiRole[] =>
  ASK_MOJI_ROLES.filter(r => ROLE_RANK[r] <= ROLE_RANK[viewer]);

const zoneOf = (timeZone: string | null | undefined) => canonicalTimeZone(timeZone) ?? 'UTC';

/**
 * The classroom's usage over the last `weeks` weeks (this week included,
 * 1..`INSIGHT_MAX_WEEKS`), every week present (zeros included), oldest first.
 */
export const usage = async (i: {
  classroomId: string;
  weeks: number;
  timeZone?: string | null;
}): Promise<UsageInsights> => {
  const weeks = Math.min(Math.max(1, Math.trunc(Number(i.weeks) || 1)), INSIGHT_MAX_WEEKS);
  const tz = zoneOf(i.timeZone);
  const prisma = getPrisma();
  const { studentIds, staffIds } = await currentMembers(i.classroomId);

  // The first Monday of the range, local, and the same instant as stored UTC.
  const range = Prisma.sql`
    SELECT (date_trunc('week', now() AT TIME ZONE ${tz}) - make_interval(weeks => ${weeks - 1}::int)) AS local_from`;
  const fromUtc = Prisma.sql`((SELECT local_from FROM r) AT TIME ZONE ${tz}) AT TIME ZONE 'UTC'`;
  const week = (col: Prisma.Sql) =>
    Prisma.sql`to_char(date_trunc('week', (${col} AT TIME ZONE 'UTC') AT TIME ZONE ${tz}), 'YYYY-MM-DD')`;

  const [questionRows, tokenRows, startRow] = await Promise.all([
    prisma.$queryRaw<
      {
        week: string;
        questions: bigint;
        conversations: bigint;
        active_students: bigint;
        staff_questions: bigint;
      }[]
    >`
      WITH r AS (${range})
      SELECT ${week(Prisma.sql`m.created_at`)} AS week,
        count(*) FILTER (WHERE s.student) AS questions,
        count(DISTINCT m.conversation_id) FILTER (WHERE s.student) AS conversations,
        count(DISTINCT c.user_id) FILTER (WHERE s.student) AS active_students,
        count(*) FILTER (WHERE c.user_id = ANY(${staffIds}::text[])) AS staff_questions
      FROM ai_conversations c
      JOIN ai_conversation_messages m
        ON m.conversation_id = c.id AND m.role = 'USER' AND m.created_at >= ${fromUtc}
      CROSS JOIN LATERAL (
        SELECT (m.metadata->>'acting_role' = 'STUDENT' AND c.user_id = ANY(${studentIds}::text[])) AS student
      ) s
      WHERE c.classroom_id = ${i.classroomId} AND c.type = 'SYLLABUS_BOT' AND c.context ? 'grant'
        AND m.format = 'ui_message_v1' AND m.metadata ? 'acting_role'
      GROUP BY 1`,
    prisma.$queryRaw<
      { week: string; input: bigint; output: bigint; cache_read: bigint; cache_write: bigint }[]
    >`
      WITH r AS (${range})
      SELECT ${week(Prisma.sql`m.created_at`)} AS week,
        COALESCE(sum((m.metadata->'usage'->>'input')::bigint), 0)::bigint AS input,
        COALESCE(sum((m.metadata->'usage'->>'output')::bigint), 0)::bigint AS output,
        COALESCE(sum((m.metadata->'usage'->>'cacheRead')::bigint), 0)::bigint AS cache_read,
        COALESCE(sum((m.metadata->'usage'->>'cacheWrite')::bigint), 0)::bigint AS cache_write
      FROM ai_conversations c
      JOIN ai_conversation_messages m
        ON m.conversation_id = c.id AND m.role = 'ASSISTANT' AND m.created_at >= ${fromUtc}
      WHERE c.classroom_id = ${i.classroomId} AND c.type = 'SYLLABUS_BOT' AND c.context ? 'grant'
        AND m.format = 'ui_message_v1' AND jsonb_typeof(m.metadata->'usage') = 'object'
      GROUP BY 1`,
    prisma.$queryRaw<{ local_from: Date }[]>`${range}`,
  ]);

  // Every week of the range, oldest first.
  const first = startRow[0]?.local_from ?? new Date();
  const byWeek = new Map<string, UsageWeek>();
  for (let n = 0; n < weeks; n++) {
    const d = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate() + 7 * n)
    );
    const key = d.toISOString().slice(0, 10);
    byWeek.set(key, {
      weekStart: key,
      questions: 0,
      conversations: 0,
      activeStudents: 0,
      staffQuestions: 0,
      tokensIn: 0,
      tokensOut: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  }
  for (const row of questionRows) {
    const w = byWeek.get(row.week);
    if (!w) continue;
    w.questions = toInt(row.questions);
    w.conversations = toInt(row.conversations);
    w.activeStudents = toInt(row.active_students);
    w.staffQuestions = toInt(row.staff_questions);
  }
  for (const row of tokenRows) {
    const w = byWeek.get(row.week);
    if (!w) continue;
    w.tokensIn = toInt(row.input);
    w.tokensOut = toInt(row.output);
    w.cacheRead = toInt(row.cache_read);
    w.cacheWrite = toInt(row.cache_write);
  }

  const [askedFrom, mostCited] = await Promise.all([
    askedFromRows(i.classroomId, studentIds, range, fromUtc),
    mostCitedRows(i.classroomId, studentIds, range, fromUtc),
  ]);
  return {
    timeZone: tz,
    weeks: [...byWeek.values()],
    askedFrom,
    mostCited,
    minAskers: INSIGHT_MIN_ASKERS,
  };
};

const askedFromRows = async (
  classroomId: string,
  studentIds: string[],
  range: Prisma.Sql,
  fromUtc: Prisma.Sql
): Promise<MaterialRow[]> => {
  const rows = await getPrisma().$queryRaw<
    { kind: string; id: string | null; askers: bigint; questions: bigint }[]
  >`
    WITH r AS (${range})
    SELECT m.metadata->'resolved_viewing'->>'kind' AS kind,
      m.metadata->'resolved_viewing'->>'id' AS id,
      count(DISTINCT c.user_id) AS askers,
      count(*) AS questions
    FROM ai_conversations c
    JOIN ai_conversation_messages m
      ON m.conversation_id = c.id AND m.role = 'USER' AND m.created_at >= ${fromUtc}
    WHERE c.classroom_id = ${classroomId} AND c.type = 'SYLLABUS_BOT' AND c.context ? 'grant'
      AND m.format = 'ui_message_v1'
      AND m.metadata->>'acting_role' = 'STUDENT'
      AND c.user_id = ANY(${studentIds}::text[])
      AND jsonb_typeof(m.metadata->'resolved_viewing') = 'object'
    GROUP BY 1, 2
    HAVING count(DISTINCT c.user_id) >= ${INSIGHT_MIN_ASKERS}
    ORDER BY askers DESC, questions DESC, kind, id
    LIMIT ${INSIGHT_TOP_MATERIALS}`;
  const out: MaterialRow[] = [];
  for (const row of rows) {
    const title = await titleOf(classroomId, row.kind, row.id);
    if (title === null) continue;
    out.push({
      kind: row.kind as AskMojiViewingKind,
      id: row.id,
      title,
      askers: toInt(row.askers),
      count: toInt(row.questions),
    });
  }
  return out;
};

const mostCitedRows = async (
  classroomId: string,
  studentIds: string[],
  range: Prisma.Sql,
  fromUtc: Prisma.Sql
): Promise<MaterialRow[]> => {
  const rows = await getPrisma().$queryRaw<
    {
      type: string;
      id: string | null;
      path: string | null;
      title: string | null;
      askers: bigint;
      cites: bigint;
    }[]
  >`
    WITH r AS (${range})
    SELECT cite->>'type' AS type, cite->>'id' AS id, cite->>'path' AS path,
      max(cite->>'title') AS title,
      count(DISTINCT c.user_id) AS askers,
      count(*) AS cites
    FROM ai_conversations c
    JOIN ai_conversation_messages m
      ON m.conversation_id = c.id AND m.role = 'ASSISTANT' AND m.created_at >= ${fromUtc}
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(m.metadata->'cites') = 'array' THEN m.metadata->'cites' ELSE '[]'::jsonb END
    ) AS cite
    WHERE c.classroom_id = ${classroomId} AND c.type = 'SYLLABUS_BOT' AND c.context ? 'grant'
      AND m.format = 'ui_message_v1'
      AND c.user_id = ANY(${studentIds}::text[])
    GROUP BY 1, 2, 3
    HAVING count(DISTINCT c.user_id) >= ${INSIGHT_MIN_ASKERS}
    ORDER BY askers DESC, cites DESC, type, id, path
    LIMIT ${INSIGHT_TOP_MATERIALS}`;
  const out: MaterialRow[] = [];
  for (const row of rows) {
    if (row.type === 'platform_docs') {
      out.push({
        kind: 'platform_docs',
        id: null,
        ...(row.path ? { path: row.path } : {}),
        title: row.title ?? row.path ?? '',
        askers: toInt(row.askers),
        count: toInt(row.cites),
      });
      continue;
    }
    const kind = row.type === 'slides' ? 'deck' : row.type === 'page' ? 'page' : null;
    if (!kind) continue;
    // The current title, by id in this classroom; a row since deleted drops out.
    const title = await titleOf(classroomId, kind, row.id);
    if (title === null) continue;
    out.push({ kind, id: row.id, title, askers: toInt(row.askers), count: toInt(row.cites) });
  }
  return out;
};

/**
 * A material's current title, by id AND classroom (staff read: drafts
 * included), or null when it is gone or not in this classroom.
 */
const titleOf = async (
  classroomId: string,
  kind: string,
  id: string | null
): Promise<string | null> => {
  const prisma = getPrisma();
  if (kind === 'calendar') return CALENDAR_TITLE;
  if (!id) return null;
  const where = { id, classroom_id: classroomId };
  switch (kind) {
    case 'page':
      return (await prisma.page.findFirst({ where, select: { title: true } }))?.title ?? null;
    case 'deck':
      return (await prisma.slide.findFirst({ where, select: { title: true } }))?.title ?? null;
    case 'module':
      return (await prisma.module.findFirst({ where, select: { title: true } }))?.title ?? null;
    case 'quiz':
      return (await prisma.quiz.findFirst({ where, select: { name: true } }))?.name ?? null;
    case 'assignment':
      return (
        (
          await prisma.assignment.findFirst({
            where: { id, module: { classroom_id: classroomId } },
            select: { title: true },
          })
        )?.title ?? null
      );
    default:
      return null;
  }
};

// ─── Feedback review ────────────────────────────────────────────────────────

type ExchangeRow = {
  id: string;
  rating: AskMojiRating;
  created_at: Date;
  updated_at: Date;
  user_id: string;
  user_name: string | null;
  conversation_id: string;
  answer_id: string;
  answer_parts: unknown;
  question_id: string;
  question_content: string;
  question_parts: unknown;
  question_metadata: unknown;
};

/**
 * The rated rows a viewer may see, newest first: in this classroom, the rated
 * row a final model answer in an Ask Moji conversation of the rater's own, the
 * question the latest user row before it, asked as a role at or below the
 * viewer's by a current member (student or staff).
 */
const exchangeRows = async (i: {
  classroomId: string;
  viewerRole: AskMojiRole;
  rating?: AskMojiRating;
  since?: Date;
  feedbackId?: string;
  limit: number;
}): Promise<ExchangeRow[]> => {
  const { studentIds, staffIds } = await currentMembers(i.classroomId);
  const members = [...studentIds, ...staffIds];
  const roles = rolesAtOrBelow(i.viewerRole);
  return getPrisma().$queryRaw<ExchangeRow[]>`
    SELECT f.id, f.rating::text AS rating, f.created_at, f.updated_at, f.user_id,
      u.name AS user_name, f.conversation_id,
      a.ui_message_id AS answer_id, a.parts AS answer_parts,
      q.ui_message_id AS question_id, q.content AS question_content,
      q.parts AS question_parts, q.metadata AS question_metadata
    FROM ask_moji_feedback f
    JOIN ai_conversations c
      ON c.id = f.conversation_id AND c.classroom_id = f.classroom_id
      AND c.user_id = f.user_id AND c.type = 'SYLLABUS_BOT' AND c.context ? 'grant'
    JOIN users u ON u.id = f.user_id
    JOIN ai_conversation_messages a
      ON a.conversation_id = f.conversation_id AND a.ui_message_id = f.ui_message_id
      AND a.role = 'ASSISTANT' AND a.final AND a.provenance = 'model' AND a.format = 'ui_message_v1'
    JOIN LATERAL (
      SELECT x.ui_message_id, x.content, x.parts, x.metadata
      FROM ai_conversation_messages x
      WHERE x.conversation_id = f.conversation_id AND x.role = 'USER'
        AND x.format = 'ui_message_v1' AND x.created_at < a.created_at
      ORDER BY x.created_at DESC, x.id DESC
      LIMIT 1
    ) q ON true
    WHERE f.classroom_id = ${i.classroomId}
      AND f.user_id = ANY(${members}::text[])
      AND q.metadata->>'acting_role' = ANY(${roles}::text[])
      ${i.rating ? Prisma.sql`AND f.rating = ${i.rating}::"ASK_MOJI_RATING"` : Prisma.empty}
      ${i.since ? Prisma.sql`AND f.created_at >= ${i.since}` : Prisma.empty}
      ${i.feedbackId ? Prisma.sql`AND f.id = ${i.feedbackId}` : Prisma.empty}
    ORDER BY f.created_at DESC, f.id DESC
    LIMIT ${i.limit}`;
};

const storedRole = (metadata: unknown): AskMojiRole | null =>
  isObject(metadata) && isAskMojiRole(metadata.acting_role) ? metadata.acting_role : null;

/** The question's viewing as the asker had it: the stored ref, re-resolved for the asker (R9). */
const viewingFor = (row: ExchangeRow, classroomId: string): Promise<ResolvedViewing | null> => {
  const metadata = isObject(row.question_metadata) ? row.question_metadata : {};
  const ref = isObject(metadata.resolved_viewing) ? metadata.resolved_viewing : null;
  if (!ref) return Promise.resolve(null);
  return resolveViewing({
    classroomId,
    userId: row.user_id,
    actingRole: storedRole(metadata),
    viewing: {
      kind: ref.kind,
      ...(typeof ref.id === 'string' ? { id: ref.id } : {}),
      ...(isObject(metadata.viewing) && typeof metadata.viewing.slide === 'number'
        ? { slide: metadata.viewing.slide }
        : {}),
    },
  });
};

export type FeedbackReviewRow = {
  feedbackId: string;
  rating: AskMojiRating;
  createdAt: Date;
  updatedAt: Date;
  asker: { userId: string; name: string | null };
  /** The role the question was asked as. */
  askerRole: AskMojiRole;
  /** The question's text, cut to `REVIEW_QUESTION_MAX_CHARS`. */
  question: string;
  viewing: ResolvedViewing | null;
};

const VIEWER_ROLES: readonly AskMojiRole[] = ['OWNER', 'TEACHER'];

/**
 * The feedback review list (R10/R11): newest first, `limit` at most
 * `FEEDBACK_REVIEW_MAX_LIMIT` (default 50), optionally one rating and from
 * `since`. Empty for a viewer role that is not OWNER or TEACHER.
 */
export const feedbackReview = async (i: {
  classroomId: string;
  viewerRole: AskMojiRole | string;
  rating?: AskMojiRating;
  since?: Date;
  limit?: number;
}): Promise<FeedbackReviewRow[]> => {
  if (!isAskMojiRole(i.viewerRole) || !VIEWER_ROLES.includes(i.viewerRole)) return [];
  if (i.rating !== undefined && i.rating !== 'UP' && i.rating !== 'DOWN') return [];
  if (i.since !== undefined && Number.isNaN(i.since.getTime())) return [];
  const limit = Math.min(Math.max(1, Math.trunc(i.limit ?? 50)), FEEDBACK_REVIEW_MAX_LIMIT);
  const rows = await exchangeRows({ ...i, viewerRole: i.viewerRole, limit });
  const out: FeedbackReviewRow[] = [];
  for (const row of rows) {
    const role = storedRole(row.question_metadata);
    if (!role) continue;
    out.push({
      feedbackId: row.id,
      rating: row.rating,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      asker: { userId: row.user_id, name: row.user_name },
      askerRole: role,
      question: row.question_content.slice(0, REVIEW_QUESTION_MAX_CHARS),
      viewing: await viewingFor(row, i.classroomId),
    });
  }
  return out;
};

export type FeedbackExchange = Omit<FeedbackReviewRow, 'question'> & {
  /** The question and the rated answer, projected (R8) as their owner saw them. */
  question: AskMojiUIMessage;
  answer: AskMojiUIMessage;
};

/**
 * One rated exchange (R10): the rated answer and the latest user row before
 * it, both projected, with the viewing re-resolved. Null when the id is not a
 * rating in this classroom that this viewer may see (one answer for missing,
 * another classroom, and above the viewer's role).
 */
export const exchange = async (i: {
  classroomId: string;
  viewerRole: AskMojiRole | string;
  feedbackId: string;
}): Promise<FeedbackExchange | null> => {
  if (!isAskMojiRole(i.viewerRole) || !VIEWER_ROLES.includes(i.viewerRole)) return null;
  if (typeof i.feedbackId !== 'string' || !i.feedbackId || i.feedbackId.length > 128) return null;
  const [row] = await exchangeRows({
    classroomId: i.classroomId,
    viewerRole: i.viewerRole,
    feedbackId: i.feedbackId,
    limit: 1,
  });
  const role = row ? storedRole(row.question_metadata) : null;
  if (!row || !role) return null;
  const question = projectAskMojiMessage(
    toUIMessage<AskMojiUIMessage>({
      ui_message_id: row.question_id,
      role: 'USER',
      parts: row.question_parts as Prisma.JsonValue,
      metadata: row.question_metadata as Prisma.JsonValue,
    })
  );
  const answer = projectAskMojiMessage(
    toUIMessage<AskMojiUIMessage>({
      ui_message_id: row.answer_id,
      role: 'ASSISTANT',
      parts: row.answer_parts as Prisma.JsonValue,
      metadata: null,
    })
  );
  if (!question || !answer) return null;
  return {
    feedbackId: row.id,
    rating: row.rating,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    asker: { userId: row.user_id, name: row.user_name },
    askerRole: role,
    question,
    answer,
    viewing: await viewingFor(row, i.classroomId),
  };
};
