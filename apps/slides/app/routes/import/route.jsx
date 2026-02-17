/**
 * Import from Slides.com Route
 *
 * Allows users to import slides.com ZIP exports into the Classmoji slides platform.
 * The route validates permissions, shows an upload form, and processes the ZIP server-side.
 * Requires OWNER or TEACHER role.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useLoaderData, useNavigate } from 'react-router';
import { useDropzone } from 'react-dropzone';
import prisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import { generateTermString, getContentRepoName } from '@classmoji/utils';
import { requireClassroomStaff } from '@classmoji/auth/server';
import { useUser } from '~/root';
import { listSavedThemes } from '~/utils/themeService.server';
import { analyzeZipForVideos } from '~/utils/zipAnalyzer';
import VideoSelectionModal from '~/components/VideoSelectionModal';
import ImportProgressModal from '~/components/ImportProgressModal';
import { useImportStream } from '~/hooks/useImportStream';

// Note: prisma, ClassmojiService, generateTermString, getContentRepoName are used in the loader

// Max file size for ZIP uploads (in bytes)
const MAX_FILE_SIZE = 150 * 1024 * 1024; // 150MB
const MAX_FILE_SIZE_MB = MAX_FILE_SIZE / 1024 / 1024;

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const classroomSlug = url.searchParams.get('class');

  if (!classroomSlug) {
    throw new Response('Missing class parameter. Please use the import button from the webapp.', { status: 400 });
  }

  // Authorization: require OWNER or TEACHER role to import slides
  await requireClassroomStaff(request, classroomSlug, {
    resourceType: 'SLIDE_CONTENT',
    attemptedAction: 'import_slides',
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

  // Derive term string from classroom data
  const term = generateTermString(classroom.term, classroom.year);

  // Get modules for dropdown
  const modules = await ClassmojiService.module.findByClassroomSlug(classroomSlug);

  // Get content repo name using utility (same as slidesComImporter)
  const repoName = getContentRepoName({
    login: gitOrgLogin,
    term: classroom.term,
    year: classroom.year,
  });
  const savedThemes = await listSavedThemes(gitOrgLogin, repoName);

  return {
    classroomSlug,
    term,
    gitOrgLogin,
    classroom,
    modules: modules.map(m => ({ id: m.id, title: m.title })),
    savedThemes,
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    webappUrl: process.env.WEBAPP_URL || 'http://localhost:3000',
  };
};

// Action removed - we now use the async /api/slides/import/start endpoint
// and stream progress via SSE

export default function ImportPage() {
  const { classroomSlug, classroom, modules, savedThemes, webappUrl } = useLoaderData();
  const userContext = useUser();
  const user = userContext?.user;
  const navigate = useNavigate();
  const [selectedFile, setSelectedFile] = useState(null);
  const [selectedModule, setSelectedModule] = useState(null);
  const [themeOption, setThemeOption] = useState('default');
  const [saveThemeName, setSaveThemeName] = useState('');
  const [dropzoneError, setDropzoneError] = useState(null);
  const [submitError, setSubmitError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Video selection state
  const [detectedVideos, setDetectedVideos] = useState([]);
  const [showVideoModal, setShowVideoModal] = useState(false);
  const [cloudinaryVideoPaths, setCloudinaryVideoPaths] = useState([]);
  const [analyzingVideos, setAnalyzingVideos] = useState(false);

  // Import progress state (SSE-based)
  const [importId, setImportId] = useState(null);
  const { progress, error: streamError, isDone, isConnected, slideId } = useImportStream(importId);

  // Form ref for reading form data
  const formRef = useRef(null);

  const isProcessing = isSubmitting || !!importId;
  const error = submitError || streamError || dropzoneError;

  // Navigate to slide when import completes
  useEffect(() => {
    if (isDone && slideId) {
      navigate(`/${slideId}?mode=edit`);
    }
  }, [isDone, slideId, navigate]);

  // Check if user has permission using classroom memberships
  const membership = user?.classroom_memberships?.find(m => m.classroom?.slug === classroomSlug);
  const canImport = membership?.role === 'OWNER' || membership?.role === 'TEACHER';

  // File dropzone
  const onDrop = useCallback(async (acceptedFiles) => {
    if (acceptedFiles.length > 0) {
      const file = acceptedFiles[0];
      setSelectedFile(file);
      setDropzoneError(null); // Clear any previous error

      // Analyze ZIP for videos (client-side, reads only metadata)
      setAnalyzingVideos(true);
      try {
        const videos = await analyzeZipForVideos(file);

        if (videos.length > 0) {
          setDetectedVideos(videos);
          // Pre-select videos recommended for Cloudinary
          const suggested = videos
            .filter(v => v.suggestCloudinary)
            .map(v => v.path);
          setCloudinaryVideoPaths(suggested);
          setShowVideoModal(true);
        } else {
          // No videos found, clear any previous state
          setDetectedVideos([]);
          setCloudinaryVideoPaths([]);
        }
      } catch (err) {
        console.error('Failed to analyze ZIP for videos:', err);
        // Don't block import if analysis fails
      } finally {
        setAnalyzingVideos(false);
      }
    }
  }, []);

  const onDropRejected = useCallback((fileRejections) => {
    const rejection = fileRejections[0];
    if (!rejection) return;

    const errorCode = rejection.errors[0]?.code;
    const file = rejection.file;

    if (errorCode === 'file-too-large') {
      const sizeMB = (file.size / 1024 / 1024).toFixed(1);
      setDropzoneError(`File is too large (${sizeMB} MB). Maximum size is ${MAX_FILE_SIZE_MB} MB.`);
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
    maxSize: MAX_FILE_SIZE,
  });

  // Handle video modal confirmation
  const handleVideoModalConfirm = useCallback((selectedPaths) => {
    setCloudinaryVideoPaths(selectedPaths);
    setShowVideoModal(false);
  }, []);

  // Handle video modal cancel (clear file selection)
  const handleVideoModalCancel = useCallback(() => {
    setShowVideoModal(false);
    setSelectedFile(null);
    setDetectedVideos([]);
    setCloudinaryVideoPaths([]);
  }, []);

  // Handle form submission - start async import with SSE progress
  const handleSubmit = useCallback(async (e) => {
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

      // Add cloudinary video paths
      formData.set('cloudinaryVideoPaths', JSON.stringify(cloudinaryVideoPaths));

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
    } catch (err) {
      console.error('Failed to start import:', err);
      setSubmitError(err.message || 'Failed to start import');
    } finally {
      setIsSubmitting(false);
    }
  }, [selectedFile, cloudinaryVideoPaths]);

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
          <h1 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
            Access Denied
          </h1>
          <p className="text-gray-500 dark:text-gray-400 mb-4">
            You do not have permission to import slides for {classroom.name || classroomSlug}.
            Only Owners and Teachers can import slides.
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
            href={`${webappUrl}/admin/${classroomSlug}/slides`}
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
            <input
              type="hidden"
              name="cloudinaryVideoPaths"
              value={JSON.stringify(cloudinaryVideoPaths)}
            />

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
                  ${isDragActive
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
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedFile(null);
                        setDetectedVideos([]);
                        setCloudinaryVideoPaths([]);
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
                          ZIP files only, max {MAX_FILE_SIZE_MB}MB
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Video detection indicator */}
              {selectedFile && !showVideoModal && detectedVideos.length > 0 && (
                <div className="mt-3 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md">
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-blue-700 dark:text-blue-300">
                      <span className="font-medium">{detectedVideos.length} video{detectedVideos.length !== 1 ? 's' : ''}</span> detected
                      {cloudinaryVideoPaths.length > 0 && (
                        <span className="ml-1">
                          ({cloudinaryVideoPaths.length} → Cloudinary,{' '}
                          {detectedVideos.length - cloudinaryVideoPaths.length} → GitHub)
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowVideoModal(true)}
                      className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      Change
                    </button>
                  </div>
                </div>
              )}

              {/* Analyzing indicator */}
              {analyzingVideos && (
                <div className="mt-3 text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2">
                  <span className="animate-spin h-4 w-4 border-2 border-gray-400 border-t-transparent rounded-full" />
                  Analyzing ZIP for videos...
                </div>
              )}
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

            {/* Module (optional) */}
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Link to Module <span className="text-gray-400 text-xs">(optional)</span>
              </label>
              <input type="hidden" name="moduleId" value={selectedModule?.id || ''} />
              <select
                value={selectedModule?.id || ''}
                onChange={e => {
                  const mod = modules.find(m => m.id === e.target.value);
                  setSelectedModule(mod || null);
                }}
                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md dark:bg-gray-700 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                <option value="">No module (standalone)</option>
                {modules.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                You can link this slide to a module later
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
                      onChange={(e) => setThemeOption(e.target.value)}
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
                        onChange={(e) => setThemeOption(e.target.value)}
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
                            onChange={(e) => setSaveThemeName(e.target.checked ? 'My Theme' : '')}
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
                            onChange={(e) => setSaveThemeName(e.target.value)}
                            placeholder="Theme name..."
                            className="mt-2 w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md dark:bg-gray-700 dark:text-white"
                          />
                        )}
                        <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                          {saveThemeName ? 'Theme will be reusable for future imports' : 'Theme will be embedded in this slide only'}
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
                          onChange={(e) => setThemeOption(e.target.value)}
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
                href={`${webappUrl}/admin/${classroomSlug}/slides`}
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

      {/* Video Selection Modal */}
      <VideoSelectionModal
        open={showVideoModal}
        onClose={handleVideoModalCancel}
        onConfirm={handleVideoModalConfirm}
        videos={detectedVideos}
      />

      {/* Import Progress Modal */}
      <ImportProgressModal
        open={!!importId}
        progress={progress}
        error={streamError}
        isDone={isDone}
        isConnected={isConnected}
        onCancel={handleImportCancel}
        onRetry={handleRetry}
      />
    </div>
  );
}
