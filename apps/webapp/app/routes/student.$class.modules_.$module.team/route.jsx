import { Button, Card, Input, List, Avatar, Tag, Empty } from 'antd';
import { IconUsers, IconUserPlus, IconLogout, IconPlus } from '@tabler/icons-react';
import { useState, useEffect, useRef } from 'react';
import { useFetcher, Link } from 'react-router';
import { toast } from 'react-toastify';
import { namedAction } from 'remix-utils/named-action';
import { ClassmojiService, getGitProvider } from '@classmoji/services';
import { assertClassroomAccess } from '~/utils/helpers';
import { PageHeader } from '~/components';
import { titleToIdentifier } from '@classmoji/utils';
import { tasks } from '@trigger.dev/sdk/v3';

export const loader = async ({ request, params }) => {
  const { class: classSlug, module: moduleSlug } = params;

  const { userId, classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['STUDENT', 'OWNER', 'TEACHER'],
    resourceType: 'TEAM',
    attemptedAction: 'view_teams',
  });

  // Get the module
  const module = await ClassmojiService.module.findByClassroomSlugAndModuleSlug(
    classSlug,
    moduleSlug
  );

  if (!module) {
    throw new Response('Module not found', { status: 404 });
  }

  // Only allow for GROUP modules with SELF_FORMED mode
  if (module.type !== 'GROUP' || module.team_formation_mode !== 'SELF_FORMED') {
    throw new Response('Team formation not available for this module', { status: 400 });
  }

  // Get the tag for this module (if it exists)
  const tag = await ClassmojiService.organizationTag.findByClassroomIdAndName(
    classroom.id,
    module.slug
  );

  // Get all teams for this module (by tag)
  const teams = tag ? await ClassmojiService.team.findByTagId(classroom.id, tag.id) : [];

  // Find user's current team
  const userTeam = teams.find(team => team.memberships.some(m => m.user_id === userId));

  // Check if deadline has passed
  const deadlinePassed = module.team_formation_deadline
    ? new Date() > new Date(module.team_formation_deadline)
    : false;

  return {
    module,
    teams,
    userTeam,
    userId,
    classSlug,
    maxTeamSize: module.max_team_size,
    deadlinePassed,
    deadline: module.team_formation_deadline,
  };
};

export const action = async ({ request, params }) => {
  const { class: classSlug, module: moduleSlug } = params;

  const { userId, classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['STUDENT', 'OWNER', 'TEACHER'],
    resourceType: 'TEAM',
    attemptedAction: 'modify_team',
  });

  // Get the module
  const module = await ClassmojiService.module.findByClassroomSlugAndModuleSlug(
    classSlug,
    moduleSlug
  );

  if (!module || module.type !== 'GROUP' || module.team_formation_mode !== 'SELF_FORMED') {
    return { error: 'Team formation not available for this module' };
  }

  // Check deadline
  if (module.team_formation_deadline && new Date() > new Date(module.team_formation_deadline)) {
    return { error: 'Team formation deadline has passed' };
  }

  // Get user info for GitHub operations
  const user = await ClassmojiService.user.findById(userId);

  // Get or create tag for this module
  const tag = await ClassmojiService.organizationTag.upsert(classroom.id, module.slug);

  // Get classroom with git organization for provider operations
  const classroomWithOrg = await ClassmojiService.classroom.findById(classroom.id);
  const gitProvider = getGitProvider(classroomWithOrg.git_organization);
  const orgLogin = classroomWithOrg.git_organization.login;

  return namedAction(request, {
    async create() {
      const formData = await request.formData();
      const teamName = formData.get('teamName');

      if (!teamName || teamName.trim().length === 0) {
        return { error: 'Team name is required' };
      }

      const teamSlug = titleToIdentifier(teamName);

      // Check if team name already exists
      const existingTeam = await ClassmojiService.team.findBySlugAndClassroomId(
        teamSlug,
        classroom.id
      );

      if (existingTeam) {
        return { error: 'A team with this name already exists' };
      }

      // Check if user is already on a team for this module
      const userCurrentTeam = await ClassmojiService.team.findUserTeamByTag(
        classroom.id,
        tag.id,
        userId
      );

      if (userCurrentTeam) {
        return { error: 'You are already on a team. Leave your current team first.' };
      }

      // Create GitHub team
      let githubTeam;
      try {
        githubTeam = await gitProvider.createTeam(orgLogin, teamSlug);
      } catch (error) {
        console.error('Failed to create GitHub team:', error);
        return {
          error: 'Failed to create team on GitHub. Please try again or contact your instructor.',
        };
      }

      // Create team in database with membership and tag
      await ClassmojiService.team.createWithMembershipAndTag({
        name: teamName.trim(),
        slug: teamSlug,
        classroomId: classroom.id,
        providerId: githubTeam.id,
        userId,
        tagId: tag.id,
      });

      // Add user to GitHub team
      try {
        await gitProvider.addTeamMember(orgLogin, teamSlug, user.login);
      } catch (error) {
        console.error('Failed to add user to GitHub team:', error);
        // Team was created, but user wasn't added - still return success
      }

      // Trigger repository creation workflow
      await tasks.trigger('create_repositories', {
        logins: [teamSlug],
        assignmentTitle: module.title,
        org: classSlug,
        sessionId: Date.now().toString(),
      });

      return { success: `Team "${teamName}" created! Repository is being set up.` };
    },

    async join() {
      const formData = await request.formData();
      const teamId = formData.get('teamId');

      if (!teamId) {
        return { error: 'Team ID is required' };
      }

      // Check if user is already on a team for this module
      const userCurrentTeam = await ClassmojiService.team.findUserTeamByTag(
        classroom.id,
        tag.id,
        userId
      );

      if (userCurrentTeam) {
        return { error: 'You are already on a team. Leave your current team first.' };
      }

      // Get the team
      const team = await ClassmojiService.team.findById(teamId);

      if (!team) {
        return { error: 'Team not found' };
      }

      // Check if team is for this module
      if (!team.tags.some(t => t.tag_id === tag.id)) {
        return { error: 'This team is not for this module' };
      }

      // Check if team is full
      if (module.max_team_size && team.memberships.length >= module.max_team_size) {
        return { error: 'This team is full' };
      }

      // Add user to team
      await ClassmojiService.teamMembership.addMemberToTeam(teamId, userId);

      // Add user to GitHub team
      try {
        await gitProvider.addTeamMember(orgLogin, team.slug, user.login);
      } catch (error) {
        console.error('Failed to add user to GitHub team:', error);
        // DB was updated, GitHub failed - still return success
      }

      return { success: `You have joined "${team.name}"` };
    },

    async leave() {
      // Find user's current team for this module
      const userTeam = await ClassmojiService.team.findUserTeamByTag(classroom.id, tag.id, userId);

      if (!userTeam) {
        return { error: 'You are not on a team' };
      }

      // Remove user from team
      await ClassmojiService.teamMembership.removeMemberFromTeam(userTeam.id, userId);

      // Remove user from GitHub team
      try {
        await gitProvider.removeTeamMember(orgLogin, userTeam.slug, user.login);
      } catch (error) {
        console.error('Failed to remove user from GitHub team:', error);
        // DB was updated, GitHub failed - still return success
      }

      return { success: `You have left "${userTeam.name}"` };
    },
  });
};

const StudentTeamPage = ({ loaderData }) => {
  const { module, teams, userTeam, maxTeamSize, deadlinePassed, deadline, classSlug } = loaderData;
  const fetcher = useFetcher();
  const [teamName, setTeamName] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const toastIdRef = useRef(null);

  const isSubmitting = fetcher.state !== 'idle';

  // Show loading toast when submitting
  useEffect(() => {
    if (fetcher.state === 'submitting' && !toastIdRef.current) {
      toastIdRef.current = toast.loading('Processing...');
    }
  }, [fetcher.state]);

  // Show feedback from action
  useEffect(() => {
    if (fetcher.data?.success) {
      if (toastIdRef.current) {
        toast.update(toastIdRef.current, {
          render: fetcher.data.success,
          type: 'success',
          isLoading: false,
          autoClose: 3000,
        });
        toastIdRef.current = null;
      } else {
        toast.success(fetcher.data.success);
      }
    }
    if (fetcher.data?.error) {
      if (toastIdRef.current) {
        toast.update(toastIdRef.current, {
          render: fetcher.data.error,
          type: 'error',
          isLoading: false,
          autoClose: 3000,
        });
        toastIdRef.current = null;
      } else {
        toast.error(fetcher.data.error);
      }
    }
  }, [fetcher.data]);

  const handleCreateTeam = () => {
    if (!teamName.trim()) {
      toast.error('Please enter a team name');
      return;
    }
    fetcher.submit({ teamName }, { method: 'post', action: '?/create' });
    setTeamName('');
    setShowCreateForm(false);
  };

  const handleJoinTeam = teamId => {
    fetcher.submit({ teamId }, { method: 'post', action: '?/join' });
  };

  const handleLeaveTeam = () => {
    fetcher.submit({}, { method: 'post', action: '?/leave' });
  };

  const availableTeams = teams.filter(team => {
    if (userTeam && team.id === userTeam.id) return false;
    if (maxTeamSize && team.memberships.length >= maxTeamSize) return false;
    return true;
  });

  return (
    <div className="max-w-4xl mx-auto">
      <Link
        to={`/student/${classSlug}/modules`}
        className="text-blue-600 hover:underline mb-4 inline-block"
      >
        ← Back to Modules
      </Link>

      <PageHeader title={`Team Formation: ${module.title}`} routeName="modules" />

      {deadline && (
        <div
          className={`mb-6 p-4 rounded-lg ${deadlinePassed ? 'bg-red-50 border border-red-200' : 'bg-blue-50 border border-blue-200'}`}
        >
          <span className={deadlinePassed ? 'text-red-700' : 'text-blue-700'}>
            {deadlinePassed ? 'Deadline passed: ' : 'Team formation deadline: '}
            {new Date(deadline).toLocaleString()}
          </span>
        </div>
      )}

      {/* User's Current Team */}
      {userTeam && (
        <Card
          className="shadow-sm mb-6 rounded-lg overflow-hidden"
          title={
            <span className="flex items-center gap-2">
              <IconUsers size={18} />
              Your Team
            </span>
          }
        >
          <div className="flex justify-between items-start">
            <div>
              <h3 className="text-xl font-semibold mb-2">{userTeam.name}</h3>
              <div className="flex items-center gap-2 mb-4">
                <Tag color="blue">
                  {userTeam.memberships.length}
                  {maxTeamSize ? `/${maxTeamSize}` : ''} members
                </Tag>
              </div>
              <div className="flex gap-3">
                {userTeam.memberships.map(membership => (
                  <div key={membership.user_id} className="flex items-center gap-2">
                    <Avatar
                      src={`https://avatars.githubusercontent.com/u/${membership.user.provider_id}?v=4`}
                      size={32}
                    >
                      {membership.user.name?.[0] || membership.user.login?.[0]}
                    </Avatar>
                    <span className="text-sm">{membership.user.name || membership.user.login}</span>
                  </div>
                ))}
              </div>
            </div>
            {!deadlinePassed && (
              <Button
                type="primary"
                danger
                icon={<IconLogout size={16} />}
                onClick={handleLeaveTeam}
                loading={isSubmitting}
              >
                Leave Team
              </Button>
            )}
          </div>
        </Card>
      )}

      {/* Create or Join Team */}
      {!userTeam && !deadlinePassed && (
        <>
          {/* Create Team Section */}
          <Card
            className="shadow-sm rounded-lg overflow-hidden"
            style={{ marginBottom: '2rem' }}
            title={
              <span className="flex items-center gap-2">
                <IconPlus size={18} />
                Create a Team
              </span>
            }
          >
            {showCreateForm ? (
              <div className="flex gap-2">
                <Input
                  placeholder="Enter team name"
                  value={teamName}
                  onChange={e => setTeamName(e.target.value)}
                  onPressEnter={handleCreateTeam}
                  disabled={isSubmitting}
                />
                <Button type="primary" onClick={handleCreateTeam} loading={isSubmitting}>
                  Create
                </Button>
                <Button onClick={() => setShowCreateForm(false)}>Cancel</Button>
              </div>
            ) : (
              <Button
                type="primary"
                icon={<IconPlus size={16} />}
                onClick={() => setShowCreateForm(true)}
              >
                Create New Team
              </Button>
            )}
          </Card>

          {/* Available Teams */}
          <Card
            className="shadow-sm rounded-lg overflow-hidden"
            title={
              <span className="flex items-center gap-2">
                <IconUserPlus size={18} />
                Join a Team
              </span>
            }
          >
            {availableTeams.length === 0 ? (
              <div className="text-center py-8">
                <div className="text-6xl mb-4">👥</div>
                <p className="text-gray-500">No teams available to join yet. Create a new team!</p>
              </div>
            ) : (
              <List
                dataSource={availableTeams}
                renderItem={team => (
                  <List.Item
                    actions={[
                      <Button
                        key="join"
                        type="primary"
                        onClick={() => handleJoinTeam(team.id)}
                        loading={isSubmitting}
                      >
                        Join
                      </Button>,
                    ]}
                  >
                    <List.Item.Meta
                      avatar={<Avatar icon={<IconUsers size={16} />} />}
                      title={team.name}
                      description={
                        <div className="flex items-center gap-3">
                          <Tag color="blue">
                            {team.memberships.length}
                            {maxTeamSize ? `/${maxTeamSize}` : ''} members
                          </Tag>
                          <div className="flex items-center gap-2">
                            {team.memberships.map(m => (
                              <Avatar
                                key={m.user_id}
                                src={`https://avatars.githubusercontent.com/u/${m.user.provider_id}?v=4`}
                                size={24}
                              >
                                {m.user.name?.[0] || m.user.login?.[0]}
                              </Avatar>
                            ))}
                          </div>
                        </div>
                      }
                    />
                  </List.Item>
                )}
              />
            )}
          </Card>
        </>
      )}

      {/* Deadline Passed Message */}
      {!userTeam && deadlinePassed && (
        <Card>
          <Empty
            description={
              <span className="text-red-600 mb-8">
                Team formation deadline has passed. Contact your instructor if you need assistance.
              </span>
            }
          />
        </Card>
      )}

      {/* All Teams (for reference) */}
      {userTeam && teams.length > 1 && (
        <Card title="All Teams" className="mt-6">
          <List
            dataSource={teams.filter(t => t.id !== userTeam.id)}
            renderItem={team => (
              <List.Item>
                <List.Item.Meta
                  avatar={<Avatar icon={<IconUsers size={16} />} />}
                  title={team.name}
                  description={
                    <Tag
                      color={maxTeamSize && team.memberships.length >= maxTeamSize ? 'red' : 'blue'}
                    >
                      {team.memberships.length}
                      {maxTeamSize ? `/${maxTeamSize}` : ''} members
                      {maxTeamSize && team.memberships.length >= maxTeamSize && ' (Full)'}
                    </Tag>
                  }
                />
              </List.Item>
            )}
          />
        </Card>
      )}
    </div>
  );
};

export default StudentTeamPage;
