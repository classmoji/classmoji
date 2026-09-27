import getPrisma from '@classmoji/database';
import {
  ClassmojiService,
  ClassroomSlugUnavailableError,
  GitLabProvider,
  createWithUniqueClassroomSlug,
} from '@classmoji/services';
import {
  canonicalTimeZone,
  defaultContentRepoName,
  GITLAB_PROJECTS_SUBGROUP,
  GITLAB_TEAMS_SUBGROUP,
  scopeGitlabId,
} from '@classmoji/utils';
import { ActionTypes } from '~/constants';
import { slugify } from './utils';
import { pickContentNamespace } from './contentNamespace.server';
import { prepareClassroomImport, runClassroomImport } from './importFlow.server';

/**
 * Create a classroom on GitLab: the group is the organization (connected
 * through the user's GitLab connection, the counterpart of the Github App
 * installation) and the classroom gets its own subgroup, which holds its
 * student projects and whose members are its staff.
 */
export async function createGitLabClassroom(
  userId: string,
  input: {
    group_id?: unknown;
    name?: unknown;
    slug?: unknown;
    timezone?: unknown;
    importConfig?: unknown;
  }
) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return { error: 'Classroom name is required' };
  const groupId =
    typeof input.group_id === 'string' || typeof input.group_id === 'number'
      ? String(input.group_id)
      : '';
  if (!groupId) return { error: 'Pick a Gitlab group' };

  const connection = await ClassmojiService.gitlabConnection.findForUser(userId);
  if (!connection) return { error: 'Connect Gitlab first.' };

  // Import checks that can refuse the create run before anything is made.
  const prepared = await prepareClassroomImport(userId, input.importConfig ?? null);
  if ('error' in prepared) return { error: prepared.error };

  // The connection's instance: gitlab.com, or the school's own GitLab.
  const instanceId = connection.gitlab_instance_id ?? null;
  const host = await ClassmojiService.gitlabInstance.hostFor(instanceId);
  const provider = new GitLabProvider(
    groupId,
    null,
    () => ClassmojiService.gitlabConnection.getConnectionToken(connection.id),
    host
  );

  // The group must be one the connection's user administers (Maintainer+),
  // exactly the list the picker offered. Never trust the id alone.
  let group;
  try {
    group = (await provider.listGroups()).find(g => String(g.id) === groupId);
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : 'Could not reach Gitlab' };
  }
  if (!group) {
    return { error: 'You need to be an Owner or Maintainer of that Gitlab group.' };
  }

  // The GitLab counterpart of the org row an installation creates. The first
  // connection to reach a group backs it; later ones don't take it over.
  // Group ids repeat across instances: a self-managed one's are scoped.
  const providerId = scopeGitlabId(instanceId, group.id);
  const existing = await getPrisma().gitOrganization.findUnique({
    where: { provider_provider_id: { provider: 'GITLAB', provider_id: providerId } },
  });
  const gitOrg = existing
    ? await getPrisma().gitOrganization.update({
        where: { id: existing.id },
        data: {
          login: group.full_path,
          base_url: host,
          ...(existing.gitlab_connection_id ? {} : { gitlab_connection_id: connection.id }),
        },
      })
    : await getPrisma().gitOrganization.create({
        data: {
          provider: 'GITLAB',
          provider_id: providerId,
          login: group.full_path,
          base_url: host,
          gitlab_instance_id: instanceId,
          gitlab_connection_id: connection.id,
        },
      });

  const slug = slugify(typeof input.slug === 'string' && input.slug ? input.slug : name);
  if (!slug) {
    return { error: 'That name has no letters or numbers to build a URL from — add some' };
  }
  const contentNamespace = await pickContentNamespace(gitOrg.id, gitOrg.login, slug);
  const groupShortName = group.full_path.split('/').pop() ?? group.full_path;

  let classroom;
  try {
    const created = await createWithUniqueClassroomSlug(
      { slug, orgLogin: groupShortName },
      classroomSlug =>
        getPrisma().$transaction(async tx => {
          const row = await tx.classroom.create({
            data: {
              git_org_id: gitOrg.id,
              slug: classroomSlug,
              name,
              content_namespace: contentNamespace,
              content_repo: defaultContentRepoName(contentNamespace),
            },
          });
          await tx.classroomSettings.create({
            data: { classroom_id: row.id, timezone: canonicalTimeZone(input.timezone) },
          });
          await tx.classroomMembership.create({
            data: {
              classroom_id: row.id,
              user_id: userId,
              role: 'OWNER',
              has_accepted_invite: true,
            },
          });
          return row;
        })
    );
    classroom = created.result;
  } catch (error: unknown) {
    if (error instanceof ClassroomSlugUnavailableError) {
      return { error: `'${slug}' and every variation of it are already taken — pick another name` };
    }
    throw error;
  }

  // The class subgroup, named after the classroom. Its members are the staff
  // (inherited access to every student project); students only ever join
  // their own project. Without it the classroom can't hold repos, so a failure
  // undoes the classroom rather than leaving a half-made one.
  try {
    // Never an existing subgroup: deleting the classroom deletes its subgroup,
    // which must hold only what Classmoji made for it.
    const subgroup = await provider.createSubgroup(group.full_path, name, classroom.slug, {
      adopt: false,
    });
    await getPrisma().classroom.update({
      where: { id: classroom.id },
      data: { git_namespace: subgroup.full_path },
    });
  } catch (error: unknown) {
    await getPrisma()
      .classroom.delete({ where: { id: classroom.id } })
      .catch(() => {});
    if ((error as { status?: number }).status === 422) {
      return {
        error: `A subgroup named '${classroom.slug}' already exists in ${group.full_path} on Gitlab. Pick a different classroom name, or rename or remove that subgroup.`,
      };
    }
    return {
      error: `Could not create the class subgroup on Gitlab: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // `<group>/templates`: where template projects live, shared by every class
  // in the group and kept apart from student work (GitLab's free plan has no
  // "template repo" flag). Idempotent; the first classroom creates it.
  try {
    await provider.createSubgroup(group.full_path, 'Templates', 'templates');
  } catch (error: unknown) {
    console.error('Templates subgroup creation failed:', error);
  }

  // The whole class layout from the start, so the subgroup reads the same on
  // day one as in week ten: `projects` (student and team projects), `teams`
  // (team subgroups) and the Content project. Best-effort: each is also made
  // on first use if this fails.
  const namespace = `${group.full_path}/${classroom.slug}`;
  for (const [path, title] of [
    [GITLAB_PROJECTS_SUBGROUP, 'Projects'],
    [GITLAB_TEAMS_SUBGROUP, 'Teams'],
  ] as const) {
    try {
      await provider.createSubgroup(namespace, title, path);
    } catch (error: unknown) {
      console.error(`${title} subgroup creation failed:`, error);
    }
  }
  try {
    await ClassmojiService.page.ensureContentRepo(classroom.id);
  } catch (error: unknown) {
    console.error('Content project creation failed:', error);
  }

  // Import from a source classroom if asked (settings, repositories, and in
  // the background content, template copies and modules); seeds the default
  // grading scale either way.
  const { successMessage, importJobId, importWarnings, unreachableSourceOrg } =
    await runClassroomImport({
      state: prepared.state,
      classroom,
      gitOrgLogin: gitOrg.login,
      userId,
    });

  return {
    success: successMessage,
    action: ActionTypes.CREATE_CLASSROOM,
    classroomSlug: classroom.slug,
    import_job_id: importJobId,
    import_warnings: importWarnings,
    import_github_unavailable: unreachableSourceOrg,
  };
}
