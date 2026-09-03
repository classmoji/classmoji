import { useLoaderData, useFetcher, useOutletContext } from 'react-router';
import { useAssetMap, useAssetRetry } from '~/hooks/useAssetMap.ts';
import { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react';
import { IconPhoto } from '@tabler/icons-react';
import { toast } from 'react-toastify';

import Header from '~/components/layout/Header.tsx';
import HeaderImage from '~/components/editor/HeaderImage.tsx';
import {
  PreviewBar,
  PendingPreviewBanner,
  NoPreviewNotice,
  ConflictPanel,
} from '~/components/preview/PreviewControls.tsx';
import { diffBlockOps, type BlockOp } from '~/components/editor/blockOpsDiff.ts';
import {
  opsPathEligible,
  deriveSaveMergeReport,
  deriveSaveConflict,
  fetcherMatchesPage,
  type SaveBaseline,
  type SaveFetcherData,
} from './saveState.ts';

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
    resolvedAssets,
  } = useLoaderData<typeof import('./route.server.ts').loader>();
  // Stored refs stay in the document; these are the URLs to display them with.
  const assets = useAssetMap(resolvedAssets, page.id);
  // An expired draft signature on a stale tab re-resolves once instead of
  // leaving a page of broken images.
  const assetEpoch = useAssetRetry();
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
  // The diff-at-save baseline, bound to the sha it represents (P1): the
  // NORMALIZED editor document at that sha. Captured from the editor after
  // mount (P2 — same BlockNote normalization on both sides, so untouched
  // stored blocks never emit phantom updates) and re-captured after a
  // merged-adoption remount. `null` until the editor's onReady fires.
  const savedBaselineRef = useRef<SaveBaseline | null>(null);
  // The sha the NEXT editor onReady should pair its snapshot with (the loaded
  // sha, or a merged save's new sha set just before the epoch remount).
  const pendingBaselineShaRef = useRef<string | null>(contentSha);

  // Conflict token (F2, 4b parity with slides): content.json's sha, seeded
  // ONCE from the loader (deliberately not re-synced on revalidation — the
  // editor's content is still what the initial load produced, so refreshing
  // the token mid-edit would let a stale save pass the server's sha check).
  // Refreshed only from a successful save's response; echoed on every save.
  const [contentToken, setContentToken] = useState<string | null>(contentSha);
  // The page id the CURRENT save fetcher exchange was stamped for (P4). The
  // fetcher survives same-route param navigation, so its data is read only
  // while this still matches page.id — otherwise a pending conflict chooser
  // ghosts onto the next page and Apply fires a wrong-page save chain. Set at
  // every save submission; deliberately NOT cleared on navigation (a stale
  // stamp keeps the gate closed on the new page until it saves).
  const saveReportPageIdRef = useRef(page.id);
  const fetcherData = fetcher.data as SaveFetcherData | undefined;
  const fetcherMatches = fetcherMatchesPage(saveReportPageIdRef.current, page.id);
  // Phase 7.5: a stale save's 3-way merge hit true collisions — the per-unit
  // report the save-variant conflict chooser renders (gated to this page, P4).
  const saveMergeReport = useMemo(
    () => deriveSaveMergeReport(fetcherData, fetcherMatches),
    [fetcherData, fetcherMatches]
  );
  // True once a save 409'd with NO mergeable report (legacy/fallback path):
  // the page changed underneath this editor session — reload banner (P4-gated).
  const saveConflict = deriveSaveConflict(fetcherData, fetcherMatches, saveMergeReport);
  // The exact content string the last save posted — a chooser re-submit (or
  // auto re-run) carries the SAME document.
  const lastPostedContentRef = useRef<string | null>(null);
  // The serialized ops of the last save when it went down the diff-at-save
  // path (null = it was a whole-document save). A chooser re-submit carries
  // the SAME ops; the whole-doc fallback clears it.
  const lastPostedOpsRef = useRef<string | null>(null);
  // Set when the user chooses Reload from the conflict banner — the banner
  // already warned that unsaved changes are discarded, so skip the browser's
  // beforeunload double-prompt.
  const skipUnloadWarningRef = useRef(false);

  // The document the editor mounts from. Normally the loader's content; after
  // a merged save (7.5) it becomes the server's MERGED document and the epoch
  // bump remounts the editor — its local copy lacked the folded-in concurrent
  // changes, and a fresh token over a stale document would clobber them on
  // the next save.
  const [editorDoc, setEditorDoc] = useState(content);
  const [editorEpoch, setEditorEpoch] = useState(0);
  // Navigating to a different page keeps this component mounted (same route,
  // new params) — re-seed the per-page editing state (React's sanctioned
  // render-time reset for prop-derived state), including the pending
  // save/conflict UI (P4) so nothing ghosts across pages.
  const lastPageIdRef = useRef(page.id);
  if (lastPageIdRef.current !== page.id) {
    lastPageIdRef.current = page.id;
    setEditorDoc(content);
    setEditorEpoch(0);
    setContentToken(contentSha);
    savedBaselineRef.current = null;
    pendingBaselineShaRef.current = contentSha;
    lastPostedContentRef.current = null;
    lastPostedOpsRef.current = null;
    setHasUnsavedChanges(false);
    setSaveStatus('saved');
  }

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

    const baseline = savedBaselineRef.current;
    if (baseline && baseline.content === currentContentStr) return;

    // Preserved for the save-merge chooser and the whole-doc fallback: a
    // conflict re-submit must carry the SAME document that produced the report.
    lastPostedContentRef.current = currentContentStr;
    // Stamp this exchange with the current page (P4).
    saveReportPageIdRef.current = page.id;

    // Diff-at-save: post only the CHANGED blocks as ops — but ONLY when the
    // baseline we diff against is the document the conflict token names (P1
    // pairing guard). The server replays the ops onto base_sha, so a desynced
    // baseline (e.g. a cover write advanced the token past this document)
    // would replay onto the wrong base and silently clobber concurrent edits —
    // fall back to the whole-document save (always correct) instead. Any
    // anomaly in the diff itself (duplicate ids, cross-scope move, complex
    // reorder) also yields null → the whole-document save (the 7.5 path).
    let ops: BlockOp[] | null = null;
    if (opsPathEligible(baseline, contentToken)) {
      try {
        ops = diffBlockOps(JSON.parse(baseline.content), currentContent);
      } catch {
        ops = null;
      }
    }

    if (ops && ops.length === 0) {
      // Canonically identical (only serialization order differs) — nothing to
      // commit; re-pin the baseline to the exact current string.
      savedBaselineRef.current = { sha: contentToken, content: currentContentStr };
      setHasUnsavedChanges(false);
      setSaveStatus('saved');
      return;
    }

    setSaveStatus('saving');
    if (ops) {
      const opsStr = JSON.stringify(ops);
      lastPostedOpsRef.current = opsStr;
      fetcher.submit(
        // base_sha: the token names the exact document the ops were diffed
        // against; content_sha rides along as the CAS token (same value).
        { intent: 'save', ops: opsStr, base_sha: contentToken, content_sha: contentToken },
        { method: 'POST', encType: 'application/json' }
      );
      return;
    }

    lastPostedOpsRef.current = null;
    fetcher.submit(
      // content_sha: the conflict token the action CAS-checks the write
      // against (null = content.json doesn't exist yet → creation).
      { intent: 'save', content: currentContentStr, content_sha: contentToken },
      { method: 'POST', encType: 'application/json' }
    );
  }, [canEdit, fetcher, contentToken, page.id]);

  // Apply the save-merge chooser's decisions (Phase 7.5): re-submit the SAME
  // posted content with one {id, choose} per conflict and the report's
  // ours_sha pin. The editor is still mounted, so prefer its live document
  // (the server re-validates the conflict set either way).
  const handleApplySaveResolutions = useCallback(
    (resolutions: Array<{ id: string; choose: 'ours' | 'theirs' }>) => {
      if (!saveMergeReport) return;
      // Stamp the resolution exchange with the current page (P4).
      saveReportPageIdRef.current = page.id;

      // Ops-save conflict: the re-submit carries the SAME ops (the server
      // re-materializes theirs = base + ops and re-validates the set).
      if (lastPostedOpsRef.current) {
        setSaveStatus('saving');
        fetcher.submit(
          {
            intent: 'save',
            ops: lastPostedOpsRef.current,
            base_sha: contentToken,
            content_sha: contentToken,
            resolutions: JSON.stringify(resolutions),
            ...(saveMergeReport.oursSha ? { ours_sha: saveMergeReport.oursSha } : {}),
          },
          { method: 'POST', encType: 'application/json' }
        );
        return;
      }

      const current = editorRef.current?.getContent();
      const content = current ? JSON.stringify(current) : lastPostedContentRef.current;
      if (!content) return;
      lastPostedContentRef.current = content;
      setSaveStatus('saving');
      fetcher.submit(
        {
          intent: 'save',
          content,
          content_sha: contentToken,
          resolutions: JSON.stringify(resolutions),
          ...(saveMergeReport.oursSha ? { ours_sha: saveMergeReport.oursSha } : {}),
        },
        { method: 'POST', encType: 'application/json' }
      );
    },
    [fetcher, contentToken, saveMergeReport, page.id]
  );

  // A `code`-bearing refusal: a chooser re-submit hit a stale ours_sha pin or
  // a changed conflict set, or an ops save's base didn't match
  // (OPS_BASE_MISMATCH). Either way the recovery is the same: ONE plain
  // whole-document re-run with the SAME posted content — it either lands
  // (possibly merged) or produces a FRESH report. Bounded: a plain whole-doc
  // save never answers with `code`, so this runs at most once per attempt.
  useEffect(() => {
    // Only recover the fetcher exchange that belongs to THIS page (P4) — a
    // stale code-bearing refusal from another page must not fire a save here.
    if (saveReportPageIdRef.current !== page.id) return;
    if (fetcher.state !== 'idle') return;
    if (!fetcher.data?.code || fetcher.data?.conflict) return;
    const content = lastPostedContentRef.current;
    if (!content) return;
    lastPostedOpsRef.current = null;
    saveReportPageIdRef.current = page.id;
    setSaveStatus('saving');
    fetcher.submit(
      { intent: 'save', content, content_sha: contentToken },
      { method: 'POST', encType: 'application/json' }
    );
  }, [fetcher.state, fetcher.data, fetcher, contentToken, page.id]);

  // Track editor changes (mark unsaved, but don't auto-save)
  const handleEditorChange = useCallback(
    (document: unknown) => {
      if (!canEdit) return;

      const currentContentStr = JSON.stringify(document);
      // Compared against the normalized baseline (P2) — an unchanged document
      // stringifies identically on both sides, so it never marks unsaved.
      if (savedBaselineRef.current?.content === currentContentStr) return;

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

  // Post-accept/discard success notice (round-tripped via redirect param).
  // Keyed on notice+sha so each accept is handled exactly once — the stripped
  // URL param leaves `notice` in the loader data until the next revalidation,
  // and a second accept can arrive with the same notice string but a new sha.
  const handledNoticeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!notice) {
      handledNoticeRef.current = null;
      return;
    }
    const noticeKey = `${notice}:${contentSha ?? ''}`;
    if (handledNoticeRef.current === noticeKey) return;
    handledNoticeRef.current = noticeKey;
    if (notice === 'preview-accepted') {
      // The post-accept redirect revalidated the loader, so `content` and
      // `contentSha` are the freshly merged main document — but the mounted
      // editor still shows its pre-merge copy. Adopt through the epoch-remount
      // protocol (baseline recaptured by onReady, same as a merged save).
      // Skipped when this session has unsaved edits: remounting would discard
      // them, and the next save's 3-way merge reconciles them against the new
      // main instead.
      if (!hasUnsavedChanges) {
        pendingBaselineShaRef.current = contentSha;
        savedBaselineRef.current = null;
        setEditorDoc(content);
        setEditorEpoch(epoch => epoch + 1);
        setContentToken(contentSha);
        setSaveStatus('saved');
      }
      toast.success(
        noticeAutoMerged
          ? `Preview merged —${noticeAutoMerged} change${noticeAutoMerged === 1 ? '' : 's'} merged automatically; changes are now live.`
          : 'Preview merged —changes are now live.'
      );
    } else if (notice === 'preview-discarded') {
      toast.success('Preview discarded.');
    }
    // Strip the params so a refresh doesn't re-toast
    const url = new URL(window.location.href);
    url.searchParams.delete('notice');
    url.searchParams.delete('auto_merged');
    window.history.replaceState({}, '', url);
  }, [notice, noticeAutoMerged, content, contentSha, hasUnsavedChanges]);

  // Baseline capture is the editor's onReady (P2), not the raw loader JSON —
  // see handleEditorReady below.

  // Track save completion
  useEffect(() => {
    // Only settle the fetcher exchange that belongs to THIS page (P4).
    if (saveReportPageIdRef.current !== page.id) return;
    if (fetcher.state === 'idle' && fetcher.data?.success) {
      const newSha =
        typeof fetcher.data.sha === 'string' && fetcher.data.sha ? fetcher.data.sha : null;
      if (Array.isArray(fetcher.data.merged_content)) {
        // Semantic save-merge (7.5): the committed document is the MERGE of
        // this editor's content and concurrent server-side changes — adopt it
        // (remount) so the editor matches the fresh token, and tell the user.
        // The NORMALIZED baseline for the adopted doc is captured by the
        // editor's onReady after the epoch remount, paired with the new sha.
        pendingBaselineShaRef.current = newSha;
        // Blocks folded in from main are new to this client — seed their
        // display URLs before the remount, or those images paint broken.
        const merged = fetcher.data.resolved_assets;
        if (merged && typeof merged === 'object') {
          for (const [ref, url] of Object.entries(merged as Record<string, string>)) {
            assets.remember(ref, url);
          }
        }
        setEditorDoc(fetcher.data.merged_content);
        setEditorEpoch(epoch => epoch + 1);
        const n = fetcher.data.merged_with_concurrent;
        if (typeof n === 'number' && n > 0) {
          toast.success(`Saved — merged with ${n} concurrent change${n === 1 ? '' : 's'}.`);
        }
      } else {
        // No adoption/remount: pin the baseline directly to the committed sha.
        // The content is the exact string posted (the normalized editor doc at
        // save time) — not a re-read of the live editor, which may already
        // contain post-save typing.
        const committed =
          lastPostedContentRef.current ??
          (editorRef.current ? JSON.stringify(editorRef.current.getContent()) : null);
        if (committed !== null) {
          savedBaselineRef.current = { sha: newSha, content: committed };
        }
      }
      // Refresh the conflict token — content.json's new sha after our save.
      if (newSha) {
        setContentToken(newSha);
      }
      setHasUnsavedChanges(false);
      setSaveStatus('saved');
    } else if (fetcher.state === 'idle' && (fetcher.data?.error || fetcher.data?.conflict)) {
      // P9: a code-bearing refusal that is NOT a conflict (OPS_BASE_MISMATCH /
      // OPS_MALFORMED) is being auto-recovered by the whole-document fallback
      // effect above — keep showing 'saving' for the recovery round-trip, not
      // 'error' (the two effects fire in the same commit).
      if (fetcher.data?.code && !fetcher.data?.conflict) return;
      // Conflict (409) keeps hasUnsavedChanges true — the chooser/banner
      // offers a way out; the editor content is preserved until the user
      // decides.
      setSaveStatus('error');
    }
  }, [fetcher.state, fetcher.data, page.id, assets]);

  // Surface cover-image failures (incl. the F5 409 "page changed — try again") —
  // the cover flow has no inline status indicator of its own.
  //
  // NOTE (P1): we deliberately do NOT advance the conflict token to the cover
  // write's sha. savePageCoverImage folds the cover into main's CURRENT blocks,
  // which may include a concurrent editor's edits this session never saw;
  // adopting its sha as our base would let the next save replay against a
  // document this editor isn't derived from and silently clobber those edits.
  // Leaving the token at the loaded sha makes the next save a 3-way merge
  // (base = what this editor loaded), which folds the cover in AND preserves
  // the concurrent edits — the cover is already committed to main regardless.
  useEffect(() => {
    if (coverFetcher.state !== 'idle') return;
    if (coverFetcher.data?.error) {
      toast.error(coverFetcher.data.error);
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

  // Baseline capture (P2): once the editor has mounted (or remounted after a
  // merged adoption), snapshot its NORMALIZED document as the diff-at-save
  // baseline, paired with the sha it represents. Same BlockNote normalization
  // on both diff sides, so untouched stored blocks never emit phantom updates.
  // Stable identity (reads refs only) so a remounted editor captures it once.
  const handleEditorReady = useCallback((document: unknown) => {
    savedBaselineRef.current = {
      sha: pendingBaselineShaRef.current,
      content: JSON.stringify(document),
    };
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

      {/* Preview-branch chrome (staff only — `preview` is null otherwise).
          Keyed on page.id so the preview fetcher's conflict state resets on
          same-route navigation (P4) instead of ghosting onto the next page. */}
      {preview?.active && <PreviewBar key={page.id} preview={preview} isEmbedded={isEmbedded} />}
      {preview?.missing && <NoPreviewNotice />}
      {preview && !preview.active && preview.exists && (
        <PendingPreviewBanner key={page.id} preview={preview} />
      )}

      {/* Save-merge chooser (Phase 7.5): a stale save hit true collisions —
          pick a side per block, then the same content re-submits with the
          choices. The editor (and lastPostedContentRef) preserve the document
          until the resolution completes. */}
      {canEdit && saveMergeReport && (
        <div className={`sticky ${isEmbedded ? 'top-0' : 'top-12'} z-30 shadow-lg`}>
          <ConflictPanel
            variant="save"
            units={saveMergeReport.units}
            autoMerged={saveMergeReport.autoMerged}
            oursSha={saveMergeReport.oursSha}
            busy={fetcher.state !== 'idle'}
            onApply={handleApplySaveResolutions}
            onDiscard={handleConflictReload}
          />
        </div>
      )}

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
          imageUrl={assets.displayUrl(coverImage.url) as string}
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
                key={`${page.id}:${editorEpoch}`}
                ref={editorRef}
                initialContent={editorDoc}
                pageId={page.id}
                darkMode={darkMode}
                onChange={handleEditorChange}
                onReady={handleEditorReady}
                resolveFileUrl={assets.resolveFileUrl}
                onAssetUploaded={assets.remember}
                // P5: block editing while the save-merge chooser is open so no
                // edits are silently discarded when the resolved merge remounts
                // the editor. The chooser is the way forward (Apply / Reload).
                editable={!saveMergeReport}
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
              <BlockNoteViewer
                // The epoch rebuilds the viewer after a 403 retry — BlockNote
                // asks for a file URL once per mount, so a refreshed map only
                // reaches it through a remount. Safe here and only here: the
                // viewer holds no unsaved state, the editor does.
                key={`${page.id}:${assetEpoch}`}
                content={content}
                darkMode={darkMode}
                resolveFileUrl={assets.resolveFileUrl}
              />
            </Suspense>
          )}
        </div>
      </div>
    </>
  );
};

export default PageRoute;
