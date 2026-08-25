import { namedAction } from 'remix-utils/named-action';
import invariant from 'tiny-invariant';
import {
  ClassmojiService,
  TeamServiceError,
  describeTeamFailureReason,
  type TeamFailureReason,
} from '@classmoji/services';
import { ActionTypes } from '~/constants';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

/**
 * Every mutation here delegates to ClassmojiService.teamAdmin, which resolves
 * the team through the classroom before it touches GitHub. The route keeps the
 * auth gates and the callout payload shapes; the service owns validation,
 * ordering and per-item failure reporting.
 */
const errorMessage = (error: TeamServiceError, slug: string) => {
  switch (error.code) {
    case 'invalid_name':
      return 'New team name is required';
    case 'no_org_configured':
      return 'Git organization not configured';
    case 'provider_unsupported':
      return 'Team rename is only supported for GitHub organizations';
    case 'team_not_found':
      return `Team @${slug} was not found in this classroom.`;
    case 'reserved_name':
      return 'That name is reserved for classroom teams. Please choose a different name.';
    case 'name_collision':
      return 'A team with that name already exists in this classroom.';
    case 'user_not_found':
      return 'No user with that login.';
    case 'tag_not_found':
      return 'That tag is not on this team.';
    default:
      return 'Could not complete this action.';
  }
};

/**
 * The service reports per-item failures as reason CODES, not raw provider or
 * database messages. The UI renders whatever it is handed, so the code is
 * turned into its phrase here, at the boundary — the client never sees the
 * vocabulary and the failure cards need no mapping of their own.
 */
const toDisplayFailures = <T extends { error: TeamFailureReason }>(failed: T[]) =>
  failed.map(f => ({ ...f, error: describeTeamFailureReason(f.error) }));

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;
  const slug = params.slug!;

  invariant(slug, 'Team slug is required');

  const { classroom, membership } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TEAMS',
    action: 'edit_team',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();

  // Map the typed service failures onto the `{ error, action }` payload the
  // global fetcher turns into a toast; anything else keeps bubbling.
  const run = async <T>(actionType: string, work: () => Promise<T>) => {
    try {
      return { ok: true as const, value: await work() };
    } catch (error: unknown) {
      if (error instanceof TeamServiceError) {
        return {
          ok: false as const,
          payload: { error: errorMessage(error, slug), action: actionType },
        };
      }
      throw error;
    }
  };

  return namedAction(request, {
    async addMembersToTeam() {
      const { members } = data as { members?: string[] };

      const result = await run(ActionTypes.ADD_TEAM_MEMBER, () =>
        ClassmojiService.teamAdmin.addTeamMembers({
          classroomId: classroom.id,
          slugOrId: slug,
          logins: members ?? [],
        })
      );
      if (!result.ok) return result.payload;

      const { succeeded, failed } = result.value;
      const displayFailed = toDisplayFailures(failed);
      if (succeeded.length === 0 && failed.length > 0) {
        return {
          error: `Could not add ${failed.length} student(s) to @${slug}.`,
          action: ActionTypes.ADD_TEAM_MEMBER,
          failed: displayFailed,
        };
      }

      return {
        success:
          failed.length === 0
            ? `Added student(s) to @${slug}.`
            : `Added ${succeeded.length} student(s) to @${slug}. ${failed.length} failed.`,
        action: ActionTypes.ADD_TEAM_MEMBER,
        failed: displayFailed,
      };
    },

    async removeMemberFromTeam() {
      const { login } = data as { login: string };

      const result = await run(ActionTypes.REMOVE_TEAM_MEMBER, () =>
        ClassmojiService.teamAdmin.removeTeamMember({
          classroomId: classroom.id,
          slugOrId: slug,
          login,
        })
      );
      if (!result.ok) return result.payload;

      return {
        success: `Removed ${login} from @${slug}.`,
        action: ActionTypes.REMOVE_TEAM_MEMBER,
      };
    },

    async addTeamTags() {
      // The team comes from the URL, never from the request body — the client
      // used to send the teamId it wanted tagged.
      const { tags } = data as { tags?: string[] };

      const result = await run(ActionTypes.ADD_TEAM_TAG, () =>
        ClassmojiService.teamAdmin.addTeamTags({
          classroomId: classroom.id,
          slugOrId: slug,
          tagIds: tags ?? [],
        })
      );
      if (!result.ok) return result.payload;

      const { added, failed } = result.value;
      if (added.length === 0 && failed.length > 0) {
        return { error: 'Tag could not be added', action: ActionTypes.ADD_TEAM_TAG };
      }

      return {
        success:
          failed.length === 0
            ? 'Tag added successfully'
            : `Added ${added.length} tag(s). ${failed.length} failed.`,
        action: ActionTypes.ADD_TEAM_TAG,
      };
    },

    async removeTeamTag() {
      const { id } = data as { id: string };

      const result = await run(ActionTypes.REMOVE_TEAM_TAG, () =>
        ClassmojiService.teamAdmin.removeTeamTag({ classroomId: classroom.id, teamTagId: id })
      );
      if (!result.ok) return result.payload;

      return {
        success: 'Tag removed successfully',
        action: ActionTypes.REMOVE_TEAM_TAG,
      };
    },

    async renameTeam() {
      const { newName } = data as { newName?: string };

      const result = await run(ActionTypes.RENAME_TEAM, () =>
        ClassmojiService.teamAdmin.renameTeam({
          classroomId: classroom.id,
          slugOrId: slug,
          newName: newName ?? '',
        })
      );
      if (!result.ok) return result.payload;

      const { newSlug, failed } = result.value;

      return {
        success:
          failed.length === 0
            ? `Renamed team to @${newSlug}.`
            : `Renamed team to @${newSlug}. ${failed.length} repo(s) failed to rename.`,
        action: ActionTypes.RENAME_TEAM,
        newSlug,
        failed: toDisplayFailures(failed),
      };
    },
  });
};
