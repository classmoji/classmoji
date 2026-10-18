/**
 * Whether this request's viewer gets the Ask Moji launcher on a deck, plus the
 * webapp origin its frame loads from and the deck's classroom slug.
 *
 * Derived only from what `assertSlideAccess` answered for the session user and
 * the slide row the loader read, never from anything the client sent. The
 * cheap checks (runtime switch, a configured webapp origin, how the viewer was
 * let in) run first, so a classroom without Ask Moji costs no extra query. The
 * rule itself is `askMojiHostDecision`.
 */
import getPrisma from '@classmoji/database';
import { findClassroomRole } from '@classmoji/auth/classroom-role';

import { askMojiHostDecision, type SlideAccessVia } from '~/components/askMoji/askMojiProtocol';

export interface AskMojiHostData {
  askMojiEnabled: boolean;
  /** The webapp origin the frame loads from; null unless enabled. */
  askMojiOrigin: string | null;
  /** The deck's classroom slug; null unless enabled. */
  classroomSlug: string | null;
}

const DISABLED: AskMojiHostData = {
  askMojiEnabled: false,
  askMojiOrigin: null,
  classroomSlug: null,
};

export async function askMojiHostData({
  userId,
  accessGrantedVia,
  slide,
}: {
  userId: string | null | undefined;
  accessGrantedVia: SlideAccessVia | undefined;
  slide: { classroom_id: string; classroom?: { slug?: string | null } | null };
}): Promise<AskMojiHostData> {
  const classroomSlug = slide.classroom?.slug;
  const base = {
    via: accessGrantedVia,
    runtime: process.env.ASK_MOJI_RUNTIME,
    webappUrl: process.env.WEBAPP_URL,
  };
  // Everything but the classroom's own state first: if that says no, skip the queries.
  if (
    !userId ||
    !classroomSlug ||
    !askMojiHostDecision({ ...base, acceptedRole: 'STUDENT', botEnabled: true }).enabled
  ) {
    return DISABLED;
  }

  try {
    const [acceptedRole, settings] = await Promise.all([
      findClassroomRole({ userId, classroomId: slide.classroom_id, acceptedOnly: true }),
      getPrisma().classroomSettings.findUnique({
        where: { classroom_id: slide.classroom_id },
        select: { syllabus_bot_enabled: true },
      }),
    ]);
    const decision = askMojiHostDecision({
      ...base,
      acceptedRole,
      botEnabled: settings?.syllabus_bot_enabled === true,
    });
    return decision.enabled
      ? { askMojiEnabled: true, askMojiOrigin: decision.origin, classroomSlug }
      : DISABLED;
  } catch (error) {
    console.warn('[slides] Ask Moji availability check failed:', error);
    return DISABLED;
  }
}
