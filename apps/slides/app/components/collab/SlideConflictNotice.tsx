import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { SlideConflictNotice as Notice } from '@classmoji/collab';

import { BUILTIN_THEMES } from '~/components/RevealSlides';
import { stripUnsafeMarkup } from '~/utils/collab/bridgeDom';

const REVEAL_CSS = 'https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css';

function themeCss(theme: string): string {
  const name = BUILTIN_THEMES.includes(theme) ? theme : 'white';
  return `https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/${name}.css`;
}

/** A slide's html as a static page (no scripts run: the frame is sandboxed). */
export function staticSlideDocument(html: string, theme: string): string {
  let body = html;
  if (typeof document !== 'undefined') {
    const template = document.createElement('template');
    template.innerHTML = html;
    stripUnsafeMarkup(template.content);
    const holder = document.createElement('div');
    holder.appendChild(template.content);
    body = holder.innerHTML;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${REVEAL_CSS}"><link rel="stylesheet" href="${themeCss(theme)}">
<style>html,body{margin:0;height:100%;overflow:hidden}
.reveal .slides{position:absolute;left:50%;top:50%;width:960px;height:700px;
transform:translate(-50%,-50%) scale(var(--s,0.55));transform-origin:center}
.reveal .slides section{display:block!important;position:absolute;inset:0;padding:20px;box-sizing:border-box}</style>
</head><body><div class="reveal"><div class="slides"><section>${body}</section></div></div></body></html>`;
}

/**
 * For the person who was editing a slide when an outside push changed it too:
 * their version was kept; they can look at GitHub's (rendered, read-only) or
 * dismiss the notice. Non-blocking.
 */
export default function SlideConflictNotice({
  notice,
  theme,
  onDismiss,
}: {
  notice: Notice;
  theme: string;
  onDismiss: () => void;
}) {
  const [viewing, setViewing] = useState(false);
  return (
    <>
      <div
        role="status"
        aria-live="polite"
        data-testid="slide-conflict-notice"
        className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 flex-wrap items-center gap-3 rounded-lg bg-white/95 px-3 py-2 text-sm shadow-md ring-1 ring-amber-300 dark:bg-gray-800/95 dark:ring-amber-600"
      >
        <span className="text-amber-900 dark:text-amber-100">
          This slide was also changed on GitHub; your version was kept.
        </span>
        <button
          type="button"
          onClick={() => setViewing(true)}
          className="font-medium text-amber-800 underline hover:text-amber-950 dark:text-amber-200 dark:hover:text-amber-50"
        >
          View GitHub version
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white"
        >
          Dismiss
        </button>
      </div>
      {viewing && (
        <GitHubVersionModal notice={notice} theme={theme} onClose={() => setViewing(false)} />
      )}
    </>
  );
}

function GitHubVersionModal({
  notice,
  theme,
  onClose,
}: {
  notice: Notice;
  theme: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const srcDoc = useMemo(() => staticSlideDocument(notice.html, theme), [notice.html, theme]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        // One control: Tab stays on it, Escape closes.
        event.preventDefault();
        if (event.key === 'Escape') onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 dark:bg-black/60">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-[calc(100%-2rem)] max-w-3xl rounded-xl bg-white p-4 shadow-xl ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id={titleId} className="font-semibold text-gray-900 dark:text-gray-100">
            This slide on GitHub
            <span className="ml-2 font-mono text-xs font-normal text-gray-500 dark:text-gray-400">
              {notice.sha.slice(0, 7)}
            </span>
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
          >
            Close
          </button>
        </div>
        <iframe
          title="The slide as pushed to GitHub"
          sandbox=""
          srcDoc={srcDoc}
          className="aspect-[960/700] w-full rounded-md ring-1 ring-gray-200 dark:ring-gray-700"
        />
      </div>
    </div>
  );
}
