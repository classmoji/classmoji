/**
 * Import from Slides.com Route
 *
 * Allows users to import slides.com ZIP exports into the Classmoji slides platform.
 * The route validates permissions, shows an upload form, and processes the ZIP server-side.
 * Requires OWNER or TEACHER role.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useLoaderData, useNavigate } from 'react-router';
import { useDropzone, type FileRejection } from 'react-dropzone';
import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { getContentRepoName } from '@classmoji/utils';
import { REPO_REST_MAX_LABEL } from '@classmoji/utils/repo-limits';
import { requireClassroomStaff } from '@classmoji/auth/server';
import { useUser } from '~/root';
import { webappClassUrl } from '~/utils/webappLinks';
import { listSavedThemes } from '~/utils/themeService.server';
import ImportProgressModal from '~/components/ImportProgressModal';
import { useImportStream } from '~/hooks/useImportStream';
import { SLIDES_IMPORT_MAX_BYTES, SLIDES_IMPORT_MAX_LABEL } from '~/utils/importLimits';

// Note: prisma, ClassmojiService, getContentRepoName are used in the loader

export const loader = async ({ request }: { request: Request }) => {
  const url = new URL(request.url);
  const classroomSlug = url.searchParams.get('class');

  if (!classroomSlug) {
    throw new Response('Missing class parameter. Please use the import button from the webapp.', {
      status: 400,
    });
  }

  // Authorization: require OWNER or TEACHER role to import slides
  const { membership } = await requireClassroomStaff(request, classroomSlug, {
    resourceType: 'SLIDE_CONTENT',
  });

  // Get classroom with git_organization
  const classroom = await getPrisma().classroom.findUnique({
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

  // Get repositories for dropdown
  const repositories = await ClassmojiService.repository.findByClassroomSlug(classroomSlug);

  // Content repo is STORED and user-editable — never re-derived. Legacy
  // classrooms without one fall back to the ORG-level content repo.
  const repoName = classroom.content_repo
    ? classroom.content_repo
    : getContentRepoName({ login: gitOrgLogin });
  const savedThemes = await listSavedThemes(gitOrgLogin, repoName);

  // Where the ZIP's videos will go, for the note under the dropzone ONLY: the
  // importer asks the storage router again, per entry, from the classroom row.
  const uploadCapability = await ClassmojiService.media.uploadCapabilityFor(classroom);

  return {
    videosToMedia: uploadCapability.media !== null,
    repoMaxLabel: REPO_REST_MAX_LABEL,
    classroomSlug,
    contentNamespace: classroom.content_namespace,
    gitOrgLogin,
    classroom,
    repositories: repositories.map(m => ({ id: m.id, title: m.title })),
    savedThemes,
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    webappUrl: process.env.WEBAPP_URL || 'http://localhost:3000',
    // Where "Cancel" goes. Built from the role the server resolved, because
    // each webapp role tree is gated to its own role — the /admin tree is
    // OWNER-only, so a teacher sent there gets a 403.
    slidesListUrl: webappClassUrl(
      process.env.WEBAPP_URL || 'http://localhost:3000',
      membership?.role,
      classroomSlug,
      'slides'
    ),
  };
};

// Action removed - we now use the async /api/slides/import/start endpoint
// and stream progress via SSE

export default function ImportPage() {
  const {
    videosToMedia,
    repoMaxLabel,
    classroomSlug,
    classroom,
    repositories,
    savedThemes,
    webappUrl,
    slidesListUrl,
  } = useLoaderData<typeof loader>();
  const userContext = useUser();
  const user = userContext?.user;
  const navigate = useNavigate();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedRepository, setSelectedRepository] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [themeOption, setThemeOption] = useState('default');
  const [saveThemeName, setSaveThemeName] = useState('');
  const [dropzoneError, setDropzoneError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Import progress state (SSE-based)
  const [importId, setImportId] = useState<string | null>(null);
  const {
    progress,
    error: streamError,
    isDone,
    isConnected,
    slideId,
    warnings: importWarnings,
  } = useImportStream(importId);

  // Form ref for reading form data
  const formRef = useRef<HTMLFormElement>(null);

  const isProcessing = isSubmitting || !!importId;
  const error = submitError || streamError || dropzoneError;

  // Navigate to slide when import completes — unless it left files out, in
  // which case the progress modal says which, and opening the deck waits for
  // the person to have read that.
  const openImportedSlides = useCallback(() => {
    if (slideId) navigate(`/${slideId}?mode=edit`);
  }, [slideId, navigate]);
  useEffect(() => {
    if (isDone && slideId && importWarnings.length === 0) {
      openImportedSlides();
    }
  }, [isDone, slideId, importWarnings.length, openImportedSlides]);

  // Check if user has permission using classroom memberships
  const membership = user?.classroom_memberships?.find(
    (m: { classroom?: { slug: string } }) => m.classroom?.slug === classroomSlug
  );
  const canImport = membership?.role === 'OWNER' || membership?.role === 'TEACHER';

  // File dropzone
  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      setSelectedFile(acceptedFiles[0]);
      setDropzoneError(null); // Clear any previous error
    }
  }, []);

  const onDropRejected = useCallback((fileRejections: FileRejection[]) => {
    const rejection = fileRejections[0];
    if (!rejection) return;

    const errorCode = rejection.errors[0]?.code;
    const file = rejection.file;

    if (errorCode === 'file-too-large') {
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);
      setDropzoneError(
        `File is too large (${sizeMB} MB). Maximum size is ${SLIDES_IMPORT_MAX_LABEL}.`
      );
    } else if (errorCode === 'file-invalid-type') {
      setDropzoneError('Please select a ZIP file (.zip)');
    } else {
      setDropzoneError(rejection.errors[0]?.message || 'File could not be uploaded');
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    onDropRejected,
    accept: {
      'application/zip': ['.zip'],
    },
    maxFiles: 1,
    maxSize: SLIDES_IMPORT_MAX_BYTES,
  });

  // Handle form submission - start async import with SSE progress
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSubmitError(null);
      setIsSubmitting(true);

      try {
        const form = formRef.current;
        if (!form) throw new Error('Form not found');

        const formData = new FormData(form);

        // Add the selected file (dropzone doesn't put it in form automatically)
        if (selectedFile) {
          formData.set('zip', selectedFile);
        }

        // POST to the async start endpoint
        const response = await fetch('/api/slides/import/start', {
          method: 'POST',
          body: formData,
        });

        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || 'Failed to start import');
        }

        // Set importId to trigger SSE subscription
        setImportId(result.importId);
      } catch (err: unknown) {
        console.error('Failed to start import:', err);
        const errorMessage = err instanceof Error ? err.message : 'Failed to start import';
        setSubmitError(errorMessage);
      } finally {
        setIsSubmitting(false);
      }
    },
    [selectedFile]
  );

  // Handle import cancellation (close modal and reset state)
  const handleImportCancel = useCallback(() => {
    setImportId(null);
    setSubmitError(null);
  }, []);

  // Handle retry (reset state and try again)
  const handleRetry = useCallback(() => {
    setImportId(null);
    setSubmitError(null);
    // Re-submit the form
    if (formRef.current) {
      formRef.current.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }
  }, []);

  if (!canImport) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="text-4xl mb-4">🔒</div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-2">Access Denied</h1>
          <p className="text-gray-500 dark:text-gray-400 mb-4">
            You do not have permission to import slides for {classroom.name || classroomSlug}. Only
            Owners and Teachers can import slides.
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
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
              Import from Slides.com
            </h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Upload a slides.com ZIP export to create new slides
            </p>
          </div>
          <a
            href={slidesListUrl}
            className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Cancel
          </a>
        </div>

        {/* Import Form */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
          <form ref={formRef} onSubmit={handleSubmit} encType="multipart/form-data">
            {/* Hidden fields */}
            <input type="hidden" name="classroomSlug" value={classroomSlug} />

            {/* Error message */}
            {error && (
              <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}

            {/* File Dropzone */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                ZIP File
              </label>
              <div
                {...getRootProps()}
                className={`
                  border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors
                  ${
                    isDragActive
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : selectedFile
                        ? 'border-green-500 bg-green-50 dark:bg-green-900/20'
                        : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
                  }
                `}
              >
                <input {...getInputProps()} name="zip" />
                {selectedFile ? (
                  <div>
                    <div className="text-3xl mb-2">📦</div>
                    <p className="text-sm font-medium text-gray-900 dark:text-white">
                      {selectedFile.name}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                    </p>
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation();
                        setSelectedFile(null);
                      }}
                      className="mt-2 text-xs text-red-500 hover:text-red-700"
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <div>
                    <div className="text-3xl mb-2">📁</div>
                    {isDragActive ? (
                      <p className="text-sm text-blue-600 dark:text-blue-400">
                        Drop the ZIP file here...
                      </p>
                    ) : (
                      <>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                          Drag & drop your slides.com export here, or click to browse
                        </p>
                        <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
                          ZIP files only, max {SLIDES_IMPORT_MAX_LABEL}
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Where the ZIP's videos will go — the router's answer, not a choice */}
              <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {videosToMedia
                  ? "Videos in the ZIP are stored in this class's media storage."
                  : `Videos are stored in the course repository. A file over ${repoMaxLabel} is left out of the import, and you'll be told which.`}
              </p>
            </div>

            {/* Title */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Title
              </label>
              <input
                type="text"
                name="title"
                required
                placeholder="e.g., Introduction to React"
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            {/* Repository (optional) */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Link to Repository <span className="text-gray-400 text-xs">(optional)</span>
              </label>
              <input type="hidden" name="repositoryId" value={selectedRepository?.id || ''} />
              <select
                value={selectedRepository?.id || ''}
                onChange={e => {
                  const repo = repositories.find(
                    m => m.id === (e.target as unknown as HTMLInputElement).value
                  );
                  setSelectedRepository(repo || null);
                }}
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="">No repository (standalone)</option>
                {repositories.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                You can link this slide to a repository later
              </p>
            </div>

            {/* Theme Option */}
            <div className="mb-6">
              <fieldset>
                <legend className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Theme
                </legend>
                <div className="space-y-3">
                  {/* Default theme */}
                  <label className="flex items-center">
                    <input
                      type="radio"
                      name="themeOption"
                      value="default"
                      checked={themeOption === 'default'}
                      onChange={e => setThemeOption((e.target as HTMLInputElement).value)}
                      className="mr-2"
                    />
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      Use default theme (reveal.js)
                    </span>
                  </label>

                  {/* Import from ZIP */}
                  <div>
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name="themeOption"
                        value="import"
                        checked={themeOption === 'import'}
                        onChange={e => setThemeOption((e.target as HTMLInputElement).value)}
                        className="mr-2"
                      />
                      <span className="text-sm text-gray-600 dark:text-gray-400">
                        Import theme from ZIP
                      </span>
                    </label>
                    {themeOption === 'import' && (
                      <div className="ml-6 mt-2">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={saveThemeName !== ''}
                            onChange={e => setSaveThemeName(e.target.checked ? 'My Theme' : '')}
                            className="rounded-sm"
                          />
                          <span className="text-sm text-gray-500 dark:text-gray-400">
                            Save as shared theme:
                          </span>
                        </label>
                        {saveThemeName !== '' && (
                          <input
                            type="text"
                            name="saveThemeAs"
                            value={saveThemeName}
                            onChange={e => setSaveThemeName((e.target as HTMLInputElement).value)}
                            placeholder="Theme name..."
                            className="mt-2 w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md dark:bg-gray-700 dark:text-white"
                          />
                        )}
                        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                          {saveThemeName
                            ? 'Theme will be reusable for future imports'
                            : 'Theme will be embedded in this slide only'}
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Use saved theme */}
                  {savedThemes.length > 0 && (
                    <div>
                      <label className="flex items-center">
                        <input
                          type="radio"
                          name="themeOption"
                          value="saved"
                          checked={themeOption === 'saved'}
                          onChange={e => setThemeOption((e.target as HTMLInputElement).value)}
                          className="mr-2"
                        />
                        <span className="text-sm text-gray-600 dark:text-gray-400">
                          Use saved theme
                        </span>
                      </label>
                      {themeOption === 'saved' && (
                        <div className="ml-6 mt-2">
                          <select
                            name="useSavedTheme"
                            required={themeOption === 'saved'}
                            className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md dark:bg-gray-700 dark:text-white"
                          >
                            <option value="">Select a theme...</option>
                            {savedThemes.map(theme => (
                              <option key={theme.name} value={theme.name}>
                                {theme.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </fieldset>
            </div>

            {/* Submit Button */}
            <div className="flex justify-end gap-3">
              <a
                href={slidesListUrl}
                className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md"
              >
                Cancel
              </a>
              <button
                type="submit"
                disabled={isProcessing || !selectedFile}
                className="px-6 py-2 bg-black text-white rounded-md hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {isProcessing ? (
                  <>
                    <span className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
                    Importing...
                  </>
                ) : (
                  'Import Slides'
                )}
              </button>
            </div>
          </form>
        </div>

        {/* Help text */}
        <div className="mt-6 text-center">
          <p className="text-xs text-gray-400 dark:text-gray-500">
            To export from slides.com: Open your deck → Settings → Export → Download ZIP
          </p>
        </div>
      </div>

      {/* Import Progress Modal */}
      <ImportProgressModal
        open={!!importId}
        progress={progress}
        error={streamError}
        isDone={isDone}
        isConnected={isConnected}
        warnings={importWarnings}
        onOpen={openImportedSlides}
        onCancel={handleImportCancel}
        onRetry={handleRetry}
      />
    </div>
  );
}
