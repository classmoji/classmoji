/**
 * Pending-state pieces shared by the slide create / replace / edit-link forms.
 *
 * All three screens post a plain React Router `<Form>` and wait on the server.
 * Two of those waits are long — a file slide streams up to 35 MB and then
 * commits it to a GitHub repo — and until now the only sign of life was the
 * submit button's label changing, which reads as a frozen page.
 *
 * Nothing here touches how a form is submitted or what the action receives.
 * These are three presentational bits driven by one boolean:
 *
 *   - `PendingSubmitButton` — spinner + label, disabled so it cannot fire twice.
 *   - `PendingCancelLink` — the `<a>` escape hatches, made inert mid-flight.
 *   - `UploadPendingPanel` — the file-upload status panel (see the note on its
 *     own docblock about why it does NOT arm a `beforeunload` prompt).
 *
 * Styling is the design-system tokens from `@classmoji/ui-components`, which
 * `tokens.css` redefines under `html.dark` — so both themes come free and there
 * is no `dark:` variant to keep in step.
 */

import { Spinner } from '~/components/Spinner';
import { formatBytes } from '~/utils/pendingSubmission';

/**
 * The primary submit for a form that waits on the server.
 *
 * While pending it shows the spinner beside `pendingLabel` and is `disabled`,
 * which is what actually prevents a second submission — a 35 MB upload fired
 * twice is two commits racing for the same content path.
 */
export function PendingSubmitButton({
  pending,
  pendingLabel,
  children,
  className = 'btn btn-primary',
}: {
  pending: boolean;
  /** What the button says while the server is working. */
  pendingLabel: string;
  /** What it says at rest. */
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending || undefined}
      className={`${className} disabled:cursor-not-allowed disabled:opacity-70`}
    >
      {pending ? (
        <>
          {/* Decorative: the label right beside it is the announcement. */}
          <Spinner label={null} className="h-4 w-4" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}

/**
 * A Cancel link that stops being a link while a submission is in flight.
 *
 * `<a>` has no `disabled`, so this is the three things that stand in for one:
 * out of the tab order, not clickable, and announced as disabled. Leaving the
 * page mid-upload would abort the request — the point is to make that take
 * deliberate effort rather than one stray click.
 */
export function PendingCancelLink({
  href,
  pending,
  className = 'btn',
  children = 'Cancel',
}: {
  href: string;
  pending: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className={`${className}${pending ? ' pointer-events-none opacity-50' : ''}`}
      aria-disabled={pending || undefined}
      tabIndex={pending ? -1 : undefined}
      onClick={pending ? event => event.preventDefault() : undefined}
    >
      {children}
    </a>
  );
}

/** The one honest sentence about what the wait is. No invented percentage. */
const UPLOAD_MESSAGE =
  "Uploading and saving to your course's content repository. Large files can take a " +
  'minute or two — keep this tab open.';

/**
 * The inline status panel under a file field, shown only while the upload runs.
 *
 * The progress bar is INDETERMINATE on purpose. The browser reports how much of
 * the body it has sent, but the commit to GitHub afterwards is an unknown share
 * of the wait, so any percentage we drew would be a guess presented as a fact —
 * and a bar that sits at 100% for thirty seconds is worse than one that keeps
 * moving without claiming to know.
 *
 * ## Why there is no `beforeunload` guard here
 *
 * A "you'll lose this upload" prompt was the obvious companion to this panel,
 * and it CANNOT work on these two screens. On success the action returns
 * `redirect(slidesListUrl)` — an absolute URL to the webapp, a different origin
 * — and React Router turns a cross-origin redirect into
 * `window.location.assign()` (`startRedirectNavigation`, guarded by
 * `isDocumentReload`). That assign is the same unload a `beforeunload` handler
 * exists to interrupt, so every SUCCESSFUL upload would end in "Leave site?".
 *
 * There is no window in which to disarm the guard first: the router never
 * re-renders between the action's response and the assign — `handleAction`
 * goes straight from the `submitting` state into `startRedirectNavigation`,
 * which calls `location.assign` synchronously — so no effect cleanup, ref or
 * state flag can run in between. Measured in Chrome, not reasoned about: the
 * probe's cross-origin `location.assign` never navigated, and the tab reported
 * `Navigation was blocked by a "Leave site?" dialog`.
 *
 * Shipping it anyway would be worse than nothing. "Leave" costs an extra click
 * on every upload; "Cancel" aborts the redirect and strands the author on a
 * page that still looks busy, next to a slide that WAS created — the shape of
 * mistake that ends in a duplicate.
 *
 * What is left in its place is the part that works: the Cancel links and every
 * input are inert while the upload runs, so the common accident — clicking away
 * mid-flight — cannot happen. Closing the tab still loses the upload silently.
 * Fixing that properly means removing the cross-origin hop (have the action
 * answer with data and let the client navigate), not re-adding the handler.
 */
export function UploadPendingPanel({
  file,
  message = UPLOAD_MESSAGE,
}: {
  /** The file being sent, for the name · size line. */
  file: { name: string; size: number } | null;
  message?: string;
}) {
  return (
    <div
      aria-live="polite"
      className="mt-3 rounded-[10px] border border-[var(--line)] bg-[var(--panel-tint)] px-4 py-3"
    >
      <div className="flex items-center gap-2.5">
        <Spinner label={null} className="h-4 w-4 shrink-0 text-[var(--accent)]" />
        <p className="min-w-0 break-all text-sm font-medium text-[var(--ink-0)]">
          {file ? `${file.name} · ${formatBytes(file.size)}` : 'Uploading your file'}
        </p>
      </div>

      <div className="cm-progress-indeterminate mt-3 h-1.5 w-full rounded-full bg-[var(--line)]" />

      <p className="mt-2 text-xs leading-relaxed text-[var(--ink-3)]">{message}</p>
    </div>
  );
}
