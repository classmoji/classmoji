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
