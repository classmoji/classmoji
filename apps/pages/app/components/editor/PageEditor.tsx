import React, {
  useCallback,
  useEffect,
  useMemo,
  useImperativeHandle,
  useRef,
  forwardRef,
} from 'react';
import {
  useCreateBlockNote,
  SuggestionMenuController,
  getDefaultReactSlashMenuItems,
  FormattingToolbarController,
  FormattingToolbar,
  SideMenu,
  SideMenuController,
  FilePanelController,
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
import { toast } from 'react-toastify';
import { kindOfFilename, type UploadCapability } from '@classmoji/services/media/router';

import {
  schema,
  customSlashMenuItems,
  type PageBlockEditor,
  type PageBlockInsertions,
} from './blocks/index.tsx';
import { ReplaceUrlItem, RemoveProfileImageItem } from './ReplaceUrlItem.tsx';
import { AssetSrcSetContext, NO_SRC_SETS, type AssetSrcSets } from '~/hooks/useAssetSrcSets.ts';
import {
  AssetDisplayUrlContext,
  IDENTITY_DISPLAY_URL,
  type DisplayUrlLookup,
} from '~/hooks/useAssetDisplayUrl.ts';
import { MediaFilePanel } from './media/MediaFilePanel.tsx';
import { usePageMedia } from './media/PageMedia.tsx';
import { fetchMediaDisplayUrl } from './media/mediaDisplayUrl.ts';
import { sendToMedia } from './media/mediaUpload.ts';
import {
  UploadRefused,
  UploadReroute,
  placeUpload,
  type UploadPorts,
} from './media/uploadRouting.ts';

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
 * - File upload through the storage router: the course repository via
 *   /api/upload, or media via the multipart routes on /api/media
 * - Custom slash menu items
 * - Dark mode support
 *
 * Exposes `getContent()` via ref for the parent to trigger saves.
 */
interface PageEditorProps {
  initialContent: unknown;
  pageId: string;
  darkMode: boolean;
  /**
   * Stored reference → signed display URL. Blocks keep the reference; BlockNote
   * is handed the signed URL through `resolveFileUrl` at paint time only.
   */
  resolveFileUrl?: (url: string) => Promise<string>;
  /**
   * Responsive candidates, keyed by the STORED reference. Handed to the image
   * and profile blocks through context rather than through the editor, because
   * `resolveFileUrl` returns one string and has no room for a second value.
   */
  srcSets?: AssetSrcSets;
  /**
   * The same map as `resolveFileUrl`, read synchronously. Custom blocks call it
   * during render so the signed URL is in `src` on the FIRST commit — an
   * effect-time swap paints the bare stored path, and the browser fetches it.
   */
  displayUrl?: DisplayUrlLookup;
  /** Called after an upload with the ref that was stored and the URL to show it with. */
  onAssetUploaded?: (ref: string, displayUrl: string | null) => void;
  onChange?: (document: unknown) => void;
  /**
   * Fired once after mount with the editor's NORMALIZED document
   * (`editor.document`). The parent uses this as its diff-at-save baseline so
   * both diff sides share BlockNote's normalization (no phantom updates).
   */
  onReady?: (document: unknown) => void;
  /** When false, the editor is read-only (e.g. while a save-merge chooser is open). */
  editable?: boolean;
  /**
   * Where this classroom's uploads can go (`storageTargetFor`). Null when the
   * loader could not work it out: uploads then go to the repository within its
   * cap, and the server still redirects a file that belongs in media.
   */
  uploadCapability?: UploadCapability | null;
}

const PageEditor = forwardRef(function PageEditor(
  {
    initialContent,
    pageId,
    darkMode,
    onChange,
    onReady,
    editable = true,
    resolveFileUrl,
    srcSets,
    displayUrl,
    onAssetUploaded,
    uploadCapability = null,
  }: PageEditorProps,
  ref: React.Ref<{ getContent: () => unknown }>
) {
  const media = usePageMedia();
  const classroomId = media.classroomId;
  // Read at upload time for the same reason as the capability below.
  const mediaRef = useRef(media);
  mediaRef.current = media;
  // Read at upload time, not captured: BlockNote holds the `uploadFile` it was
  // created with for the editor's whole life, and every loader revalidation
  // (each save) hands down a fresher capability — the quota left, a classroom
  // that has since gone Pro.
  const capabilityRef = useRef(uploadCapability);
  capabilityRef.current = uploadCapability;
  // `uploadFile` is handed to BlockNote once, at creation, so it reads the
  // editor through a ref rather than closing over a value that does not exist
  // yet.
  const editorRef = useRef<PageBlockEditor | null>(null);

  // Upload handler — BlockNote's `uploadFile`, and the video block's Upload
  // button. The storage router decides where the file goes (`placeUpload`):
  //
  //   - repo  → POST /api/upload?pageId=…, which answers with the repo path;
  //   - media → a multipart upload straight to storage over /api/media, which
  //             answers with `media://{id}`.
  //
  // A video headed for media first asks the uploader for its three options
  // (Upload / Cancel); a cancel sends nothing and says nothing.
  //
  // Either way what goes INTO the block is the reference that keeps following
  // the file — a repo path or `media://{id}` — and never a signed URL: that
  // only ever goes into the display map, so a save can never commit it.
  //
  // A refusal is TOASTED before it is thrown: BlockNote's upload tab catches
  // the error and shows its own generic "Upload failed", so the sentence that
  // says why (the size cap, a type the classroom does not accept, a full
  // quota) would otherwise never reach the person.
  const uploadFile = useCallback(
    async (file: File, blockId?: string) => {
      const ports: UploadPorts = {
        // The page travels in the query string so the server can authorize
        // before it reads the body.
        async toRepo(repoFile) {
          const formData = new FormData();
          formData.append('file', repoFile);
          const response = await fetch(`/api/upload?pageId=${encodeURIComponent(pageId)}`, {
            method: 'POST',
            body: formData,
          });
          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
            // The capability was stale: this file belongs in media.
            if (response.status === 409 && body?.error === 'USE_MEDIA') {
              throw new UploadReroute('media');
            }
            throw new UploadRefused(typeof body?.error === 'string' ? body.error : 'Upload failed');
          }
          const result = await response.json();
          return { ref: result.url, displayUrl: result.displayUrl ?? null };
        },

        async toMedia(mediaFile, options) {
          // Progress, destination and room left are the toast's; the
          // failures come back as the routing errors `placeUpload` follows.
          const { ref } = await sendToMedia({
            file: mediaFile,
            classroomId,
            options,
            capability: capabilityRef.current,
          });
          return { ref, displayUrl: await fetchMediaDisplayUrl(pageId, ref) };
        },

        // A video bound for media is set up by the uploader, in the same
        // three-option dialog every other surface shows, before it is sent.
        askVideoOptions: videoFile => mediaRef.current.askVideoOptions(videoFile),
      };

      let placed;
      try {
        placed = await placeUpload(file, capabilityRef.current, ports);
      } catch (error) {
        if (error instanceof UploadRefused) toast.error(error.message);
        throw error;
      }

      // The display URL goes into the map BEFORE the block gets the reference,
      // so the render that first sees the reference already has its URL.
      onAssetUploaded?.(placed.ref, placed.displayUrl);

      // A video dropped on the page, or uploaded through a generic file
      // block, becomes a video block: BlockNote makes a `file` block for any
      // type no block in the schema claims, and a lecture shown as a filename
      // is not what anyone dropping one meant.
      if (blockId && kindOfFilename(file.name) === 'VIDEO') {
        const block = editorRef.current?.getBlock(blockId);
        if (block?.type === 'file') {
          return { type: 'video', props: { url: placed.ref } };
        }
      }
      return placed.ref;
    },
    [pageId, onAssetUploaded, classroomId]
  );
  const typedInitialContent =
    Array.isArray(initialContent) && initialContent.length > 0
      ? (initialContent as PageBlockInsertions)
      : undefined;

  // Create the BlockNote editor with multi-column drop cursor + dictionary
  const editor = useCreateBlockNote(
    {
      schema,
      initialContent: typedInitialContent,
      uploadFile,
      // The one place a stored reference becomes a signed URL. BlockNote calls
      // it per file block at render; the document it saves back is untouched.
      ...(resolveFileUrl ? { resolveFileUrl } : {}),
      dropCursor: multiColumnDropCursor,
      dictionary: { ...defaultLocale, multi_column: multiColumnLocales.en },
    },
    [onChange]
  );

  editorRef.current = editor;

  // Expose getContent() to parent via ref
  useImperativeHandle(
    ref,
    () => ({
      getContent: () => editor.document,
    }),
    [editor]
  );

  // Baseline capture (P2): hand the parent this editor's normalized document
  // once, right after mount. Runs again for a remounted instance (the parent
  // remounts via `key` on merged adoption), so the baseline tracks the
  // adopted document. `editor` is stable; onReady reads refs only.
  useEffect(() => {
    onReady?.(editor.document);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per editor instance
  }, [editor]);

  // Slash menu: default + multi-column + custom blocks
  const getAllSlashMenuItems = useMemo(() => {
    return (editor: PageBlockEditor) => {
      const items = [...getDefaultReactSlashMenuItems(editor)];
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
        }))
      );

      // Sort items by group to ensure blocks with same group appear together
      const groupOrder = [
        'Headings',
        'Basic blocks',
        'Code',
        'Lists',
        'Media',
        'Advanced',
        'Subheadings',
        'Others',
      ];
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
      {/* Above the view, not inside it: BlockNote portals every block render
          into this tree (its own file blocks read their dictionary the same
          way), so a provider here is what the image and profile blocks see. */}
      <AssetSrcSetContext.Provider value={srcSets ?? NO_SRC_SETS}>
        <AssetDisplayUrlContext.Provider value={displayUrl ?? IDENTITY_DISPLAY_URL}>
          <BlockNoteView
            editor={editor}
            editable={editable}
            theme={darkMode ? 'dark' : 'light'}
            slashMenu={false}
            formattingToolbar={false}
            sideMenu={false}
            filePanel={false}
            onChange={() => onChange?.(editor.document)}
          >
            <SideMenuController
              sideMenu={props => <SideMenu {...props} dragHandleMenu={CustomDragHandleMenu} />}
            />
            <FormattingToolbarController formattingToolbar={() => <FormattingToolbar />} />
            {/* BlockNote's file panel plus a Media tab for file and audio blocks. */}
            <FilePanelController filePanel={MediaFilePanel} />
            <SuggestionMenuController
              triggerCharacter="/"
              getItems={async query => filterSuggestionItems(getAllSlashMenuItems(editor), query)}
            />
          </BlockNoteView>
        </AssetDisplayUrlContext.Provider>
      </AssetSrcSetContext.Provider>
    </div>
  );
});

export default PageEditor;
