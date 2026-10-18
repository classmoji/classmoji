/**
 * Whether this request's reader gets the Ask Moji launcher, and the webapp
 * origin its frame loads from.
 *
 * Derived only from the session user and the classroom row the loader read,
 * never from anything the client sent. In order, cheapest first:
 *   1. no query: signed in, not embedded, the runtime switch, a configured
 *      webapp origin (`askMojiHostDecision`), and the row's own
 *      `syllabus_bot_enabled` when it already says off;
 *   2. one query: an ACCEPTED member of this classroom;
 *   3. members only: `askMojiSession.askMojiAvailable`, the webapp's own rule
 *      (runtime, Trigger configured, an Anthropic key, Pro, switched on).
 * So a non-member or a classroom without Ask Moji never costs the
 * availability queries. This is for the UI only; the webapp's embed route
 * enforces the real gates.
 */
import { askMojiHostDecision } from '~/components/askMoji/askMojiProtocol.ts';
import { findClassroomRole } from '~/utils/classroomRole.server.ts';
import { ClassmojiService } from '~/utils/db.server.ts';

export interface AskMojiHostData {
  askMojiEnabled: boolean;
  /** The webapp origin the frame loads from; null unless enabled. */
  askMojiOrigin: string | null;
}

const DISABLED: AskMojiHostData = { askMojiEnabled: false, askMojiOrigin: null };

export async function askMojiHostData({
  userId,
  classroom,
  embedded,
}: {
  userId: string | null | undefined;
  classroom: { id: string; settings?: { syllabus_bot_enabled?: boolean | null } | null };
  embedded: boolean;
}): Promise<AskMojiHostData> {
  const base = {
    // Availability decides below; this only lets the pure checks run first.
    botEnabled: true,
    runtime: process.env.ASK_MOJI_RUNTIME,
    webappUrl: process.env.WEBAPP_URL,
    embedded,
  };
  // Everything but membership and availability first: if that says no, skip the queries.
  if (
    !userId ||
    classroom.settings?.syllabus_bot_enabled === false ||
    !askMojiHostDecision({ ...base, acceptedRole: 'STUDENT' }).enabled
  ) {
    return DISABLED;
  }

  try {
    const acceptedRole = await findClassroomRole({
      userId,
      classroomId: classroom.id,
      acceptedOnly: true,
    });
    const decision = askMojiHostDecision({ ...base, acceptedRole });
    if (!decision.enabled) return DISABLED;

    const availability = await ClassmojiService.askMojiSession.askMojiAvailable({
      classroomId: classroom.id,
    });
    return availability.available
      ? { askMojiEnabled: true, askMojiOrigin: decision.origin }
      : DISABLED;
  } catch (error) {
    console.warn('[pages] Ask Moji availability check failed:', error);
    return DISABLED;
  }
}
