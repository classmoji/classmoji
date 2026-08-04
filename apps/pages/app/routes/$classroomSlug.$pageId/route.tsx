import { useLoaderData, useFetcher, useOutletContext } from 'react-router';
import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { IconPhoto } from '@tabler/icons-react';
import { toast } from 'react-toastify';

import Header from '~/components/layout/Header.tsx';
import HeaderImage from '~/components/editor/HeaderImage.tsx';
import {
  PreviewBar,
  PendingPreviewBanner,
  NoPreviewNotice,
} from '~/components/preview/PreviewControls.tsx';

const PageEditor = lazy(() => import('~/components/editor/PageEditor.tsx'));
const BlockNoteViewer = lazy(() => import('~/components/viewer/BlockNoteViewer.tsx'));

// Import server-only code from co-located .server.ts file
export { loader, action } from './route.server.ts';

// Width class mapping
const widthClasses: Record<number, string> = {
  1: 'max-w-2xl',
  2: 'max-w-4xl',
  3: 'max-w-5xl',
  4: 'max-w-7xl',
};

const PageRoute = () => {
  const {
    page,
    classroom,
    content,
    coverImage,
    canEdit: canEditRole,
    preview,
    notice,
    noticeAutoMerged,
    contentSha,
  } = useLoaderData<typeof import('./route.server.ts').loader>();
  const outletContext = useOutletContext<{ isEmbedded?: boolean }>();
  const isEmbedded = outletContext?.isEmbedded || false;
  // Preview mode is strictly read-only — editing chrome is suppressed while
  // rendering the pending preview branch (plan §3b).
  const isPreview = Boolean(preview?.active);
  const canEdit = canEditRole && !isPreview;
  const widthClass = widthClasses[page.width] || 'max-w-4xl';
  const editorRef = useRef<{ getContent: () => unknown } | null>(null);
  const fetcher = useFetcher();
  const titleFetcher = useFetcher();
  const coverFetcher = useFetcher();

  // Save state (explicit saves only)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [saveStatus, setSaveStatus] = useState('saved');
  const lastSavedContent = useRef<string | null>(null);

  // Conflict token (F2, 4b parity with slides): content.json's sha, seeded
  // ONCE from the loader (deliberately not re-synced on revalidation — the
  // editor's content is still what the initial load produced, so refreshing
  // the token mid-edit would let a stale save pass the server's sha check).
  // Refreshed only from a successful save's response; echoed on every save.
  const [contentToken, setContentToken] = useState<string | null>(contentSha);
  // True once a save 409'd: the page changed underneath this editor session.
  const saveConflict = Boolean(fetcher.data?.conflict);
  // Set when the user chooses Reload from the conflict banner — the banner
  // already warned that unsaved changes are discarded, so skip the browser's
  // beforeunload double-prompt.
  const skipUnloadWarningRef = useRef(false);

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
      // content_sha: the conflict token the action CAS-checks the write
      // against (null = content.json doesn't exist yet → creation).
      { intent: 'save', content: currentContentStr, content_sha: contentToken },
      { method: 'POST', encType: 'application/json' }
    );
  }, [canEdit, fetcher, contentToken]);

  // Track editor changes (mark unsaved, but don't auto-save)
  const handleEditorChange = useCallback(
    (document: unknown) => {
      if (!canEdit) return;

      const currentContentStr = JSON.stringify(document);
      if (lastSavedContent.current === currentContentStr) return;

      setHasUnsavedChanges(true);
      setSaveStatus('unsaved');
    },
    [canEdit]
  );

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

  // Post-accept/discard success notice (round-tripped via redirect param)
  useEffect(() => {
    if (!notice) return;
    if (notice === 'preview-accepted') {
      toast.success(
        noticeAutoMerged
          ? `Preview accepted — ${noticeAutoMerged} change${noticeAutoMerged === 1 ? '' : 's'} merged automatically; changes are now live.`
          : 'Preview accepted — changes are now live.'
      );
    } else if (notice === 'preview-discarded') {
      toast.success('Preview discarded.');
    }
    // Strip the params so a refresh doesn't re-toast
    const url = new URL(window.location.href);
    url.searchParams.delete('notice');
    url.searchParams.delete('auto_merged');
    window.history.replaceState({}, '', url);
  }, [notice, noticeAutoMerged]);

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
      // Refresh the conflict token — content.json's new sha after our save.
      if (typeof fetcher.data.sha === 'string' && fetcher.data.sha) {
        setContentToken(fetcher.data.sha);
      }
      setHasUnsavedChanges(false);
      setSaveStatus('saved');
    } else if (fetcher.state === 'idle' && (fetcher.data?.error || fetcher.data?.conflict)) {
      // Conflict (409) keeps hasUnsavedChanges true — the banner offers
      // Reload; the editor content is preserved until the user decides.
      setSaveStatus('error');
    }
  }, [fetcher.state, fetcher.data]);

  // Surface cover-image failures (incl. the F5 409 "page changed — try
  // again") — the cover flow has no inline status indicator of its own.
  // On success, refresh the conflict token: a cover write advances
  // content.json's sha, so a save still carrying the pre-cover token would
  // self-conflict against our own change.
  useEffect(() => {
    if (coverFetcher.state !== 'idle') return;
    if (coverFetcher.data?.error) {
      toast.error(coverFetcher.data.error);
    } else if (coverFetcher.data?.sha) {
      setContentToken(coverFetcher.data.sha);
    }
  }, [coverFetcher.state, coverFetcher.data]);

  // Cmd/Ctrl+S to save
  useEffect(() => {
    if (!canEdit) return;

    const handleKeyDown = (e: KeyboardEvent) => {
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

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges && !skipUnloadWarningRef.current) {
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

  // Reload from the save-conflict banner: discard this session's unsaved
  // changes and pick up the latest content + a fresh conflict token.
  const handleConflictReload = useCallback(() => {
    skipUnloadWarningRef.current = true;
    window.location.reload();
  }, []);

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

      {/* Preview-branch chrome (staff only — `preview` is null otherwise) */}
      {preview?.active && <PreviewBar preview={preview} isEmbedded={isEmbedded} />}
      {preview?.missing && <NoPreviewNotice />}
      {preview && !preview.active && preview.exists && <PendingPreviewBanner preview={preview} />}

      {/* Save-conflict notice (F2): the last save 409'd — content.json changed
          under this editor session (another editor, an MCP apply). Amber, same
          visual language as the preview chrome. */}
      {canEdit && saveConflict && (
        <div
          data-testid="save-conflict-banner"
          className={`sticky ${isEmbedded ? 'top-0' : 'top-12'} z-30`}
        >
          <div className="border-y border-amber-300 dark:border-amber-700/70 bg-amber-50/95 dark:bg-amber-950/90 backdrop-blur px-4 sm:px-6 lg:px-8 py-2">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div className="text-sm text-amber-900 dark:text-amber-100">
                <span className="font-semibold">
                  This page changed since you opened it — reload to get the latest before saving.
                </span>{' '}
                <span className="text-amber-700 dark:text-amber-300">
                  Your unsaved changes here will be discarded.
                </span>
              </div>
              <button
                type="button"
                onClick={handleConflictReload}
                className="rounded px-3 py-1 text-sm font-medium transition-colors bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400"
              >
                Reload
              </button>
            </div>
          </div>
        </div>
      )}

      {coverImage?.url && (
        <HeaderImage
          imageUrl={coverImage.url}
          position={coverImage.position ?? 50}
          editMode={canEdit}
          pageId={page.id}
        />
      )}

      <div
        className={`mx-auto px-4 sm:px-6 lg:px-8 pb-16 ${widthClass} ${coverImage?.url ? 'mt-12' : 'mt-16'}`}
      >
        <div>
          {/* "Add cover" button — always visible in edit mode when no image */}
          {!coverImage?.url && canEdit && (
            <div className="flex items-center gap-2 mb-2">
              {coverFetcher.state !== 'idle' &&
              coverFetcher.formData?.get('intent') === 'upload-header-image' ? (
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
                    input.onchange = (e: Event) => {
                      const file = (e.target as HTMLInputElement).files?.[0];
                      if (!file) return;
                      const formData = new FormData();
                      formData.append('intent', 'upload-header-image');
                      formData.append('file', file);
                      coverFetcher.submit(formData, {
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
              onChange={e => setTitleValue(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={e => {
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
            <Suspense
              fallback={
                <div className="flex items-center justify-center py-12">
                  <div className="text-gray-500 dark:text-gray-400">Loading editor...</div>
                </div>
              }
            >
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
            <Suspense
              fallback={
                <div className="flex items-center justify-center py-12">
                  <div className="text-gray-500 dark:text-gray-400">Loading content...</div>
                </div>
              }
            >
              <BlockNoteViewer key={page.id} content={content} darkMode={darkMode} />
            </Suspense>
          )}
        </div>
      </div>
    </>
  );
};

export default PageRoute;
