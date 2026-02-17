import { NavLink } from 'react-router';
import { VideoCameraOutlined, GithubOutlined } from '@ant-design/icons';
import { IconFileText, IconPresentation, IconExternalLink, IconClipboardList } from '@tabler/icons-react';

/**
 * Renders clickable links for calendar events in the detail modal.
 * - Meeting links open in a new tab (external)
 * - Pages open in a new tab (external pages app)
 * - Slides open in a new tab (external slides viewer)
 * - Assignments: GitHub issue for students with repo assignment, modules page with hash anchor otherwise
 * - GitHub issue links open in a new tab (for deadline events)
 *
 * @param {object} event - The calendar event
 * @param {string} classSlug - The classroom slug
 * @param {string} rolePrefix - Route prefix (student, admin, assistant)
 * @param {string} slidesUrl - Base URL for slides viewer
 * @param {string} pagesUrl - Base URL for pages viewer
 * @param {string} gitOrgLogin - GitHub organization login (for constructing issue URLs)
 * @param {object} repoAssignmentsByAssignmentId - Map of assignment_id -> RepositoryAssignment
 */
const EventLinks = ({
  event,
  classSlug,
  rolePrefix = 'student',
  slidesUrl,
  pagesUrl = 'http://localhost:7100',
  gitOrgLogin = null,
  repoAssignmentsByAssignmentId = {},
}) => {
  const hasMeetingLink = event.meeting_link;
  const hasPages = event.pages?.length > 0;
  const hasSlides = event.slides?.length > 0;
  const hasAssignments = event.assignments?.length > 0;
  const hasGitHubIssue = event.github_issue_url;
  const hasAnyLinks = hasMeetingLink || hasPages || hasSlides || hasAssignments || hasGitHubIssue;

  if (!hasAnyLinks) {
    return null;
  }

  return (
    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 space-y-3">
      {/* Meeting Link - opens in new tab */}
      {hasMeetingLink && (
        <a
          href={event.meeting_link}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-sm"
        >
          <VideoCameraOutlined className="text-lg" />
          <span className="underline">Join Meeting</span>
          <IconExternalLink size={14} className="text-gray-400" />
        </a>
      )}

      {/* Pages - opens in new tab (external pages app) */}
      {hasPages && event.pages.map(({ page }) => (
        <a
          key={page.id}
          href={`${pagesUrl}/${classSlug}/${page.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-sm"
        >
          <IconFileText size={18} className="text-gray-500 dark:text-gray-400" />
          <span className="underline">{page.title}</span>
          <IconExternalLink size={14} className="text-gray-400" />
        </a>
      ))}

      {/* Slides - opens in new tab */}
      {hasSlides && event.slides.map(({ slide }) => (
        <a
          key={slide.id}
          href={`${slidesUrl}/${slide.id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-sm"
        >
          <IconPresentation size={18} className="text-gray-500 dark:text-gray-400" />
          <span className="underline">{slide.title}</span>
          <IconExternalLink size={14} className="text-gray-400" />
        </a>
      ))}

      {/* Assignments - GitHub issue for students with repo, modules page otherwise */}
      {hasAssignments && event.assignments.map(({ assignment, module }) => {
        // Check if user has a repo assignment with a GitHub issue
        const repoAssignment = repoAssignmentsByAssignmentId[assignment.id];
        const hasGitHubIssue = repoAssignment?.provider_issue_number && gitOrgLogin && repoAssignment.repository?.name;

        if (hasGitHubIssue) {
          // Link directly to student's GitHub issue (external)
          const githubIssueUrl = `https://github.com/${gitOrgLogin}/${repoAssignment.repository.name}/issues/${repoAssignment.provider_issue_number}`;
          return (
            <a
              key={assignment.id}
              href={githubIssueUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-sm"
            >
              <IconClipboardList size={18} className="text-gray-500 dark:text-gray-400" />
              <span className="underline">{assignment.title}</span>
              <IconExternalLink size={14} className="text-gray-400" />
            </a>
          );
        }

        // Fallback: link to modules page with hash anchor
        return (
          <NavLink
            key={assignment.id}
            to={`/${rolePrefix}/${classSlug}/modules#${module?.slug || ''}`}
            className="flex items-center gap-2 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-sm"
          >
            <IconClipboardList size={18} className="text-gray-500 dark:text-gray-400" />
            <span className="underline">{assignment.title}</span>
          </NavLink>
        );
      })}

      {/* GitHub Issue - opens in new tab */}
      {hasGitHubIssue && (
        <a
          href={event.github_issue_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 text-sm"
        >
          <GithubOutlined className="text-lg" />
          <span className="underline">View on GitHub</span>
          <IconExternalLink size={14} className="text-gray-400" />
        </a>
      )}
    </div>
  );
};

export default EventLinks;
