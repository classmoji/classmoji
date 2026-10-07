import type { Prisma } from '@prisma/client';

/** What `ClassmojiService.classroom.updateSettings` accepts. */
type SettingsInput = Prisma.ClassroomSettingsUncheckedCreateWithoutClassroomInput;

/**
 * The settings fields a Settings tab may write, taken from its request body.
 *
 * `updateSettings` upserts whatever object it is given over the whole
 * `classroom_settings` row, so an action that passes the raw body lets anyone
 * who can POST to it set any column there. Each action lists the fields its own
 * form sends; everything else in the body is ignored, and a listed field the
 * body leaves out (or sends as `undefined`) is not written. Values are passed
 * through as sent: any checks on them stay with the action.
 */
export const pickSettings = <const K extends keyof SettingsInput>(
  body: unknown,
  fields: readonly K[]
): Pick<SettingsInput, K> => {
  const source = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const picked: Partial<Record<K, unknown>> = {};
  for (const field of fields) {
    if (Object.hasOwn(source, field) && source[field] !== undefined) {
      picked[field] = source[field];
    }
  }
  return picked as Pick<SettingsInput, K>;
};
