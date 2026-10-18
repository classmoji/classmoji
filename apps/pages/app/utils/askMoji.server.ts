/**
 * Whether this request's reader gets the Ask Moji launcher, and the webapp
 * origin its frame loads from.
 *
 * Derived only from the session user and the classroom row the loader read,
 * never from anything the client sent. The cheap checks (runtime switch, a
 * configured webapp origin, a signed-in user, not embedded, the classroom
 * setting) run first, so a classroom without Ask Moji costs no extra query.
 * The rule itself is `askMojiHostDecision`.
 */
import { askMojiHostDecision } from '~/components/askMoji/askMojiProtocol.ts';
import { findClassroomRole } from '~/utils/classroomRole.server.ts';

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
    botEnabled: classroom.settings?.syllabus_bot_enabled === true,
    runtime: process.env.ASK_MOJI_RUNTIME,
    webappUrl: process.env.WEBAPP_URL,
    embedded,
  };
  // Everything but membership first: if that already says no, skip the query.
  if (!userId || !askMojiHostDecision({ ...base, acceptedRole: 'STUDENT' }).enabled) {
    return DISABLED;
  }

  let acceptedRole: string | null = null;
  try {
    acceptedRole = await findClassroomRole({
      userId,
      classroomId: classroom.id,
      acceptedOnly: true,
    });
  } catch (error) {
    console.warn('[pages] Ask Moji membership check failed:', error);
    return DISABLED;
  }

  const decision = askMojiHostDecision({ ...base, acceptedRole });
  return { askMojiEnabled: decision.enabled, askMojiOrigin: decision.origin };
}
