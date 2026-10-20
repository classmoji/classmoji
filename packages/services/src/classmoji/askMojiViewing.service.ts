/**
 * What an Ask Moji user message says is open (`metadata.viewing`, sent by the
 * widget and never trusted), resolved against the conversation's classroom
 * and the asker's acting role (R9). Every lookup is by id AND classroom id;
 * anything the asker may not see, or that is not in this classroom, resolves
 * to null and is dropped silently. The title and detail come from the row,
 * never from the client.
 *
 * The acting role comes from the asker's current memberships (admission and
 * `contextForTurn` compute it the same way), never from the grant. Per kind:
 *   page / deck  the row, then `contentVisibility(role)` (drafts are staff only).
 *                A deck may be any Slide kind; only a DECK has slides, so only
 *                a DECK keeps `slide` (clamped to `MAX_SLIDE_INDEX`).
 *   module       `show_modules` off hides every module from every role;
 *                students need it published, staff see unpublished ones.
 *   assignment   students: `openToStudents`; staff: the MCP coursework rule
 *                (module and repository in this classroom, quizzes visible).
 *   quiz         quizzes visible; students: the student quiz list's two-branch
 *                rule. Refused for ANY role while the asker has an open,
 *                unexpired attempt on it.
 *   calendar     every member.
 *
 * Reads only; writes nothing and audits nothing.
 */
import getPrisma from '@classmoji/database';
import { openToStudents } from '@classmoji/utils';
import {
  AskMojiViewingSchema,
  MAX_SLIDE_INDEX,
  isAskMojiRole,
  type AskMojiRole,
  type AskMojiViewingKind,
} from '@classmoji/utils/ask-moji';
import { contentVisibility } from './contentSearch.service.ts';
import { quizzesVisible } from './entitlement.service.ts';
import { isExpiredOpenAttempt } from './quizGrading.service.ts';

/** A viewing the server checked: what the task may tell the model is open. */
export type ResolvedViewing = {
  kind: AskMojiViewingKind;
  /** The row's id; null for the calendar. */
  id: string | null;
  /** The row's own title (the calendar's is fixed). */
  title: string;
  /** A DECK's current slide, 0-based, clamped. */
  slide?: number;
  /** A short server-derived label: `Slide N` for a deck, the assignment's type. */
  detail?: string;
};

/** The calendar's title (it has no row). */
export const CALENDAR_TITLE = 'Calendar';

const STAFF: readonly AskMojiRole[] = ['OWNER', 'TEACHER', 'ASSISTANT'];

const ASSIGNMENT_DETAIL: Readonly<Record<string, string>> = {
  REPO: 'repository assignment',
  QUIZ: 'quiz assignment',
  FORM: 'form assignment',
};

const resolvePage = async (classroomId: string, id: string, role: AskMojiRole) => {
  const row = await getPrisma().page.findFirst({
    where: { id, classroom_id: classroomId },
    select: { id: true, title: true, is_draft: true, is_public: true },
  });
  if (!row || !contentVisibility(role).allows(row)) return null;
  return { kind: 'page', id: row.id, title: row.title } satisfies ResolvedViewing;
};

const resolveDeck = async (
  classroomId: string,
  id: string,
  role: AskMojiRole,
  slide: number | undefined
) => {
  const row = await getPrisma().slide.findFirst({
    where: { id, classroom_id: classroomId },
    select: { id: true, title: true, kind: true, is_draft: true, is_public: true },
  });
  if (!row || !contentVisibility(role).allows(row)) return null;
  const out: ResolvedViewing = { kind: 'deck', id: row.id, title: row.title };
  if (row.kind === 'DECK' && slide !== undefined) {
    out.slide = Math.min(Math.max(0, Math.trunc(slide)), MAX_SLIDE_INDEX);
    out.detail = `Slide ${out.slide + 1}`;
  }
  return out;
};

const resolveModule = async (classroomId: string, id: string, role: AskMojiRole) => {
  const prisma = getPrisma();
  const [settings, row] = await Promise.all([
    prisma.classroomSettings.findUnique({
      where: { classroom_id: classroomId },
      select: { show_modules: true },
    }),
    prisma.module.findFirst({
      where: { id, classroom_id: classroomId },
      select: { id: true, title: true, is_published: true },
    }),
  ]);
  if (!row || settings?.show_modules === false) return null;
  if (!STAFF.includes(role) && !row.is_published) return null;
  return { kind: 'module', id: row.id, title: row.title } satisfies ResolvedViewing;
};

const resolveAssignment = async (classroomId: string, id: string, role: AskMojiRole) => {
  const row = await getPrisma().assignment.findFirst({
    where: { id, module: { classroom_id: classroomId } },
    select: {
      id: true,
      title: true,
      type: true,
      is_published: true,
      release_at: true,
      repository: { select: { is_published: true, classroom_id: true } },
      form: { select: { status: true } },
    },
  });
  if (!row) return null;
  if (row.repository && row.repository.classroom_id !== classroomId) return null;
  const visible = row.type === 'QUIZ' ? await quizzesVisible(classroomId) : true;
  if (STAFF.includes(role)) {
    if (!visible) return null;
  } else if (!openToStudents(row, new Date(), { quizzesVisible: visible })) {
    return null;
  }
  const detail = ASSIGNMENT_DETAIL[row.type];
  return {
    kind: 'assignment',
    id: row.id,
    title: row.title,
    ...(detail ? { detail } : {}),
  } satisfies ResolvedViewing;
};

const resolveQuiz = async (classroomId: string, id: string, role: AskMojiRole, userId: string) => {
  const prisma = getPrisma();
  const row = await prisma.quiz.findFirst({
    where: { id, classroom_id: classroomId },
    select: {
      id: true,
      name: true,
      status: true,
      assignment: { select: { is_published: true, release_at: true } },
    },
  });
  if (!row || !(await quizzesVisible(classroomId))) return null;
  if (!STAFF.includes(role)) {
    // The student quiz list's rule (quiz.service getQuizzesForStudent, closed
    // quizzes included: a student keeps the quiz they finished).
    const now = Date.now();
    const listed = row.assignment
      ? row.assignment.is_published &&
        (row.assignment.release_at === null || row.assignment.release_at.getTime() <= now)
      : row.status === 'PUBLISHED' || row.status === 'CLOSED';
    if (!listed) return null;
  }
  // Never while the asker is taking it, whatever the role.
  const open = await prisma.quizAttempt.findMany({
    where: { quiz_id: row.id, user_id: userId, completed_at: null },
    select: { agent_runtime: true, completed_at: true, session_expires_at: true },
  });
  if (open.some(attempt => !isExpiredOpenAttempt(attempt))) return null;
  return { kind: 'quiz', id: row.id, title: row.name } satisfies ResolvedViewing;
};

/**
 * The viewing as the server resolved it, or null (malformed, not in this
 * classroom, or not visible to the asker). A null or unknown role resolves
 * nothing: the asker is not a member.
 */
export const resolve = async (i: {
  classroomId: string;
  userId: string;
  actingRole: AskMojiRole | string | null;
  viewing: unknown;
}): Promise<ResolvedViewing | null> => {
  if (!i.viewing || !isAskMojiRole(i.actingRole)) return null;
  const parsed = AskMojiViewingSchema.safeParse(i.viewing);
  if (!parsed.success) return null;
  const { kind, id, slide } = parsed.data;
  const role = i.actingRole;
  if (kind === 'calendar') return { kind, id: null, title: CALENDAR_TITLE };
  if (!id) return null;
  switch (kind) {
    case 'page':
      return resolvePage(i.classroomId, id, role);
    case 'deck':
      return resolveDeck(i.classroomId, id, role, slide);
    case 'module':
      return resolveModule(i.classroomId, id, role);
    case 'assignment':
      return resolveAssignment(i.classroomId, id, role);
    case 'quiz':
      return resolveQuiz(i.classroomId, id, role, i.userId);
    default:
      return null;
  }
};

/** The stored form of a resolved viewing: kind and id only. */
export const viewingRef = (v: ResolvedViewing | null) => (v ? { kind: v.kind, id: v.id } : null);
