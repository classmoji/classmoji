import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { MantineProvider } from '@mantine/core';
import { useState, useEffect } from 'react';
import { schema, type PageBlockInsertions } from '~/components/editor/blocks/index.tsx';

import '@blocknote/mantine/style.css';
import '@blocknote/core/fonts/inter.css';
import '~/styles/blocknote-overrides.css';

/**
 * BlockNoteViewer - Read-only BlockNote viewer for pages.
 */
interface BlockNoteViewerProps {
  content: unknown;
  darkMode: boolean;
}

const BlockNoteViewer = ({ content, darkMode }: BlockNoteViewerProps) => {
  const [isMounted, setIsMounted] = useState(false);
  const initialContent =
    Array.isArray(content) && content.length > 0
      ? (content as PageBlockInsertions)
      : ([{ type: 'paragraph', content: [] }] as PageBlockInsertions);

  const editor = useCreateBlockNote({
    schema,
    initialContent,
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
        <BlockNoteView editor={editor} editable={false} theme={darkMode ? 'dark' : 'light'} />
      </div>
    </MantineProvider>
  );
};

export default BlockNoteViewer;
