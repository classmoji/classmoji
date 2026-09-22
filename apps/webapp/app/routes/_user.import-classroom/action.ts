import { ClassmojiService } from '@classmoji/services';
import { checkAuth } from '~/utils/helpers';
import { ActionTypes } from '~/constants';

type ImportInputs = Parameters<
  typeof ClassmojiService.githubClassroomImport.importGithubClassrooms
>[1];

/**
 * Import one or more GitHub Classroom classrooms from an uploaded export bundle.
 *
 * The bundle is parsed client-side; the request body carries the normalized,
 * already-selected classrooms (each with a resolved slug). The import is fast,
 * GitHub-free DB work, so it runs synchronously here (no background job) and
 * records a durable `AuditLog` row per classroom for observability.
 */
export const action = checkAuth(async ({ request, user }) => {
  let body: { classrooms?: ImportInputs };
  try {
    body = await request.json();
  } catch {
    return { error: 'Invalid request body.' };
  }

  const classrooms = body.classrooms;
  if (!Array.isArray(classrooms) || classrooms.length === 0) {
    return { error: 'No classrooms selected to import.' };
  }

  let results: Awaited<
    ReturnType<typeof ClassmojiService.githubClassroomImport.importGithubClassrooms>
  >['results'];
  let errors: Awaited<
    ReturnType<typeof ClassmojiService.githubClassroomImport.importGithubClassrooms>
  >['errors'];
  try {
    ({ results, errors } = await ClassmojiService.githubClassroomImport.importGithubClassrooms(
      user.id,
      classrooms
    ));
  } catch (error: unknown) {
    console.error('github classroom import failed:', error);
    return { error: error instanceof Error ? error.message : 'Import failed. Please try again.' };
  }

  // Durable audit record per imported classroom (the importer is the OWNER).
  for (const r of results) {
    try {
      await ClassmojiService.audit.create({
        user_id: user.id,
        classroom_id: r.classroomId,
        role: 'OWNER',
        action: 'CREATE',
        resource_type: 'GITHUB_CLASSROOM_IMPORT',
        resource_id: r.classroomSlug,
        data: {
          classroomName: r.classroomName,
          organizationLogin: r.organizationLogin,
          appInstalled: r.appInstalled,
          repositoriesImported: r.repositoriesImported,
          assignmentsImported: r.assignmentsImported,
          studentsEnrolled: r.studentsEnrolled,
          reposLinked: r.reposLinked,
          gradesRecorded: r.gradesRecorded,
          teamsImported: r.teamsImported,
          teamMembershipsImported: r.teamMembershipsImported,
          groupReposLinked: r.groupReposLinked,
          warnings: r.warnings,
        },
      });
    } catch (auditError: unknown) {
      console.error('audit log (classroom import) failed:', auditError);
    }
  }

  if (results.length === 0) {
    return { error: errors[0]?.message ?? 'Import failed.', errors };
  }

  const totalStudents = results.reduce((n, r) => n + r.studentsEnrolled, 0);
  const plural = results.length === 1 ? '' : 's';

  return {
    success: `Imported ${results.length} classroom${plural} with ${totalStudents} student${
      totalStudents === 1 ? '' : 's'
    }.`,
    action: ActionTypes.IMPORT_CLASSROOM,
    results,
    errors,
    // Single-classroom import → navigate straight to its dashboard.
    classroomSlug: results.length === 1 ? results[0].classroomSlug : undefined,
  };
});
