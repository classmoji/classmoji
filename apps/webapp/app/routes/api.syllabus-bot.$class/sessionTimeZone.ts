import { canonicalTimeZone, resolveEffectiveTimeZone, type TimeZoneSource } from '@classmoji/utils';

/**
 * The zone this Ask Moji session states dates in, and where it came from.
 *
 * Order (@classmoji/utils resolveEffectiveTimeZone): the classroom's own
 * setting, then the student's browser zone sent at session start, then UTC.
 * Every candidate is validated against Intl; an invalid browser zone is ignored.
 *
 * - `timezone` / `timezoneSource` feed the prompt's session-start "now" line and
 *   its course-time-zone line (null on the UTC default, so it says "not set").
 * - `callerTimezone` is forwarded to the MCP server as `X-Classmoji-Timezone`,
 *   which applies it to `_local` fields only when the classroom has no zone —
 *   the same order, decided again server-side.
 *
 * PRESENTATION ONLY, like the role above: a zone changes how a date is printed,
 * never what anyone may see.
 */
export function sessionTimeZone(
  classroomZone: string | null | undefined,
  browserZone: FormDataEntryValue | null
): { timezone: string | null; timezoneSource: TimeZoneSource; callerTimezone: string | null } {
  const callerTimezone = canonicalTimeZone(typeof browserZone === 'string' ? browserZone : null);
  const effective = resolveEffectiveTimeZone(classroomZone, callerTimezone);
  return {
    timezone: effective.source === 'default' ? null : effective.timeZone,
    timezoneSource: effective.source,
    callerTimezone,
  };
}
