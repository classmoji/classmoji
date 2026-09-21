import { usePagePeek } from './PagePeekProvider';

/**
 * A link to a classroom page, rendered as whatever the surrounding shell can
 * support.
 *
 * Inside the student/assistant shell (where PagePeekProvider is mounted) it is
 * a button that opens the peek drawer — reading a linked page never navigates
 * away from the tree or calendar you clicked it from. Anywhere else — admin
 * routes, the app-root syllabus-bot overlay — there is no provider and it
 * degrades to exactly the anchor those surfaces rendered before, so converting
 * a shared component does not change admin behaviour.
 */

export interface PageLinkProps {
  pageId: string;
  title: string;
  /** The pre-peek behaviour: the external pages-app URL this site already built. */
  href: string;
  className?: string;
  /**
   * What a screen reader announces, when the visible children are not enough on
   * their own — a truncated title beside an icon, say. Left out, the children
   * name the control as they always did.
   */
  ariaLabel?: string;
  children: React.ReactNode;
}

const PageLink = ({ pageId, title, href, className, ariaLabel, children }: PageLinkProps) => {
  const peek = usePagePeek();

  // The page's title is the pointer tooltip in both branches. Whatever the
  // caller renders inside can be truncated — this is where the whole title is
  // still readable, and it costs nothing where it is not.
  const shared = { className, title, 'aria-label': ariaLabel };

  if (!peek) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" {...shared}>
        {children}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={() => peek.openPeek({ pageId, title })}
      data-cm-page-link={pageId}
      {...shared}
      className={`text-left ${className ?? ''}`}
    >
      {children}
    </button>
  );
};

export default PageLink;
