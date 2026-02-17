import { Button, Tag } from 'antd';
import dayjs from 'dayjs';
import { IconBrandGithub } from '@tabler/icons-react';
import { EmojisDisplay } from '~/components';
import ResourceLinks from './ResourceLinks';

const getStatusDisplay = repoAssignment => {
  if (!repoAssignment) {
    return null;
  }
  if (repoAssignment.status === 'CLOSED') {
    return { color: 'green', text: 'Submitted' };
  }
  return { color: 'red', text: 'Not Submitted' };
};

const AssignmentCard = ({
  assignment,
  repoAssignment,
  classSlug,
  slidesUrl,
  pagesUrl,
  rolePrefix = 'student',
}) => {
  const status = getStatusDisplay(repoAssignment);
  const showGrades = assignment.grades_released && repoAssignment?.grades?.length > 0;

  const githubIssueUrl = repoAssignment?.repository?.classroom?.git_organization?.login
    ? `https://github.com/${repoAssignment.repository.classroom.git_organization.login}/${repoAssignment.repository.name}/issues/${repoAssignment.provider_issue_number}`
    : null;

  return (
    <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 mb-3">
      <div className="flex justify-between items-start">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h4 className="font-medium text-gray-900 dark:text-gray-100">{assignment.title}</h4>
            {status && (
              <Tag color={status.color} bordered={false}>
                {status.text}
              </Tag>
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
        <div className="flex flex-col items-end gap-2 text-sm">
          <div className="flex items-center gap-4">
            {showGrades && <EmojisDisplay grades={repoAssignment.grades} />}
            {assignment.student_deadline && (
              <span className="text-gray-500 dark:text-gray-400">
                {dayjs(assignment.student_deadline).format('MMM D, YYYY')}
              </span>
            )}
          </div>
          {githubIssueUrl && (
            <Button
              type="primary"
              icon={<IconBrandGithub size={16} />}
              href={githubIssueUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              View Issue
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default AssignmentCard;
