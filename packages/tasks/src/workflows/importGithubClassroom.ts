import { task, logger, metadata } from '@trigger.dev/sdk';
import { ClassmojiService } from '@classmoji/services';

/**
 * Import one GitHub Classroom into Classmoji by pulling it live from the GitHub
 * Classroom REST API (no ZIP upload). One run per classroom, so the webapp can
 * track per-classroom progress via run tags (`session_<id>`).
 *
 * Steps: resolve the user's GitHub token → fetch + normalize the classroom →
 * hand the normalized bundle to the (GitHub-free, idempotent) importer → record
 * an AuditLog. Re-running the same import is safe (the importer upserts).
 */
export const importGithubClassroomTask = task({
  id: 'import_github_classroom',
  queue: {
    // Gentle on the GitHub API: a handful of classrooms import concurrently,
    // and each classroom fans out to ~3 calls per assignment internally.
    concurrencyLimit: 4,
  },
  run: async (arg: {
    userId: string;
    classroomId: number;
    name: string;
    slug: string;
    sessionId?: string;
  }) => {
    const { userId, classroomId, name, slug } = arg;
    logger.info('Importing GitHub Classroom', { classroomId, name, slug });

    metadata.set('classroomName', name);
    metadata.set('currentStep', 'Authenticating with GitHub');
    await metadata.flush();

    const tokenResult = await ClassmojiService.githubUserToken.getGitHubTokenForUser(userId);
    if (!tokenResult?.token) {
      throw new Error(
        'No valid GitHub token for this user. Please sign in with GitHub again and retry.'
      );
    }

    let input;
    try {
      metadata.set('currentStep', `Fetching "${name}" from GitHub Classroom`);
      await metadata.flush();

      input = await ClassmojiService.githubClassroomApi.buildClassroomImportInput(
        tokenResult.token,
        classroomId,
        slug,
        (done, total) => {
          metadata.set('assignmentsDone', done);
          metadata.set('assignmentsTotal', total);
          metadata.set('currentStep', `Fetched ${done}/${total} assignments`);
        }
      );
    } catch (error: unknown) {
      // A revoked/expired token surfaces as 401 from GitHub — clear it so the
      // next sign-in re-issues a working one, then surface a clear message.
      if (typeof error === 'object' && error !== null && (error as { status?: number }).status === 401) {
        await ClassmojiService.githubUserToken.clearRevokedTokenForUser(userId);
        throw new Error('GitHub access was revoked. Please sign in with GitHub again and retry.');
      }
      throw error;
    }

    metadata.set('currentStep', 'Saving to Classmoji');
    await metadata.flush();

    const summary = await ClassmojiService.githubClassroomImport.importGithubClassroom(
      userId,
      input
    );

    // Durable audit record (importer is the OWNER). Mirrors the old synchronous
    // action's audit payload. Never fail the import on an audit-write error.
    try {
      await ClassmojiService.audit.create({
        user_id: userId,
        classroom_id: summary.classroomId,
        role: 'OWNER',
        action: 'CREATE',
        resource_type: 'GITHUB_CLASSROOM_IMPORT',
        resource_id: summary.classroomSlug,
        data: {
          classroomName: summary.classroomName,
          organizationLogin: summary.organizationLogin,
          appInstalled: summary.appInstalled,
          repositoriesImported: summary.repositoriesImported,
          assignmentsImported: summary.assignmentsImported,
          studentsEnrolled: summary.studentsEnrolled,
          reposLinked: summary.reposLinked,
          gradesRecorded: summary.gradesRecorded,
          teamsImported: summary.teamsImported,
          teamMembershipsImported: summary.teamMembershipsImported,
          groupReposLinked: summary.groupReposLinked,
          warnings: summary.warnings,
          source: 'github_classroom_api',
        },
      });
    } catch (auditError: unknown) {
      logger.error('audit log (classroom import) failed', { auditError });
    }

    metadata.set('currentStep', 'Done');
    await metadata.flush();

    return summary;
  },
});
