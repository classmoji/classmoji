import { Collapse, Tag, Alert, Button, Avatar } from 'antd';
import { IconUsers, IconCheck } from '@tabler/icons-react';
import { Link } from 'react-router';
import ResourceLinks from './ResourceLinks';
import AssignmentCard from './AssignmentCard';

const TeamFormationBanner = ({ module, userTeam, classSlug }) => {
  const deadlinePassed = module.team_formation_deadline
    ? new Date() > new Date(module.team_formation_deadline)
    : false;

  if (userTeam) {
    const maxTeamSize = module.max_team_size;
    return (
      <Alert
        type="success"
        icon={<IconCheck size={16} />}
        message={
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <span>
                You are on team: <strong>{userTeam.name}</strong>
              </span>
              <Tag color="blue">
                {userTeam.memberships?.length || 0}{maxTeamSize ? `/${maxTeamSize}` : ''} members
              </Tag>
              <div className="flex items-center gap-2">
                {userTeam.memberships?.map(m => (
                  <Avatar
                    key={m.user_id}
                    src={`https://avatars.githubusercontent.com/u/${m.user?.provider_id}?v=4`}
                    size={24}
                  >
                    {m.user?.name?.[0] || m.user?.login?.[0]}
                  </Avatar>
                ))}
              </div>
            </div>
            <Link to={`/student/${classSlug}/modules/${module.slug}/team`}>
              <Button size="small" type="link">
                View Team
              </Button>
            </Link>
          </div>
        }
        className="mb-4"
        style={{ marginBottom: '16px' }}
      />
    );
  }

  if (deadlinePassed) {
    return (
      <Alert
        type="error"
        icon={<IconUsers size={16} />}
        message="Team formation deadline has passed. Contact your instructor for assistance."
        className="mb-4"
        style={{ marginBottom: '16px' }}
      />
    );
  }

  return (
    <Alert
      type="warning"
      icon={<IconUsers size={16} />}
      message={
        <div className="flex justify-between items-center">
          <span>
            You need to join or create a team for this module
            {module.team_formation_deadline && (
              <span className="ml-2 text-sm">
                (Deadline: {new Date(module.team_formation_deadline).toLocaleDateString()})
              </span>
            )}
          </span>
          <Link to={`/student/${classSlug}/modules/${module.slug}/team`}>
            <Button type="primary">Create or Join Team</Button>
          </Link>
        </div>
      }
      className="mb-4"
    />
  );
};

const ModuleAccordion = ({
  modules,
  repoAssignmentsByAssignmentId,
  userTeamsByModuleSlug = {},
  classSlug,
  slidesUrl,
  pagesUrl,
  rolePrefix = 'student',
}) => {
  // Auto-expand modules that have unsubmitted assignments
  const activeModuleIds = modules
    .filter(module => {
      // Check if any assignment in this module is not submitted
      return module.assignments?.some(assignment => {
        const repoAssignment = repoAssignmentsByAssignmentId[assignment.id];
        // Active if: no repo assignment yet, or status is not CLOSED (submitted)
        return !repoAssignment || repoAssignment.status !== 'CLOSED';
      });
    })
    .map(module => module.id);

  const collapseItems = modules.map(module => ({
    key: module.id,
    label: (
      // Add id for hash anchor scrolling (e.g., /modules#module-slug)
      <div id={module.slug} className="flex justify-between items-center w-full pr-4 scroll-mt-24">
        <span className="font-medium">{module.title}</span>
        <Tag color={module.type === 'INDIVIDUAL' ? 'blue' : 'purple'} bordered={false}>
          {module.type}
        </Tag>
      </div>
    ),
    children: (
      <div>
        {module.team_formation_mode === 'SELF_FORMED' && rolePrefix === 'student' && (
          <TeamFormationBanner
            module={module}
            userTeam={userTeamsByModuleSlug[module.slug]}
            classSlug={classSlug}
          />
        )}

        {module.description && (
          <p className="text-gray-600 dark:text-gray-400 mb-4">{module.description}</p>
        )}

        <ResourceLinks
          pages={module.pages}
          slides={module.slides}
          classSlug={classSlug}
          slidesUrl={slidesUrl}
          pagesUrl={pagesUrl}
          rolePrefix={rolePrefix}
        />

        {(module.pages?.length > 0 || module.slides?.length > 0) &&
          module.assignments?.length > 0 && (
            <div className="border-t border-gray-200 dark:border-gray-700 my-4" />
          )}

        {module.assignments?.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-3">
              Assignments
            </h4>
            {module.assignments.map(assignment => (
              <AssignmentCard
                key={assignment.id}
                assignment={assignment}
                repoAssignment={repoAssignmentsByAssignmentId[assignment.id]}
                classSlug={classSlug}
                slidesUrl={slidesUrl}
                pagesUrl={pagesUrl}
                rolePrefix={rolePrefix}
              />
            ))}
          </div>
        )}
      </div>
    ),
  }));

  return (
    <Collapse
      items={collapseItems}
      defaultActiveKey={activeModuleIds}
      expandIconPosition="start"
      className="bg-white dark:bg-gray-900"
    />
  );
};

export default ModuleAccordion;
