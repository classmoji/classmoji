import getPrisma from '@classmoji/database';
import {
  ClassmojiService,
  ClassroomSlugUnavailableError,
  GitLabProvider,
  createWithUniqueClassroomSlug,
} from '@classmoji/services';
import { canonicalTimeZone, defaultContentRepoName } from '@classmoji/utils';
import { ActionTypes } from '~/constants';
import { slugify } from './utils';
import { pickContentNamespace } from './contentNamespace.server';

/**
 * Create a classroom on GitLab: the group is the organization (connected
 * through the user's GitLab connection, the counterpart of the Github App
 * installation) and the classroom gets its own subgroup, which holds its
 * student projects and whose members are its staff.
 */
export async function createGitLabClassroom(
  userId: string,
  input: { group_id?: unknown; name?: unknown; slug?: unknown; timezone?: unknown }
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

  const provider = new GitLabProvider(groupId, null, () =>
    ClassmojiService.gitlabConnection.getConnectionToken(connection.id)
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
  const existing = await getPrisma().gitOrganization.findUnique({
    where: { provider_provider_id: { provider: 'GITLAB', provider_id: String(group.id) } },
  });
  const gitOrg = existing
    ? await getPrisma().gitOrganization.update({
        where: { id: existing.id },
        data: {
          login: group.full_path,
          ...(existing.gitlab_connection_id ? {} : { gitlab_connection_id: connection.id }),
        },
      })
    : await getPrisma().gitOrganization.create({
        data: {
          provider: 'GITLAB',
          provider_id: String(group.id),
          login: group.full_path,
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
    const subgroup = await provider.createSubgroup(group.full_path, name, classroom.slug);
    await getPrisma().classroom.update({
      where: { id: classroom.id },
      data: { git_namespace: subgroup.full_path },
    });
  } catch (error: unknown) {
    await getPrisma()
      .classroom.delete({ where: { id: classroom.id } })
      .catch(() => {});
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

  try {
    await ClassmojiService.emojiMapping.ensureDefaultScale(classroom.id);
  } catch (error: unknown) {
    console.error('Default grading scale seeding failed:', error);
  }

  return {
    success: 'Classroom created successfully!',
    action: ActionTypes.CREATE_CLASSROOM,
    classroomSlug: classroom.slug,
    import_job_id: null,
    import_warnings: [] as string[],
    import_github_unavailable: null,
  };
}
