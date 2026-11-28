import { Button, Card, Input, Avatar, Tag, Empty } from 'antd';
import { IconUsers, IconUserPlus, IconLogout, IconPlus } from '@tabler/icons-react';
import { useState, useEffect, useContext } from 'react';
import { useFetcher, Link } from 'react-router';
import { namedAction } from '~/utils/namedAction.server';
import type { Route } from './+types/route';
import { ClassmojiService, getGitProvider, isReservedSlug } from '@classmoji/services';
import { useCallout } from '@classmoji/ui-components';
import { assertClassroomAccess, assertClassroomMutationAllowed } from '~/utils/helpers';
import { auditActor } from '~/utils/auditActor.server';
import getPrisma, { GIT_IDENTITY } from '@classmoji/database';
import { gitUsername, scopeGitlabId, teamsNamespace, titleToIdentifier } from '@classmoji/utils';
import { reportError } from '@classmoji/utils/error-report';
import { tasks } from '@trigger.dev/sdk/v3';
import { auth } from '@trigger.dev/sdk';
import { nanoid } from 'nanoid';
import { FetcherContext } from '~/contexts';
import { useClassroomStatusModals } from '~/utils/classroomStatusModals';
import { gitTerms } from '~/utils/gitWeb';

/**
 * A student reaches a repository's team page only once the repository is
 * published, as on the other student repository screens; its owner and
 * teachers (who reach it too) see it either way.
 */
const repositoryVisibleTo = (
  repository: { is_published: boolean },
  role: string | null | undefined
): boolean => repository.is_published || role === 'OWNER' || role === 'TEACHER';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const classSlug = params.class!;
  const moduleSlug = params.repo!;

  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['STUDENT', 'OWNER', 'TEACHER'],
    resourceType: 'TEAMS',
    attemptedAction: 'view_teams',
  });
  const terms = gitTerms(classroom.git_organization?.provider === 'GITLAB');

  // Get the repository
  const repository = await ClassmojiService.repository.findByClassroomSlugAndModuleSlug(
    classSlug,
    moduleSlug
  );

  if (!repository || !repositoryVisibleTo(repository, membership?.role)) {
    throw new Response(`${terms.Repo} not found`, { status: 404 });
  }

  // Only allow for GROUP repositories with SELF_FORMED mode
  if (repository.type !== 'GROUP' || repository.team_formation_mode !== 'SELF_FORMED') {
    throw new Response(`Team formation not available for this ${terms.repo}`, { status: 400 });
  }

  // Get the tag for this repository (if it exists)
  const tag = await ClassmojiService.organizationTag.findByClassroomIdAndName(
    classroom.id,
    repository.slug!
  );

  // Get all teams for this repository (by tag)
  const teams = tag ? await ClassmojiService.team.findByTagId(classroom.id, tag.id) : [];

  // Find user's current team
  const userTeam = teams.find(team => team.memberships.some(m => m.user_id === userId));

  // Check if deadline has passed
  const deadlinePassed = repository.team_formation_deadline
    ? new Date() > new Date(repository.team_formation_deadline)
    : false;

  return {
    // What the page shows of the repository: its title.
    repository: { title: repository.title },
    teams,
    userTeam,
    userId,
    classSlug,
    maxTeamSize: repository.max_team_size,
    deadlinePassed,
    deadline: repository.team_formation_deadline,
  };
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;
  const moduleSlug = params.repo!;

  const gate = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['STUDENT', 'OWNER', 'TEACHER'],
    resourceType: 'TEAMS',
    attemptedAction: 'modify_team',
  });
  const { userId, classroom, membership } = gate;
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });
  const terms = gitTerms(classroom.git_organization?.provider === 'GITLAB');

  // Get the repository
  const repository = await ClassmojiService.repository.findByClassroomSlugAndModuleSlug(
    classSlug,
    moduleSlug
  );

  if (
    !repository ||
    !repositoryVisibleTo(repository, membership?.role) ||
    repository.type !== 'GROUP' ||
    repository.team_formation_mode !== 'SELF_FORMED'
  ) {
    return { error: `Team formation not available for this ${terms.repo}` };
  }

  // Check deadline
  if (
    repository.team_formation_deadline &&
    new Date() > new Date(repository.team_formation_deadline)
  ) {
    return { error: 'Team formation deadline has passed' };
  }

  // Get or create tag for this repository (the tag service records one it creates)
  const { tag } = await ClassmojiService.organizationTag.findOrCreate(
    classroom.id,
    repository.slug!,
    await auditActor(request, gate, 'web:team_formation.tag')
  );

  // Get classroom with git organization for provider operations
  const classroomWithOrg = await ClassmojiService.classroom.findById(classroom.id);
  const gitProvider = getGitProvider(
    classroomWithOrg!.git_organization as {
      provider: string;
      github_installation_id?: string;
      access_token?: string;
      base_url?: string;
      login?: string;
    }
  );
  // Where teams live: the org on Github, `<class subgroup>/teams` on GitLab.
  const orgLogin = teamsNamespace(classroomWithOrg!) ?? classroomWithOrg!.git_organization.login;
  const provider = classroomWithOrg!.git_organization.provider;
  const isGitLab = provider === 'GITLAB';
  const providerName = isGitLab ? 'Gitlab' : 'Github';

  const identity = await getPrisma().user.findUnique({
    where: { id: userId },
    select: GIT_IDENTITY,
  });
  const username = gitUsername(identity, provider);
  if (!username) {
    return { error: `Connect your ${providerName} account before joining a team.` };
  }

  return namedAction(request, {
    async create() {
      const formData = await request.formData();
      const teamName = formData.get('teamName') as string | null;

      if (!teamName || teamName.trim().length === 0) {
        return { error: 'Team name is required' };
      }

      const teamSlug = titleToIdentifier(teamName);

      // `{classroom-slug}-students` / `-assistants` name the classroom's own
      // GitHub membership teams, which have no local Team row and must not be
      // reachable from this form. The check runs on the slug BEFORE the
      // provider call, because gitProvider.createTeam adopts an existing team
      // on a 422 rather than failing — so a request landing on one of those
      // slugs would come back holding the classroom's membership team. A name
      // that slugifies to nothing is refused here too.
      if (!teamSlug || isReservedSlug(teamSlug)) {
        return { error: 'That team name is not available.' };
      }

      // Check if team name already exists
      const existingTeam = await ClassmojiService.team.findBySlugAndClassroomId(
        teamSlug,
        classroom.id
      );

      if (existingTeam) {
        return { error: 'A team with this name already exists' };
      }

      // Check if user is already on a team for this repository
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
      } catch (error: unknown) {
        console.error('Failed to create GitHub team:', error);
        reportError(error, {
          surface: 'team.create.github',
          tags: { classroom_id: classroom.id, provider },
        });
        return {
          error: `Failed to create team on ${terms.platform}. Please try again or contact your instructor.`,
        };
      }

      // GitHub is authoritative for the slug, so the same check runs again on
      // what it returned. Deliberately NO rollback here: createTeam adopts an
      // existing team on a 422, so the team in hand may be one that already
      // existed — deleting it could remove the classroom's own membership
      // team. Nothing local has been written yet, so refusing is enough.
      if (isReservedSlug(githubTeam.slug)) {
        console.error(
          `[team] refusing to record a team on the reserved slug ${githubTeam.slug} in ${orgLogin}`
        );
        return { error: 'That team name is not available.' };
      }

      // Create team in database with membership and tag; the team service
      // records it (TEAMS / CREATE).
      await ClassmojiService.team.createWithMembershipAndTag(
        {
          name: teamName.trim(),
          slug: teamSlug,
          classroomId: classroom.id,
          providerId: isGitLab
            ? scopeGitlabId(
                classroomWithOrg!.git_organization.gitlab_instance_id ?? null,
                githubTeam.id
              )
            : githubTeam.id,
          provider: isGitLab ? 'GITLAB' : 'GITHUB',
          userId,
          tagId: tag.id,
        },
        await auditActor(request, gate, 'web:team_formation.create')
      );

      // Add user to GitHub team
      try {
        await gitProvider.addTeamMember(orgLogin, teamSlug, username);
      } catch (error: unknown) {
        console.error('Failed to add user to GitHub team:', error);
        // Team was created, but user wasn't added - still return success
        reportError(error, {
          surface: 'team.create.add_member',
          tags: { classroom_id: classroom.id, provider },
        });
      }

      // Trigger repository creation workflow. Keyed by classroom like every
      // other caller: without a key, team creations from every classroom
      // share one run at a time.
      const sessionId = nanoid();
      await tasks.trigger(
        'create_git_repos',
        {
          logins: [teamSlug],
          assignmentTitle: repository.title,
          org: classSlug,
          sessionId,
        },
        { concurrencyKey: classSlug }
      );
      // Read-only and scoped to this one batch's tag, so the progress panel can
      // show the repository being created and nothing else.
      const accessToken = await auth.createPublicToken({
        scopes: { read: { tags: [`session_${sessionId}`] } },
      });

      return {
        success: `Team "${teamName}" created.`,
        triggerSession: { id: sessionId, accessToken },
      };
    },

    async join() {
      const formData = await request.formData();
      const teamId = formData.get('teamId') as string | null;

      if (!teamId) {
        return { error: 'Team ID is required' };
      }

      // Check if user is already on a team for this repository
      const userCurrentTeam = await ClassmojiService.team.findUserTeamByTag(
        classroom.id,
        tag.id,
        userId
      );

      if (userCurrentTeam) {
        return { error: 'You are already on a team. Leave your current team first.' };
      }

      // Get the team. teamId comes from the request body, so the row is scoped
      // to THIS classroom before it is used — an id naming a team in another
      // classroom resolves to nothing, exactly like an id naming nothing.
      const team = await ClassmojiService.team.findById(teamId);

      if (!team || team.classroom_id !== classroom.id) {
        return { error: 'Team not found' };
      }

      // Check if team is for this repository
      if (!team.tags.some(t => t.tag_id === tag.id)) {
        return { error: `This team is not for this ${terms.repo}` };
      }

      // Check if team is full
      if (repository.max_team_size && team.memberships.length >= repository.max_team_size) {
        return { error: 'This team is full' };
      }

      // Add user to team — the RESOLVED row, not the raw body value. The
      // membership service records the join (TEAMS / UPDATE).
      await ClassmojiService.teamMembership.addMemberToTeam(
        team,
        userId,
        await auditActor(request, gate, 'web:team_formation.join')
      );

      // Add user to GitHub team
      try {
        await gitProvider.addTeamMember(orgLogin, team.slug, username);
      } catch (error: unknown) {
        console.error('Failed to add user to GitHub team:', error);
        // DB was updated, GitHub failed - still return success
        reportError(error, {
          surface: 'team.join.github',
          tags: { classroom_id: classroom.id, team_id: team.id, provider },
        });
      }

      return { success: `You have joined "${team.name}"` };
    },

    async leave() {
      // Find user's current team for this repository
      const userTeam = await ClassmojiService.team.findUserTeamByTag(classroom.id, tag.id, userId);

      if (!userTeam) {
        return { error: 'You are not on a team' };
      }

      // Remove user from team; the membership service records the leave.
      await ClassmojiService.teamMembership.removeMemberFromTeam(
        userTeam,
        userId,
        await auditActor(request, gate, 'web:team_formation.leave')
      );

      // Remove user from GitHub team
      try {
        await gitProvider.removeTeamMember(orgLogin, userTeam.slug, username);
      } catch (error: unknown) {
        console.error('Failed to remove user from GitHub team:', error);
        // DB was updated, GitHub failed - still return success
        reportError(error, {
          surface: 'team.leave.github',
          tags: { classroom_id: classroom.id, team_id: userTeam.id, provider },
        });
      }

      return { success: `You have left "${userTeam.name}"` };
    },
  });
};

/**
 * One team in a list. antd 6 deprecates `List`, so this is the markup and the
 * spacing antd 5's `List.Item` + `List.Item.Meta` drew: a 12px row padding, a
 * hairline between rows, a 32px avatar 16px from the text, and the action
 * 48px clear of it with antd's trailing 8px.
 */
const TeamRow = ({
  title,
  description,
  action,
}: {
  title: React.ReactNode;
  description: React.ReactNode;
  action?: React.ReactNode;
}) => (
  // Pixel values, not the spacing scale: the root font size is 17px here, so
  // `py-3` would be 12.75px rather than antd's 12px.
  <li className="flex items-center justify-between py-[12px] border-b border-[rgba(5,5,5,0.06)] dark:border-[#404040] last:border-b-0 text-[14px] leading-[1.5714]">
    <div className="flex flex-1 items-start max-w-full">
      <div className="me-[16px]">
        <Avatar icon={<IconUsers size={16} />} />
      </div>
      <div className="flex-[1_0] w-0">
        <div className="mb-[4px] text-[rgba(20,21,26,0.88)] dark:text-[#e5e5e5]">{title}</div>
        <div className="text-[rgba(20,21,26,0.45)] dark:text-[#a3a3a3]">{description}</div>
      </div>
    </div>
    {action && <div className="flex-none ms-[48px] pe-[8px]">{action}</div>}
  </li>
);

const StudentTeamPage = ({ loaderData }: Route.ComponentProps) => {
  const { repository, teams, userTeam, maxTeamSize, deadlinePassed, deadline, classSlug } =
    loaderData;
  const fetcher = useFetcher();
  const [teamName, setTeamName] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const callout = useCallout();
  const { showStatusErrorFromResponse } = useClassroomStatusModals();
  const { startOperation } = useContext(FetcherContext);

  const isSubmitting = fetcher.state !== 'idle';

  // Show feedback from action
  useEffect(() => {
    showStatusErrorFromResponse(fetcher.data as { error?: string } | undefined);
    if (fetcher.data?.success) {
      callout.show({ variant: 'success', title: fetcher.data.success, autoDismissMs: 3000 });
      // Closed only once the team exists: closing on submit took the
      // spinning Create button away while the provider team was created.
      setTeamName('');
      setShowCreateForm(false);
    }
    // The repository is created in the background; the progress panel shows it
    // being made, then that it is there.
    const session = (fetcher.data as { triggerSession?: { id: string; accessToken: string } })
      ?.triggerSession;
    if (session) startOperation({ session, kind: 'TEAM_REPO' });
    if (fetcher.data?.error) {
      callout.show({ variant: 'error', title: fetcher.data.error, autoDismissMs: 3000 });
    }
  }, [fetcher.data]);

  const handleCreateTeam = () => {
    if (!teamName.trim()) {
      callout.show({ variant: 'error', title: 'Please enter a team name' });
      return;
    }
    fetcher.submit({ teamName }, { method: 'post', action: '?/create' });
  };

  const handleJoinTeam = (teamId: string) => {
    fetcher.submit({ teamId }, { method: 'post', action: '?/join' });
  };

  const handleLeaveTeam = () => {
    fetcher.submit({}, { method: 'post', action: '?/leave' });
  };

  // Every other team is listed, full ones included (marked, with Join
  // disabled), so a student can see who has formed what.
  const availableTeams = teams.filter(team => !(userTeam && team.id === userTeam.id));
  const isFull = (team: { memberships: unknown[] }) =>
    Boolean(maxTeamSize && team.memberships.length >= maxTeamSize);

  return (
    <div className="max-w-4xl mx-auto">
      <Link
        to={`/student/${classSlug}/dashboard`}
        className="text-blue-600 hover:underline mb-4 inline-block"
      >
        ← Back to dashboard
      </Link>

      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-lg font-semibold text-ink-1 truncate">
          Team Formation: {repository.title}
        </h1>
      </div>

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
              <div className="flex items-center gap-2 mb-4">
                <h3 className="text-base font-semibold m-0">{userTeam.name}</h3>
                <Tag color="blue" className="m-0">
                  {userTeam.memberships.length}
                  {maxTeamSize ? `/${maxTeamSize}` : ''} members
                </Tag>
              </div>
              <div className="flex gap-3">
                {userTeam.memberships.map(membership => (
                  <div key={membership.user_id} className="flex items-center gap-2">
                    <Avatar src={membership.user.image ?? undefined} size={32}>
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
                <Button onClick={() => setShowCreateForm(false)} disabled={isSubmitting}>
                  Cancel
                </Button>
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
              <div className="text-center py-12 text-gray-500">
                <div className="font-medium">No teams available to join yet</div>
                <div className="text-sm">Create a new team to get started!</div>
              </div>
            ) : (
              <ul className="m-0 p-0 list-none">
                {availableTeams.map(team => (
                  <TeamRow
                    key={team.id}
                    title={team.name}
                    action={
                      <Button
                        type="primary"
                        onClick={() => handleJoinTeam(team.id)}
                        loading={isSubmitting}
                        disabled={isFull(team)}
                      >
                        {isFull(team) ? 'Full' : 'Join'}
                      </Button>
                    }
                    description={
                      <div className="flex items-center gap-3">
                        <Tag color={isFull(team) ? 'red' : 'blue'}>
                          {team.memberships.length}
                          {maxTeamSize ? `/${maxTeamSize}` : ''} members
                          {isFull(team) && ' (Full)'}
                        </Tag>
                        <div className="flex items-center gap-2">
                          {team.memberships.map(m => (
                            <Avatar key={m.user_id} src={m.user.image ?? undefined} size={24}>
                              {m.user.name?.[0] || m.user.login?.[0]}
                            </Avatar>
                          ))}
                        </div>
                      </div>
                    }
                  />
                ))}
              </ul>
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
        // The gap lives on this wrapper, not on the Card's own className: antd's
        // `.ant-card` styles are unlayered and Tailwind's utilities sit in a
        // cascade layer, so an `mt-*` utility on the Card loses to antd's margin
        // and the two cards render flush against each other.
        <div className="mt-6">
          <Card title="All Teams">
            <ul className="m-0 p-0 list-none">
              {teams
                .filter(t => t.id !== userTeam.id)
                .map(team => (
                  <TeamRow
                    key={team.id}
                    title={team.name}
                    description={
                      <Tag
                        color={
                          maxTeamSize && team.memberships.length >= maxTeamSize ? 'red' : 'blue'
                        }
                      >
                        {team.memberships.length}
                        {maxTeamSize ? `/${maxTeamSize}` : ''} members
                        {maxTeamSize && team.memberships.length >= maxTeamSize && ' (Full)'}
                      </Tag>
                    }
                  />
                ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
};

export default StudentTeamPage;
