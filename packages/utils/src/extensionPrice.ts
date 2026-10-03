/**
 * The price, in tokens, of one extension hour on an assignment: the
 * assignment's own price when it sets one, otherwise the classroom's default
 * (`ClassroomSettings.default_tokens_per_hour`). 0 means no extensions are
 * sold. An assignment's 0 is deliberate and wins over the classroom default.
 */
export const effectiveTokensPerHour = (
  assignmentPrice: number | null | undefined,
  classroomDefault: number | null | undefined
): number => assignmentPrice ?? classroomDefault ?? 0;
