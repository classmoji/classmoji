import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ConfigProvider, Modal, theme } from 'antd';
import {
  HTML_BLOCK_SANDBOX,
  htmlBlockFrameMarkup,
  htmlBlockSource,
  htmlBlockSrcdoc,
  isSafeHtmlBlockSandbox,
} from '@classmoji/services/slides/runtime-attrs';

import { useIsDarkMode } from '~/hooks/useIsDarkMode';
import CodeSourceEditor from './CodeSourceEditor';
import { frameOfBlock, storedSrcdoc, svgFromSource, svgOfBlock } from './slideBlocks';

/**
 * BlockSourceModal — edit an html or svg block's source with a live preview.
 *
 * html: the preview is a frame in the block's own sandbox; Apply writes the
 * frame's srcdoc once (one change to the slide). svg: the source is held to
 * the svg-block lists on Apply and replaces the block's `<svg>`.
 *
 * While open, the block carries `editing-code`, so a live deck holds remote
 * changes to its slide until the modal closes (DeckBridge.busyIn); the
 * bridge applies them on its next tick.
 */

export type SourceBlockKind = 'html' | 'svg';

export function sourceBlockKind(block: HTMLElement | null): SourceBlockKind | null {
  const type = block?.dataset.blockType;
  return type === 'html' || type === 'svg' ? type : null;
}

/** The source the editor opens with. */
function initialSource(block: HTMLElement, kind: SourceBlockKind): string {
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

interface BlockSourceModalProps {
  block: HTMLElement | null;
  onClose: () => void;
  onApplied?: () => void;
}

export default function BlockSourceModal({ block, onClose, onApplied }: BlockSourceModalProps) {
  const isDark = useIsDarkMode();
  const kind = sourceBlockKind(block);
  const open = block !== null && kind !== null;

  return (
    <ConfigProvider theme={{ algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
      <Modal
        open={open}
        onCancel={onClose}
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
            dark={isDark}
            onClose={onClose}
            onApplied={onApplied}
          />
        )}
      </Modal>
    </ConfigProvider>
  );
}

function SourceEditorBody({
  block,
  kind,
  dark,
  onClose,
  onApplied,
}: {
  block: HTMLElement;
  kind: SourceBlockKind;
  dark: boolean;
  onClose: () => void;
  onApplied?: () => void;
}) {
  const initial = useMemo(() => initialSource(block, kind), [block, kind]);
  const [source, setSource] = useState(initial);
  const [previewSource, setPreviewSource] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const locked = block.closest('section')?.classList.contains('cm-locked') ?? false;

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
      const frame = frameOfBlock(block);
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
      if (current) current.replaceWith(result.svg);
      else content.append(result.svg);
    }
    onApplied?.();
    onClose();
  }, [block, kind, source, onApplied, onClose]);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid h-[65vh] min-h-[320px] grid-cols-1 gap-3 md:grid-cols-2">
        <CodeSourceEditor
          initialValue={initial}
          onChange={value => {
            setSource(value);
            setError(null);
          }}
          dark={dark}
          ariaLabel={kind === 'svg' ? 'SVG source' : 'HTML source'}
        />
        <ScaledPreview box={blockBox(block)} backdrop={backdrop}>
          {previewDoc === null ? (
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
        <div className="min-h-[1.25rem] text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </div>
        <div className="flex gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" onClick={apply} disabled={locked}>
            Apply
          </Button>
        </div>
      </div>
    </div>
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
