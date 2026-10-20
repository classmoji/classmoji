/**
 * Page sections: per-student reader state on a page.
 *
 *   - checks:  checkable headings a student has ticked (`page_section_checks`)
 *   - unlocks: locked sections a student has opened (`page_section_unlocks`)
 *
 * Block ids are the BlockNote block ids in the page's content.json.
 *
 * Every id here is SERVER-DERIVED: the page row, the session's user, the
 * classroom the page belongs to. No function takes a classroom id from a client;
 * the unlock's classroom is copied from the page row the caller already loaded.
 *
 * Reads scope every query by page AND user (a reader's own state) or by page
 * AND classroom (staff views). A staff view handed ids first confirms the page
 * is in that classroom, so a page id from another classroom yields nothing; one
 * handed the page row its caller already loaded and authorized against reads
 * that row's own classroom and skips the re-query.
 *
 * Staff views count CURRENT students only: accepted STUDENT members of the
 * classroom holding no accepted teaching-team role there. A removed student's
 * rows stay in the table and drop out of every count and list; a person who is
 * both staff and student is staff and never counted.
 *
 * Ids are checked before Prisma sees them (a non-string id would be read as a
 * filter object, and an empty one dropped): reads answer "nothing" for an
 * unusable id, writes throw `PageSectionsValidationError`.
 */
import getPrisma, { GIT_IDENTITY } from '@classmoji/database';
import { gitUsername, type GitIdentityAccount } from '@classmoji/utils';
import type { Role } from '@prisma/client';

import { findClassroomGitProvider } from './classroomGitProvider.ts';
import { TEACHING_TEAM_ROLES, currentStudentIds } from './classroomStudents.ts';

/** Longest block id accepted. BlockNote ids are uuids (36 chars). */
export const BLOCK_ID_MAX_LENGTH = 64;

const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const ID_MAX_LENGTH = 255;

/** Higher is more privileged (same order as `@classmoji/auth`'s classroomRole). */
const ROLE_PRIORITY: Record<Role, number> = {
  OWNER: 4,
  TEACHER: 3,
  ASSISTANT: 2,
  STUDENT: 1,
};

/** An id or block id a write was handed that cannot be one. */
export class PageSectionsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageSectionsValidationError';
  }
}

/** A row id (page, user, classroom): a non-empty string of sane length. */
export const isSectionId = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.length <= ID_MAX_LENGTH;

/** A BlockNote block id: letters, digits, `-` and `_`, at most 64 characters. */
export const isBlockId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= BLOCK_ID_MAX_LENGTH &&
  BLOCK_ID_PATTERN.test(value);

function requireId(value: unknown, label: string): asserts value is string {
  if (!isSectionId(value)) throw new PageSectionsValidationError(`Invalid ${label} id`);
}

function requireBlockId(value: unknown): asserts value is string {
  if (!isBlockId(value)) throw new PageSectionsValidationError('Invalid block id');
}

const isUniqueConflict = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === 'P2002';

function highestRole(roles: readonly Role[]): Role | null {
  let best: Role | null = null;
  for (const role of roles) {
    if (best === null || (ROLE_PRIORITY[role] ?? 0) > (ROLE_PRIORITY[best] ?? 0)) best = role;
  }
  return best;
}

// ── Reader ─────────────────────────────────────────────────────────────────

/**
 * What a user is on a classroom's pages: the ONE rule every surface (the pages
 * loader, `/api/page-sections`, the MCP tools and `content_get`) reads, so the
 * UI and the MCP answer the same question the same way.
 */
export interface SectionViewer {
  /** Highest role in ANY invite state (what the classroom status gates read), or null. */
  role: Role | null;
  /** Highest role among the user's ACCEPTED memberships, or null. */
  acceptedRole: Role | null;
  /** Highest accepted role is OWNER, TEACHER or ASSISTANT. */
  teachingTeam: boolean;
  /** Highest accepted role is STUDENT. */
  student: boolean;
  /**
   * OWNER or TEACHER in any invite state: the page editor's rule. Such a user
   * opens the editor, so they must never receive a redacted document (saving
   * it would drop the locked bodies).
   */
  canEditAnyState: boolean;
  /** Receives every locked body and records no unlock: canEditAnyState or accepted teaching team. */
  revealAll: boolean;
  /** An accepted student who does not reveal all. */
  canUnlock: boolean;
  /** Accepted OWNER or TEACHER: may see other readers' checks and unlocks. */
  canSeeActivity: boolean;
  /**
   * OWNER, TEACHER or ASSISTANT in any invite state: may open draft pages.
   * The pages app's existing draft rule, unchanged by page sections; a reader
   * who opens a draft without revealAll still gets it redacted.
   */
  canViewDrafts: boolean;
}

export const NO_SECTION_VIEWER: Readonly<SectionViewer> = Object.freeze({
  role: null,
  acceptedRole: null,
  teachingTeam: false,
  student: false,
  canEditAnyState: false,
  revealAll: false,
  canUnlock: false,
  canSeeActivity: false,
  canViewDrafts: false,
});

/** The rule itself, from a user's membership rows in one classroom. */
export function sectionViewerFromMemberships(
  rows: ReadonlyArray<{ role: Role; has_accepted_invite: boolean }>
): SectionViewer {
  const role = highestRole(rows.map(row => row.role));
  const acceptedRole = highestRole(
    rows.filter(row => row.has_accepted_invite).map(row => row.role)
  );
  const teachingTeam = acceptedRole !== null && TEACHING_TEAM_ROLES.includes(acceptedRole);
  const student = acceptedRole === 'STUDENT';
  const canEditAnyState = role === 'OWNER' || role === 'TEACHER';
  const revealAll = canEditAnyState || teachingTeam;
  return {
    role,
    acceptedRole,
    teachingTeam,
    student,
    canEditAnyState,
    revealAll,
    canUnlock: student && !revealAll,
    canSeeActivity: acceptedRole === 'OWNER' || acceptedRole === 'TEACHER',
    canViewDrafts: role !== null && TEACHING_TEAM_ROLES.includes(role),
  };
}

/**
 * The calling user's `SectionViewer` in one classroom (one membership read,
 * every invite state; acceptance is applied per field). The highest role wins:
 * a member who is both staff and student is staff.
 */
export const sectionViewer = async ({
  userId,
  classroomId,
}: {
  userId: string;
  classroomId: string;
}): Promise<SectionViewer> => {
  if (!isSectionId(userId) || !isSectionId(classroomId)) return { ...NO_SECTION_VIEWER };

  const rows = await getPrisma().classroomMembership.findMany({
    where: { user_id: userId, classroom_id: classroomId },
    select: { role: true, has_accepted_invite: true },
  });
  return sectionViewerFromMemberships(rows);
};

export interface ReaderState {
  /** Heading block ids this user has checked on this page. */
  checked: string[];
  /** Locked-section block id → when this user first unlocked it (ISO). */
  unlocked: Record<string, string>;
}

/** One user's own checks and unlocks on one page. */
export const readerState = async ({
  pageId,
  userId,
}: {
  pageId: string;
  userId: string;
}): Promise<ReaderState> => {
  if (!isSectionId(pageId) || !isSectionId(userId)) return { checked: [], unlocked: {} };

  const prisma = getPrisma();
  const [checks, unlocks] = await Promise.all([
    prisma.pageSectionCheck.findMany({
      where: { page_id: pageId, user_id: userId },
      select: { block_id: true },
      orderBy: { checked_at: 'asc' },
    }),
    prisma.pageSectionUnlock.findMany({
      where: { page_id: pageId, user_id: userId },
      select: { block_id: true, unlocked_at: true },
    }),
  ]);

  const unlocked: Record<string, string> = {};
  for (const row of unlocks) unlocked[row.block_id] = row.unlocked_at.toISOString();
  return { checked: checks.map(row => row.block_id), unlocked };
};

/**
 * Check or uncheck one heading for one user. Checking twice keeps the first
 * row; unchecking something unchecked is a no-op.
 */
export const setChecked = async ({
  pageId,
  userId,
  blockId,
  checked,
}: {
  pageId: string;
  userId: string;
  blockId: string;
  checked: boolean;
}): Promise<{ checked: boolean; changed: boolean }> => {
  requireId(pageId, 'page');
  requireId(userId, 'user');
  requireBlockId(blockId);
  if (typeof checked !== 'boolean') throw new PageSectionsValidationError('Invalid checked value');

  const prisma = getPrisma();
  if (!checked) {
    const { count } = await prisma.pageSectionCheck.deleteMany({
      where: { page_id: pageId, user_id: userId, block_id: blockId },
    });
    return { checked: false, changed: count > 0 };
  }

  // skipDuplicates: an existing row (or a concurrent check that made it first)
  // is "already checked", reported as no change.
  const { count } = await prisma.pageSectionCheck.createMany({
    data: [{ page_id: pageId, user_id: userId, block_id: blockId }],
    skipDuplicates: true,
  });
  return { checked: true, changed: count > 0 };
};

/**
 * Record that a user opened a locked section. Idempotent: the first unlock's
 * time is kept and `created` says whether this call made the row. The
 * classroom is the page's own (`page.classroom_id` from the loaded page row).
 */
export const recordUnlock = async ({
  page,
  userId,
  blockId,
}: {
  page: { id: string; classroom_id: string };
  userId: string;
  blockId: string;
}): Promise<{ unlockedAt: Date; created: boolean }> => {
  requireId(page?.id, 'page');
  requireId(page?.classroom_id, 'classroom');
  requireId(userId, 'user');
  requireBlockId(blockId);

  const prisma = getPrisma();
  const key = { page_id: page.id, user_id: userId, block_id: blockId };

  const existing = await prisma.pageSectionUnlock.findUnique({
    where: { page_id_user_id_block_id: key },
    select: { unlocked_at: true },
  });
  if (existing) return { unlockedAt: existing.unlocked_at, created: false };

  try {
    const row = await prisma.pageSectionUnlock.create({
      data: { ...key, classroom_id: page.classroom_id },
      select: { unlocked_at: true },
    });
    return { unlockedAt: row.unlocked_at, created: true };
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    // A concurrent unlock of the same section won the insert; its time stands.
    const winner = await prisma.pageSectionUnlock.findUnique({
      where: { page_id_user_id_block_id: key },
      select: { unlocked_at: true },
    });
    if (!winner) throw error;
    return { unlockedAt: winner.unlocked_at, created: false };
  }
};

// ── Staff views ────────────────────────────────────────────────────────────

/** Is this page in this classroom? Both ids must already be valid. */
const pageIsInClassroom = async (pageId: string, classroomId: string): Promise<boolean> => {
  const page = await getPrisma().page.findFirst({
    where: { id: pageId, classroom_id: classroomId },
    select: { id: true },
  });
  return page !== null;
};

/**
 * Which page a staff view is about:
 *   - `{ pageId, classroomId }`: ids; the page must be in that classroom (one query);
 *   - `{ page }`: the page row the caller already loaded and authorized the
 *     viewer against; its own `classroom_id` is the scope, nothing is re-read.
 */
export type StaffPageRef =
  | { pageId: string; classroomId: string; page?: undefined }
  | { page: { id: string; classroom_id: string }; pageId?: undefined; classroomId?: undefined };

/**
 * The page's scope for a staff view, or null when the ids are unusable or the
 * page is not in the classroom. Carries the current-student set it was
 * computed with, so every view reads one filter.
 */
const staffScope = async (
  ref: StaffPageRef
): Promise<{ pageId: string; classroomId: string; studentIds: string[] } | null> => {
  if (ref.page !== undefined) {
    // Checked like any id: a caller's row may still be malformed.
    const { id, classroom_id } = (ref.page ?? {}) as { id?: unknown; classroom_id?: unknown };
    if (!isSectionId(id) || !isSectionId(classroom_id)) return null;
    return {
      pageId: id,
      classroomId: classroom_id,
      studentIds: await currentStudentIds(classroom_id),
    };
  }
  const { pageId, classroomId } = ref;
  if (!isSectionId(pageId) || !isSectionId(classroomId)) return null;
  if (!(await pageIsInClassroom(pageId, classroomId))) return null;
  return { pageId, classroomId, studentIds: await currentStudentIds(classroomId) };
};

/**
 * How many current students unlocked each locked section of a page. Null when
 * the page is not in the classroom.
 */
export const unlockCounts = async (
  ref: StaffPageRef
): Promise<{ students: number; unlocks: Record<string, number> } | null> => {
  const scope = await staffScope(ref);
  if (!scope) return null;

  const groups = scope.studentIds.length
    ? await getPrisma().pageSectionUnlock.groupBy({
        by: ['block_id'],
        where: {
          page_id: scope.pageId,
          classroom_id: scope.classroomId,
          user_id: { in: scope.studentIds },
        },
        _count: { _all: true },
      })
    : [];

  const unlocks: Record<string, number> = {};
  for (const group of groups) unlocks[group.block_id] = group._count._all;
  return { students: scope.studentIds.length, unlocks };
};

/**
 * How many current students checked each checkable heading of a page. Null
 * when the page is not in the classroom. (Checks carry no classroom column:
 * the page scope and the student set are the scope.)
 */
export const checkCounts = async (
  ref: StaffPageRef
): Promise<{ students: number; checks: Record<string, number> } | null> => {
  const scope = await staffScope(ref);
  if (!scope) return null;

  const groups = scope.studentIds.length
    ? await getPrisma().pageSectionCheck.groupBy({
        by: ['block_id'],
        where: { page_id: scope.pageId, user_id: { in: scope.studentIds } },
        _count: { _all: true },
      })
    : [];

  const checks: Record<string, number> = {};
  for (const group of groups) checks[group.block_id] = group._count._all;
  return { students: scope.studentIds.length, checks };
};

export interface SectionActivityEntry {
  blockId: string;
  userId: string;
  name: string | null;
  /** Git username on the classroom's provider. */
  login: string | null;
  avatarUrl: string | null;
  /** When the student unlocked (unlocks) or checked (checks). */
  at: Date;
}

export interface SectionActivity {
  students: number;
  /** Newest first. */
  unlocks: SectionActivityEntry[];
  /** Newest first. */
  checks: SectionActivityEntry[];
}

const ACTIVITY_USER_SELECT = {
  id: true,
  name: true,
  image: true,
  accounts: GIT_IDENTITY.accounts,
} as const;

/**
 * Who unlocked and who checked what on a page, current students only, newest
 * first. `blockId` narrows both lists to one block; `only` reads one of the two
 * lists (the other comes back empty and is never queried). Null when the page
 * is not in the classroom or an id is unusable.
 */
export const sectionActivity = async (
  args: StaffPageRef & { blockId?: string; only?: 'unlocks' | 'checks' }
): Promise<SectionActivity | null> => {
  const { blockId, only } = args;
  if (blockId !== undefined && !isBlockId(blockId)) return null;
  const scope = await staffScope(args);
  if (!scope) return null;
  if (scope.studentIds.length === 0) return { students: 0, unlocks: [], checks: [] };

  const prisma = getPrisma();
  const block = blockId !== undefined ? { block_id: blockId } : {};
  const [provider, unlockRows, checkRows] = await Promise.all([
    findClassroomGitProvider(scope.classroomId),
    only === 'checks'
      ? []
      : prisma.pageSectionUnlock.findMany({
          where: {
            page_id: scope.pageId,
            classroom_id: scope.classroomId,
            user_id: { in: scope.studentIds },
            ...block,
          },
          orderBy: [{ unlocked_at: 'desc' }, { id: 'asc' }],
          select: { block_id: true, unlocked_at: true, user: { select: ACTIVITY_USER_SELECT } },
        }),
    only === 'unlocks'
      ? []
      : prisma.pageSectionCheck.findMany({
          where: { page_id: scope.pageId, user_id: { in: scope.studentIds }, ...block },
          orderBy: [{ checked_at: 'desc' }, { id: 'asc' }],
          select: { block_id: true, checked_at: true, user: { select: ACTIVITY_USER_SELECT } },
        }),
  ]);

  const entry = (
    row: {
      block_id: string;
      user: {
        id: string;
        name: string | null;
        image: string | null;
        accounts: GitIdentityAccount[];
      };
    },
    at: Date
  ): SectionActivityEntry => ({
    blockId: row.block_id,
    userId: row.user.id,
    name: row.user.name,
    login: gitUsername(row.user, provider),
    avatarUrl: row.user.image,
    at,
  });

  return {
    students: scope.studentIds.length,
    unlocks: unlockRows.map(row => entry(row, row.unlocked_at)),
    checks: checkRows.map(row => entry(row, row.checked_at)),
  };
};
