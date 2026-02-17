import { useCallback, useMemo, useImperativeHandle, forwardRef } from 'react';
import {
  useCreateBlockNote,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  FormattingToolbarController,
  FormattingToolbar,
  SideMenu,
  SideMenuController,
  DragHandleMenu,
  RemoveBlockItem,
  BlockColorsItem,
} from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import { filterSuggestionItems } from '@blocknote/core/extensions';
import { en as defaultLocale } from '@blocknote/core/locales';
import {
  multiColumnDropCursor,
  getMultiColumnSlashMenuItems,
  locales as multiColumnLocales,
} from '@blocknote/xl-multi-column';

import { schema, customSlashMenuItems } from './blocks/index.jsx';
import { ReplaceUrlItem, RemoveProfileImageItem } from './ReplaceUrlItem.jsx';

// Custom drag handle menu — extends default with block-specific actions
const CustomDragHandleMenu = () => (
  <DragHandleMenu>
    <RemoveBlockItem>Delete</RemoveBlockItem>
    <BlockColorsItem>Colors</BlockColorsItem>
    <ReplaceUrlItem>Replace URL</ReplaceUrlItem>
    <RemoveProfileImageItem>Remove Image</RemoveProfileImageItem>
  </DragHandleMenu>
);

/**
 * PageEditor — the main BlockNote-powered page editor.
 *
 * Wraps BlockNote with:
 * - Custom schema (all custom blocks including pageLink)
 * - File upload to GitHub via /api/upload
 * - Custom slash menu items
 * - Dark mode support
 *
 * Exposes `getContent()` via ref for the parent to trigger saves.
 */
const PageEditor = forwardRef(function PageEditor({
  initialContent,
  pageId,
  darkMode,
  onChange
}, ref) {
  // Upload handler: POSTs to the page's upload action
  const uploadFile = useCallback(async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('pageId', pageId);

    const response = await fetch(`/api/upload`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error('Upload failed');
    }

    const result = await response.json();
    return result.url;
  }, [pageId]);

  // Create the BlockNote editor with multi-column drop cursor + dictionary
  const editor = useCreateBlockNote({
    schema,
    initialContent: initialContent?.length ? initialContent : undefined,
    uploadFile,
    dropCursor: multiColumnDropCursor,
    dictionary: { ...defaultLocale, multi_column: multiColumnLocales.en },
  }, [onChange]);

  // Expose getContent() to parent via ref
  useImperativeHandle(ref, () => ({
    getContent: () => editor.document,
  }), [editor]);

  // Slash menu: default + multi-column + custom blocks
  const getAllSlashMenuItems = useMemo(() => {
    return (editor) => {
      const items = [
        ...getDefaultReactSlashMenuItems(editor),
      ];
      try {
        items.push(...getMultiColumnSlashMenuItems(editor));
      } catch (e) {
        console.error('[PageEditor] getMultiColumnSlashMenuItems failed:', e);
      }

      // Remove default blocks that we're replacing with custom versions
      const blocksToRemove = ['Divider', 'Video'];
      const filteredItems = items.filter(item => !blocksToRemove.includes(item.title));

      // Override default block groups for better organization
      filteredItems.forEach(item => {
        // Move Code Block from "Advanced" to "Code"
        if (item.title === 'Code Block' || item.title === 'Code') {
          item.group = 'Code';
        }
        // Move regular headings to "Headings" group (H1-H6, but not Toggle Headings)
        if (item.title?.includes('Heading') && !item.title?.includes('Toggle')) {
          item.group = 'Headings';
        }
        // Move all lists to "Lists" group (but not Toggle List)
        if (item.title?.includes('List') && !item.title?.includes('Toggle')) {
          item.group = 'Lists';
        }
      });

      // Add custom blocks
      filteredItems.push(
        ...customSlashMenuItems.map(item => ({
          title: item.title,
          subtext: item.subtext,
          aliases: item.aliases,
          group: item.group,
          icon: item.icon,
          onItemClick: () => item.onItemClick(editor),
        })),
      );

      // Sort items by group to ensure blocks with same group appear together
      const groupOrder = ['Headings', 'Basic blocks', 'Code', 'Lists', 'Media', 'Advanced', 'Subheadings', 'Others'];
      filteredItems.sort((a, b) => {
        const groupA = a.group || 'Others';
        const groupB = b.group || 'Others';
        const indexA = groupOrder.indexOf(groupA);
        const indexB = groupOrder.indexOf(groupB);

        // If both groups are in our order, sort by index
        if (indexA !== -1 && indexB !== -1) {
          return indexA - indexB;
        }
        // If only one is in our order, it comes first
        if (indexA !== -1) return -1;
        if (indexB !== -1) return 1;
        // If neither is in our order, sort alphabetically by group
        return groupA.localeCompare(groupB);
      });

      return filteredItems;
    };
  }, []);

  return (
    <div className="page-editor">
      <style>{`
        .page-editor .bn-block-content,
        .page-editor .bn-inline-content {
          font-size: 16px !important;
          line-height: 1.6 !important;
        }
        .page-editor h1,
        .page-editor h2,
        .page-editor h3 {
          line-height: 1.3 !important;
        }
        .page-editor .callout-block {
          width: 100% !important;
          display: flex !important;
          align-items: center !important;
          gap: 0.5rem !important;
          border: none !important;
          padding: 0.75rem 1rem !important;
          background-color: rgba(0, 0, 0, 0.03) !important;
          border-radius: 10px !important;
        }
        .page-editor .callout-block .callout-emoji {
          height: 1.6em !important;
          line-height: 1.6 !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          flex-shrink: 0 !important;
          align-self: flex-start !important;
        }
        .dark .page-editor .callout-block {
          background-color: rgba(255, 255, 255, 0.05) !important;
        }
        .page-editor .callout-block .inline-content {
          flex: 1 !important;
          min-width: 0 !important;
        }
        .page-editor .alert {
          border: none !important;
          border-radius: 10px !important;
        }
        .page-editor .alert .alert-icon-wrapper {
          height: 1.6em !important;
          line-height: 1.6 !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          flex-shrink: 0 !important;
          align-self: flex-start !important;
        }
        .page-editor .divider-block {
          width: 100% !important;
          margin: 1rem 0 !important;
        }
        .page-editor .divider-block hr {
          border: none !important;
          border-top: 2px solid rgba(0, 0, 0, 0.1) !important;
          margin: 0 !important;
          width: 100% !important;
        }
        .dark .page-editor .divider-block hr {
          border-top-color: rgba(255, 255, 255, 0.15) !important;
        }
        .page-editor .bn-block-content[data-content-type="diff"],
        .page-editor .bn-block-content[data-content-type="fileTree"] {
          width: 100% !important;
          max-width: 100% !important;
        }
        .page-editor .bn-block-content[data-content-type="diff"] > div,
        .page-editor .file-tree-block {
          width: 100% !important;
          max-width: 100% !important;
          box-sizing: border-box !important;
        }
      `}</style>
      <BlockNoteView
        editor={editor}
        theme={darkMode ? 'dark' : 'light'}
        slashMenu={false}
        formattingToolbar={false}
        sideMenu={false}
        onChange={() => onChange?.(editor.document)}
      >
        <SideMenuController
          sideMenu={(props) => (
            <SideMenu {...props} dragHandleMenu={CustomDragHandleMenu} />
          )}
        />
        <FormattingToolbarController
          formattingToolbar={() => (
            <FormattingToolbar />
          )}
        />
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(getAllSlashMenuItems(editor), query)
          }
        />
      </BlockNoteView>
    </div>
  );
});

export default PageEditor;
