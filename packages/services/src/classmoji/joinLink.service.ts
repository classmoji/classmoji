import { randomBytes } from 'node:crypto';
import getPrisma from '@classmoji/database';
import type { Prisma } from '@prisma/client';
import * as classroomInviteService from './classroomInvite.service.ts';

/**
 * The shareable class invite link, `/join/<code>`: the Github Classroom way of
 * filling a roster. Anyone signed in who opens it while it is on joins as a
 * STUDENT, with no email from Classmoji in between. A pasted roster still
 * works alongside it; a student whose verified address is on it is matched to
 * their invite as they join.
 *
 * The code is the only key. The classroom a join lands in is always the one
 * the code names, never an id the client sent.
 */

/** 16 url-safe characters, 96 random bits: not guessable, short enough to paste. */
export const generateJoinCode = (): string => randomBytes(12).toString('base64url');

/** The shape a code may have before it reaches the database. */
const JOIN_CODE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface JoinLinkState {
  enabled: boolean;
  /** Null until the link is first turned on. */
  code: string | null;
}

export const getJoinLink = async (classroomId: string): Promise<JoinLinkState> => {
  const classroom = await getPrisma().classroom.findUnique({
    where: { id: classroomId },
    select: { join_code: true, join_link_enabled: true },
  });
  if (!classroom) throw new Error(`[joinLink] classroom ${classroomId} not found`);
  return { enabled: classroom.join_link_enabled, code: classroom.join_code };
};

/**
 * Turn the link on or off, and/or replace its code. Turning it on the first
 * time mints a code; `reset` mints a new one, so the old link stops working at
 * once. Turning it off keeps the code, so turning it back on revives the same
 * link (reset if it leaked).
 */
export const updateJoinLink = async (
  classroomId: string,
  { enabled, reset = false }: { enabled?: boolean; reset?: boolean }
): Promise<JoinLinkState> => {
  const current = await getJoinLink(classroomId);
  const nextEnabled = enabled ?? current.enabled;
  const needsCode = reset || (nextEnabled && !current.code);
  const updated = await getPrisma().classroom.update({
    where: { id: classroomId },
    data: {
      join_link_enabled: nextEnabled,
      ...(needsCode ? { join_code: generateJoinCode() } : {}),
    },
    select: { join_code: true, join_link_enabled: true },
  });
  return { enabled: updated.join_link_enabled, code: updated.join_code };
};

const JOINABLE_CLASSROOM = {
  id: true,
  name: true,
  slug: true,
  status: true,
  is_archived: true,
  is_example: true,
  join_link_enabled: true,
  git_organization: { select: { provider: true, login: true, base_url: true } },
} satisfies Prisma.ClassroomSelect;

export type JoinableClassroom = Prisma.ClassroomGetPayload<{ select: typeof JOINABLE_CLASSROOM }>;

export type JoinLinkLookup =
  | { ok: true; classroom: JoinableClassroom }
  /**
   * `inactive` covers every refusal (unknown code, link off, classroom locked,
   * unpublished or archived) with one answer, so a code reveals nothing about
   * a classroom it does not let you into.
   */
  | { ok: false; reason: 'inactive' };

/**
 * The classroom a code lets people into right now, or `inactive`. Only an
 * ACTIVE, non-archived, non-example classroom with its link on accepts joins:
 * a LOCKED classroom refuses changes, and an unpublished or archived one is
 * not taking students.
 */
export const findJoinableClassroom = async (code: string): Promise<JoinLinkLookup> => {
  if (!JOIN_CODE_PATTERN.test(code)) return { ok: false, reason: 'inactive' };
  const classroom = await getPrisma().classroom.findUnique({
    where: { join_code: code },
    select: JOINABLE_CLASSROOM,
  });
  if (
    !classroom ||
    !classroom.join_link_enabled ||
    classroom.status !== 'ACTIVE' ||
    classroom.is_archived ||
    classroom.is_example
  ) {
    return { ok: false, reason: 'inactive' };
  }
  return { ok: true, classroom };
};

export type JoinByCodeResult =
  | { status: 'inactive' }
  /** Not a verified email yet: they finish registration first. */
  | { status: 'needs_email' }
  /** Already on this classroom's roster or staff: nothing was written. */
  | { status: 'already_member'; classroom: JoinableClassroom; roles: string[] }
  | {
      status: 'joined';
      classroom: JoinableClassroom;
      membershipId: string;
      /** A pasted-roster invite for one of their addresses was used up. */
      matchedRosterInvite: boolean;
    };

/**
 * Join the classroom a code names as a STUDENT. The membership starts pending
 * (`has_accepted_invite: false`), exactly like a roster add: the git step
 * (Github org invite, or Gitlab activation) is what makes it active.
 *
 * Idempotent: a second call finds the membership and writes nothing. Staff of
 * the classroom are never given a student role by opening the link.
 */
export const joinByCode = async ({
  userId,
  code,
}: {
  userId: string;
  code: string;
}): Promise<JoinByCodeResult> => {
  const lookup = await findJoinableClassroom(code);
  if (!lookup.ok) return { status: 'inactive' };
  const { classroom } = lookup;
  const prisma = getPrisma();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  if (!user?.email || !user.emailVerified) return { status: 'needs_email' };

  const existing = await prisma.classroomMembership.findMany({
    where: { classroom_id: classroom.id, user_id: userId },
    select: { role: true },
  });
  if (existing.length > 0) {
    return { status: 'already_member', classroom, roles: existing.map(m => m.role) };
  }

  // A pasted roster may already name them: claiming makes that invite their
  // membership (every classroom it covers, this one included) and removes it,
  // so the roster shows one row for them, not an invite beside a student.
  let matchedRosterInvite = false;
  try {
    const { classroomIds } = await classroomInviteService.claimPendingInvites(userId);
    matchedRosterInvite = classroomIds.includes(classroom.id);
  } catch (error: unknown) {
    console.error('[joinLink] claiming roster invites failed:', error);
  }

  await prisma.classroomMembership.createMany({
    data: [
      { classroom_id: classroom.id, user_id: userId, role: 'STUDENT', has_accepted_invite: false },
    ],
    skipDuplicates: true,
  });
  const membership = await prisma.classroomMembership.findFirstOrThrow({
    where: { classroom_id: classroom.id, user_id: userId, role: 'STUDENT' },
    select: { id: true },
  });

  return { status: 'joined', classroom, membershipId: membership.id, matchedRosterInvite };
};
