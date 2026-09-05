import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { MantineProvider } from '@mantine/core';
import { useState, useEffect } from 'react';
import { schema, type PageBlockInsertions } from '~/components/editor/blocks/index.tsx';
import { AssetSrcSetContext, NO_SRC_SETS, type AssetSrcSets } from '~/hooks/useAssetSrcSets.ts';

import '@blocknote/mantine/style.css';
import '@blocknote/core/fonts/inter.css';
import '~/styles/blocknote-overrides.css';

/**
 * BlockNoteViewer - Read-only BlockNote viewer for pages.
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
}

const BlockNoteViewer = ({
  content,
  darkMode,
  resolveFileUrl,
  srcSets,
}: BlockNoteViewerProps) => {
  const [isMounted, setIsMounted] = useState(false);
  const initialContent =
    Array.isArray(content) && content.length > 0
      ? (content as PageBlockInsertions)
      : ([{ type: 'paragraph', content: [] }] as PageBlockInsertions);

  const editor = useCreateBlockNote({
    schema,
    initialContent,
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
          <BlockNoteView editor={editor} editable={false} theme={darkMode ? 'dark' : 'light'} />
        </AssetSrcSetContext.Provider>
      </div>
    </MantineProvider>
  );
};

export default BlockNoteViewer;
