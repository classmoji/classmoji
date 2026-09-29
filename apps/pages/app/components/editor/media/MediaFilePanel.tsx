import { useState } from 'react';
import {
  EmbedTab,
  FilePanel,
  UploadTab,
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  type FilePanelProps,
} from '@blocknote/react';

import { MediaLibraryList, type MediaLibraryKind } from './MediaLibraryList.tsx';
import { usePageMedia } from './PageMedia.tsx';

/**
 * BlockNote's file panel with a third tab: the classroom's media.
 *
 * Upload and Embed are BlockNote's own tabs, unchanged — the upload tab calls
 * `editor.uploadFile`, which is the page editor's router, so a file dropped
 * there already lands in the repository or in media as it should. The Media
 * tab adds what BlockNote has no notion of: re-using a file the classroom
 * already stores, without uploading it again.
 *
 * Only for the blocks whose files can live in media — `file` (anything) and
 * `audio` — and only when this editor can use media at all. The image block
 * keeps BlockNote's panel: images stay in the repository (§7.10), so a Media
 * tab there would list almost nothing.
 */

/** Block type → what its Media tab lists. A type not here gets no Media tab. */
const MEDIA_TAB: Record<string, { kind?: MediaLibraryKind }> = {
  file: {},
  audio: { kind: 'AUDIO' },
};

export function MediaFilePanel(props: FilePanelProps) {
  const editor = useBlockNoteEditor();
  const media = usePageMedia();
  const block = editor.getBlock(props.blockId);
  const type = block?.type ?? '';
  const tab = media.canUseMedia ? MEDIA_TAB[type] : undefined;

  if (!tab || !media.classroomId) return <FilePanel {...props} />;
  return <FilePanelWithMedia {...props} classroomId={media.classroomId} kind={tab.kind} />;
}

function FilePanelWithMedia({
  blockId,
  classroomId,
  kind,
}: FilePanelProps & { classroomId: string; kind?: MediaLibraryKind }) {
  // Always present under BlockNoteView, which is the only place a file panel renders.
  const Components = useComponentsContext() as NonNullable<ReturnType<typeof useComponentsContext>>;
  const dict = useDictionary();
  const editor = useBlockNoteEditor();
  const media = usePageMedia();
  const [loading, setLoading] = useState(false);

  const tabs = [
    ...(editor.uploadFile !== undefined
      ? [
          {
            name: dict.file_panel.upload.title,
            tabPanel: <UploadTab blockId={blockId} setLoading={setLoading} />,
          },
        ]
      : []),
    {
      name: dict.file_panel.embed.title,
      tabPanel: <EmbedTab blockId={blockId} />,
    },
    {
      name: 'Media',
      tabPanel: (
        <Components.FilePanel.TabPanel className="bn-tab-panel">
          <div className="w-full">
            <MediaLibraryList
              classroomId={classroomId}
              kind={kind}
              onPick={async item => {
                setLoading(true);
                try {
                  // The display URL first, so the block's first render with
                  // the new reference already has something to show.
                  await media.place(item.ref);
                  editor.updateBlock(blockId, {
                    props: { name: item.filename, url: item.ref },
                  } as Parameters<typeof editor.updateBlock>[1]);
                } finally {
                  setLoading(false);
                }
              }}
            />
          </div>
        </Components.FilePanel.TabPanel>
      ),
    },
  ];

  const [openTab, setOpenTab] = useState(tabs[0].name);

  return (
    <Components.FilePanel.Root
      className="bn-panel"
      defaultOpenTab={openTab}
      openTab={openTab}
      setOpenTab={setOpenTab}
      tabs={tabs}
      loading={loading}
    />
  );
}
