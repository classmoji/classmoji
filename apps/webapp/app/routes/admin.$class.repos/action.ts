import { namedAction } from '~/utils/namedAction.server';

import { isGitLabClassroom } from '~/utils/gitlabGuard.server';
import { ClassmojiService } from '@classmoji/services';
import { gitTerms } from '~/utils/gitWeb';
import {
  RepositorySyncNotFoundError,
  RepositorySyncPartialError,
} from '@classmoji/tasks/repo-sync';
import { publishAssignment, publishAssignmentAndRepository, syncAssignment } from './helpers';
import { calculateContributions } from './contributions';
import { ActionTypes } from '~/constants';
import { addClassroomAuditLog } from '~/utils/helpers';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom, userId, membership } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'REPOSITORIES',
    action: 'manage_repositories',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const terms = gitTerms(isGitLabClassroom(classroom));
  // Every action here names one record by `assignment_id`; anything else is
  // answered in the route's error shape rather than failing further down.
  let data: unknown;
  try {
    data = await request.json();
  } catch {
    return { error: 'Invalid request.' };
  }
  const assignmentId =
    typeof data === 'object' && data !== null
      ? (data as { assignment_id?: unknown }).assignment_id
      : undefined;
  if (typeof assignmentId !== 'string' || !assignmentId) return { error: 'Invalid request.' };

  // One audit row per repository action (CLAUDE.md rule 2), named like the
  // MCP repo tools' rows so both surfaces read together.
  const auditRepository = (
    action: 'UPDATE' | 'DELETE',
    tool: string,
    metadata: Record<string, unknown> = {},
    options: { dedupe?: boolean } = {}
  ) =>
    addClassroomAuditLog({
      classroomId: classroom.id,
      userId,
      role: membership!.role,
      action,
      resourceType: 'REPOSITORIES',
      resourceId: assignmentId,
      metadata: { tool, ...metadata },
      ...options,
    });

  return namedAction(request, {
    async delete() {
      const repository = await ClassmojiService.repository.findByIdInClassroom(
        assignmentId,
        classroom.id
      );
      await ClassmojiService.repository.deleteById(assignmentId, classroom.id);
      await auditRepository('DELETE', 'web:repos.delete', {
        title: repository?.title ?? null,
      });

      return {
        success: `${terms.Repo} deleted`,
        action: ActionTypes.DELETE_ASSIGNMENT,
      };
    },

    async publish() {
      const result = await publishAssignment(classSlug, classroom.id, assignmentId, userId);
      if (!('error' in result)) {
        const session = 'triggerSession' in result ? result.triggerSession : null;
        await auditRepository('UPDATE', 'web:repos.publish', {
          is_published: true,
          ...(session ? { repos_to_create: session.numReposToCreate / 2 } : {}),
        });
      }
      return result;
    },

    // One assignment, plus its repository when that still needs provisioning.
    // `assignment_id` really is an assignment id here, unlike the repository-
    // scoped actions around it.
    async publishAssignment() {
      const result = await publishAssignmentAndRepository(
        classSlug,
        classroom.id,
        assignmentId,
        userId
      );
      if (!('error' in result)) {
        const session = 'triggerSession' in result ? result.triggerSession : null;
        await addClassroomAuditLog({
          classroomId: classroom.id,
          userId,
          role: membership!.role,
          action: 'UPDATE',
          resourceType: 'ASSIGNMENTS',
          resourceId: assignmentId,
          metadata: {
            tool: 'web:repos.publish_assignment',
            is_published: true,
            // Repos provisioned (the assignment arrives with them), or the
            // assignment queued into repos that already existed. Either way
            // the session counts two runs per item (Github + database).
            ...(session && session.numReposToCreate > 0
              ? { repos_to_create: session.numReposToCreate / 2 }
              : {}),
            ...(session && session.numReposToCreate === 0
              ? { opened_in_repos: session.numIssuesToCreate / 2 }
              : {}),
          },
        });
      }
      return result;
    },

    async unpublish() {
      await ClassmojiService.repository.setPublished(assignmentId, false, classroom.id);
      await auditRepository('UPDATE', 'web:repos.unpublish', { is_published: false });
      return { success: `${terms.Repo} unpublished` };
    },

    async sync() {
      // Two syncs a few seconds apart are two actions: never folded into one row.
      const once = { dedupe: false };
      let res: Awaited<ReturnType<typeof syncAssignment>>;
      try {
        res = await syncAssignment(classSlug, classroom.id, assignmentId, userId);
      } catch (error: unknown) {
        if (error instanceof RepositorySyncNotFoundError)
          return { error: `${terms.Repo} not found.` };
        console.error('[admin.repos] Sync failed:', error);
        // Part of the work was queued before the failure: record what was.
        if (error instanceof RepositorySyncPartialError) {
          await auditRepository(
            'UPDATE',
            'web:repos.sync',
            {
              partial: true,
              repos_to_create: error.reposToCreate,
              assignments_to_add: error.assignmentsToAdd,
            },
            once
          );
        }
        return { error: 'Sync could not finish. Try again in a minute.' };
      }
      const {
        triggerSession: { numReposToCreate, numIssuesToCreate },
      } = res;
      // The session counts two runs per repo and per issue (Github + database).
      await auditRepository(
        'UPDATE',
        'web:repos.sync',
        {
          repos_to_create: numReposToCreate / 2,
          assignments_to_add: numIssuesToCreate / 2,
        },
        once
      );

      if (numReposToCreate + numIssuesToCreate == 0)
        return {
          info: 'No missing repo or issue',
        };

      return res;
    },

    // Group repos only: fan out one contribution-stats task per team repo.
    async calculateContributions() {
      const repository = await ClassmojiService.repository.findByIdInClassroom(
        assignmentId,
        classroom.id
      );
      if (!repository) {
        return { action: 'CALCULATE_REPO_CONTRIBUTIONS', error: 'Repository not found.' };
      }
      return calculateContributions({ id: repository.id }, classSlug);
    },
  });
};
