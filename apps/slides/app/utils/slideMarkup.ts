/**
 * slideMarkup.ts — deck markup on its way into the deck viewer/editor
 * (RevealSlides) and back out to a save.
 *
 * In: parsed into a template of the live document, held to the slide markup
 * lists, and inserted as nodes (`replaceChildren`) — what is checked is what
 * is inserted, never serialised and parsed again. Readers get remove mode;
 * the editor gets rename mode (nothing authored is lost) and its frames shown
 * through the editor frame route.
 *
 * Out: a copy of the editor's slides through the one write cleanup
 * (`toStoredMarkup`).
 *
 * Pure DOM, no React: the unit suite runs it under jsdom.
 */
import { sanitizeClient } from '@classmoji/services/slides/safe-markup';
import {
  neutralizeHtmlBlockFrames,
  sanitizeSvgBlocks,
} from '@classmoji/services/slides/runtime-attrs';

import {
  restoreInertMarkup,
  stripUnsafeMarkup,
  toStoredMarkup,
  type EditorDisplay,
} from './collab/bridgeDom.ts';
import { FRAME_MISSING_ATTR, showFrames, type EditorFrames } from './editorFrames.ts';
import { mountLegacyHtmlBlocks, restoreLegacyHtmlBlocks } from './legacyHtmlBlocks.ts';

/**
 * The deck's slides as the editor shows them: held to the slide markup lists
 * in rename mode (nothing authored is lost), frames shown the editor's way,
 * legacy html blocks through the preview frame. A fragment of the live
 * document, inserted as is.
 */
export function editorSlidesFragment(
  html: string,
  doc: Document,
  display: EditorDisplay
): DocumentFragment {
  const template = doc.createElement('template');
  template.innerHTML = html;
  stripUnsafeMarkup(template.content, display);
  return template.content;
}

/**
 * The deck's slides as a reader sees them: held to the slide markup lists
 * (remove mode), html-block frames and svg blocks to their own rules, frames
 * of ours shown through the editor frame route when this reader edits the
 * deck, legacy html blocks through the preview frame.
 */
export function viewerSlidesFragment(
  html: string,
  doc: Document,
  display: EditorDisplay
): DocumentFragment {
  const fragment = sanitizeClient(html, { mode: 'remove', doc });
  neutralizeHtmlBlockFrames(fragment);
  sanitizeSvgBlocks(fragment);
  showFrames(fragment, display.frames ?? null);
  mountLegacyHtmlBlocks(fragment, display.contentOrigin ?? display.frames?.contentOrigin ?? null);
  return fragment;
}

/**
 * The editor's slides (a copy) as the save stores them: the `<section>`s of
 * `slidesDiv` through the one write cleanup (`toStoredMarkup`). Root sections
 * only — nested wrapper divs left by an old bug are dropped.
 */
export function storedSectionsHtml(slidesDiv: Element, frames: EditorFrames | null): string {
  const slidesClone = slidesDiv.cloneNode(true) as HTMLElement;
  toStoredMarkup(slidesClone, frames, { lazyLoad: false });
  const rootSections = Array.from(slidesClone.querySelectorAll('section')).filter(
    (section: Element) => !section.parentElement?.closest('section')
  );
  return rootSections.map((s: Element) => s.outerHTML).join('\n');
}

/**
 * What a copy or cut of the editor's slides puts on the clipboard (`contents`:
 * the selection, cloned): its authored form — what this page renamed or held
 * back for display restored, legacy html blocks' code back in `srcdoc`, the
 * placeholder mark dropped — so no other page or peer ever receives this
 * page's session marker. Frames keep the editor's URLs: those carry the repo
 * path, so a paste into another deck still names the same file
 * (`adoptPastedHtmlBlocks`). Parsed in a template: nothing in it loads.
 */
export function clipboardHtml(contents: DocumentFragment, doc: Document): string {
  const template = doc.createElement('template');
  template.content.append(contents);
  restoreLegacyHtmlBlocks(template.content);
  restoreInertMarkup(template.content);
  for (const frame of Array.from(template.content.querySelectorAll(`[${FRAME_MISSING_ATTR}]`))) {
    frame.removeAttribute(FRAME_MISSING_ATTR);
  }
  return template.innerHTML;
}
