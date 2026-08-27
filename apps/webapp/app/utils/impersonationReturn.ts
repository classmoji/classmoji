/**
 * Where "Stop viewing" should land after an in-app "View as".
 *
 * The banner used to work this out on the way OUT, by parsing a class slug from
 * whatever page the session happened to be on and rebuilding an `/admin/...`
 * URL from it. That guesses twice: at the classroom, and at the actor's role in
 * it. An impersonated session can move between classrooms, and the actor is not
 * necessarily an owner of the one it ended up in — `/admin/:class/**` is closed
 * to non-owner navigation, so the guess could land on a 403 the moment
 * impersonation ended.
 *
 * So the origin is recorded on the way IN instead. The page the actor was
 * standing on when they clicked "View as" is a page they could open a moment
 * earlier, which makes it the one target that needs no guessing at all.
 *
 * sessionStorage, not a cookie: this is per-tab UI state that the server never
 * reads, and a tab that never started an impersonation should not inherit
 * another tab's return path. A tab with no record falls back to the classroom
 * picker, which is always reachable.
 */

const RETURN_KEY = 'cm_impersonation_return';

/**
 * A path we are willing to navigate to: same-document, absolute, and not
 * protocol-relative (`//evil.example` is a valid pathname prefix but an
 * off-origin destination).
 */
const isSafeReturnPath = (path: string): boolean => path.startsWith('/') && !path.startsWith('//');

/** Record the page an impersonation is being started FROM. */
export const rememberImpersonationReturn = (path: string = window.location.pathname) => {
  if (!isSafeReturnPath(path)) return;
  try {
    window.sessionStorage.setItem(RETURN_KEY, path);
  } catch {
    // Storage can be unavailable (private mode, disabled). The banner falls
    // back to the picker, so failing to record is degraded, never broken.
  }
};

/**
 * Read and consume the recorded origin. Returns null when nothing was recorded
 * in this tab, or when what was recorded is not a path we would navigate to.
 */
export const takeImpersonationReturn = (): string | null => {
  try {
    const stored = window.sessionStorage.getItem(RETURN_KEY);
    window.sessionStorage.removeItem(RETURN_KEY);
    return stored && isSafeReturnPath(stored) ? stored : null;
  } catch {
    return null;
  }
};

/** Drop any recorded origin without navigating to it. */
export const clearImpersonationReturn = () => {
  try {
    window.sessionStorage.removeItem(RETURN_KEY);
  } catch {
    // See rememberImpersonationReturn.
  }
};
