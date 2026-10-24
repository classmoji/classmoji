/**
 * safeMarkup/server.ts — the server engine: slide markup parsed by cheerio in
 * parse5 mode (the browser's parsing algorithm, scripting on, as a browser
 * parses `innerHTML`), held to the lists (walk.ts), serialized with parse5.
 * Remove mode only (rename mode is the editor's, client.ts).
 *
 * What comes back is always the serialized tree, never the input: a browser
 * whose parser builds something parse5 does not (a newer `<select>` content
 * model, say) only ever sees markup made from what was checked. The output is
 * parsed and held to the lists again; markup that comes back different (a
 * serialization the parser reads another way) is run until it holds still,
 * and reported.
 */

import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode, Element, ParentNode } from 'domhandler';

import { walkMarkup, type MarkupAdapter, type NodeKind } from './walk.ts';

type AttrMap = Record<string, string | undefined>;
type NsElement = Element & {
  'x-attribsNamespace'?: AttrMap;
  'x-attribsPrefix'?: AttrMap;
};

function makeAdapter($: CheerioAPI): MarkupAdapter<AnyNode, Element> {
  return {
    childNodes: parent => [...((parent as ParentNode).children ?? [])],
    kind(node): NodeKind {
      switch (node.type) {
        case 'tag':
        case 'script':
        case 'style':
          return 'element';
        case 'text':
          return 'text';
        case 'comment':
          return 'comment';
        default:
          return 'other';
      }
    },
    localName: el => el.name,
    namespace: el => el.namespace ?? null,
    attrs(el) {
      const prefixes = (el as NsElement)['x-attribsPrefix'] ?? {};
      return Object.entries(el.attribs).map(([key, value]) => {
        const prefix = prefixes[key];
        return [prefix ? `${prefix}:${key}` : key, value] as [string, string];
      });
    },
    setAttrs(el, next) {
      const nsEl = el as NsElement;
      const oldNs = nsEl['x-attribsNamespace'] ?? {};
      const oldPrefix = nsEl['x-attribsPrefix'] ?? {};
      const keyOf = new Map<string, string>();
      for (const key of Object.keys(el.attribs)) {
        keyOf.set(oldPrefix[key] ? `${oldPrefix[key]}:${key}` : key, key);
      }
      const attribs: Record<string, string> = Object.create(null);
      const ns: Record<string, string> = Object.create(null);
      const prefix: Record<string, string> = Object.create(null);
      for (const [name, value] of next) {
        const key = keyOf.get(name) ?? name;
        attribs[key] = value;
        const known = keyOf.has(name);
        if (known && oldNs[key] !== undefined) ns[key] = oldNs[key] as string;
        if (known && oldPrefix[key] !== undefined) prefix[key] = oldPrefix[key] as string;
      }
      el.attribs = attribs;
      if (nsEl['x-attribsNamespace']) nsEl['x-attribsNamespace'] = ns;
      if (nsEl['x-attribsPrefix']) nsEl['x-attribsPrefix'] = prefix;
    },
    remove: node => {
      $(node).remove();
    },
    unwrap: el => {
      $(el).replaceWith($(el).contents());
    },
    hide() {
      throw new Error('rename mode is client-only');
    },
    retag() {
      throw new Error('rename mode is client-only');
    },
  };
}

/** One pass over a fragment: the clean markup, serialized, and how many changes it took. */
function passFragment(html: string): { html: string; changes: number } {
  const $ = cheerio.load(html, null, false);
  const changes = walkMarkup(makeAdapter($), $.root()[0], { mode: 'remove' });
  return { html: $.root().html() ?? '', changes };
}

export interface ServerSanitizeResult {
  html: string;
  /** Changes made by the first pass (0: nothing in the input had to go). */
  changes: number;
  /** The first output did not survive a second parse unchanged (and was run again until it did). */
  unstable: boolean;
}

const MAX_PASSES = 4;

function untilStable(
  html: string,
  pass: (html: string) => { html: string; changes: number }
): ServerSanitizeResult {
  let current = pass(html);
  const changes = current.changes;
  let unstable = false;
  // The output is returned only once its own parse has been held to the lists
  // and found clean.
  for (let i = 1; i < MAX_PASSES; i++) {
    const again = pass(current.html);
    if (again.changes === 0) break;
    unstable = true;
    current = again;
  }
  return { html: current.html, changes, unstable };
}

/** {@link sanitizeServer} with what it did. */
export function sanitizeServerResult(html: string): ServerSanitizeResult {
  // Text alone cannot make an element.
  if (!html.includes('<')) return { html, changes: 0, unstable: false };
  return untilStable(html, passFragment);
}

function reportUnstable(where: string): void {
  console.warn(`[safeMarkup] ${where}: output changed on a second pass; returned the settled form`);
}

/**
 * Slide markup (a fragment: slide html, `.slides` content, notes) held to the
 * lists, remove mode, as parse5 serializes it.
 */
export function sanitizeServer(html: string, _opts?: { mode: 'remove' }): string {
  const result = sanitizeServerResult(html);
  if (result.unstable) reportUnstable('fragment');
  return result.html;
}

/** Rendered speaker notes (after `marked`): the same lists, remove mode. */
export function sanitizeNotesHtmlServer(markedOutput: string): string {
  return sanitizeServer(markedOutput);
}

const DOCUMENT_RE = /<(?:!doctype|html|head|body)[\s>]/i;

/** One pass over a whole deck document: only `.slides` is slide markup. */
function passDocument(html: string): { html: string; changes: number } {
  const $ = cheerio.load(html);
  // No slide container: everything in the body is someone's markup.
  const slides = $('.reveal .slides').first();
  const root = slides.length > 0 ? slides[0] : $('body')[0];
  if (!root) return { html, changes: 0 };
  const changes = walkMarkup(makeAdapter($), root, { mode: 'remove' });
  return { html: $.html(), changes };
}

/**
 * A whole deck document (index.html shape) with its slides held to the lists:
 * everything inside `.reveal .slides`; the head and the document's own
 * scripts are the generator's and are left as they are (the whole document
 * comes back serialized by parse5; script text is unchanged). A fragment is
 * treated as slide markup ({@link sanitizeServer}).
 */
export function sanitizeDeckDocumentServer(html: string): string {
  if (!DOCUMENT_RE.test(html)) return sanitizeServer(html);
  const result = untilStable(html, passDocument);
  if (result.unstable) reportUnstable('document');
  return result.html;
}
