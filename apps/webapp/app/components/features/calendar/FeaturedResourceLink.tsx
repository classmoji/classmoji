/**
 * The starred resource, drawn under an event chip in month view.
 *
 * A week column lists everything an event links to; a month cell has room for
 * one line, so an event shows the one thing the instructor starred and nothing
 * otherwise. It goes to the SAME place the link list sends that kind — pages
 * through `PageLink`, so the peek drawer keeps working where its provider is
 * mounted, decks to the slides viewer, assignments to the repositories page —
 * because two links with the same title that land in different places is worse
 * than either one alone.
 *
 * It is a SIBLING of the event's button, never inside it: a link nested in a
 * button is not something a browser can render. It also stops `pointerdown`
 * and `click` from travelling, so clicking it neither starts a drag (dnd-kit's
 * PointerSensor is listening on an ancestor in the staff calendar) nor opens
 * the event modal.
 */

import { NavLink } from 'react-router';
import { IconClipboardList, IconFileText, IconPresentation } from '@tabler/icons-react';
import type { CalendarEventWithLinks, CalendarFeaturedResource } from './types';
import DraftPill from './DraftPill';
import { PageLink } from '~/components/features/pages';

export interface FeaturedResourceLinkProps {
  featured: CalendarFeaturedResource;
  /**
   * The event it belongs to. Read for one thing only: an assignment's
   * repository slug, which is the anchor the repositories page scrolls to and
   * is not part of the starred resource itself.
   */
  event: CalendarEventWithLinks;
  classSlug?: string;
  rolePrefix?: string;
  pagesUrl?: string;
  slidesUrl?: string;
}

const ICONS = {
  page: IconFileText,
  slide: IconPresentation,
  assignment: IconClipboardList,
} as const;

/** Indented under the chip, one line, truncated — a month cell clips overflow. */
const ROW_CLASS =
  'flex items-center gap-1 pl-2 pr-1 min-w-0 text-xs text-ink-3 hover:text-ink-1 rounded ' +
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent';

const FeaturedResourceLink = ({
  featured,
  event,
  classSlug = '',
  rolePrefix = 'student',
  pagesUrl = 'http://localhost:7100',
  slidesUrl = '',
}: FeaturedResourceLinkProps) => {
  const Icon = ICONS[featured.kind];

  const body = (
    <>
      <Icon size={12} className="shrink-0" />
      <span className="truncate">{featured.title}</span>
      {featured.is_draft && <DraftPill />}
    </>
  );

  // React's synthetic handlers are what dnd-kit's listeners are too, so
  // stopping propagation here is enough to keep a click off the drag layer.
  const stop = {
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  };

  if (featured.kind === 'page') {
    return (
      <span {...stop} className="block min-w-0" title={featured.title}>
        <PageLink
          pageId={featured.id}
          title={featured.title}
          href={`${pagesUrl}/${classSlug}/${featured.id}`}
          className={`${ROW_CLASS} w-full`}
        >
          {body}
        </PageLink>
      </span>
    );
  }

  if (featured.kind === 'slide') {
    return (
      <a
        {...stop}
        href={`${slidesUrl}/${featured.id}`}
        target="_blank"
        rel="noopener noreferrer"
        title={featured.title}
        className={ROW_CLASS}
      >
        {body}
      </a>
    );
  }

  // The repositories page scrolls to the repository, not to the assignment, so
  // the anchor comes off the event's own assignment list — the same one the
  // link list reads. Staff have no repo of their own to deep-link into, and a
  // student's GitHub issue needs data the month grid is not given, so both get
  // the fallback destination the link list already falls back to.
  const repoSlug =
    (event.assignments ?? []).find(a => a.assignment.id === featured.id)?.repository?.slug ?? '';

  return (
    <NavLink
      {...stop}
      to={`/${rolePrefix}/${classSlug}/repos#${repoSlug}`}
      title={featured.title}
      className={ROW_CLASS}
    >
      {body}
    </NavLink>
  );
};

export default FeaturedResourceLink;
