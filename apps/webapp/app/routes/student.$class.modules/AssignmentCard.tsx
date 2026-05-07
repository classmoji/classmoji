import dayjs from 'dayjs';
import { IconBrandGithub } from '@tabler/icons-react';
import { EmojisDisplay } from '~/components';
import ResourceLinks from './ResourceLinks';

interface AssignmentCardAssignment {
  title: string;
  grades_released?: boolean;
  student_deadline?: string | Date | null;
  pages?: Array<{ page: { id: string; title: string } }>;
  slides?: Array<{ slide: { id: string; title: string } }>;
}

interface Grade {
  id?: string;
  emoji: string;
  grader?: { name: string };
}

interface AssignmentCardRepositoryAssignment {
  id: string;
  status: 'OPEN' | 'CLOSED' | string;
  provider_issue_number?: number | null;
  grades?: Grade[];
  repository?: {
    name: string;
    classroom?: {
      git_organization?: {
        login?: string | null;
      } | null;
    } | null;
  } | null;
}

interface AssignmentCardProps {
  assignment: AssignmentCardAssignment;
  repoAssignment?: AssignmentCardRepositoryAssignment | null;
  classSlug: string | undefined;
  slidesUrl: string;
  pagesUrl: string;
  rolePrefix?: string;
}

const getStatusPill = (repoAssignment?: AssignmentCardRepositoryAssignment | null) => {
  if (!repoAssignment) return null;
  if (repoAssignment.status === 'CLOSED') {
    return {
      label: 'Submitted',
      className: 'bg-[#619462]/15 text-[#3f6a40] dark:bg-[#619462]/20 dark:text-[#9BC39C]',
    };
  }
  return {
    label: 'Not submitted',
    className: 'bg-[#D4A289]/15 text-[#8a5b3a] dark:bg-[#D4A289]/20 dark:text-[#E8C4AC]',
  };
};

const AssignmentCard = ({
  assignment,
  repoAssignment,
  classSlug,
  slidesUrl,
  pagesUrl,
  rolePrefix = 'student',
}: AssignmentCardProps) => {
  const statusPill = getStatusPill(repoAssignment);
  const showGrades = assignment.grades_released && (repoAssignment?.grades?.length ?? 0) > 0;

  const githubIssueUrl = repoAssignment?.repository?.classroom?.git_organization?.login
    ? `https://github.com/${repoAssignment.repository.classroom.git_organization.login}/${repoAssignment.repository.name}/issues/${repoAssignment.provider_issue_number}`
    : null;

  return (
    <div className="bg-stone-50 dark:bg-neutral-800/60 rounded-lg p-4 mb-3">
      <div className="flex justify-between items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="font-medium text-gray-900 dark:text-gray-100">{assignment.title}</h4>
            {statusPill && (
              <span
                className={`inline-flex items-center text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusPill.className}`}
              >
                {statusPill.label}
              </span>
            )}
          </div>
          <ResourceLinks
            pages={assignment.pages}
            slides={assignment.slides}
            classSlug={classSlug}
            slidesUrl={slidesUrl}
            pagesUrl={pagesUrl}
            rolePrefix={rolePrefix}
          />
        </div>

        <div className="flex items-center gap-3 shrink-0 text-sm">
          {assignment.student_deadline && (
            <span className="text-gray-500 dark:text-gray-400 whitespace-nowrap">
              {dayjs(assignment.student_deadline).format('MMM D, YYYY')}
            </span>
          )}
          {showGrades && <EmojisDisplay grades={repoAssignment?.grades} />}
          {githubIssueUrl && (
            <a
              href={githubIssueUrl}
              target="_blank"
              rel="noreferrer"
              title="View GitHub issue"
              aria-label="View GitHub issue"
              className="inline-flex items-center justify-center w-7 h-7 rounded-md text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-stone-100 dark:hover:bg-neutral-700 transition-colors"
            >
              <IconBrandGithub size={16} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
};

export default AssignmentCard;
