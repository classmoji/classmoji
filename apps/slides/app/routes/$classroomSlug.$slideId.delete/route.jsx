/**
 * Delete Slide Route
 *
 * Full-page confirmation for deleting a slide, including theme cleanup options.
 * Replaces the DeleteSlideModal from the webapp.
 * Requires edit permission (same as editing slides).
 */

import { useState } from 'react';
import { useLoaderData, useNavigation, Form, redirect, useActionData } from 'react-router';
import { assertSlideAccess } from '@classmoji/auth/server';
import { useUser } from '~/root';
import { getSlideDeleteInfo, deleteSlide } from '~/utils/slideService.server';

export const loader = async ({ params, request }) => {
  const { classroomSlug, slideId } = params;

  // Authorization: require edit permission to delete slides
  // Uses same permissions as editing (owner/teacher/assistant with team_edit)
  await assertSlideAccess({
    request,
    slideId,
    accessType: 'edit',
  });

  // Get slide info for deletion confirmation
  let slideInfo;
  try {
    slideInfo = await getSlideDeleteInfo(slideId);
  } catch (error) {
    console.log(error);
    throw new Response(error.message || 'Slide not found', { status: 404 });
  }

  // Validate that the slide belongs to this classroom
  if (slideInfo.slide.classroom?.slug !== classroomSlug) {
    throw new Response('Slide does not belong to this classroom', { status: 403 });
  }

  // Build the GitHub paths that will be deleted
  const gitOrgLogin = slideInfo.slide.classroom?.git_organization?.login;
  const repoName = gitOrgLogin ? `content-${gitOrgLogin}-${slideInfo.slide.term}` : null;
  const contentPath = slideInfo.slide.content_path;

  return {
    classroomSlug,
    slideId,
    slide: {
      id: slideInfo.slide.id,
      title: slideInfo.slide.title,
      term: slideInfo.slide.term,
      contentPath,
    },
    github: repoName ? {
      repo: repoName,
      folder: contentPath,
      files: [
        `${contentPath}/index.html`,
        `${contentPath}/images/*`,
      ],
    } : null,
    classroom: {
      name: slideInfo.slide.classroom?.name,
      slug: slideInfo.slide.classroom?.slug,
    },
    themeName: slideInfo.themeName,
    otherSlidesUsingTheme: slideInfo.otherSlidesUsingTheme || 0,
    slideList: slideInfo.slideList || [],
    webappUrl: process.env.WEBAPP_URL || 'http://localhost:3000',
  };
};

export const action = async ({ request, params }) => {
  const { classroomSlug, slideId } = params;
  const formData = await request.formData();

  const deleteTheme = formData.get('deleteTheme') === 'true';

  // Authorization: require edit permission to delete slides
  const { slide } = await assertSlideAccess({
    request,
    slideId,
    accessType: 'edit',
  });

  // Verify the slide belongs to this classroom
  if (slide.classroom?.slug !== classroomSlug) {
    return { error: 'Slide does not belong to this classroom' };
  }

  // Delete the slide
  try {
    await deleteSlide({ slideId, deleteTheme });

    // Redirect back to webapp slides list
    const webappUrl = process.env.WEBAPP_URL || 'http://localhost:3000';
    return redirect(`${webappUrl}/admin/${classroomSlug}/slides`);
  } catch (error) {
    console.error('Failed to delete slide:', error);
    return { error: error.message || 'Failed to delete slide' };
  }
};

export default function DeleteSlidePage() {
  const {
    classroomSlug,
    slide,
    classroom,
    github,
    themeName,
    otherSlidesUsingTheme,
    slideList,
    webappUrl,
  } = useLoaderData();
  const userContext = useUser();
  const user = userContext?.user;
  const navigation = useNavigation();
  const actionData = useActionData();
  const [deleteTheme, setDeleteTheme] = useState(Boolean(otherSlidesUsingTheme === 0 && themeName));

  const isDeleting = navigation.state === 'submitting';
  const error = actionData?.error;

  // Check if user has permission using classroom memberships
  // OWNER, TEACHER, and ASSISTANT can delete (ASSISTANT can delete their own slides or when team_edit is enabled)
  // Server-side auth in loader/action handles the detailed permission check
  const membership = user?.classroom_memberships?.find(m => m.classroom?.slug === classroomSlug);
  const canDelete = membership?.role === 'OWNER' || membership?.role === 'TEACHER' || membership?.role === 'ASSISTANT';

  if (!canDelete) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="text-4xl mb-4">🔒</div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
            Access Denied
          </h1>
          <p className="text-gray-500 dark:text-gray-400 mb-4">
            You do not have permission to delete slides for {classroom.name || classroomSlug}.
            Only Owners, Teachers, and Assistants can delete slides.
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
          <div className="flex items-center gap-3">
            <div className="text-2xl">⚠️</div>
            <div>
              <h1 className="text-2xl font-bold text-red-600 dark:text-red-400">
                Delete Slide
              </h1>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                This action cannot be undone
              </p>
            </div>
          </div>
          <a
            href={`${webappUrl}/admin/${classroomSlug}/slides`}
            className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Cancel
          </a>
        </div>

        {/* Confirmation Card */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
          <Form method="post">
            {/* Hidden field for deleteTheme */}
            <input type="hidden" name="deleteTheme" value={deleteTheme.toString()} />

            {/* Error message */}
            {error && (
              <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}

            {/* Slide info */}
            <div className="mb-6">
              <p className="text-gray-700 dark:text-gray-300">
                Are you sure you want to delete <strong className="text-gray-900 dark:text-white">{slide.title}</strong>?
              </p>
            </div>

            {/* Warning */}
            <div className="mb-6 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-md">
              <div className="flex items-start gap-3">
                <span className="text-amber-500">⚠️</span>
                <div>
                  <p className="font-medium text-amber-800 dark:text-amber-200">
                    This action cannot be undone
                  </p>
                  <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                    The slide content will be permanently removed from both the database and GitHub.
                  </p>
                </div>
              </div>
            </div>

            {/* Files to be deleted */}
            {github && (
              <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-md">
                <p className="font-medium text-gray-900 dark:text-white mb-2">
                  Files to be deleted from GitHub:
                </p>
                <div className="font-mono text-xs bg-gray-100 dark:bg-gray-800 rounded p-3 overflow-x-auto">
                  <p className="text-gray-500 dark:text-gray-400 mb-1">
                    # Repository: {github.repo}
                  </p>
                  {github.files.map((file, i) => (
                    <p key={i} className="text-red-600 dark:text-red-400">
                      - {file}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {/* Theme info */}
            {themeName && (
              <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-md">
                <p className="font-medium text-gray-900 dark:text-white mb-2">
                  Shared Theme: {themeName}
                </p>

                {otherSlidesUsingTheme > 0 ? (
                  <>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                      This theme is also used by {otherSlidesUsingTheme} other slide{otherSlidesUsingTheme !== 1 ? 's' : ''}:
                    </p>
                    <ul className="text-sm text-gray-500 dark:text-gray-400 list-disc list-inside mb-2">
                      {slideList.slice(0, 5).map(s => (
                        <li key={s.id}>{s.title}</li>
                      ))}
                      {slideList.length > 5 && (
                        <li>...and {slideList.length - 5} more</li>
                      )}
                    </ul>
                    <p className="text-sm text-amber-600 dark:text-amber-400">
                      The theme will be kept since other slides are using it.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                      No other slides are using this theme.
                    </p>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={deleteTheme}
                        onChange={e => setDeleteTheme(e.target.checked)}
                        className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                      />
                      <span className="text-sm text-gray-700 dark:text-gray-300">
                        Also delete the shared theme from GitHub
                      </span>
                    </label>
                  </>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-3">
              <a
                href={`${webappUrl}/admin/${classroomSlug}/slides`}
                className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md"
              >
                Cancel
              </a>
              <button
                type="submit"
                disabled={isDeleting}
                className="px-6 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isDeleting ? (
                  <>
                    <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                    Deleting...
                  </>
                ) : (
                  'Delete Slide'
                )}
              </button>
            </div>
          </Form>
        </div>

        {/* Back link */}
        <div className="mt-6 text-center">
          <a
            href={`${webappUrl}/admin/${classroomSlug}/slides`}
            className="text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
          >
            ← Back to slides list
          </a>
        </div>
      </div>
    </div>
  );
}
