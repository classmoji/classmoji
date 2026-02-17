/**
 * Create New Slide Route
 *
 * Allows users to create a new slide presentation for a classroom.
 * Creates the slide in GitHub and the database, then redirects to the editor.
 * Requires OWNER, TEACHER, or ASSISTANT role.
 */

import { useLoaderData, useNavigation, Form, redirect, useActionData } from 'react-router';
import prisma from '@classmoji/database';
import { getGitProvider, ClassmojiService } from '@classmoji/services';
import { ContentService } from '@classmoji/content';
import { requireClassroomTeachingTeam } from '@classmoji/auth/server';
import { useUser } from '~/root';
import { generateTermString } from '@classmoji/utils';
import { generateSlideTemplate } from '~/utils/slideHelpers.server';

export const loader = async ({ params, request }) => {
  const { classroomSlug } = params;

  // Authorization: require OWNER, TEACHER, or ASSISTANT role to create slides
  await requireClassroomTeachingTeam(request, classroomSlug, {
    resourceType: 'SLIDE_CONTENT',
    attemptedAction: 'create_slide',
  });

  // Get classroom with git_organization
  const classroom = await prisma.classroom.findUnique({
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

  // Generate term string from classroom settings
  const term = generateTermString(classroom.term, classroom.year);
  if (!term) {
    throw new Response('Classroom term/year not configured', { status: 400 });
  }

  return {
    classroomSlug,
    term,
    gitOrgLogin,
    classroom,
    webappUrl: process.env.WEBAPP_URL || 'http://localhost:3000',
  };
};

export const action = async ({ request, params }) => {
  const { classroomSlug } = params;
  const formData = await request.formData();

  const title = formData.get('title')?.trim();
  const term = formData.get('term');

  // Validate required fields
  if (!title) {
    return { error: 'Please enter a title for the slides' };
  }

  // Authorization: require OWNER, TEACHER, or ASSISTANT role to create slides
  const { userId } = await requireClassroomTeachingTeam(request, classroomSlug, {
    resourceType: 'SLIDE_CONTENT',
    attemptedAction: 'create_slide',
  });

  // Get classroom with git_organization for GitHub API calls
  const classroom = await prisma.classroom.findUnique({
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

  // Generate slug from title
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  // Content repo name: content-{gitOrgLogin}-{term}
  const repoName = `content-${gitOrgLogin}-${term}`;

  // Flat content path: slides/{slug}
  const contentPath = `slides/${slug}`;

  try {
    // Step 1: Check if content repo exists, create if not
    const gitProvider = getGitProvider(classroom.git_organization);
    const repoExists = await gitProvider.repositoryExists(gitOrgLogin, repoName);
    if (!repoExists) {
      console.log(`Creating content repository: ${repoName}`);
      await gitProvider.createPublicRepository(
        gitOrgLogin,
        repoName,
        `Course content for ${classroom.name || gitOrgLogin} - ${term}`
      );

      // Give GitHub a moment to initialize the repo
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Always try to enable GitHub Pages (idempotent - skips if already enabled)
    try {
      console.log(`Ensuring GitHub Pages is enabled for: ${repoName}`);
      await gitProvider.enableGitHubPages(gitOrgLogin, repoName);
    } catch (pagesError) {
      // Pages API requires special permission - log but continue
      console.warn(`Could not auto-enable GitHub Pages: ${pagesError.message}`);
      console.warn('GitHub Pages may need to be enabled manually in repo settings');
    }

    // Step 2: Create the slide HTML file
    const slideHtml = generateSlideTemplate(title);
    const filePath = `${contentPath}/index.html`;

    console.log(`Creating slide content at: ${filePath}`);
    await ContentService.put({
      gitOrganization: classroom.git_organization,
      repo: repoName,
      path: filePath,
      content: slideHtml,
      message: `Create slides: ${title}`,
    });

    // Step 3: Create the database record
    const slide = await prisma.slide.create({
      data: {
        title,
        slug,
        term,
        content_path: contentPath,
        classroom_id: classroom.id,
        created_by: userId,
      },
    });

    // Update manifest after creating slide
    await ClassmojiService.contentManifest.saveManifest(classroom.id);

    // Redirect to the new slide in edit mode
    return redirect(`/${slide.id}?mode=edit`);
  } catch (error) {
    console.error('Failed to create slide:', error);
    return { error: error.message || 'Failed to create slide' };
  }
};

export default function CreateSlidePage() {
  const { classroomSlug, term, classroom, webappUrl } = useLoaderData();
  const userContext = useUser();
  const user = userContext?.user;
  const navigation = useNavigation();
  const actionData = useActionData();

  const isProcessing = navigation.state === 'submitting';
  const error = actionData?.error;

  // Check if user has permission using classroom memberships
  // OWNER, TEACHER, and ASSISTANT can all create slides
  const membership = user?.classroom_memberships?.find(m => m.classroom?.slug === classroomSlug);
  const canCreate = membership?.role === 'OWNER' || membership?.role === 'TEACHER' || membership?.role === 'ASSISTANT';

  // Format term for display (e.g., "25w" -> "Winter 2025")
  const termDisplayMap = { w: 'Winter', s: 'Spring', u: 'Summer', f: 'Fall' };
  const termYear = term ? `20${term.slice(0, 2)}` : '';
  const termSeason = term ? termDisplayMap[term.slice(2)] : '';
  const termDisplay = term ? `${termSeason} ${termYear}` : '';

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
            {/* Hidden field for term */}
            <input type="hidden" name="term" value={term} />

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

            {/* Term (read-only) */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Term
              </label>
              <input
                type="text"
                value={termDisplay}
                disabled
                className="w-full px-4 py-2 border border-gray-200 dark:border-gray-700 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400 cursor-not-allowed"
              />
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                Term is determined by your classroom settings
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
