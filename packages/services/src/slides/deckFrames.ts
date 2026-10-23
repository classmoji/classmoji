import * as cheerio from 'cheerio';

import {
  HTML_BLOCK_SANDBOX,
  HTML_BLOCK_SRC_ATTR,
  INERT_ATTR_PREFIX,
  isHtmlBlockFileSrc,
} from './deckBlocks.ts';
import type { DeckJson, DeckSlide } from './deckTypes.ts';
import {
  classifyFrameRef,
  parseEditorFrameUrl,
  relativeToDeck,
  type FrameRefOptions,
  type RepoFrameTarget,
} from './frameRefs.ts';

/**
 * The frames of a deck: read-time signing and the save-time backstop.
 *
 * READ (`rewriteDeckFrames`): every frame source that names a file in the
 * classroom's content repo is pointed at a signed files URL on the content
 * service, and the frame gets the box sandbox (the service's own response
 * header enforces it either way). External frames are left as written; the
 * rest are made inert (`data-cm-inert-<attr>`) and marked `data-cm-missing`
 * so the surfaces can show a placeholder.
 *
 * SAVE (`canonicalizeDeckFrames`): a files URL of this classroom or an editor
 * frame URL of any deck (`/<slideId>/frame/…`, on one of the app's hosts when
 * absolute) that reached a deck is turned back into the stored reference,
 * relative to THIS deck, and nothing derived for display survives (the
 * `data-cm-orig-*` copies, the `data-cm-missing` mark).
 */

/** Marks a frame whose source could not be shown (inert, or no signature). */
export const FRAME_MISSING_ATTR = 'data-cm-missing';
/** Display-only copies of a stored attribute; never stored. */
const ORIG_ATTR_PREFIX = 'data-cm-orig-';

const BG_IFRAME = 'data-background-iframe';
const FRAME_SELECTOR = `iframe[src], iframe[data-src], iframe[${HTML_BLOCK_SRC_ATTR}], [${BG_IFRAME}]`;
const DOCUMENT_RE = /<(?:!doctype|html|head|body)[\s>]/i;

type FrameElement = { name?: string; attribs: Record<string, string> };

/** One attribute of one element to judge, and where its signed URL goes. */
interface FrameJob {
  el: FrameElement;
  attr: string;
  write: string;
  value: string;
  /** An html block's frame: it loads from `data-src` only. */
  block: boolean;
}

function frameJobs(el: FrameElement): FrameJob[] {
  const jobs: FrameJob[] = [];
  const { attribs } = el;
  if (el.name === 'iframe') {
    const blockSrc = attribs[HTML_BLOCK_SRC_ATTR];
    if (blockSrc !== undefined) {
      // Reveal copies `data-src` to `src` when the slide comes near, so an html
      // block loads with its slide rather than with the deck.
      jobs.push({ el, attr: HTML_BLOCK_SRC_ATTR, write: 'data-src', value: blockSrc, block: true });
    } else {
      for (const attr of ['src', 'data-src']) {
        const value = attribs[attr];
        if (value !== undefined) jobs.push({ el, attr, write: attr, value, block: false });
      }
    }
  }
  const background = attribs[BG_IFRAME];
  if (background !== undefined) {
    jobs.push({ el, attr: BG_IFRAME, write: BG_IFRAME, value: background, block: false });
  }
  return jobs;
}

export interface RewriteDeckFramesOptions {
  /** The frame rule's inputs for this deck (`frameRefOptions`). */
  refs: FrameRefOptions;
  /** A repo target → its signed URL, or null when it cannot be framed. */
  sign: (repoPath: string, query: string) => Promise<string | null>;
}

/** Rename `attr` so it does nothing, keep its value, and mark the frame. */
function makeInert(el: FrameElement, attr: string, value: string): void {
  delete el.attribs[attr];
  el.attribs[`${INERT_ATTR_PREFIX}${attr}`] = value;
  el.attribs[FRAME_MISSING_ATTR] = '1';
}

/**
 * Point every frame of ours in a deck document (or fragment) at its signed
 * URL; see the module comment. Returns the input string when nothing changed.
 *
 * Runs on markup that has already been cleaned (`sanitizeDeckDocumentServer`):
 * what it writes — signed https URLs and the box sandbox — is its own.
 */
export async function rewriteDeckFrames(
  html: string,
  opts: RewriteDeckFramesOptions
): Promise<string> {
  if (!html || !/<iframe|data-background-iframe/i.test(html)) return html;
  const $ = DOCUMENT_RE.test(html) ? cheerio.load(html) : cheerio.load(html, null, false);
  const jobs = $(FRAME_SELECTOR)
    .toArray()
    .flatMap(el => frameJobs(el as unknown as FrameElement));
  if (jobs.length === 0) return html;

  const signed = new Map<string, Promise<string | null>>();
  const signOnce = (repoPath: string, query: string): Promise<string | null> => {
    const key = `${repoPath}\n${query}`;
    let pending = signed.get(key);
    if (!pending) {
      pending = opts.sign(repoPath, query).catch(() => null);
      signed.set(key, pending);
    }
    return pending;
  };

  const outcomes = await Promise.all(
    jobs.map(async job => {
      const ref = classifyFrameRef(job.value, opts.refs);
      // An html block's file is in the repo; a block naming anything else shows nothing.
      if (ref.kind === 'inert' || (ref.kind === 'external' && job.block)) {
        return { job, kind: 'inert' as const };
      }
      if (ref.kind === 'external') return { job, kind: 'external' as const };
      const url = await signOnce(ref.repoPath, ref.query);
      return url ? { job, kind: 'signed' as const, url } : { job, kind: 'inert' as const };
    })
  );

  let changed = false;
  for (const outcome of outcomes) {
    const { job } = outcome;
    if (outcome.kind === 'external') continue;
    changed = true;
    if (job.block) {
      // An html block's frame is its file: nothing else may load in it.
      delete job.el.attribs['src'];
      delete job.el.attribs['srcdoc'];
      delete job.el.attribs['data-src'];
    }
    if (outcome.kind === 'inert') {
      makeInert(job.el, job.attr, job.value);
      continue;
    }
    job.el.attribs[job.write] = outcome.url;
    if (job.el.name === 'iframe') job.el.attribs['sandbox'] = HTML_BLOCK_SANDBOX;
  }

  if (!changed) return html;
  return $.root().html() ?? html;
}

// ─── Save backstop ───────────────────────────────────────────────────────────

export interface CanonicalizeFramesOptions {
  /** The deck folder (`slides/<seg>`), which stored references are relative to. */
  deckFolder: string;
  /** @deprecated Ignored: editor frame URLs of any deck are turned back (see `parseEditorFrameUrl`). */
  slideId?: string | null;
  /** A files URL of this classroom → its target; null otherwise (`parseOwnFilesUrl`). */
  filesRef: (url: string) => RepoFrameTarget | null;
  /**
   * The app's own hosts (`appFrameHosts`): an absolute editor frame URL is
   * turned back only on one of them. Absent: root-relative ones only.
   */
  ourHosts?: readonly string[] | null;
}

/** A frame URL derived for display → the stored deck-relative reference, or null. */
function storedFrameRef(value: string, opts: CanonicalizeFramesOptions): string | null {
  const target =
    opts.filesRef(value.trim()) ?? parseEditorFrameUrl(value, { ourHosts: opts.ourHosts });
  return target ? `${relativeToDeck(target.repoPath, opts.deckFolder)}${target.query}` : null;
}

/** Whether the markup could hold anything this pass changes (skips the parse when not). */
function mayHoldDerivedFrames(html: string): boolean {
  return /<iframe|data-background-iframe|data-cm-orig-|data-cm-missing/i.test(html);
}

/**
 * One fragment of slide markup with its derived frame values undone. Sync and
 * pure; the input string comes back when nothing changed.
 */
export function canonicalizeFrameMarkup(html: string, opts: CanonicalizeFramesOptions): string {
  if (!html || !mayHoldDerivedFrames(html)) return html;
  const $ = cheerio.load(html, null, false);
  let changed = false;

  for (const node of $('*').toArray()) {
    const el = node as unknown as FrameElement;
    for (const name of Object.keys(el.attribs)) {
      if (name.startsWith(ORIG_ATTR_PREFIX) || name === FRAME_MISSING_ATTR) {
        delete el.attribs[name];
        changed = true;
      }
    }

    const block = el.name === 'iframe' && el.attribs[HTML_BLOCK_SRC_ATTR] !== undefined;
    if (block && !isHtmlBlockFileSrc(el.attribs[HTML_BLOCK_SRC_ATTR])) {
      // The URL the frame showed names the file it was showing — after a paste
      // from another deck, a file of that deck — so the reference is re-derived
      // from it, relative to this deck. A block naming one of this deck's own
      // `blocks/` files keeps it: that name is the block's, whatever URL the
      // frame carries.
      for (const name of ['src', 'data-src']) {
        const value = el.attribs[name];
        const stored = value ? storedFrameRef(value, opts) : null;
        if (stored === null) continue;
        if (stored !== el.attribs[HTML_BLOCK_SRC_ATTR]) {
          el.attribs[HTML_BLOCK_SRC_ATTR] = stored;
          changed = true;
        }
        break;
      }
    }

    const names = block
      ? [HTML_BLOCK_SRC_ATTR, BG_IFRAME]
      : el.name === 'iframe'
        ? ['src', 'data-src', BG_IFRAME]
        : [BG_IFRAME];
    for (const name of names) {
      const value = el.attribs[name];
      if (!value) continue;
      const stored = storedFrameRef(value, opts);
      if (stored !== null && stored !== value) {
        el.attribs[name] = stored;
        changed = true;
      }
    }

    // An html block's frame stores its file reference and nothing that loads.
    if (block) {
      for (const name of ['src', 'srcdoc', 'data-src']) {
        if (el.attribs[name] !== undefined) {
          delete el.attribs[name];
          changed = true;
        }
      }
    }
  }

  return changed ? ($.root().html() ?? html) : html;
}

/** A section's attribute map with a derived `data-background-iframe` undone; same object when unchanged. */
function canonicalizeFrameAttrs(
  attrs: Record<string, string>,
  opts: CanonicalizeFramesOptions
): Record<string, string> {
  let next: Record<string, string> | null = null;
  for (const name of Object.keys(attrs)) {
    if (name.startsWith(ORIG_ATTR_PREFIX) || name === FRAME_MISSING_ATTR) {
      next ??= { ...attrs };
      delete next[name];
    }
  }
  const background = attrs[BG_IFRAME];
  if (background) {
    const stored = storedFrameRef(background, opts);
    if (stored !== null && stored !== background) {
      next ??= { ...attrs };
      next[BG_IFRAME] = stored;
    }
  }
  return next ?? attrs;
}

/**
 * A deck with every display-derived frame value turned back into its stored
 * form: files URLs of this classroom and editor frame URLs of any deck become
 * references relative to this deck, `data-cm-orig-*` and `data-cm-missing` are
 * dropped, and an html block's frame keeps `data-cm-src` (re-derived from the
 * URL it showed when there is one and `data-cm-src` is not one of this deck's
 * own `blocks/` files) with no `src`/`srcdoc`/`data-src`.
 *
 * Sync and pure (no database): it runs on every save whatever else fails.
 * Slides with nothing to change keep their objects; the deck comes back by
 * identity when nothing changed.
 */
export function canonicalizeDeckFrames(deck: DeckJson, opts: CanonicalizeFramesOptions): DeckJson {
  const rewrite = (slides: DeckSlide[]): DeckSlide[] => {
    let changed = false;
    const next = slides.map(slide => {
      const html =
        slide.html === undefined ? slide.html : canonicalizeFrameMarkup(slide.html, opts);
      const notes =
        slide.notes === undefined ? slide.notes : canonicalizeFrameMarkup(slide.notes, opts);
      const attrs =
        slide.attrs === undefined ? slide.attrs : canonicalizeFrameAttrs(slide.attrs, opts);
      const children = slide.children === undefined ? slide.children : rewrite(slide.children);
      if (
        html === slide.html &&
        notes === slide.notes &&
        attrs === slide.attrs &&
        children === slide.children
      ) {
        return slide;
      }
      changed = true;
      return { ...slide, html, notes, attrs, children } as DeckSlide;
    });
    return changed ? next : slides;
  };

  const slides = rewrite(deck.slides);
  return slides === deck.slides ? deck : { ...deck, slides };
}
