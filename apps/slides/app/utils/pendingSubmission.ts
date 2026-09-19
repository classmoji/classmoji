/**
 * Pending-submission helpers for the slide create/replace/link screens.
 *
 * Both functions are pure and DOM-free so they can be unit tested without a
 * browser — see `tests/unit/pending-submission.spec.ts`.
 */

/** The slice of `useNavigation()` that decides whether a form is mid-flight. */
export type NavigationLike = {
  state: 'idle' | 'loading' | 'submitting';
  formMethod?: string | null;
};

/**
 * Is a form submission still in flight?
 *
 * `submitting` is the upload itself — React Router sets it the moment it starts
 * the fetch, and holds it until the action answers, which for a 35 MB file is
 * the whole wait. It is not the whole story though: once the action returns,
 * the navigation drops to `loading` while loaders revalidate or a redirect is
 * followed, and the form is still not usable then. `formMethod` is what tells
 * that phase apart from an ordinary GET navigation happening alongside it.
 *
 * When the action returns an ERROR this goes false again as soon as the
 * navigation settles to `idle`, which is what clears the pending UI and hands
 * the form back with the message showing.
 */
export function isSubmissionPending(navigation: NavigationLike): boolean {
  if (navigation.state === 'idle') return false;
  if (navigation.state === 'submitting') return true;
  // state === 'loading': only ours if it is the tail of a mutation.
  const method = navigation.formMethod;
  return typeof method === 'string' && method.toUpperCase() !== 'GET';
}

/**
 * A byte count a person can read: `41.2 MB`, `812.0 KB`, `0 B`.
 *
 * Binary units (1 KB = 1024 B), matching `SLIDE_FILE_MAX_BYTES` and the "up to
 * 35 MB" the form promises — quoting a file in decimal MB next to a limit
 * measured in binary ones is how a file that fits looks like one that doesn't.
 * Whole bytes below 1 KB, one decimal above it.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  // `1023.95`, not `1024`: one decimal place rounds 1023.999 up, and a file
  // 512 bytes shy of a megabyte should read "1.0 MB", never "1024.0 KB".
  while (value >= 1023.95 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
