export const SCHOOL_ID_MAX_LENGTH = 64;

/**
 * Trim a typed School ID for storage. Empty clears it (null); undefined means
 * the input was not acceptable (too long or not a string) and the caller
 * should refuse it rather than write.
 */
export const normalizeSchoolId = (value: unknown): string | null | undefined => {
  if (value == null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length > SCHOOL_ID_MAX_LENGTH) return undefined;
  return trimmed.length === 0 ? null : trimmed;
};
