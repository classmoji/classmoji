import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { syntaxHighlighter } from '@blocknote/code-block';
import { MantineProvider } from '@mantine/core';
import { normalizeCodeBlockContent } from '@classmoji/page-schema';
import { findBlock, lockedSectionIds } from '@classmoji/page-schema/sections';
import { useState, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
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
}: BlockNoteViewerProps) => {
  const [isMounted, setIsMounted] = useState(false);
  const initialContent =
    Array.isArray(content) && content.length > 0
      ? (normalizeCodeBlockContent(content) as PageBlockInsertions)
      : ([{ type: 'paragraph', content: [] }] as PageBlockInsertions);

  const downloads = useMemo(
    () => (pageId ? mediaDownloadLookup(pageId, mediaDownloads) : mediaDownloadLookup('', null)),
    [pageId, mediaDownloads]
  );

  const editor = useCreateBlockNote({
    schema: viewerSchema,
    initialContent: initialContent as never,
    // Shiki highlighting for code blocks, as in the editor.
    extensions: [syntaxHighlighter],
    ...(resolveFileUrl ? { resolveFileUrl } : {}),
  });

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Code and terminal blocks with copying off: CSS makes them unselectable,
  // this keeps a selection that spans one from copying it (copyGuard.ts).
  // BlockNote copies from its own selection, so the guard reads that one.
  useEffect(() => installCopyGuard(document, () => editor.prosemirrorView), [editor]);

  // The tick boxes on checkable headings are node-view DOM, not React: they
  // read the reader's state from this editor's store. The store is filled
  // here on the first commit, before `isMounted` brings the view (and its
  // node views) in, and again on every change.
  const sectionStore = sectionStoreFor(editor);
  const { canCheck, checked, toggleCheck } = readerSections;
  useLayoutEffect(() => {
    sectionStore.set({ canCheck, checked, toggleCheck });
  }, [sectionStore, canCheck, checked, toggleCheck]);

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
          children: normalizeCodeBlockContent(children) as PageBlockInsertions,
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

  const fade = useSectionFade(content, checked, readerSections.canCheck);
  // Tick boxes in the gutter, or inline where the gutter has no room.
  const gutterRef = useSectionCheckGutter(readerSections.canCheck);
  const fadeRef = fade.containerRef;
  const containerRef = useCallback(
    (element: HTMLElement | null) => {
      fadeRef(element);
      gutterRef(element);
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
        fontFamily: 'Noto Sans, -apple-system, BlinkMacSystemFont, sans-serif',
        fontFamilyMonospace:
          'JetBrains Mono, SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace',
      }}
    >
      <div className="page-editor pg-reader-sections" ref={containerRef}>
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
