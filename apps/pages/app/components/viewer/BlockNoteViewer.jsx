import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { MantineProvider } from '@mantine/core';
import { useState, useEffect } from 'react';
import { schema } from '~/components/editor/blocks/index.jsx';

import '@blocknote/mantine/style.css';
import '@blocknote/core/fonts/inter.css';
import '~/styles/blocknote-overrides.css';

/**
 * BlockNoteViewer - Read-only BlockNote viewer for pages.
 */
const BlockNoteViewer = ({ content, darkMode }) => {
  const [isMounted, setIsMounted] = useState(false);

  const editor = useCreateBlockNote({
    schema,
    initialContent: content?.length ? content : [{ type: 'paragraph', content: [] }],
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
        colorScheme: darkMode ? 'dark' : 'light',
        fontFamily: 'Noto Sans, -apple-system, BlinkMacSystemFont, sans-serif',
        fontFamilyMonospace: 'JetBrains Mono, SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace',
      }}
    >
      <div className="page-editor">
        <BlockNoteView
          editor={editor}
          editable={false}
          theme={darkMode ? 'dark' : 'light'}
        />
      </div>
    </MantineProvider>
  );
};

export default BlockNoteViewer;
