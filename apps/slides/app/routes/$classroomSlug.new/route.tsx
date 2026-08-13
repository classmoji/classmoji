/**
 * Create New Slide Route
 *
 * Allows users to create a new slide presentation for a classroom.
 * Creates the slide in GitHub and the database, then redirects to the editor.
 * Requires OWNER, TEACHER, or ASSISTANT role.
 */

import { useLoaderData, useNavigation, Form, redirect, useActionData } from 'react-router';
import getPrisma from '@classmoji/database';
import { requireClassroomTeachingTeam } from '@classmoji/auth/server';
import { slideService } from '@classmoji/services/slides';
import { useUser } from '~/root';

export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const { classroomSlug } = params;
  if (!classroomSlug) throw new Response('Missing classroomSlug', { status: 400 });

  // Authorization: require OWNER, TEACHER, or ASSISTANT role to create slides
  await requireClassroomTeachingTeam(request, classroomSlug, {
    resourceType: 'SLIDE_CONTENT',
  });

  // Get classroom with git_organization
  const classroom = await getPrisma().classroom.findFirst({
    where: { slug: classroomSlug },
    include: { git_organization: true },
  });

  if (!classroom) {
    throw new Response(`Classroom not found: ${classroomSlug}`, { status: 404 });
  }

  // Get git org login for GitHub API calls
  const gitOrgLogin = classroom.git_organization?.login;
  if (!gitOrgLogin) {
    throw new Response('Git organization not configured for this classroom', { status: 400 });
  }

  // Slides land in the classroom's STORED content repo (user-editable, never
  // re-derived); creation is impossible without it.
  if (!classroom.content_repo) {
    throw new Response('Classroom content repo not configured', { status: 400 });
  }

  return {
    classroomSlug,
    contentNamespace: classroom.content_namespace,
    gitOrgLogin,
    classroom,
    webappUrl: process.env.WEBAPP_URL || 'http://localhost:3000',
  };
};

export const action = async ({
  request,
  params,
}: {
  request: Request;
  params: Record<string, string | undefined>;
}) => {
  const { classroomSlug } = params;
  if (!classroomSlug) return { error: 'Missing classroomSlug' };
  const formData = await request.formData();

  const title = (formData.get('title') as string | null)?.trim();

  // Validate required fields
  if (!title) {
    return { error: 'Please enter a title for the slides' };
  }

  // Authorization: require OWNER, TEACHER, or ASSISTANT role to create slides
  const { userId } = await requireClassroomTeachingTeam(request, classroomSlug, {
    resourceType: 'SLIDE_CONTENT',
  });

  // Get classroom with git_organization for GitHub API calls
  const classroom = await getPrisma().classroom.findFirst({
    where: { slug: classroomSlug },
    include: { git_organization: true },
  });

  if (!classroom) {
    return { error: `Classroom not found: ${classroomSlug}` };
  }

  const gitOrgLogin = classroom.git_organization?.login;
  if (!gitOrgLogin) {
    return { error: 'Git organization not configured for this classroom' };
  }

  // Slides land in the classroom's STORED content repo (user-editable, never
  // re-derived); creation is impossible without it.
  if (!classroom.content_repo) {
    return { error: 'Classroom content repo not configured' };
  }

  try {
    // Orchestrated creation (content-tools plan §5.3): repo ensure → canonical
    // starter deck via saveDeck (deck.json + index.html in one commit) → DB
    // row → manifest refresh.
    const { slide } = await slideService.createSlide({
      classroomId: classroom.id,
      title,
      createdBy: userId,
    });

    // Redirect to the new slide in edit mode
    return redirect(`/${slide.id}?mode=edit`);
  } catch (error: unknown) {
    console.error('Failed to create slide:', error);
    const message = error instanceof Error ? error.message : 'Failed to create slide';
    return { error: message };
  }
};

export default function CreateSlidePage() {
  const { classroomSlug, contentNamespace, classroom, webappUrl } = useLoaderData<typeof loader>();
  const userContext = useUser();
  const user = userContext?.user;
  const navigation = useNavigation();
  const actionData = useActionData();

  const isProcessing = navigation.state === 'submitting';
  const error = actionData?.error;

  // Check if user has permission using classroom memberships
  // OWNER, TEACHER, and ASSISTANT can all create slides
  const membership = user?.classroom_memberships?.find(
    (m: { classroom?: { slug: string } }) => m.classroom?.slug === classroomSlug
  );
  const canCreate =
    membership?.role === 'OWNER' ||
    membership?.role === 'TEACHER' ||
    membership?.role === 'ASSISTANT';

  const namespaceDisplay = contentNamespace ?? '';

  if (!canCreate) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="text-4xl mb-4">🔒</div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-2">Access Denied</h1>
          <p className="text-gray-500 dark:text-gray-400 mb-4">
            You do not have permission to create slides for {classroom.name || classroomSlug}. Only
            Owners, Teachers, and Assistants can create slides.
          </p>
          <a
            href={webappUrl}
            className="px-4 py-2 bg-black text-white rounded-md hover:bg-gray-800 inline-block"
          >
            Back to Classmoji
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-8">
      <div className="max-w-xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Create New Slides</h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Create a new slide presentation for {classroom.name || classroomSlug}
            </p>
          </div>
          <a
            href={`${webappUrl}/admin/${classroomSlug}/slides`}
            className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Cancel
          </a>
        </div>

        {/* Create Form */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
          <Form method="post">
            {/* Error message */}
            {error && (
              <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}

            {/* Title */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Title <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                name="title"
                required
                placeholder="e.g., Introduction to JavaScript"
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* Content namespace (read-only) */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Content namespace
              </label>
              <input
                type="text"
                value={namespaceDisplay}
                disabled
                className="w-full px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 cursor-not-allowed"
              />
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                Determined by your classroom settings
              </p>
            </div>

            {/* Submit Button */}
            <div className="flex justify-end gap-3">
              <a
                href={`${webappUrl}/admin/${classroomSlug}/slides`}
                className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md"
              >
                Cancel
              </a>
              <button
                type="submit"
                disabled={isProcessing}
                className="px-6 py-2 bg-black text-white rounded-md hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isProcessing ? (
                  <>
                    <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                    Creating...
                  </>
                ) : (
                  'Create Slides'
                )}
              </button>
            </div>
          </Form>
        </div>
      </div>
    </div>
  );
}
