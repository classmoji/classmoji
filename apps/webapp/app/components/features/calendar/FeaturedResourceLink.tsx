/**
 * The starred resource, drawn under an event chip in month view.
 *
 * A week column lists everything an event links to; a month cell has room for
 * one line, so an event shows the one thing the instructor starred and nothing
 * otherwise. Where that one line GOES is not decided here: it is decided in
 * `ResourceLink`, along with every other link to the same three kinds of
 * thing, because two links with the same title that land in different places
 * are worse than either one alone. Sharing it is also what gives this line the
 * student's own GitHub issue for a starred assignment — it used to send every
 * reader to the repositories page.
 *
 * What is left here is the one thing that is particular to the star: a starred
 * assignment's repository anchor comes off the EVENT, not off the star.
 */

import ResourceLink, { featuredResource } from './ResourceLink';
import type { ResourceLinkContext } from './ResourceLink';
import type { CalendarEventWithLinks, CalendarFeaturedResource } from './types';

export interface FeaturedResourceLinkProps {
  featured: CalendarFeaturedResource;
  /**
   * The event it belongs to. Read for one thing only: an assignment's
   * repository slug, which is the anchor the repositories page scrolls to and
   * is not part of the starred resource itself.
   */
  event: CalendarEventWithLinks;
  context?: ResourceLinkContext;
}

const FeaturedResourceLink = ({ featured, event, context }: FeaturedResourceLinkProps) => (
  <ResourceLink resource={featuredResource(featured, event)} context={context} variant="row" />
);

export default FeaturedResourceLink;
