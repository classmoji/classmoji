import { auth } from '@trigger.dev/sdk';
import Tasks from '@classmoji/tasks';
import { checkAuth } from '~/utils/helpers';

interface Selection {
  classroomId: number;
  name: string;
  slug: string;
}

const isTriggerConfigured = () =>
  Boolean(process.env.TRIGGER_SECRET_KEY || process.env.TRIGGER_ACCESS_TOKEN);

/**
 * Kick off a live GitHub Classroom import.
 *
 * The body carries the selected classrooms (each with a resolved slug). We fan
 * out one background job per classroom (so progress is trackable per classroom),
 * tagged with a shared session id, and return a Trigger.dev public token the UI
 * uses to subscribe to live progress. The heavy GitHub fetch + DB import happens
 * in the job (`import_github_classroom`); see its workflow for details.
 */
export const action = checkAuth(async ({ request, user }) => {
  if (!isTriggerConfigured()) {
    return {
      error:
        'Importing requires the background job service (Trigger.dev), which isn’t configured here.',
    };
  }

  let body: { selections?: Selection[] };
  try {
    body = await request.json();
  } catch {
    return { error: 'Invalid request body.' };
  }

  const selections = (body.selections ?? []).filter(
    s => s && typeof s.classroomId === 'number' && s.slug
  );
  if (selections.length === 0) {
    return { error: 'No classrooms selected to import.' };
  }

  const sessionId = crypto.randomUUID();
  const tag = `session_${sessionId}`;

  try {
    await Tasks.importGithubClassroomTask.batchTrigger(
      selections.map(s => ({
        payload: {
          userId: user.id,
          sessionId,
          classroomId: s.classroomId,
          name: s.name,
          slug: s.slug,
        },
        options: { tags: [tag] },
      })) as unknown as Parameters<typeof Tasks.importGithubClassroomTask.batchTrigger>[0]
    );
  } catch (error: unknown) {
    console.error('failed to trigger github classroom import:', error);
    return { error: 'Could not start the import. Please try again.' };
  }

  const accessToken = await auth.createPublicToken({
    scopes: { read: { tags: [tag] } },
  });

  return {
    triggerSession: {
      accessToken,
      id: sessionId,
      expected: selections.length,
      // For a single import we know the destination slug up front (the importer
      // uses it verbatim); multi-import lands back on the org picker.
      singleSlug: selections.length === 1 ? selections[0].slug : null,
    },
  };
});
