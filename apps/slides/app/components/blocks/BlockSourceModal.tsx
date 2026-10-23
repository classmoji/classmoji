import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ConfigProvider, Modal, theme } from 'antd';
import {
  BLOCK_ID_ATTR,
  HTML_BLOCK_SANDBOX,
  MAX_HTML_BLOCK_FILE_BYTES,
  htmlBlockFrameMarkup,
  htmlBlockSource,
  htmlBlockSrcdoc,
  isSafeHtmlBlockSandbox,
  utf8ByteLength,
} from '@classmoji/services/slides/runtime-attrs';
import { resolveDeckRelative } from '@classmoji/services/slides/frame-refs';

import { useIsDarkMode } from '~/hooks/useIsDarkMode';
import type { EditorFrames } from '~/utils/editorFrames';
import { HtmlBlockApiError, readHtmlBlockFile, saveHtmlBlockFile } from '~/utils/htmlBlockClient';
import { feedPreviewFrame, previewFrameUrl } from '~/utils/legacyHtmlBlocks';
import CodeSourceEditor from './CodeSourceEditor';
import {
  STARTER_HTML_SOURCE,
  frameOfBlock,
  htmlBlockSourceOf,
  isHtmlBlockFileShared,
  setHtmlBlockFile,
  slideHtmlLengthWith,
  slideHtmlOverCap,
  storedSrcdoc,
  svgFromSource,
  svgOfBlock,
  type HtmlBlockSource,
} from './slideBlocks';

/**
 * BlockSourceModal — edit an html or svg block's source with a live preview.
 *
 * html: the block's code is a file in the deck's repository
 * (`blocks/<name>.html`). Opening reads it; Apply writes it (a compare-and-swap
 * on the version opened) and points the block at the version written — one
 * change to the slide, so undo and live editing see it. The live preview is
 * the content service's preview frame, sent the draft as it is typed. A block
 * that shows another repo file is not edited here. Without the content service
 * (local development) a block keeps its code inline in `srcdoc`, as before.
 *
 * svg: the source is held to the svg-block lists on Apply and replaces the
 * block's `<svg>`.
 *
 * While open, the block carries `editing-code`, so a live deck holds remote
 * changes to its slide until the modal closes (DeckBridge.busyIn); the
 * bridge applies them on its next tick.
 *
 * Closing with changes not applied asks first.
 */

export type SourceBlockKind = 'html' | 'svg';

/** How the source editor opens. */
export interface BlockSourceOptions {
  /** Start from the starter code and save it as a new file (the block shows a repo file today). */
  fresh?: boolean;
}

export function sourceBlockKind(block: HTMLElement | null): SourceBlockKind | null {
  const type = block?.dataset.blockType;
  return type === 'html' || type === 'svg' ? type : null;
}

/** The source the editor opens with, when it is in the block itself. */
function inlineSource(block: HTMLElement, kind: SourceBlockKind): string {
  if (kind === 'html') {
    const frame = frameOfBlock(block);
    return frame ? htmlBlockSource(storedSrcdoc(frame)) : '';
  }
  const svg = svgOfBlock(block);
  return svg ? new XMLSerializer().serializeToString(svg) : '';
}

function blockBox(block: HTMLElement): { width: number; height: number } {
  const width = parseFloat(block.style.width) || block.offsetWidth || 960;
  const height = parseFloat(block.style.height) || block.offsetHeight || 540;
  return { width, height };
}

/** The colour behind the slide (the preview is shown on it). */
function slideBackdrop(block: HTMLElement): string {
  for (const el of [block.closest('.reveal-viewport'), block.closest('.reveal')]) {
    if (!el) continue;
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
  }
  return '#ffffff';
}

const PREVIEW_DELAY_MS = 400;

/** The message for a block whose file moved on since it was opened. */
export const CODE_CHANGED_MESSAGE = "This block's code changed since you opened it";

interface BlockSourceModalProps {
  block: HTMLElement | null;
  options?: BlockSourceOptions;
  /** The deck (its html-block API). */
  slideId?: string | null;
  /** The deck's editor frame context: present, new code is saved as a file. */
  frames?: EditorFrames | null;
  /** The content service origin: the live preview runs in its preview frame. */
  contentOrigin?: string | null;
  onClose: () => void;
  onApplied?: () => void;
}

export default function BlockSourceModal({
  block,
  options = {},
  slideId = null,
  frames = null,
  contentOrigin = null,
  onClose,
  onApplied,
}: BlockSourceModalProps) {
  const isDark = useIsDarkMode();
  const kind = sourceBlockKind(block);
  const open = block !== null && kind !== null;
  // Changes typed but not applied, and the "discard them?" question.
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setDirty(false);
    setConfirming(false);
  }, [block]);

  const requestClose = useCallback(() => {
    if (dirty) setConfirming(true);
    else onClose();
  }, [dirty, onClose]);

  return (
    <ConfigProvider theme={{ algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
      <Modal
        open={open}
        onCancel={requestClose}
        // Escape belongs to the editor (closing a completion list), never
        // to discarding the source.
        keyboard={false}
        maskClosable={false}
        destroyOnHidden
        width="min(1200px, 94vw)"
        title={kind === 'svg' ? 'SVG source' : 'HTML source'}
        footer={null}
        centered
      >
        {open && block && kind && (
          <SourceEditorBody
            key={block.dataset.cmBlockId ?? 'block'}
            block={block}
            kind={kind}
            fresh={Boolean(options.fresh)}
            slideId={slideId}
            frames={frames}
            contentOrigin={contentOrigin ?? frames?.contentOrigin ?? null}
            dark={isDark}
            onClose={onClose}
            onCancel={requestClose}
            onDirtyChange={setDirty}
            onApplied={onApplied}
          />
        )}
      </Modal>
      <Modal
        open={open && confirming}
        title="Discard changes?"
        onCancel={() => setConfirming(false)}
        width={400}
        centered
        footer={[
          <Button key="keep" onClick={() => setConfirming(false)}>
            Keep editing
          </Button>,
          <Button
            key="discard"
            danger
            type="primary"
            data-testid="block-source-discard"
            onClick={() => {
              setConfirming(false);
              onClose();
            }}
          >
            Discard
          </Button>,
        ]}
      >
        The changes to this source have not been applied.
      </Modal>
    </ConfigProvider>
  );
}

/** Where Apply writes an html block's code. */
type HtmlTarget =
  /** A file: the block's own (`src`, opened at `rev`), or a new one. */
  | { kind: 'file'; src: string | null; rev: string | null }
  /** Inline in `srcdoc` (no content service). */
  | { kind: 'inline' }
  /** Another repo file: not edited here. */
  | { kind: 'repo'; src: string };

function htmlTargetOf(source: HtmlBlockSource, fresh: boolean, filesOn: boolean): HtmlTarget {
  if (fresh) return filesOn ? { kind: 'file', src: null, rev: null } : { kind: 'inline' };
  if (source.kind === 'file') return { kind: 'file', src: source.src, rev: source.rev };
  if (source.kind === 'repo') return { kind: 'repo', src: source.src };
  return filesOn ? { kind: 'file', src: null, rev: null } : { kind: 'inline' };
}

function SourceEditorBody({
  block,
  kind,
  fresh,
  slideId,
  frames,
  contentOrigin,
  dark,
  onClose,
  onCancel,
  onDirtyChange,
  onApplied,
}: {
  block: HTMLElement;
  kind: SourceBlockKind;
  fresh: boolean;
  slideId: string | null;
  frames: EditorFrames | null;
  contentOrigin: string | null;
  dark: boolean;
  onClose: () => void;
  /** Cancel: the parent asks first when there are changes. */
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onApplied?: () => void;
}) {
  const target = useMemo(
    () =>
      kind === 'html'
        ? htmlTargetOf(htmlBlockSourceOf(block), fresh, frames !== null && slideId !== null)
        : null,
    [block, kind, fresh, frames, slideId]
  );
  const readsFile = target?.kind === 'file' && target.src !== null;

  // The code as opened: inline right away, a file once it is read. `rev` is
  // the version read — what Apply's compare-and-swap names.
  const [opened, setOpened] = useState<{ source: string; rev: string | null } | null>(() =>
    readsFile
      ? null
      : {
          source: fresh ? STARTER_HTML_SOURCE : inlineSource(block, kind),
          rev: null,
        }
  );
  // Bumped to read the file again (and restart the editor from it).
  const [loadKey, setLoadKey] = useState(0);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const initial = opened?.source ?? '';
  const [source, setSource] = useState(initial);
  const dirty = opened !== null && source !== initial;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const [previewSource, setPreviewSource] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const locked = block.closest('section')?.classList.contains('cm-locked') ?? false;

  useEffect(() => {
    if (!readsFile || !slideId || target?.kind !== 'file' || !target.src) return;
    let cancelled = false;
    setOpened(null);
    setLoadError(null);
    readHtmlBlockFile(slideId, { src: target.src, rev: target.rev })
      .then(file => {
        if (cancelled) return;
        setMissing(false);
        setOpened({ source: file.html, rev: file.rev });
        setSource(file.html);
        setPreviewSource(file.html);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof HtmlBlockApiError && err.code === 'not-found') {
          // A file that is gone: what is written next is saved as a new file.
          setMissing(true);
          setOpened({ source: '', rev: null });
          setSource('');
          setPreviewSource('');
          return;
        }
        setLoadError(err instanceof Error ? err.message : 'The code could not be read.');
      });
    return () => {
      cancelled = true;
    };
  }, [readsFile, slideId, target, loadKey]);

  // The block is being edited: a live deck holds remote renders of its slide.
  useEffect(() => {
    block.classList.add('editing-code');
    return () => block.classList.remove('editing-code');
  }, [block]);

  useEffect(() => {
    const timer = setTimeout(() => setPreviewSource(source), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [source]);

  const svgPreview = useMemo(() => {
    if (kind !== 'svg') return null;
    const result = svgFromSource(previewSource, document);
    return result.ok ? new XMLSerializer().serializeToString(result.svg) : null;
  }, [kind, previewSource]);

  const backdrop = useMemo(() => slideBackdrop(block), [block]);
  const contentColor = useMemo(() => {
    const content = block.querySelector('.sl-block-content');
    return content ? getComputedStyle(content).color : '';
  }, [block]);

  const previewDoc = useMemo(() => {
    if (kind === 'html') return htmlBlockSrcdoc(previewSource);
    if (!svgPreview) return null;
    return (
      '<!DOCTYPE html><style>html,body{margin:0;height:100%;overflow:hidden}' +
      `body{color:${contentColor || 'inherit'}}svg{display:block}</style>${svgPreview}`
    );
  }, [kind, previewSource, svgPreview, contentColor]);

  const finish = useCallback(() => {
    onDirtyChange(false);
    onApplied?.();
    onClose();
  }, [onApplied, onClose, onDirtyChange]);

  const applyFile = useCallback(async () => {
    if (target?.kind !== 'file' || !slideId) return;
    if (utf8ByteLength(source) > MAX_HTML_BLOCK_FILE_BYTES) {
      setError(
        `This code is ${Math.ceil(utf8ByteLength(source) / 1000)} KB; the limit is ${
          MAX_HTML_BLOCK_FILE_BYTES / 1000
        } KB.`
      );
      return;
    }
    const deck = block.closest('.slides');
    const own = target.src !== null && !missing;
    const fork = own && isHtmlBlockFileShared(block, target.src as string, deck);
    setSaving(true);
    setError(null);
    try {
      const ref = await saveHtmlBlockFile(slideId, {
        html: source,
        src: own ? target.src : null,
        rev: own ? opened?.rev : null,
        fork,
        blockId: block.getAttribute(BLOCK_ID_ATTR),
      });
      if (!block.isConnected) {
        setError('This block is no longer on the slide');
        return;
      }
      setHtmlBlockFile(block, ref, frames);
      finish();
    } catch (err: unknown) {
      if (err instanceof HtmlBlockApiError && err.code === 'changed') {
        setError(CODE_CHANGED_MESSAGE);
        setLoadKey(n => n + 1);
        return;
      }
      setError(err instanceof Error ? err.message : 'The code could not be saved.');
    } finally {
      setSaving(false);
    }
  }, [target, slideId, source, block, missing, opened, frames, finish]);

  const apply = useCallback(() => {
    if (!block.isConnected) {
      setError('This block is no longer on the slide');
      return;
    }
    const content = block.querySelector(':scope > .sl-block-content');
    if (!content) {
      setError('This block has no content');
      return;
    }
    if (kind === 'html') {
      if (target?.kind === 'file') {
        void applyFile();
        return;
      }
      const frame = frameOfBlock(block);
      const tooLong = slideHtmlOverCap(
        slideHtmlLengthWith(block, content.innerHTML, htmlBlockFrameMarkup(source))
      );
      if (tooLong) {
        setError(tooLong);
        return;
      }
      const loads =
        frame !== null &&
        frame.hasAttribute('srcdoc') &&
        isSafeHtmlBlockSandbox(frame.getAttribute('sandbox')) &&
        !Array.from(frame.attributes).some(a => a.name.startsWith('data-cm-inert-'));
      if (frame && loads) {
        frame.setAttribute('srcdoc', htmlBlockSrcdoc(source));
      } else {
        // A frame built outside the html-block rule is rebuilt to it.
        content.innerHTML = htmlBlockFrameMarkup(source);
      }
    } else {
      const result = svgFromSource(source, document);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const current = svgOfBlock(block);
      const tooLong = slideHtmlOverCap(
        slideHtmlLengthWith(block, current?.outerHTML ?? '', result.svg.outerHTML)
      );
      if (tooLong) {
        setError(tooLong);
        return;
      }
      if (current) current.replaceWith(result.svg);
      else content.append(result.svg);
    }
    finish();
  }, [block, kind, source, target, applyFile, finish]);

  if (target?.kind === 'repo') {
    const resolved = frames ? resolveDeckRelative(target.src, frames.deckFolder) : null;
    return (
      <div className="flex flex-col gap-3" data-testid="block-source-repo-file">
        <p className="text-sm text-gray-700 dark:text-gray-300">
          This block shows a file from the repository:{' '}
          <code className="font-mono text-xs">{resolved?.repoPath ?? target.src}</code>. Edit that
          file in the repository, or set the block&apos;s source to Code to write its code here.
        </p>
        <div className="flex justify-end">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    );
  }

  const useFramePreview = kind === 'html' && contentOrigin !== null;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid h-[65vh] min-h-[320px] grid-cols-1 gap-3 md:grid-cols-2">
        {opened === null ? (
          <div className="flex items-center justify-center rounded-md border border-gray-200 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
            {loadError ?? 'Loading…'}
          </div>
        ) : (
          <CodeSourceEditor
            key={loadKey}
            initialValue={initial}
            onChange={value => {
              setSource(value);
              if (error !== CODE_CHANGED_MESSAGE) setError(null);
            }}
            dark={dark}
            ariaLabel={kind === 'svg' ? 'SVG source' : 'HTML source'}
          />
        )}
        <ScaledPreview box={blockBox(block)} backdrop={backdrop}>
          {useFramePreview ? (
            <PreviewFrame html={previewSource} contentOrigin={contentOrigin as string} />
          ) : previewDoc === null ? (
            <div className="flex h-full items-center justify-center text-sm text-gray-500 dark:text-gray-400">
              Needs exactly one &lt;svg&gt; element
            </div>
          ) : (
            <iframe
              title="Preview"
              className="block h-full w-full border-0"
              sandbox={kind === 'html' ? HTML_BLOCK_SANDBOX : ''}
              srcDoc={previewDoc}
            />
          )}
        </ScaledPreview>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div
          className="min-h-[1.25rem] text-sm text-red-600 dark:text-red-400"
          role="alert"
          data-testid="block-source-error"
        >
          {error ??
            (missing && target?.kind === 'file' && target.src
              ? `Not found: ${target.src}. Apply saves this code as a new file.`
              : null)}
        </div>
        <div className="flex gap-2">
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            type="primary"
            onClick={apply}
            loading={saving}
            disabled={locked || opened === null}
          >
            Apply
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The live preview of html code: the content service's preview frame (a
 * sandboxed origin), sent the draft once it is ready. A new frame per draft:
 * the preview frame takes one document and keeps it.
 */
function PreviewFrame({ html, contentOrigin }: { html: string; contentOrigin: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const generation = useRef(0);
  const key = useMemo(() => {
    void html;
    return ++generation.current;
  }, [html]);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    return feedPreviewFrame(frame, contentOrigin, html);
  }, [html, contentOrigin]);
  return (
    <iframe
      key={key}
      ref={frameRef}
      title="Preview"
      className="block h-full w-full border-0"
      sandbox={HTML_BLOCK_SANDBOX}
      src={previewFrameUrl(contentOrigin)}
      data-testid="block-source-preview-frame"
    />
  );
}

/**
 * The preview at the block's own size, scaled down to fit its pane — as the
 * slide scales it.
 */
function ScaledPreview({
  box,
  backdrop,
  children,
}: {
  box: { width: number; height: number };
  backdrop: string;
  children: React.ReactNode;
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const measure = () => {
      const s = Math.min(pane.clientWidth / box.width, pane.clientHeight / box.height, 1);
      setScale(s > 0 ? s : 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [box.width, box.height]);

  return (
    <div
      ref={paneRef}
      className="relative flex items-center justify-center overflow-hidden rounded-md border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-950"
      data-testid="block-source-preview"
    >
      <div
        className="shrink-0 overflow-hidden shadow-sm"
        style={{
          background: backdrop,
          width: box.width * scale,
          height: box.height * scale,
        }}
      >
        <div
          style={{
            width: box.width,
            height: box.height,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
