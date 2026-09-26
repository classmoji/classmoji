import { VideoCameraOutlined, GithubOutlined } from '@ant-design/icons';
import { useGitContext } from '~/hooks/useGitWeb';
import { IconExternalLink, IconClipboardList } from '@tabler/icons-react';
import type { CalendarEventWithLinks } from './types';
import ResourceLink, { LIST_LINK_CLASS, resourceKey, resourcesForEvent } from './ResourceLink';
import type { RepositoryAssignmentLinkInfo, ResourceLinkContext } from './ResourceLink';

interface EventLinksProps {
  event: CalendarEventWithLinks;
  classSlug?: string;
  rolePrefix?: string;
  slidesUrl: string;
  pagesUrl?: string;
  gitOrgLogin?: string | null;
  repoAssignmentsByAssignmentId?: Record<string, RepositoryAssignmentLinkInfo | undefined>;
}

/**
 * Everything a calendar event links to, in the detail modal.
 *
 * The three LINKED kinds — pages, decks, assignments — are drawn by the shared
 * `ResourceLink`, which is also what the week chips and the month view's
 * starred line use, so the modal cannot send a reader somewhere the grid does
 * not. What is left here is what only the modal has: the meeting link, a
 * synthesized form close, and a deadline's GitHub issue.
 */
const EventLinks = ({
  event,
  classSlug,
  rolePrefix = 'student',
  slidesUrl,
  pagesUrl,
  gitOrgLogin = null,
  repoAssignmentsByAssignmentId = {},
}: EventLinksProps) => {
  const gitCtx = useGitContext();
  const context: ResourceLinkContext = {
    classSlug,
    git: gitCtx,
    rolePrefix,
    slidesUrl,
    pagesUrl,
    gitOrgLogin,
    repoAssignmentsByAssignmentId,
  };
  const resources = resourcesForEvent(event);

  const hasMeetingLink = event.meeting_link;
  const hasGitHubIssue = event.github_issue_url;
  // Synthesized form-close events carry a single link, already pointed at the
  // right surface by the service: the responses view for staff, the fill page
  // for everyone else.
  const formUrl = event.is_form_close ? (event.form_url ?? null) : null;

  if (!hasMeetingLink && resources.length === 0 && !hasGitHubIssue && !formUrl) {
    return null;
  }

  return (
    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-neutral-700 space-y-3">
      {/* Meeting Link - opens in new tab */}
      {hasMeetingLink && (
        <a
          href={event.meeting_link ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          className={LIST_LINK_CLASS}
        >
          <VideoCameraOutlined className="text-lg" />
          <span className="underline">Join Meeting</span>
          <IconExternalLink size={14} className="text-ink-3" />
        </a>
      )}

      {/* Pages peek in place inside the student/assistant shell and open a new
          tab on admin, where no drawer is mounted; decks open the slides
          viewer; an assignment goes to the reader's own GitHub issue where
          they have one and to the repositories page where they do not. */}
      {resources.map(resource => (
        <ResourceLink
          key={resourceKey(resource)}
          resource={resource}
          context={context}
          variant="list"
          // The list is starred-first, like the grids. Without the star that
          // order is unexplained — with it, the row says WHY it is at the top
          // and what the month view will show.
          showStar
        />
      ))}

      {/* Form close - opens the form (or its responses, for staff) in a new tab */}
      {formUrl && (
        <a href={formUrl} target="_blank" rel="noopener noreferrer" className={LIST_LINK_CLASS}>
          <IconClipboardList size={18} className="text-ink-3" />
          <span className="underline">
            {formUrl.endsWith('/responses')
              ? 'View responses'
              : event.form_status === 'CLOSED'
                ? 'View form (closed)'
                : 'Open form'}
          </span>
          <IconExternalLink size={14} className="text-ink-3" />
        </a>
      )}

      {/* GitHub Issue - opens in new tab */}
      {hasGitHubIssue && (
        <a
          href={event.github_issue_url ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          className={LIST_LINK_CLASS}
        >
          <GithubOutlined className="text-lg" />
          <span className="underline">View on GitHub</span>
          <IconExternalLink size={14} className="text-ink-3" />
        </a>
      )}
    </div>
  );
};

export default EventLinks;
