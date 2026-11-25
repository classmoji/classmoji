import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { syntaxHighlighter } from '@blocknote/code-block';
import { MantineProvider } from '@mantine/core';
import { drawableBlocks } from '~/utils/drawableBlocks.ts';
import { MANTINE_8_THEME, mantine8CssVariables } from '~/utils/mantineTheme.ts';
import { findBlock, lockedSectionIds } from '@classmoji/page-schema/sections';
import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import { pageCommentsExtension } from '~/components/comments/commentsPlugin.ts';
import { headingAnchorsExtension } from './headingAnchors.ts';
import { CommentsHost } from '~/components/comments/CommentsHost.tsx';
import type { CommentsBridge } from '~/components/comments/commentsBridge.ts';
import type { PageBlockInsertions } from '~/components/editor/blocks/index.tsx';
import { viewerSchema } from './viewerBlocks.tsx';
import { AssetSrcSetContext, NO_SRC_SETS, type AssetSrcSets } from '~/hooks/useAssetSrcSets.ts';
import {
  AssetDisplayUrlContext,
  IDENTITY_DISPLAY_URL,
  type DisplayUrlLookup,
} from '~/hooks/useAssetDisplayUrl.ts';
import { MediaDownloadContext, mediaDownloadLookup } from '~/hooks/useMediaDownloads.ts';
import type { MediaDownloads } from '~/utils/mediaDownloads.ts';
import { installCopyGuard } from '~/utils/copyGuard.ts';
import {
  NO_READER_SECTIONS,
  ReaderSectionsContext,
  type ReaderSectionsValue,
} from '~/hooks/useReaderSections.tsx';
import { openLockedSections, sectionStoreFor } from './sections/sectionCheckbox.ts';
import { useSectionFade } from './sections/useSectionFade.ts';
import { useSectionCheckGutter } from './sections/useSectionCheckGutter.ts';
import { openAllToggles } from './toggles.ts';

import '@blocknote/mantine/style.css';
import '@blocknote/core/fonts/inter.css';
import '~/styles/blocknote-overrides.css';
import '~/styles/page-sections.css';

/**
 * BlockNoteViewer - Read-only BlockNote viewer for pages.
 *
 * Renders with `viewerSchema` (the editor's blocks, plus a reader's Download
 * button on file and audio blocks) and hands the video block the same
 * button through `MediaDownloadContext`.
 */
interface BlockNoteViewerProps {
  content: unknown;
  darkMode: boolean;
  /**
   * Stored reference → signed display URL, same contract as the editor's. The
   * viewer never writes, but it renders the same documents, so it needs the
   * same translation or every repo-relative reference resolves against the
   * pages origin and 404s.
   */
  resolveFileUrl?: (url: string) => Promise<string>;
  /** Responsive candidates, keyed by the stored reference. Same as the editor's. */
  srcSets?: AssetSrcSets;
  /**
   * The same map as `resolveFileUrl`, read synchronously. Custom blocks call it
   * during render so the signed URL is in `src` on the FIRST commit — an
   * effect-time swap paints the bare stored path, and the browser fetches it.
   */
  displayUrl?: DisplayUrlLookup;
  /** The page, for the download buttons' route. */
  pageId?: string;
  /**
   * `ref → downloadable` for this reader (the loader's `mediaDownloads`). A
   * file with `true` gets a Download button; everything else gets none.
   */
  mediaDownloads?: MediaDownloads;
  /**
   * This reader's checkable / locked section state (`useReaderSectionsState`
   * in the route, so it outlives a remount of this viewer). None: no tick
   * boxes, locked sections drawn from whatever the content holds.
   */
  readerSections?: ReaderSectionsValue;
  /**
   * Page comments for this reader (`usePageCommentsController` in the
   * route): highlights, bubbles, the selection and block buttons. None: no
   * comment UI at all (signed out, not a member, a preview).
   */
  comments?: CommentsBridge | null;
  /**
   * Prefix for the Download links ('' on the pages host itself; the pages
   * origin where the reader is mounted on another host).
   */
  downloadOrigin?: string;
  /**
   * `#fragment` ids on h1-h3 (the class site's ids). The shared reader turns
   * it on (and scrolls to `location.hash` once the view is in).
   */
  headingAnchors?: boolean;
  /**
   * Draw every toggle list item and toggle heading open, and remember nothing
   * (the MCP's page render, whose screenshot must show their bodies). Off:
   * BlockNote's behaviour, closed until the reader opens one.
   */
  togglesOpen?: boolean;
  /** Called once the view is mounted (the reader's ready signal). */
  onMounted?: () => void;
}

const BlockNoteViewer = ({
  content,
  darkMode,
  resolveFileUrl,
  srcSets,
  displayUrl,
  pageId,
  mediaDownloads,
  readerSections = NO_READER_SECTIONS,
  comments = null,
  downloadOrigin = '',
  headingAnchors = false,
  togglesOpen = false,
  onMounted,
}: BlockNoteViewerProps) => {
  const [isMounted, setIsMounted] = useState(false);
  // Stored blocks as the viewer schema can build them (drawableBlocks).
  const initialContent =
    Array.isArray(content) && content.length > 0
      ? (drawableBlocks(content) as PageBlockInsertions)
      : ([{ type: 'paragraph', content: [] }] as PageBlockInsertions);

  const downloads = useMemo(
    () =>
      pageId
        ? mediaDownloadLookup(pageId, mediaDownloads, downloadOrigin)
        : mediaDownloadLookup('', null),
    [pageId, mediaDownloads, downloadOrigin]
  );

  const editor = useCreateBlockNote({
    schema: viewerSchema,
    initialContent: initialContent as never,
    // Shiki highlighting for code blocks, as in the editor; comment
    // highlights (decorations only, drawing nothing without threads).
    extensions: [
      syntaxHighlighter,
      pageCommentsExtension(),
      ...(headingAnchors ? [headingAnchorsExtension()] : []),
    ],
    ...(resolveFileUrl ? { resolveFileUrl } : {}),
  });
  // Before the view (mounted below, after `isMounted`) builds its node views.
  if (togglesOpen) openAllToggles(editor);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Once the view is in, tell the host (the reader then goes to the heading
  // the address names: its id comes from a decoration, so only now does it
  // exist). Two frames, so BlockNote's node views have painted.
  const onMountedRef = useRef(onMounted);
  onMountedRef.current = onMounted;
  useEffect(() => {
    if (!isMounted) return;
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        onMountedRef.current?.();
      });
    });
    return () => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
    };
    // Once per mount: a later change of these is not a new arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMounted]);

  // Code and terminal blocks with copying off: CSS makes them unselectable,
  // this keeps a selection that spans one from copying it (copyGuard.ts).
  // BlockNote copies from its own selection, so the guard reads that one.
  useEffect(() => installCopyGuard(document, () => editor.prosemirrorView), [editor]);

  // The tick boxes on checkable headings are node-view DOM, not React: they
  // read the reader's state from this editor's store. The store is filled
  // here on the first commit, before `isMounted` brings the view (and its
  // node views) in, and again on every change.
  const sectionStore = sectionStoreFor(editor);
  const { showChecks, canCheck, checked, toggleCheck } = readerSections;
  useLayoutEffect(() => {
    sectionStore.set({ showChecks, canCheck, checked, toggleCheck });
  }, [sectionStore, showChecks, canCheck, checked, toggleCheck]);

  // Which locked sections are open in this editor: the body is in, or the
  // section has none (`openLockedSections`). Published through the section
  // store: a locked section shows as unlocked only once it is open here
  // (BlockNote does not re-render a block's own view when only its children
  // change, so the block cannot tell by itself).
  const { contentUnlocked } = readerSections;
  const publishFilled = useCallback(() => {
    const filled = openLockedSections(editor.document, content, contentUnlocked);
    const previous = sectionStore.get().filled;
    if (previous.size !== filled.size || [...filled].some(id => !previous.has(id))) {
      sectionStore.set({ filled });
    }
    return filled;
  }, [editor, sectionStore, content, contentUnlocked]);

  // Before the view (and its blocks) first render: the bodies built in.
  useLayoutEffect(() => {
    publishFilled();
  }, [publishFilled]);

  // A locked section's body reaches the reader only through the page loader:
  // after an unlock the route revalidates and `content` comes back with the
  // section's children. The read-only editor was built from the first
  // `content` and is not rebuilt (that would drop scroll, toggles and the
  // unlock animation), so the children are put into it here — for any
  // section whose body is in `content` and not yet in the editor, however
  // it got there. Then every unlock whose reloaded page has arrived is
  // settled: opened if the section is open now (body in the editor, or none
  // to send), failed if not.
  const { status: unlockStatus, settleOpen } = readerSections;
  useEffect(() => {
    if (!isMounted || !Array.isArray(content)) return;
    for (const id of lockedSectionIds(content)) {
      const source = findBlock(content, id);
      const children = Array.isArray(source?.children) ? source.children : [];
      if (children.length === 0) continue;
      const current = editor.getBlock(id);
      if (!current || current.children.length > 0) continue;
      try {
        editor.updateBlock(id, {
          children: drawableBlocks(children) as PageBlockInsertions,
        } as never);
      } catch (error) {
        console.error('[BlockNoteViewer] could not insert a locked section body:', error);
      }
    }
    const filled = publishFilled();
    for (const [id, state] of Object.entries(unlockStatus)) {
      if (state === 'arrived') settleOpen(id, filled.has(id));
    }
  }, [content, editor, isMounted, publishFilled, unlockStatus, settleOpen]);

  // Drawn wherever the reader's ticks are shown ("View as" included), not
  // only where they can be changed.
  const fade = useSectionFade(content, checked, showChecks);
  // Tick boxes in the gutter, or inline where the gutter has no room.
  const gutterRef = useSectionCheckGutter(showChecks);
  const fadeRef = fade.containerRef;
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const containerRef = useCallback(
    (element: HTMLElement | null) => {
      fadeRef(element);
      gutterRef(element);
      setContainer(element);
    },
    [fadeRef, gutterRef]
  );

  // Prevent SSR - BlockNote requires browser APIs
  if (!isMounted) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-gray-500 dark:text-gray-400">Loading content...</div>
      </div>
    );
  }

  return (
    <MantineProvider
      theme={{
        ...MANTINE_8_THEME,
        fontFamily: 'Noto Sans, -apple-system, BlinkMacSystemFont, sans-serif',
        fontFamilyMonospace:
          'JetBrains Mono, SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace',
      }}
      cssVariablesResolver={mantine8CssVariables}
    >
      <div className="page-editor pg-reader-sections" ref={containerRef}>
        {comments ? <CommentsHost editor={editor} bridge={comments} container={container} /> : null}
        {fade.css ? <style data-testid="section-fade-styles">{fade.css}</style> : null}
        <AssetSrcSetContext.Provider value={srcSets ?? NO_SRC_SETS}>
          <AssetDisplayUrlContext.Provider value={displayUrl ?? IDENTITY_DISPLAY_URL}>
            <MediaDownloadContext.Provider value={downloads}>
              <ReaderSectionsContext.Provider value={readerSections}>
                <BlockNoteView
                  editor={editor}
                  editable={false}
                  theme={darkMode ? 'dark' : 'light'}
                />
              </ReaderSectionsContext.Provider>
            </MediaDownloadContext.Provider>
          </AssetDisplayUrlContext.Provider>
        </AssetSrcSetContext.Provider>
      </div>
    </MantineProvider>
  );
};

export default BlockNoteViewer;
