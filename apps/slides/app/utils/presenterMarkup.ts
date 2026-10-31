/**
 * Slide markup and speaker notes as the presenter, follow and speaker views
 * insert them. Markup is parsed by the live document into a template (nothing
 * in it loads or runs), held to the slide-markup lists, and handed back as a
 * fragment for `replaceChildren`: what is checked is what is inserted, and it
 * is never serialised and parsed again on the way in.
 */

import { marked } from 'marked';
import { sanitizeClient, sanitizeNotesHtml } from '@classmoji/services/slides/safe-markup';
import {
  neutralizeHtmlBlockFrames,
  sanitizeSvgBlocks,
} from '@classmoji/services/slides/runtime-attrs';
import { domSlideTree, removeHiddenSlides } from '@classmoji/services/slides/hidden';

/**
 * The deck's slides as a fragment of `doc`: held to the lists, hidden slides
 * removed (#436), html-block frames and svg blocks held to their own rules
 * (deckBlocks.ts). Not yet in the document.
 */
export function deckSlidesFragment(html: string, doc: Document): DocumentFragment {
  const fragment = sanitizeClient(html, { mode: 'remove', doc });
  removeHiddenSlides(fragment, domSlideTree);
  neutralizeHtmlBlockFrames(fragment);
  sanitizeSvgBlocks(fragment);
  return fragment;
}

/** Whether the deck's slides leave at least one slide to show. */
export function hasVisibleSlides(fragment: DocumentFragment): boolean {
  return fragment.querySelector('section') !== null;
}

/**
 * Speaker notes (markdown) rendered into `target`: `marked` first, then the
 * same lists (remove mode), then inserted as nodes.
 */
export function renderSpeakerNotes(target: Element, markdown: string): void {
  const html = marked.parse(markdown, { breaks: true, gfm: true, async: false }) as string;
  target.replaceChildren(sanitizeNotesHtml(html, target.ownerDocument));
}
