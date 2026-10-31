/**
 * Whether this request's viewer gets the Ask Moji launcher on a deck, plus the
 * webapp origin its frame loads from and the deck's classroom slug.
 *
 * Derived only from what `assertSlideAccess` answered for the session user and
 * the slide row the loader read, never from anything the client sent. In
 * order, cheapest first:
 *   1. no query: signed in, the deck has a classroom, let in as a member (never
 *      public or share-code access), the runtime switch, a configured webapp
 *      origin (`askMojiHostDecision`);
 *   2. one query: an ACCEPTED member of the deck's classroom;
 *   3. members only: `askMojiSession.askMojiAvailable`, the webapp's own rule
 *      (runtime, Trigger configured, an Anthropic key, Pro, switched on).
 * So a non-member never costs the availability queries. This is for the UI
 * only; the webapp's embed route enforces the real gates.
 */
import { ClassmojiService } from '@classmoji/services';
import { isAskMojiTriggerRuntime } from '@classmoji/utils/ask-moji';
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
    // The one ASK_MOJI_RUNTIME parse every app shares.
    triggerRuntime: isAskMojiTriggerRuntime(),
    webappUrl: process.env.WEBAPP_URL,
    // Availability decides below; this only lets the pure checks run first.
    botEnabled: true,
  };
  // Everything but membership and availability first: if that says no, skip the queries.
  if (
    !userId ||
    !classroomSlug ||
    !askMojiHostDecision({ ...base, acceptedRole: 'STUDENT' }).enabled
  ) {
    return DISABLED;
  }

  try {
    const acceptedRole = await findClassroomRole({
      userId,
      classroomId: slide.classroom_id,
      acceptedOnly: true,
    });
    const decision = askMojiHostDecision({ ...base, acceptedRole });
    if (!decision.enabled) return DISABLED;

    const availability = await ClassmojiService.askMojiSession.askMojiAvailable({
      classroomId: slide.classroom_id,
    });
    return availability.available
      ? { askMojiEnabled: true, askMojiOrigin: decision.origin, classroomSlug }
      : DISABLED;
  } catch (error) {
    console.warn('[slides] Ask Moji availability check failed:', error);
    return DISABLED;
  }
}
