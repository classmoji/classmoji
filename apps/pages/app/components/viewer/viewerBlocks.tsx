import {
  BlockNoteSchema,
  audioParse,
  createAudioBlockConfig,
  createFileBlockConfig,
  fileParse,
} from '@blocknote/core';
import {
  AudioBlock,
  AudioPreview,
  AudioToExternalHTML,
  FileBlockWrapper,
  FileNameWithIcon,
  createReactBlockSpec,
} from '@blocknote/react';

import { schema as editorSchema } from '~/components/editor/blocks/index.tsx';
import { useMediaDownloadHref } from '~/hooks/useMediaDownloads.ts';
import { MediaDownloadLink } from './MediaDownloadLink.tsx';

/**
 * The schema the read-only page viewer renders with: the editor's, with the
 * `file` and `audio` blocks able to show a reader's download button.
 *
 * Viewer-only on purpose. The editor keeps BlockNote's own blocks (it shows no
 * download buttons), and the class site builds its static schema from the
 * EDITOR's specs — a React file block there would need editor context the
 * server render does not have and would render as nothing.
 *
 * Both overrides are BlockNote's own composition — `FileBlockWrapper`,
 * `FileNameWithIcon`, `AudioPreview` — so a file with no button renders
 * exactly as it did. `parse` is BlockNote's, and the config is the same
 * factory, so the documents are read identically.
 */

type WrapperProps = Parameters<typeof FileBlockWrapper>[0];

/** A block's props, as the two renders below read them. */
type FileLikeProps = {
  block: { props: { url?: unknown; caption?: unknown; showPreview?: unknown } };
};

/**
 * The file's own content, its caption, and the button — in one column, the
 * way BlockNote's wrapper lays a file block out. Only drawn when there IS a
 * button: every other state (empty, uploading, no permission) is BlockNote's
 * wrapper, untouched.
 */
function WithDownload({ props, children }: { props: FileLikeProps; children: React.ReactNode }) {
  const caption = typeof props.block.props.caption === 'string' ? props.block.props.caption : '';
  return (
    <div className="bn-file-block-content-wrapper media-download-block">
      {children}
      {caption && <p className="bn-file-caption">{caption}</p>}
      <MediaDownloadLink fileRef={props.block.props.url} />
    </div>
  );
}

function ViewerFile(props: WrapperProps) {
  const href = useMediaDownloadHref(props.block.props.url);
  if (!href) return <FileBlockWrapper {...props} />;
  return (
    <WithDownload props={props as unknown as FileLikeProps}>
      <FileNameWithIcon {...props} />
    </WithDownload>
  );
}

type AudioProps = Parameters<typeof AudioBlock>[0];

function ViewerAudio(props: AudioProps) {
  const href = useMediaDownloadHref(props.block.props.url);
  if (!href) return <AudioBlock {...props} />;
  const preview =
    props.block.props.showPreview === false ? (
      <FileNameWithIcon {...(props as unknown as WrapperProps)} />
    ) : (
      <AudioPreview {...props} />
    );
  return <WithDownload props={props as unknown as FileLikeProps}>{preview}</WithDownload>;
}

// `meta.fileBlockAccept` is what puts `data-file-block` on the block's DOM, and
// every one of BlockNote's file-block styles (the wrapper's column layout, the
// name-with-icon row, the icon's size) is scoped under that attribute. The
// values are BlockNote's own for these two blocks.
const DownloadableFile = createReactBlockSpec(createFileBlockConfig, {
  meta: { fileBlockAccept: ['*/*'] },
  render: props => <ViewerFile {...(props as unknown as WrapperProps)} />,
  parse: fileParse(),
});

const DownloadableAudio = createReactBlockSpec(createAudioBlockConfig, config => ({
  meta: { fileBlockAccept: ['audio/*'] },
  render: props => <ViewerAudio {...(props as unknown as AudioProps)} />,
  parse: audioParse(config),
  toExternalHTML: AudioToExternalHTML,
  runsBefore: ['file'],
}));

type SchemaOptions = NonNullable<Parameters<typeof BlockNoteSchema.create>[0]>;

export const viewerSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...editorSchema.blockSpecs,
    file: DownloadableFile(),
    audio: DownloadableAudio(),
  } as SchemaOptions['blockSpecs'],
});
