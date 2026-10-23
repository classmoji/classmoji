/**
 * Html blocks saved before blocks became repo files keep their code inline in
 * `srcdoc`. Under the page's script policy an inline frame inherits that
 * policy and its scripts don't run, so these blocks are shown through the
 * content service's preview frame instead: the frame loads from the content
 * origin, then receives the block's code by postMessage.
 *
 * The preview frame runs in an opaque origin (its response is sandboxed), so
 * messages to it are posted with target `'*'`; what decides who gets the code
 * is `event.source` — the frame this page itself pointed at the preview.
 *
 * The stored markup is not changed here; editing the block in the editor
 * saves it as a file.
 */

const HTML_BLOCK_FRAME = '.sl-block[data-block-type="html"] iframe[srcdoc]';
const PREVIEW_PATH = '/preview-frame';

/** Marks a frame this module took over, keeping its code for serialisers to restore. */
export const LEGACY_SRCDOC_ATTR = 'data-cm-legacy-srcdoc';

const READY = 'cm-preview-ready';

export function previewFrameUrl(contentOrigin: string): string {
  return `${contentOrigin.replace(/\/+$/, '')}${PREVIEW_PATH}`;
}

function isReady(data: unknown): boolean {
  return Boolean(data && typeof data === 'object' && (data as { type?: unknown }).type === READY);
}

function post(frame: HTMLIFrameElement, html: string): void {
  // Opaque origin: no origin to name. The frame was chosen by `event.source`.
  frame.contentWindow?.postMessage({ type: 'cm-preview', html }, '*');
}

/**
 * Sends `html` to a preview frame each time it reports ready (a frame that is
 * moved in the document reloads and asks again). Returns the unsubscribe.
 */
export function feedPreviewFrame(
  frame: HTMLIFrameElement,
  _contentOrigin: string,
  html: string
): () => void {
  const view = frame.ownerDocument.defaultView ?? window;
  const onMessage = (event: MessageEvent) => {
    if (!frame.contentWindow || event.source !== frame.contentWindow) return;
    if (isReady(event.data)) post(frame, html);
  };
  view.addEventListener('message', onMessage);
  return () => view.removeEventListener('message', onMessage);
}

/**
 * One listener per window for every legacy block: a ready message from a
 * frame carrying {@link LEGACY_SRCDOC_ATTR} is answered with that attribute's
 * code. The frames are found in the document, so a block re-rendered or moved
 * needs nothing re-registered; a mount's cleanup only stops answering its own.
 */
const listening = new WeakSet<Window>();
const unmounted = new WeakSet<HTMLIFrameElement>();
function listenForLegacyFrames(view: Window): void {
  if (listening.has(view)) return;
  listening.add(view);
  view.addEventListener('message', (event: MessageEvent) => {
    if (!event.source || !isReady(event.data)) return;
    for (const frame of Array.from(
      view.document.querySelectorAll<HTMLIFrameElement>(`iframe[${LEGACY_SRCDOC_ATTR}]`)
    )) {
      if (frame.contentWindow !== event.source) continue;
      if (!unmounted.has(frame)) post(frame, frame.getAttribute(LEGACY_SRCDOC_ATTR) ?? '');
      return;
    }
  });
}

/** Rename `from` to `to` on `el` in place (same position, value kept). */
function renameAttr(el: Element, from: string, to: string): void {
  const attrs = Array.from(el.attributes, a => [a.name, a.value] as const);
  for (const [name] of attrs) el.removeAttribute(name);
  for (const [name, value] of attrs) el.setAttribute(name === from ? to : name, value);
}

/**
 * Points every legacy (srcdoc) html-block frame under `root` at the preview
 * frame and feeds it its code. Returns a cleanup function. With no content
 * origin configured (local development without the content service) the
 * frames are left as they are. `root` may be a fragment not yet in the
 * document: the frames are fed once they load.
 */
export function mountLegacyHtmlBlocks(
  root: ParentNode,
  contentOrigin: string | null | undefined,
  view: Window | null = typeof window !== 'undefined' ? window : null
): () => void {
  if (!contentOrigin) return () => {};
  const frames = Array.from(root.querySelectorAll<HTMLIFrameElement>(HTML_BLOCK_FRAME));
  if (frames.length === 0) return () => {};
  if (view) listenForLegacyFrames(view);
  for (const frame of frames) {
    unmounted.delete(frame);
    renameAttr(frame, 'srcdoc', LEGACY_SRCDOC_ATTR);
    frame.setAttribute('src', previewFrameUrl(contentOrigin));
  }
  return () => frames.forEach(frame => unmounted.add(frame));
}

/**
 * Undo of `mountLegacyHtmlBlocks` for serialisers working on a copy of the
 * live DOM: puts the code back in `srcdoc` (where it was) and drops the
 * preview `src`.
 */
export function restoreLegacyHtmlBlocks(root: ParentNode): void {
  const frames = Array.from(
    root.querySelectorAll<HTMLIFrameElement>(`iframe[${LEGACY_SRCDOC_ATTR}]`)
  );
  if ((root as Element).matches?.(`iframe[${LEGACY_SRCDOC_ATTR}]`))
    frames.unshift(root as HTMLIFrameElement);
  for (const frame of frames) {
    frame.removeAttribute('src');
    if (frame.hasAttribute('srcdoc')) frame.removeAttribute(LEGACY_SRCDOC_ATTR);
    else renameAttr(frame, LEGACY_SRCDOC_ATTR, 'srcdoc');
  }
}
