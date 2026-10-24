import { useCallback, useEffect, useState } from 'react';
import { Button, ConfigProvider, Input, Modal, Segmented, theme } from 'antd';
import { relativeToDeck } from '@classmoji/services/slides/frame-refs';

import { useIsDarkMode } from '~/hooks/useIsDarkMode';
import { listRepoFolder, type RepoFolderEntry } from '~/utils/htmlBlockClient';
import PropertySection, { PropertyLabel } from '../PropertySection';
import { useElementSelection } from '../ElementSelectionContext';
import {
  frameOfBlock,
  htmlBlockSourceOf,
  parentFolder,
  repoFileProblem,
  setHtmlBlockFile,
} from '../../blocks/slideBlocks';

/**
 * HtmlBlockProperties - where an html block's page comes from:
 *   - Code: its own code, written in the source editor and saved as a file
 *     of the deck (`blocks/<name>.html`);
 *   - File in repo: any HTML file of the course repository, named relative to
 *     the deck folder (`games/snake/index.html`,
 *     `../../games/sketchkit/draw.html?deck=x`), typed or picked.
 * The frame's sandbox is fixed: there is nothing else to set here.
 */

type SourceMode = 'code' | 'repo';

export default function HtmlBlockProperties({ block }: { block: HTMLElement }) {
  const { openBlockSource, onContentChange, frames, slideId, deckFolder, afterBlocksRemoved } =
    useElementSelection();
  const locked = block.closest('section')?.classList.contains('cm-locked') ?? false;
  const current = htmlBlockSourceOf(block);
  const [mode, setMode] = useState<SourceMode>(current.kind === 'repo' ? 'repo' : 'code');
  const [path, setPath] = useState(current.kind === 'repo' ? current.src : '');
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    const source = htmlBlockSourceOf(block);
    setMode(source.kind === 'repo' ? 'repo' : 'code');
    setPath(source.kind === 'repo' ? source.src : '');
    setProblem(null);
  }, [block]);

  const folder = deckFolder ?? frames?.deckFolder ?? null;
  const canUseRepo = Boolean(slideId && folder);

  const applyPath = useCallback(
    async (value: string) => {
      if (!slideId || !folder) return;
      const src = value.trim();
      if (
        htmlBlockSourceOf(block).kind === 'repo' &&
        frameOfBlock(block)?.getAttribute('data-cm-src') === src
      ) {
        setProblem(null);
        return;
      }
      setChecking(true);
      try {
        const why = await repoFileProblem(src, folder, f => listRepoFolder(slideId, f));
        setProblem(why);
        if (why) return;
        // The block's own code file may now be named by no block at all.
        const before = block.cloneNode(true) as HTMLElement;
        setHtmlBlockFile(block, { src }, frames);
        onContentChange?.();
        afterBlocksRemoved([before]);
      } catch (err: unknown) {
        setProblem(err instanceof Error ? err.message : 'The repository could not be read.');
      } finally {
        setChecking(false);
      }
    },
    [slideId, folder, block, frames, onContentChange, afterBlocksRemoved]
  );

  return (
    <PropertySection title="HTML">
      <div className="space-y-3">
        <div>
          <PropertyLabel>Source</PropertyLabel>
          <Segmented
            size="small"
            block
            value={mode}
            onChange={value => {
              setMode(value as SourceMode);
              setProblem(null);
            }}
            disabled={locked}
            options={[
              { value: 'code', label: 'Code' },
              { value: 'repo', label: 'File in repo', disabled: !canUseRepo },
            ]}
            data-testid="html-block-source-mode"
          />
        </div>

        {mode === 'code' ? (
          <button
            type="button"
            onClick={() =>
              openBlockSource(block, current.kind === 'repo' ? { fresh: true } : undefined)
            }
            disabled={locked}
            data-testid="html-block-edit-source"
            className="w-full px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {current.kind === 'repo' ? 'Write code' : 'Edit source'}
          </button>
        ) : (
          <div className="space-y-2">
            <div>
              <PropertyLabel>Path (from the deck folder)</PropertyLabel>
              <Input
                size="small"
                value={path}
                placeholder="games/snake/index.html"
                disabled={locked || checking}
                onChange={e => {
                  setPath(e.target.value);
                  setProblem(null);
                }}
                onPressEnter={() => void applyPath(path)}
                onBlur={() => {
                  if (path.trim()) void applyPath(path);
                }}
                data-testid="html-block-repo-path"
              />
            </div>
            <Button
              size="small"
              block
              onClick={() => setBrowsing(true)}
              disabled={locked || !canUseRepo}
            >
              Browse…
            </Button>
            {problem && (
              <p className="text-xs text-red-600 dark:text-red-400" role="alert">
                {problem}
              </p>
            )}
          </div>
        )}
      </div>
      {browsing && slideId && folder && (
        <RepoFilePicker
          slideId={slideId}
          deckFolder={folder}
          onCancel={() => setBrowsing(false)}
          onPick={repoPath => {
            setBrowsing(false);
            const src = relativeToDeck(repoPath, folder);
            setPath(src);
            void applyPath(src);
          }}
        />
      )}
    </PropertySection>
  );
}

const HTML_FILE_RE = /\.html?$/i;

/** A folder browser over the course repository: start at the deck folder, up to the root, pick an .html file. */
function RepoFilePicker({
  slideId,
  deckFolder,
  onCancel,
  onPick,
}: {
  slideId: string;
  deckFolder: string;
  onCancel: () => void;
  onPick: (repoPath: string) => void;
}) {
  const isDark = useIsDarkMode();
  const [folder, setFolder] = useState(deckFolder);
  const [entries, setEntries] = useState<RepoFolderEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    listRepoFolder(slideId, folder)
      .then(listing => {
        if (!cancelled) setEntries(listing.entries);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'This folder could not be read.');
      });
    return () => {
      cancelled = true;
    };
  }, [slideId, folder]);

  const shown = (entries ?? [])
    .filter(entry => entry.type === 'dir' || HTML_FILE_RE.test(entry.name))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));

  return (
    <ConfigProvider theme={{ algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
      <Modal
        open
        title="Choose an HTML file"
        onCancel={onCancel}
        footer={[
          <Button key="cancel" onClick={onCancel}>
            Cancel
          </Button>,
        ]}
        width={520}
        centered
      >
        <div className="mb-2 flex items-center gap-2">
          <Button
            size="small"
            disabled={folder === ''}
            onClick={() => setFolder(parentFolder(folder))}
          >
            Up
          </Button>
          <code className="truncate font-mono text-xs text-gray-600 dark:text-gray-400">
            /{folder}
          </code>
        </div>
        <div
          className="max-h-[50vh] min-h-[120px] overflow-y-auto rounded-md border border-gray-200 dark:border-gray-700"
          data-testid="html-block-repo-picker"
        >
          {error ? (
            <p className="p-3 text-sm text-red-600 dark:text-red-400">{error}</p>
          ) : entries === null ? (
            <p className="p-3 text-sm text-gray-500 dark:text-gray-400">Loading…</p>
          ) : shown.length === 0 ? (
            <p className="p-3 text-sm text-gray-500 dark:text-gray-400">No folders or HTML files</p>
          ) : (
            <ul>
              {shown.map(entry => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-800 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700"
                    onClick={() =>
                      entry.type === 'dir' ? setFolder(entry.path) : onPick(entry.path)
                    }
                  >
                    <span aria-hidden className="w-4 text-gray-400">
                      {entry.type === 'dir' ? '▸' : ''}
                    </span>
                    <span className="truncate">
                      {entry.name}
                      {entry.type === 'dir' ? '/' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Modal>
    </ConfigProvider>
  );
}
