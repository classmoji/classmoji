/**
 * The one cleanup that turns editor DOM into saveable deck HTML.
 *
 * Run by the editor's getCurrentContent (RevealSlides) on its clone of the
 * live slides, and by the diff-at-save snapshot (deckOpsDiff) on BOTH diff
 * sides — so the posted document and the baseline it is compared against are
 * cleaned by construction the same way, and a merely-viewed slide never reads
 * as edited.
 *
 * Pure DOM, no React — runs in Node-side unit tests too. Idempotent.
 */

import { cleanSandpackBlocks } from './sandpackBlocks.ts';

export function cleanupEditorContainer(container: Element): void {
  // Runtime contenteditable never persists (the editor sets it on blocks, and
  // `false` on a Sandpack embed while its code is being edited).
  container.querySelectorAll('[contenteditable]').forEach(el => {
    el.removeAttribute('contenteditable');
  });

  // Code blocks: flatten to escaped plain text, drop hljs (idempotent — the
  // same normalization the editor applies on load and save, and the server
  // applies in normalizeSlideHtml). textContent decodes `<`, so it is
  // re-escaped before going back in as HTML.
  container.querySelectorAll('pre code').forEach(codeEl => {
    const plainText = codeEl.textContent || '';
    const escaped = plainText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    codeEl.innerHTML = escaped;
    codeEl.classList.remove('hljs');
    if ((codeEl.getAttribute('class') ?? '') === '') codeEl.removeAttribute('class');
  });

  // Sandpack embeds: strip the live editor's additions (React mount, typed
  // text), keep the stored embed, its attributes and its files payload.
  cleanSandpackBlocks(container);

  // Reveal runtime position classes.
  container.querySelectorAll('.present, .past, .future').forEach(el => {
    el.classList.remove('present', 'past', 'future');
    if ((el.getAttribute('class') ?? '') === '') el.removeAttribute('class');
  });

  // Reveal fragment runtime paint (`visible` / `current-fragment`) is added as
  // the presenter steps through fragments — never authored, must never persist,
  // or a merely-VIEWED slide reads as edited. `fragment` itself stays.
  container.querySelectorAll('.fragment').forEach(el => {
    el.classList.remove('visible', 'current-fragment');
  });
}

/**
 * Undo Reveal's lazy loading inside an editor container. Navigating to a slide
 * turns `data-src` into `src` (+ `data-lazy-loaded`) on its media and iframes,
 * and leaving it can move `src` back; a started iframe carries both. None of
 * that is authored, so reading the slide back must give the stored
 * `data-src` again — otherwise merely viewing a slide reads as an edit.
 *
 * Used by the live editor's per-slide serialization. Idempotent.
 */
export function undoRevealLazyLoad(container: Element): void {
  container.querySelectorAll('[data-lazy-loaded]').forEach(el => {
    const src = el.getAttribute('src');
    if (src != null && !el.hasAttribute('data-src')) el.setAttribute('data-src', src);
    el.removeAttribute('src');
    el.removeAttribute('data-lazy-loaded');
  });
  // An iframe Reveal started without the lazy-load marker: src mirrors data-src.
  container.querySelectorAll('iframe[data-src][src]').forEach(el => {
    if (el.getAttribute('src') === el.getAttribute('data-src')) el.removeAttribute('src');
  });
  // Reveal re-adds `data-src` at the end of the attribute list, so the order
  // of a lazy element's attributes depends on whether it was ever shown. Fix
  // one order (by name) for every element that lazy-loads.
  container.querySelectorAll('[data-src]').forEach(el => {
    const attrs = Array.from(el.attributes).map(a => [a.name, a.value] as const);
    const sorted = [...attrs].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    if (sorted.every((a, i) => a[0] === attrs[i][0])) return;
    for (const [name] of attrs) el.removeAttribute(name);
    for (const [name, value] of sorted) el.setAttribute(name, value);
  });
}
