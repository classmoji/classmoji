import { safeReturnPath } from '@classmoji/utils/return-path';

/**
 * A `?from=` value is only honoured when it is a path inside this app, by the
 * shared return-path rule (`@classmoji/utils/return-path`).
 */
export const safeReturn = (from: string | null, fallback: string): string =>
  safeReturnPath(from, fallback);
