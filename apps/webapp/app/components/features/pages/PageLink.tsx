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
  children: React.ReactNode;
}

const PageLink = ({ pageId, title, href, className, children }: PageLinkProps) => {
  const peek = usePagePeek();

  if (!peek) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
        {children}
      </a>
    );
  }

  return (
    <button
      type="button"
      onClick={() => peek.openPeek({ pageId, title })}
      className={`text-left ${className ?? ''}`}
      data-cm-page-link={pageId}
    >
      {children}
    </button>
  );
};

export default PageLink;
