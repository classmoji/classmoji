import { useCallback, useState } from 'react';
import { Button, ConfigProvider, Modal, theme } from 'antd';

import { useIsDarkMode } from '~/hooks/useIsDarkMode';
import { deleteHtmlBlockFile } from '~/utils/htmlBlockClient';
import type { PendingFileDeletes } from './pendingFileDeletes';
import { htmlBlockFileNamedIn, orphanedHtmlBlockFiles } from './slideBlocks';

/**
 * Deleting an html block (or a slide holding one) leaves its code file
 * (`blocks/<name>.html`) in the repository. When no other block of the deck
 * names that file any more, the author is asked whether to delete it too.
 * The block itself is gone either way.
 *
 * "Delete file" deletes it at once in a live deck (the live deck is the
 * source of truth). The git editor hands it to `pending` instead: it is
 * deleted once the save that drops the block has landed, and not at all if
 * the edit is discarded.
 */

/** The editor's slides: the live deck every reference is counted in. */
function liveDeck(): Element | null {
  return typeof document === 'undefined' ? null : document.querySelector('.reveal .slides');
}

export function useHtmlBlockFilePrompt(
  slideId: string | null,
  pending: PendingFileDeletes | null = null
) {
  // One question per removal, asked in turn.
  const [queue, setQueue] = useState<string[][]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Call after removing `removed` from the deck (blocks, slides, stacks). */
  const afterBlocksRemoved = useCallback(
    (removed: Iterable<Element>) => {
      if (!slideId) return;
      const files = orphanedHtmlBlockFiles(removed, liveDeck());
      if (files.length > 0) setQueue(current => [...current, files]);
    },
    [slideId]
  );

  const files = queue[0] ?? null;
  const next = useCallback(() => {
    setError(null);
    setQueue(current => current.slice(1));
  }, []);

  const deleteFiles = useCallback(async () => {
    if (!files || !slideId) return;
    setBusy(true);
    setError(null);
    try {
      // Checked again now: an undo may have brought a block back meanwhile.
      const orphans = files.filter(src => !htmlBlockFileNamedIn(src, liveDeck()));
      if (pending) pending.add(orphans);
      else for (const src of orphans) await deleteHtmlBlockFile(slideId, { src });
      next();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'The file could not be deleted.');
    } finally {
      setBusy(false);
    }
  }, [files, slideId, next, pending]);

  const prompt = (
    <HtmlBlockFilePromptModal
      files={files}
      busy={busy}
      error={error}
      onKeep={next}
      onDelete={deleteFiles}
    />
  );

  return { afterBlocksRemoved, prompt };
}

function HtmlBlockFilePromptModal({
  files,
  busy,
  error,
  onKeep,
  onDelete,
}: {
  files: string[] | null;
  busy: boolean;
  error: string | null;
  onKeep: () => void;
  onDelete: () => void;
}) {
  const isDark = useIsDarkMode();
  const one = files?.length === 1;
  return (
    <ConfigProvider theme={{ algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
      <Modal
        open={files !== null}
        title={one && files ? `Also delete its file ${files[0]}?` : 'Also delete their files?'}
        onCancel={busy ? undefined : onKeep}
        closable={!busy}
        maskClosable={false}
        width={440}
        centered
        footer={[
          <Button key="keep" onClick={onKeep} disabled={busy} data-testid="html-block-file-keep">
            {one ? 'Keep file' : 'Keep files'}
          </Button>,
          <Button
            key="delete"
            danger
            type="primary"
            loading={busy}
            onClick={onDelete}
            data-testid="html-block-file-delete"
          >
            {one ? 'Delete file' : 'Delete files'}
          </Button>,
        ]}
      >
        {!one && (
          <ul className="mb-2 list-disc pl-5 text-sm text-gray-700 dark:text-gray-300">
            {files?.map(src => (
              <li key={src}>
                <code className="font-mono text-xs">{src}</code>
              </li>
            ))}
          </ul>
        )}
        <p className="text-sm text-gray-700 dark:text-gray-300">
          No other block in this deck uses {one ? 'it' : 'them'}.
        </p>
        {error && (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
      </Modal>
    </ConfigProvider>
  );
}
