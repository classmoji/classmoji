/**
 * "Where to go next" values (`?next=`, `?returnTo=`, `?returnUrl=`): only a
 * path on the app's own origin is followed.
 *
 * The rule:
 * - one leading `/`, and the second character is neither `/` nor `\`;
 * - no `\` anywhere;
 * - printable ASCII only (0x20 to 0x7E): no control characters, nothing
 *   outside ASCII. The space stays allowed: `URLSearchParams` reads `+` as a
 *   space, so a query such as `?q=a+b` inside the value arrives with one;
 * - resolved against a placeholder origin, the result keeps that origin, and
 *   its path does not begin with `//` (dot segments such as `/..//x` resolve
 *   to the path `//x`, which reads as a host once it is a value of its own).
 *
 * Percent-encoded characters stay encoded in the path (`/%5Cx` is the path
 * `/%5Cx` on this origin), so the checks above cover them as they are.
 *
 * Dependency-free and isomorphic: servers and browsers both use it.
 */

const PLACEHOLDER_ORIGIN = 'http://x';

/** Anything outside printable ASCII. A codepoint scan, so none appear in this file. */
const hasNonPrintableAscii = (value: string): boolean => {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return true;
  }
  return false;
};

/** Whether `value` is a path on this app's own origin, by the rule above. */
export const isSafeReturnPath = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  if (!value.startsWith('/')) return false;
  if (value[1] === '/' || value[1] === '\\') return false;
  if (value.includes('\\')) return false;
  if (hasNonPrintableAscii(value)) return false;
  try {
    const resolved = new URL(value, PLACEHOLDER_ORIGIN);
    return resolved.origin === PLACEHOLDER_ORIGIN && !resolved.pathname.startsWith('//');
  } catch {
    return false;
  }
};

/** `value` when it is a path on this app's own origin, else `fallback`. */
export const safeReturnPath = <T>(value: unknown, fallback: T): string | T =>
  isSafeReturnPath(value) ? value : fallback;
