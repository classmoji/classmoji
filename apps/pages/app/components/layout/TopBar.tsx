import { IconMenu2 } from '@tabler/icons-react';
import { Logo } from '@classmoji/ui-components/logo';
import { isPlaceholderAvatar } from '@classmoji/utils';

import gitlabLogo from '~/components/ui/gitlab.svg';
import type { ClassroomSummary, PagesUser } from '~/types/pages.ts';

interface TopBarProps {
  classroom: ClassroomSummary;
  /** The webapp's origin: the Classmoji logo goes there. */
  webappUrl: string;
  /**
   * Where the class name takes a member: the webapp page this tab was opened
   * from, else the class dashboard in their own role tree. Null for a reader who
   * is not a member (a public page).
   */
  classHomeUrl: string | null;
  user: Pick<PagesUser, 'name' | 'login' | 'image'> | null;
  /** Opens the page list on phones, where the sidebar is hidden. */
  onMenuClick: () => void;
}

const initialsOf = (text: string | null | undefined): string => {
  const words = (text ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
};

/**
 * The bar across the top of the pages app when it is opened on its own (never
 * in the webapp's reader frame): the Classmoji logo back to the webapp, the
 * class name back to that class, and where the reader is now.
 */
const TopBar = ({ classroom, webappUrl, classHomeUrl, user, onMenuClick }: TopBarProps) => {
  // Signed out: the class name and a "Sign in" button go to the webapp's sign-in
  // page. A signed-in non-member gets plain text: signing in again would change
  // nothing for them.
  const signInHref = !user && !classHomeUrl ? `${webappUrl}/` : null;
  const classHref = classHomeUrl ?? signInHref;
  const classAvatar = classroom.git_organization?.avatar_url || classroom.avatar_url || null;
  const isGitLab = classroom.git_organization?.provider === 'GITLAB';
  const userName = user?.name || user?.login || null;

  const classLabel = (
    <>
      {classAvatar ? (
        <img
          src={classAvatar}
          alt=""
          className="h-5 w-5 rounded-full border border-gray-200 dark:border-gray-600 flex-shrink-0"
        />
      ) : isGitLab ? (
        // Gitlab groups have no avatar we can build: show the Gitlab logo.
        <img src={gitlabLogo} alt="" className="h-5 w-5 flex-shrink-0" />
      ) : null}
      <span className="truncate">{classroom.name}</span>
    </>
  );

  return (
    <div className="h-12 flex-shrink-0 flex items-center justify-between gap-3 px-3 sm:px-4 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-[#191919]">
      <div className="flex items-center gap-2 min-w-0">
        <button
          type="button"
          onClick={onMenuClick}
          className="md:hidden p-1.5 -ml-1 rounded-md text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          aria-label="Open page list"
        >
          <IconMenu2 size={20} />
        </button>

        <nav aria-label="Breadcrumb" className="flex items-center gap-2 min-w-0 text-sm">
          <a
            href={webappUrl}
            className="flex items-center flex-shrink-0 rounded-md px-1 py-0.5 hover:bg-gray-100 dark:hover:bg-gray-800 [--cm-logo-ink:#1a1a1a] dark:[--cm-logo-ink:#ffffff]"
            aria-label="Classmoji"
          >
            <div className="sm:hidden">
              <Logo variant="icon" size={22} />
            </div>
            <div className="hidden sm:flex">
              <Logo variant="full" size={22} />
            </div>
          </a>

          <span aria-hidden="true" className="text-gray-300 dark:text-gray-600">
            /
          </span>

          {classHref ? (
            <a
              href={classHref}
              className="flex items-center gap-1.5 min-w-0 rounded-md px-1.5 py-0.5 font-semibold text-gray-900 hover:bg-gray-100 dark:text-white dark:hover:bg-gray-800"
            >
              {classLabel}
            </a>
          ) : (
            <span className="flex items-center gap-1.5 min-w-0 px-1.5 font-semibold text-gray-900 dark:text-white">
              {classLabel}
            </span>
          )}

          <span aria-hidden="true" className="hidden sm:inline text-gray-300 dark:text-gray-600">
            /
          </span>
          <span
            aria-current="page"
            className="hidden sm:inline font-medium text-gray-500 dark:text-gray-400"
          >
            Pages
          </span>
        </nav>
      </div>

      {user && (
        <span title={userName ?? undefined} className="flex-shrink-0">
          {!isPlaceholderAvatar(user.image) ? (
            <img
              src={user.image as string}
              alt={userName ?? ''}
              className="h-7 w-7 rounded-full border border-gray-200 dark:border-gray-700"
            />
          ) : (
            <span
              role="img"
              aria-label={userName ?? 'You'}
              className="h-7 w-7 rounded-full bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-200 text-[11px] font-semibold grid place-items-center"
            >
              {initialsOf(userName)}
            </span>
          )}
        </span>
      )}

      {signInHref && (
        <a
          href={signInHref}
          className="flex-shrink-0 rounded-md px-3 py-1.5 text-sm font-medium text-gray-700 ring-1 ring-gray-200 hover:bg-gray-50 dark:text-gray-200 dark:ring-gray-700 dark:hover:bg-gray-800"
        >
          Sign in
        </a>
      )}
    </div>
  );
};

export default TopBar;
