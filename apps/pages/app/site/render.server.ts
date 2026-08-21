import { ServerBlockNoteEditor } from '@blocknote/server-util';
// @ts-expect-error -- jsdom ships no type declarations and `@types/jsdom` is
// not a dependency of this workspace. The cast below pins the shape this
// module actually uses, so everything downstream of it is fully typed.
import { JSDOM as UntypedJSDOM } from 'jsdom';

import { redactDocumentForViewer } from './redact.server.ts';
import { createViewerSchema, type PageLinkResolver } from './viewerSchema.server.ts';

/** The only part of jsdom's surface this module touches. */
type DomFactory = new (html?: string) => { window: { document: Document } };
const JSDOM = UntypedJSDOM as DomFactory;

/**
 * Server-side rendering of a page's BlockNote document to static HTML.
 *
 * ## Why the mutex
 *
 * `ServerBlockNoteEditor` serializes by swapping `globalThis.window` and
 * `globalThis.document` for a JSDOM pair, running the render, and swapping
 * them back. Those are PROCESS globals. Two requests serializing at the same
 * time therefore interleave on shared mutable state: the second render's
 * setup clobbers the first's globals, and the first's teardown restores
 * whatever was there before the second started. The observable failure is not
 * a clean error — it is one visitor's page acquiring fragments of another's,
 * on a multi-tenant public host. So every render on this process goes through
 * a one-at-a-time queue.
 *
 * The cost is real but small (renders are single-digit milliseconds and the
 * expensive part of a site request is the GitHub read, which happens outside
 * the lock). `tests/unit/site-render.spec.ts` fires 20 concurrent renders of
 * distinguishable documents and asserts no cross-contamination.
 */

/** Tail of the render queue. Every render chains onto it. */
let renderQueue: Promise<unknown> = Promise.resolve();

/**
 * Run `work` with exclusive use of the process's JSDOM globals.
 *
 * Exported because rendering is not the only thing that swaps them: the
 * legacy-HTML migration (`migrateHtmlToBlockNote`) builds its own
 * `ServerBlockNoteEditor`, and a migration running concurrently with a render
 * corrupts both. Anything that touches `ServerBlockNoteEditor` on this process
 * must go through here.
 */
export function withServerBlockNoteLock<T>(work: () => Promise<T>): Promise<T> {
  // Chain onto the tail, swallowing the predecessor's rejection so one failed
  // render does not poison every render that follows it.
  const result = renderQueue.then(work, work);
  renderQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/* ------------------------------------------------------------------ *
 * JSDOM storage shim
 * ------------------------------------------------------------------ */

/** Marker so the shim is installed at most once per JSDOM window. */
const STORAGE_SHIM_FLAG = '__classmojiSiteStorageShim';

/**
 * Give the server's JSDOM window a working `localStorage`.
 *
 * BlockNote's toggle wrapper (`@blocknote/core/blocks/ToggleWrapper`) reads
 * `window.localStorage` during render, to remember whether a toggle is open.
 * `ServerBlockNoteEditor` builds its JSDOM with no URL, which makes the
 * document's origin *opaque*, and an opaque origin's `localStorage` getter
 * throws `SecurityError` instead of returning a store.
 *
 * That throw is not survivable the way a React component's throw is. It comes
 * out of a ProseMirror node view rather than a React render, so BlockNote's
 * per-block error handling never sees it: it aborts the ENTIRE document
 * serialization, and — verified against the dev server — the half-finished
 * React work it leaves behind surfaces later as an uncaught exception from
 * react-dom's scheduler, which takes the whole process down. One page
 * containing one toggle would have been an outage.
 *
 * `toggleListItem` is overridden in the viewer schema anyway, but toggles are
 * not only a block type: `heading` carries an `isToggleable` prop and goes
 * through the same wrapper. Shimming the storage fixes every route into it at
 * once, rather than re-implementing heading rendering to dodge one attribute.
 */
function installStorageShim(): void {
  const win = globalThis.window as unknown as Record<string, unknown> | undefined;
  if (!win || win[STORAGE_SHIM_FLAG]) return;

  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string): string | null => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string): void => {
      store.set(String(key), String(value));
    },
    removeItem: (key: string): void => {
      store.delete(String(key));
    },
    clear: (): void => store.clear(),
    key: (index: number): string | null => [...store.keys()][index] ?? null,
    get length(): number {
      return store.size;
    },
  };

  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      Object.defineProperty(win, name, { value: storage, configurable: true, writable: true });
    } catch {
      // A future JSDOM that makes these non-configurable would land here; the
      // render below still runs, and a toggle block is what breaks, not this.
    }
  }
  win[STORAGE_SHIM_FLAG] = true;
}

/**
 * Let React finish whatever it deferred, while the DOM globals still exist.
 *
 * BlockNote serializes React blocks with `flushSync`, but React does not
 * necessarily finish inside it: some of BlockNote's own components (the toggle
 * wrapper, for one) leave passive work queued on react-dom's scheduler, which
 * runs it on a later macrotask. `ServerBlockNoteEditor._withJSDOM` restores
 * `globalThis.window` to `undefined` the moment serialization returns — so
 * that queued callback wakes up in a world with no `window`, reads
 * `window.event`, and throws.
 *
 * It throws from a timer callback, which means it is an UNCAUGHT EXCEPTION:
 * not a failed render, a dead Node process. That was reproduced against both
 * the dev server and the test runner, and it is why this three-tick drain
 * (macrotask, timer, macrotask) runs inside the JSDOM scope rather than the
 * render simply returning.
 */
async function drainReactWork(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setImmediate(resolve));
}

/** Thrown when the document could not be turned into HTML at all. */
export class SiteRenderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SiteRenderError';
  }
}

export type RenderSitePageOptions = {
  /** The page's BlockNote document. */
  blocks: unknown;
  /** Per-viewer page-id → link resolution (see PageLinkResolver). */
  resolveLink: PageLinkResolver;
};

/** BlockNote's own wrappers, in the order the client viewer nests them. */
export type RenderedPage = {
  html: string;
  /** Headings found in the document, for a future in-page table of contents. */
  headings: Array<{ id: string; level: number; text: string }>;
};

const EMPTY_DOCUMENT = [{ type: 'paragraph', content: [] }];

/**
 * Turn a BlockNote document into the inner HTML of a class-site article.
 *
 * The caller wraps the result in `siteArticleWrapper` — kept separate so the
 * wrapper markup is testable without running a render, and so the renderer has
 * exactly one job.
 */
export async function renderSitePage({
  blocks,
  resolveLink,
}: RenderSitePageOptions): Promise<RenderedPage> {
  // Redact BEFORE serializing: BlockNote writes block props onto the wrapper
  // as data-* attributes, so a hidden page's title would ship in the HTML even
  // though its block renders as nothing. See redact.server.ts.
  const redacted = redactDocumentForViewer(blocks, resolveLink);
  const document = redacted.length > 0 ? redacted : EMPTY_DOCUMENT;

  let html: string;
  try {
    html = await withServerBlockNoteLock(async () => {
      // The schema is per-render because its link resolution is per-viewer.
      const editor = ServerBlockNoteEditor.create({ schema: createViewerSchema(resolveLink) });

      // `editor.isEditable` is `true` inside ServerBlockNoteEditor and setting
      // it false is NOT a safety net (verified) — the static viewer schema is
      // what actually keeps editor affordances out of the HTML. Setting it
      // anyway costs nothing and makes the intent explicit to any default
      // block that consults it.
      try {
        (editor as unknown as { editor?: { isEditable?: boolean } }).editor!.isEditable = false;
      } catch {
        // Not all versions expose the inner editor before first use.
      }

      // The outer `_withJSDOM` is what makes this safe — see drainReactWork.
      // `blocksToFullHTML` opens its own nested one; nesting is harmless
      // (the inner save/restore round-trips the same window).
      return editor._withJSDOM(async () => {
        installStorageShim();
        const serialized = await editor.blocksToFullHTML(document as never);
        await drainReactWork();
        return serialized;
      });
    });
  } catch (error) {
    // A structural failure (malformed document, a block spec that threw all
    // the way out) is a 503, never a blank page cached for a minute.
    throw new SiteRenderError('Failed to render page content', { cause: error });
  }

  const { html: withAnchors, headings } = addHeadingAnchors(html);
  return { html: withAnchors, headings };
}

/* ------------------------------------------------------------------ *
 * Heading anchors
 * ------------------------------------------------------------------ */

/** Slugify heading text into a stable, URL-safe fragment id. */
export function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/&[a-z]+;/g, ' ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'section'
  );
}

/**
 * One reused JSDOM window, built on first use.
 *
 * Reused so `addHeadingAnchors` stays SYNCHRONOUS and cheap (constructing a
 * JSDOM is the expensive part; a fresh `<div>` off an existing window is not).
 * A brand-new host element per call is what keeps two documents from seeing
 * each other's nodes — the window itself holds no state we write to. This
 * window is entirely separate from the pair `ServerBlockNoteEditor` swaps into
 * `globalThis`, and is never installed as a global, so it cannot participate in
 * the interleaving hazard `withServerBlockNoteLock` exists to prevent.
 */
let anchorWindow: { document: Document } | null = null;

function anchorHost(): HTMLElement {
  if (!anchorWindow) anchorWindow = new JSDOM('').window;
  return anchorWindow.document.createElement('div');
}

/**
 * Give every h1-h3 an `id` so `#fragment` links work.
 *
 * A post-pass rather than a schema override: BlockNote's heading render is fine
 * as-is, and re-implementing it to add one attribute would mean owning its
 * inline-content plumbing forever. Duplicate slugs get a numeric suffix so two
 * "Grading" headings do not collide.
 *
 * ## Why this parses instead of running a regex
 *
 * This used to be `html.replace(/<h([1-3])([^>]*)>...)` splicing `id="slug"`
 * back into the match. BlockNote's serializer writes EVERY block prop onto the
 * block wrapper as a `data-*` attribute, and block props are author-controlled
 * — a terminal block whose `code` is `<h1 a>b</h1>` puts that text inside
 * `data-code="..."`, where the regex happily matched it and spliced in two
 * unescaped quote characters. Those quotes close the attribute, and everything
 * after them becomes live markup: stored XSS, authored through a perfectly
 * ordinary block field.
 *
 * Parsing, mutating and re-serializing cannot have that bug in principle. The
 * HTML serializer escapes attribute values on the way out, so nothing written
 * through `setAttribute` can break out of the attribute it lands in, whatever
 * the slug contains.
 */
export function addHeadingAnchors(html: string): {
  html: string;
  headings: Array<{ id: string; level: number; text: string }>;
} {
  const headings: Array<{ id: string; level: number; text: string }> = [];
  const used = new Map<string, number>();

  const host = anchorHost();
  host.innerHTML = html;

  for (const heading of host.querySelectorAll('h1, h2, h3')) {
    // Never overwrite an id BlockNote (or an author) already set.
    if (heading.hasAttribute('id')) continue;

    const text = (heading.textContent ?? '').trim();
    if (!text) continue;

    const base = slugifyHeading(text);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const id = seen === 0 ? base : `${base}-${seen + 1}`;

    heading.setAttribute('id', id);
    headings.push({ id, level: Number(heading.tagName[1]), text });
  }

  return { html: host.innerHTML, headings };
}

/* ------------------------------------------------------------------ *
 * Wrapper markup
 * ------------------------------------------------------------------ */

/**
 * The exact wrapper chain BlockNote's own styles expect.
 *
 * `bn-root` / `bn-container` / `bn-mantine` on the outside and
 * `ProseMirror bn-editor bn-default-styles` on the inside is the official
 * recipe for rendering serialized BlockNote HTML with the editor's stylesheet,
 * and it is the reason this feature ships ZERO custom block CSS: every block's
 * appearance comes from `@blocknote/mantine/style.css` plus the app's existing
 * overrides, which is also what makes the site look identical to the editor.
 *
 * The colour scheme is fixed to `light` server-side. BlockNote's theme is an
 * attribute, not a media query, and the document's dark-mode script toggles a
 * `dark` class on `<html>` — so the dark variant is applied by CSS in
 * `site.css` (which mirrors the attribute under `.dark`) rather than by
 * guessing the visitor's preference in the loader. A theme cookie would be the
 * only way to get the attribute right server-side, and that is a bigger
 * decision than a stylesheet rule.
 */
export function siteArticleWrapper(html: string): string {
  return (
    '<div class="bn-root bn-container bn-mantine" data-color-scheme="light" ' +
    'data-mantine-color-scheme="light">' +
    '<div class="ProseMirror bn-editor bn-default-styles">' +
    html +
    '</div></div>'
  );
}
