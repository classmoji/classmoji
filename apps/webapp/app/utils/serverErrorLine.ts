/** An `error` made only of capitals, digits and underscores is a code, not a line. */
const BARE_CODE = /^[A-Z0-9_]+$/;

/**
 * The line a failed JSON reply carries for the person using the page, if any.
 *
 * `message` comes first: the classroom-status gate answers
 * `{ error: 'CLASSROOM_LOCKED', message: <text> }`, so there `error` is a code
 * and `message` is the line. Otherwise `error` is used when it reads as text.
 * A bare code, a missing or empty field, or a body that isn't an object all
 * answer null, and the caller shows its own fixed copy.
 */
export const serverErrorLine = (body: unknown): string | null => {
  if (!body || typeof body !== 'object') return null;
  const { message, error } = body as { message?: unknown; error?: unknown };
  if (typeof message === 'string' && message.trim()) return message;
  if (typeof error === 'string' && error.trim() && !BARE_CODE.test(error.trim())) return error;
  return null;
};
