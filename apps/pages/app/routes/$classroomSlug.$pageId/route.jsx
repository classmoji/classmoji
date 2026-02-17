import { useLoaderData, useFetcher, useOutletContext } from 'react-router';
import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { IconPhoto } from '@tabler/icons-react';

import Header from '~/components/layout/Header.jsx';
import HeaderImage from '~/components/editor/HeaderImage.jsx';

const PageEditor = lazy(() => import('~/components/editor/PageEditor.jsx'));
const BlockNoteViewer = lazy(() => import('~/components/viewer/BlockNoteViewer.jsx'));

// Import server-only code from co-located .server.js file
export { loader, action } from './route.server.js';

// Width class mapping
const widthClasses = {
  1: 'max-w-2xl',
  2: 'max-w-4xl',
  3: 'max-w-5xl',
  4: 'max-w-7xl',
};

const PageRoute = () => {
  const { page, classroom, content, coverImage, canEdit } = useLoaderData();
  const outletContext = useOutletContext();
  const isEmbedded = outletContext?.isEmbedded || false;
  const widthClass = widthClasses[page.width] || 'max-w-4xl';
  const editorRef = useRef(null);
  const fetcher = useFetcher();
  const titleFetcher = useFetcher();

  // Save state (explicit saves only)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [saveStatus, setSaveStatus] = useState('saved');
  const lastSavedContent = useRef(null);

  // Client-only flag — prevents BlockNote from rendering during SSR
  const [isClient, setIsClient] = useState(false);

  // Detect dark mode
  const [darkMode, setDarkMode] = useState(false);

  // Title editing state
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(page.title || 'Untitled');

  // Explicit save — called by Cmd/Ctrl+S or Save button
  const handleSave = useCallback(() => {
    if (!canEdit || !editorRef.current) return;

    const currentContent = editorRef.current.getContent();
    const currentContentStr = JSON.stringify(currentContent);

    if (lastSavedContent.current === currentContentStr) return;

    setSaveStatus('saving');
    fetcher.submit(
      { intent: 'save', content: currentContentStr },
      { method: 'POST', encType: 'application/json' }
    );
  }, [canEdit, fetcher]);

  // Track editor changes (mark unsaved, but don't auto-save)
  const handleEditorChange = useCallback((document) => {
    if (!canEdit) return;

    const currentContentStr = JSON.stringify(document);
    if (lastSavedContent.current === currentContentStr) return;

    setHasUnsavedChanges(true);
    setSaveStatus('unsaved');
  }, [canEdit]);

  useEffect(() => {
    setIsClient(true);
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (isDark) setDarkMode(true);
  }, []);

  // Update title when page changes
  useEffect(() => {
    setTitleValue(page.title || 'Untitled');
    setIsEditingTitle(false);
  }, [page.id, page.title]);

  // Initialize lastSavedContent on mount
  useEffect(() => {
    if (canEdit && content && lastSavedContent.current === null) {
      lastSavedContent.current = JSON.stringify(content);
    }
  }, [canEdit, content]);

  // Track save completion
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.success) {
      if (editorRef.current) {
        const currentContent = editorRef.current.getContent();
        lastSavedContent.current = JSON.stringify(currentContent);
      }
      setHasUnsavedChanges(false);
      setSaveStatus('saved');
    } else if (fetcher.state === 'idle' && fetcher.data?.error) {
      setSaveStatus('error');
    }
  }, [fetcher.state, fetcher.data]);

  // Cmd/Ctrl+S to save
  useEffect(() => {
    if (!canEdit) return;

    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canEdit, handleSave]);

  // Warn before closing with unsaved changes
  useEffect(() => {
    if (!canEdit) return;

    const handleBeforeUnload = (e) => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [canEdit, hasUnsavedChanges]);

  // Title editing handlers
  const saveTitle = () => {
    const trimmed = titleValue.trim();
    if (trimmed && trimmed !== page.title) {
      titleFetcher.submit(
        { intent: 'update-title', title: trimmed },
        { method: 'POST', encType: 'application/json' }
      );
    }
    setIsEditingTitle(false);
  };

  const cancelTitleEdit = () => {
    setTitleValue(page.title || 'Untitled');
    setIsEditingTitle(false);
  };

  return (
    <>
      {!isEmbedded && (
        <Header
          classroom={classroom}
          page={page}
          saveStatus={canEdit ? saveStatus : undefined}
          hasUnsavedChanges={canEdit ? hasUnsavedChanges : undefined}
          canEdit={canEdit}
          onSave={canEdit ? handleSave : undefined}
        />
      )}

      {coverImage?.url && (
        <HeaderImage
          imageUrl={coverImage.url}
          position={coverImage.position ?? 50}
          editMode={canEdit}
          pageId={page.id}
        />
      )}

      <div className={`mx-auto px-4 sm:px-6 lg:px-8 pb-16 ${widthClass} ${coverImage?.url ? 'mt-12' : 'mt-16'}`}>
        <div>
          {/* "Add cover" button — always visible in edit mode when no image */}
          {!coverImage?.url && canEdit && (
            <div className="flex items-center gap-2 mb-2">
              {fetcher.state !== 'idle' && fetcher.formData?.get('intent') === 'upload-header-image' ? (
                <div className="flex items-center gap-1.5 px-2 py-1 text-sm text-gray-500 dark:text-gray-400">
                  <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                  Uploading...
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = 'image/*';
                    input.onchange = (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const formData = new FormData();
                      formData.append('intent', 'upload-header-image');
                      formData.append('file', file);
                      fetcher.submit(formData, {
                        method: 'POST',
                        encType: 'multipart/form-data',
                      });
                    };
                    input.click();
                  }}
                  className="
                    flex items-center gap-1.5
                    px-2 py-1 text-sm text-gray-500 dark:text-gray-400
                    hover:bg-gray-100 dark:hover:bg-gray-800
                    rounded transition-colors
                  "
                >
                  <IconPhoto size={16} />
                  Add cover
                </button>
              )}
            </div>
          )}

          {canEdit && isEditingTitle ? (
            <input
              type="text"
              value={titleValue}
              onChange={(e) => setTitleValue(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveTitle();
                if (e.key === 'Escape') cancelTitleEdit();
              }}
              autoFocus
              className="!text-5xl !font-bold text-gray-900 dark:text-white mb-6 w-full bg-transparent border-none outline-none focus:ring-0 p-0 m-0"
              style={{ fontSize: '3rem', fontWeight: 700, lineHeight: 1 }}
              placeholder="Untitled"
            />
          ) : (
            <h1
              className={`text-5xl font-bold text-gray-900 dark:text-white mb-6 ${canEdit ? 'cursor-text hover:bg-gray-50 dark:hover:bg-gray-800 rounded px-2 py-1 -mx-2 -my-1' : ''}`}
              onClick={() => canEdit && setIsEditingTitle(true)}
            >
              {page.title || 'Untitled'}
            </h1>
          )}
        </div>

        {page.is_draft && (
          <span className="inline-block px-2 py-0.5 text-xs font-medium bg-yellow-100 text-yellow-800 rounded-full mb-2">
            Draft
          </span>
        )}

        <div className="mt-2">
          {!isClient ? (
            /* SSR placeholder — BlockNote requires browser APIs */
            <div className="flex items-center justify-center py-12">
              <div className="text-gray-500 dark:text-gray-400">Loading content...</div>
            </div>
          ) : canEdit ? (
            /* Editor for instructors */
            <Suspense fallback={
              <div className="flex items-center justify-center py-12">
                <div className="text-gray-500 dark:text-gray-400">Loading editor...</div>
              </div>
            }>
              <PageEditor
                key={page.id}
                ref={editorRef}
                initialContent={content}
                pageId={page.id}
                darkMode={darkMode}
                onChange={handleEditorChange}
              />
            </Suspense>
          ) : (
            /* Viewer for students/public */
            <Suspense fallback={
              <div className="flex items-center justify-center py-12">
                <div className="text-gray-500 dark:text-gray-400">Loading content...</div>
              </div>
            }>
              <BlockNoteViewer key={page.id} content={content} darkMode={darkMode} />
            </Suspense>
          )}
        </div>
      </div>
    </>
  );
};

export default PageRoute;
