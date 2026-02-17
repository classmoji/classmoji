import { Tag, Button, Progress } from 'antd';
import { IconBrandGithub } from '@tabler/icons-react';
import { useFetcher, useParams } from 'react-router';

const Card = ({ title, children, icon }) => (
  <div className="bg-white dark:bg-gray-800 p-6 rounded-lg border border-gray-200 dark:border-gray-700 shadow-xs">
    <div className="flex items-center gap-2 mb-2">
      {icon}
      <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-200">{title}</h3>
    </div>
    <div className="space-y-2">{children}</div>
  </div>
);

const StatItem = ({ label, value }) => (
  <div className="flex justify-between">
    <span className="text-gray-600 dark:text-gray-400">{label}:</span>
    <span className="font-medium text-gray-900 dark:text-gray-100">{value}</span>
  </div>
);

const SummaryCards = ({ module, repos }) => {
  const fetcher = useFetcher();
  const { class: classSlug, title } = useParams();

  // Count total submissions across all assignments in the module
  const allAssignments = module.assignments || [];
  const totalSubmissions = allAssignments.reduce(
    (total, assignment) =>
      total +
      repos.filter(repo =>
        repo.assignments?.some(
          repoAssignment => repoAssignment.assignment_id === assignment.id && repoAssignment.status === 'CLOSED'
        )
      ).length,
    0
  );

  // Count repos with projects
  const reposWithProjects = repos.filter(repo => repo.project_id).length;
  const showProjectsCard = module.type === 'GROUP' && module.project_template_id;

  const handleCreateProjects = () => {
    fetcher.submit(
      {
        moduleId: module.id,
      },
      {
        action: `/admin/${classSlug}/modules/${title}?/createProjects`,
        method: 'post',
        encType: 'application/json',
      }
    );
  };

  const isCreating = fetcher.state === 'submitting';

  return (
    <div className={`grid grid-cols-1 ${showProjectsCard ? 'md:grid-cols-3' : 'md:grid-cols-2'} gap-6 mb-8`}>
      <Card title="Module Overview">
        <StatItem
          label="Type"
          value={
            <Tag color={module.type === 'GROUP' ? 'blue' : 'orange'} className="m-0">
              {module.type}
            </Tag>
          }
        />
        <StatItem label="Weight" value={`${module.weight}%`} />
        <StatItem label="Repositories" value={repos.length} />
      </Card>

      <Card title="Assignments Overview">
        <StatItem label="Number of Assignments" value={allAssignments.length} />
        <StatItem label="Total Submissions" value={totalSubmissions} />
      </Card>

      {showProjectsCard && (
        <Card
          title="GitHub Projects"
          icon={<IconBrandGithub size={20} className="text-gray-600 dark:text-gray-400" />}
        >
          <StatItem
            label="Repos with Projects"
            value={`${reposWithProjects} / ${repos.length}`}
          />
          <Progress
            percent={repos.length ? Math.round((reposWithProjects / repos.length) * 100) : 0}
            size="small"
            status={reposWithProjects === repos.length ? 'success' : 'active'}
          />
          {reposWithProjects < repos.length && repos.length > 0 && (
            <Button
              type="primary"
              size="small"
              onClick={handleCreateProjects}
              loading={isCreating}
              className="mt-2 w-full"
            >
              Create Projects ({repos.length - reposWithProjects} remaining)
            </Button>
          )}
          {reposWithProjects === repos.length && repos.length > 0 && (
            <p className="text-green-600 text-sm mt-2">All repos have projects</p>
          )}
        </Card>
      )}
    </div>
  );
};

export default SummaryCards;
