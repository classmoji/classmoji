/**
 * `returnTo` validation for the class-site sign-in interstitial.
 *
 * Pure and dependency-free so it can be unit tested directly — it is the only
 * place a URL supplied by an anonymous visitor is turned into something the
 * app will later navigate to, which makes it the open-redirect surface of the
 * whole feature.
 *
 * The rule is "same-site absolute path, or nothing". Not "looks safe": every
 * classic bypass (`//evil.test`, `/\evil.test`, `https://evil.test`, a CR/LF
 * smuggled into a Location header) is rejected by shape, and anything
 * rejected silently becomes `/`.
 */

/** Longer than any real page path; a giant value is an attack, not a link. */
const MAX_LENGTH = 512;

/** The path the interstitial itself lives at — never a valid destination. */
const SIGN_IN_PATH = '/sign-in';

export const DEFAULT_RETURN_TO = '/';

/**
 * Control bytes, DEL and the space — none belong in a path we minted.
 *
 * A codepoint scan rather than a character-class regex, so the control
 * characters this rejects never have to appear literally in this file (where
 * an editor, a formatter or a copy-paste could quietly mangle them).
 */
function hasUnsafeBytes(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function sanitizeReturnTo(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return DEFAULT_RETURN_TO;

  const value = raw.trim();
  if (!value || value.length > MAX_LENGTH) return DEFAULT_RETURN_TO;

  // Must be an absolute path on this site. A single leading slash only:
  // `//evil.test` is a protocol-relative URL, and browsers follow it.
  if (!value.startsWith('/')) return DEFAULT_RETURN_TO;
  if (value.startsWith('//')) return DEFAULT_RETURN_TO;

  // `/\evil.test` is treated as protocol-relative by several browsers, and a
  // backslash has no legitimate place in a path we generated.
  if (value.includes('\\')) return DEFAULT_RETURN_TO;

  // CR/LF header injection, NUL, tabs, raw spaces.
  if (hasUnsafeBytes(value)) return DEFAULT_RETURN_TO;

  // Bouncing back to the interstitial would loop forever.
  const path = value.split(/[?#]/)[0];
  if (path === SIGN_IN_PATH || path.startsWith(`${SIGN_IN_PATH}/`)) return DEFAULT_RETURN_TO;

  return value;
}

/**
 * Build the sign-in URL for a path the visitor could not see.
 *
 * The destination is re-sanitized on the way in as well as on the way out, so
 * a caller that forgot cannot widen the surface.
 */
export function signInPathFor(returnTo: string): string {
  const safe = sanitizeReturnTo(returnTo);
  if (safe === DEFAULT_RETURN_TO) return SIGN_IN_PATH;
  return `${SIGN_IN_PATH}?returnTo=${encodeURIComponent(safe)}`;
}
