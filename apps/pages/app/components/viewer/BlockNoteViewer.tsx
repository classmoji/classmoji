import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { MantineProvider } from '@mantine/core';
import { useState, useEffect, useMemo } from 'react';
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

import '@blocknote/mantine/style.css';
import '@blocknote/core/fonts/inter.css';
import '~/styles/blocknote-overrides.css';

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
}

const BlockNoteViewer = ({
  content,
  darkMode,
  resolveFileUrl,
  srcSets,
  displayUrl,
  pageId,
  mediaDownloads,
}: BlockNoteViewerProps) => {
  const [isMounted, setIsMounted] = useState(false);
  const initialContent =
    Array.isArray(content) && content.length > 0
      ? (content as PageBlockInsertions)
      : ([{ type: 'paragraph', content: [] }] as PageBlockInsertions);

  const downloads = useMemo(
    () => (pageId ? mediaDownloadLookup(pageId, mediaDownloads) : mediaDownloadLookup('', null)),
    [pageId, mediaDownloads]
  );

  const editor = useCreateBlockNote({
    schema: viewerSchema,
    initialContent: initialContent as never,
    ...(resolveFileUrl ? { resolveFileUrl } : {}),
  });

  useEffect(() => {
    setIsMounted(true);
  }, []);

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
      <div className="page-editor">
        <AssetSrcSetContext.Provider value={srcSets ?? NO_SRC_SETS}>
          <AssetDisplayUrlContext.Provider value={displayUrl ?? IDENTITY_DISPLAY_URL}>
            <MediaDownloadContext.Provider value={downloads}>
              <BlockNoteView editor={editor} editable={false} theme={darkMode ? 'dark' : 'light'} />
            </MediaDownloadContext.Provider>
          </AssetDisplayUrlContext.Provider>
        </AssetSrcSetContext.Provider>
      </div>
    </MantineProvider>
  );
};

export default BlockNoteViewer;
