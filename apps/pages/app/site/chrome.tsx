import { Link } from 'react-router';

/**
 * Shared chrome for class websites.
 *
 * Everything here renders to plain HTML + Tailwind classes. There is no
 * client bundle on these pages, so any `onClick`, any state, any component
 * that needs to mount is dead weight that renders once and never responds.
 * Links and `<details>` are the entire interaction vocabulary.
 */

export type IdentityBarProps = {
  courseName: string;
  /** Signed-in member's display name, or null for anonymous visitors. */
  memberName?: string | null;
  /** Deep link into the app for members ("Open in Classmoji"). */
  appHref?: string | null;
  /** Sign-in interstitial path (anonymous visitors only). */
  signInHref?: string | null;
};

/** Two initials for the avatar chip — never more, never an empty circle. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * The minimal identity bar: course name on the left (links home), viewer
 * state on the right. Deliberately not a nav — navigation on a class site is
 * authored content (the page directory block), not chrome.
 */
export function IdentityBar({ courseName, memberName, appHref, signInHref }: IdentityBarProps) {
  return (
    <header className="border-b border-stone-200 dark:border-neutral-800 bg-white/90 dark:bg-[#191919]/90">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link
          to="/"
          className="truncate text-sm font-semibold text-gray-900 no-underline hover:text-gray-600 dark:text-gray-100 dark:hover:text-gray-300"
        >
          {courseName}
        </Link>

        <div className="flex shrink-0 items-center gap-3">
          {memberName ? (
            <span className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
              <span
                aria-hidden="true"
                className="flex h-6 w-6 items-center justify-center rounded-full bg-stone-200 text-[10px] font-semibold text-gray-700 dark:bg-neutral-700 dark:text-gray-200"
              >
                {initialsOf(memberName)}
              </span>
              <span className="hidden sm:inline">{memberName}</span>
            </span>
          ) : null}

          {appHref ? (
            <a
              href={appHref}
              className="rounded-full border border-stone-300 px-3 py-1 text-sm text-gray-700 no-underline hover:bg-stone-50 dark:border-neutral-700 dark:text-gray-200 dark:hover:bg-neutral-800"
            >
              Open in Classmoji
            </a>
          ) : null}

          {signInHref ? (
            <Link
              to={signInHref}
              className="rounded-full bg-gray-900 px-3 py-1 text-sm text-white no-underline hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
            >
              Sign in
            </Link>
          ) : null}
        </div>
      </div>
    </header>
  );
}

/** The one-line footer every site page ends with. */
export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-stone-200 py-6 dark:border-neutral-800">
      <div className="mx-auto max-w-5xl px-4 text-xs text-gray-500 sm:px-6 dark:text-gray-500">
        Powered by{' '}
        <a
          href="https://classmoji.io"
          className="text-gray-600 underline hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
        >
          Classmoji
        </a>
      </div>
    </footer>
  );
}

export type SiteNoticeProps = {
  title: string;
  message: string;
  /** Optional call to action rendered under the message. */
  action?: { href: string; label: string; external?: boolean } | null;
};

/**
 * The branded full-page state used for every 403/404/503 on a class site.
 *
 * One component for all of them because the visitor's question is always the
 * same ("is this thing broken, or am I in the wrong place?") and the answer is
 * always a sentence plus at most one link.
 */
export function SiteNotice({ title, message, action }: SiteNoticeProps) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <h1 className="mb-2 text-2xl font-semibold text-gray-900 dark:text-gray-100">{title}</h1>
      <p className="max-w-md text-gray-600 dark:text-gray-400">{message}</p>
      {action ? (
        <a
          href={action.href}
          {...(action.external ? { rel: 'noopener noreferrer' } : {})}
          className="mt-6 rounded-full bg-gray-900 px-4 py-2 text-sm text-white no-underline hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
        >
          {action.label}
        </a>
      ) : null}
    </div>
  );
}

/** The staff-only "Edit page →" pill, anchored to the editor on the app host. */
export function EditPagePill({ href }: { href: string }) {
  return (
    <div className="mb-4">
      <a
        href={href}
        className="inline-flex items-center gap-1 rounded-full border border-stone-300 px-3 py-1 text-xs font-medium text-gray-600 no-underline hover:bg-stone-50 dark:border-neutral-700 dark:text-gray-300 dark:hover:bg-neutral-800"
      >
        Edit page →
      </a>
    </div>
  );
}

/**
 * The page cover, reproducing the editor's composition statically.
 *
 * The editor renders a cover as a background image on a fixed-height div
 * (`.page-header-image`, styled in page-viewer.css) so a repositioned image
 * keeps the framing its author chose. Using the same markup here means a page
 * looks identical on the site and in the editor, without the drag handles and
 * hover controls coming along for the ride.
 *
 * The URL goes through `JSON.stringify` so it lands inside quotes in the CSS
 * `url()` with any quote characters escaped — an unquoted `url()` would let a
 * crafted image URL close the declaration and inject CSS.
 */
export function CoverImage({
  coverImage,
}: {
  coverImage?: { url: string; position?: number } | null;
}) {
  if (!coverImage?.url) return null;
  return (
    <div
      className="page-header-image relative w-full overflow-hidden"
      style={{
        backgroundImage: `url(${JSON.stringify(coverImage.url)})`,
        backgroundPosition: `center ${coverImage.position ?? 50}%`,
      }}
    />
  );
}
