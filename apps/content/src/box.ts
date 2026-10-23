/**
 * The box: how HTML from a content repo runs when a frame loads it.
 *
 * Every other reply from this Worker carries `default-src 'none'; sandbox` —
 * no script at all. A page served through a files grant is meant to run (a
 * game, a diagram, an html block), so its HTML gets a different policy: a CSP
 * sandbox that allows script but never `allow-same-origin`. The document lands
 * in an opaque origin, so it holds no cookies, cannot read storage on this
 * host, and cannot reach the app that framed it. Nothing restricts fetch or
 * script sources: these pages load libraries and fonts from CDNs.
 *
 * Only HTML gets the box. A script, stylesheet, image or svg from the same
 * grant is a subresource of that boxed page, or an inert file opened on its
 * own, and keeps the strict policy byte for byte. `text/html` also gets the
 * storage shim; XHTML gets the box with its bytes untouched (a script ahead of
 * its root element would not be well-formed XML).
 */
import { finalizeHeaders } from './cache.ts';

/** Sandbox flags for a boxed page. Never `allow-same-origin`, never `allow-top-navigation*`. */
export const BOX_SANDBOX =
  'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals ' +
  'allow-pointer-lock allow-downloads';

export const BOX_CONTENT_SECURITY_POLICY = `sandbox ${BOX_SANDBOX}`;

/**
 * An in-memory `localStorage` / `sessionStorage` for a boxed page.
 *
 * In an opaque origin reading either property throws, and most games read one
 * on startup. Where the real one works it is left alone; otherwise a Map-backed
 * stand-in is defined, so state lasts as long as the frame does. Same
 * semantics as the html-block shim in `packages/services` (`data-cm-storage-shim`
 * marks it in both).
 */
export const STORAGE_SHIM =
  '<script data-cm-storage-shim>(function(){function m(){var d=new Map();return{get length(){' +
  'return d.size},key:function(i){var k=Array.from(d.keys());return i>=0&&i<k.length?k[i]:null},' +
  'getItem:function(k){k=String(k);return d.has(k)?d.get(k):null},setItem:function(k,v){' +
  'd.set(String(k),String(v))},removeItem:function(k){d.delete(String(k))},clear:function(){' +
  "d.clear()}}}['localStorage','sessionStorage'].forEach(function(n){try{if(window[n])return}" +
  'catch(e){}try{Object.defineProperty(window,n,{value:m(),configurable:true,enumerable:true})}' +
  'catch(e){}})})();</script>';

const encoder = new TextEncoder();
const SHIM_BYTES = encoder.encode(STORAGE_SHIM);

const BOM = [0xef, 0xbb, 0xbf];

function isAsciiSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d;
}

/** Whether `bytes` holds `ascii` at `at`, ASCII letters compared case-insensitively. */
function matchesAscii(bytes: Uint8Array, at: number, ascii: string): boolean {
  if (at + ascii.length > bytes.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    let byte = bytes[at + i];
    if (byte >= 0x41 && byte <= 0x5a) byte += 0x20;
    if (byte !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

function indexOfAscii(bytes: Uint8Array, ascii: string, from: number): number {
  for (let at = from; at + ascii.length <= bytes.length; at++) {
    if (matchesAscii(bytes, at, ascii)) return at;
  }
  return -1;
}

/**
 * Where the shim goes: just past a leading `<!doctype …>` (after whitespace
 * and comments), else at the very start — after a UTF-8 byte order mark if
 * there is one. A script ahead of the doctype would drop the page into quirks
 * mode; one ahead of the BOM would turn the BOM into text.
 *
 * Works on bytes, so a page in any ASCII-compatible encoding is passed through
 * untouched apart from the inserted script.
 */
export function shimOffset(bytes: Uint8Array): number {
  const start = BOM.every((byte, i) => bytes[i] === byte) ? BOM.length : 0;
  let at = start;
  for (;;) {
    while (at < bytes.length && isAsciiSpace(bytes[at])) at++;
    if (!matchesAscii(bytes, at, '<!--')) break;
    const end = indexOfAscii(bytes, '-->', at + 4);
    if (end === -1) return start;
    at = end + 3;
  }
  if (!matchesAscii(bytes, at, '<!doctype')) return start;
  const close = bytes.indexOf(0x3e, at);
  return close === -1 ? start : close + 1;
}

/** The page with the storage shim inserted at `shimOffset`. */
export function withStorageShim(bytes: Uint8Array): Uint8Array {
  const at = shimOffset(bytes);
  const out = new Uint8Array(bytes.length + SHIM_BYTES.length);
  out.set(bytes.subarray(0, at), 0);
  out.set(SHIM_BYTES, at);
  out.set(bytes.subarray(at), at + SHIM_BYTES.length);
  return out;
}

function essenceOf(contentType: string | null): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

/** `text/html` or `application/xhtml+xml`, whatever the parameters. */
export function isHtmlContentType(contentType: string | null): boolean {
  const essence = essenceOf(contentType);
  return essence === 'text/html' || essence === 'application/xhtml+xml';
}

/**
 * Turn an already-built 200 HTML reply into a boxed page — the files route's
 * counterpart to `asDownload`. Anything else (another type, an error, a 404)
 * is returned untouched, strict policy and all.
 *
 * For `text/html` the body is buffered to insert the shim, which changes its
 * length, so the stored `Content-Length`, `ETag` and `Accept-Ranges` no longer
 * describe it and are dropped (the caller never asks for a range on HTML).
 * XHTML is passed through as stored, length and `ETag` included. A HEAD gets
 * the headers only — its body, if any, is a tee'd branch and is cancelled.
 */
export async function asHtmlApp(response: Response, head: boolean): Promise<Response> {
  if (response.status !== 200 || !isHtmlContentType(response.headers.get('Content-Type'))) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', BOX_CONTENT_SECURITY_POLICY);
  headers.set('Referrer-Policy', 'no-referrer');
  headers.delete('Accept-Ranges');

  const shim = essenceOf(response.headers.get('Content-Type')) === 'text/html';
  if (shim) {
    headers.delete('Content-Length');
    headers.delete('ETag');
  }

  if (head) {
    response.body?.cancel().catch(() => {});
    return new Response(null, { status: 200, headers });
  }
  if (!shim) return new Response(response.body, { status: 200, headers });

  const body = withStorageShim(new Uint8Array(await response.arrayBuffer()));
  headers.set('Content-Length', String(body.byteLength));
  return new Response(body, { status: 200, headers });
}

/**
 * The script of `/preview-frame`. It announces itself to its parent, takes the
 * first `{type:'cm-preview', html, base?}` message that comes FROM that parent,
 * and replaces the frame's document with it — the shim inserted the same way
 * the Worker inserts it, and an http(s) `base` as a `<base href>` so relative
 * references in a draft resolve where the saved file's would.
 *
 * Anything the page posts back is the editor's business; this frame holds
 * nothing. `'*'` on the ready message is safe because the message carries no
 * data, and the frame cannot know its parent's origin.
 *
 * Every `<` inside a string literal is written `\x3c`, so nothing in the
 * script can be read by the HTML parser as markup (`<!--`, `</script`).
 */
const PREVIEW_FRAME_SCRIPT =
  '(function(){' +
  `var S=${JSON.stringify(STORAGE_SHIM).replace(/</g, '\\u003c')};` +
  'function at(h){var s=h.charCodeAt(0)===65279?1:0,i=s;for(;;){' +
  'while(i<h.length&&/[\\t\\n\\f\\r ]/.test(h[i]))i++;' +
  "if(h.substr(i,4)!=='\\x3c!--')break;var e=h.indexOf('-->',i+4);if(e<0)return s;i=e+3}" +
  "if(h.substr(i,9).toLowerCase()!=='\\x3c!doctype')return s;" +
  "var c=h.indexOf('>',i);return c<0?s:c+1}" +
  'function base(b){if(typeof b!=="string")return"";try{var u=new URL(b);' +
  'if(u.protocol!=="https:"&&u.protocol!=="http:")return"";' +
  'return\'\\x3cbase href="\'+u.href.replace(/&/g,"&amp;").replace(/"/g,"&quot;")' +
  '.replace(/</g,"&lt;")+\'">\'}catch(e){return""}}' +
  'var done=false;' +
  "window.addEventListener('message',function(e){" +
  'if(done||e.source!==window.parent)return;var d=e.data;' +
  "if(!d||d.type!=='cm-preview'||typeof d.html!=='string')return;" +
  'done=true;var h=d.html,i=at(h);' +
  'document.open();document.write(h.slice(0,i)+S+base(d.base)+h.slice(i));document.close()});' +
  "window.parent.postMessage({type:'cm-preview-ready'},'*')" +
  '})();';

export const PREVIEW_FRAME_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Preview</title>' +
  `<script>${PREVIEW_FRAME_SCRIPT}</script></head><body></body></html>`;

/**
 * `GET /preview-frame` — unsigned and static. A page in the box whose only
 * content is whatever its parent posts to it: the editor's live preview of
 * code that has not been saved yet, and the display path for html blocks that
 * still carry their code inline. It serves no classroom data, so it needs no
 * signature, and it is cached for an hour like any static file.
 */
export function previewFrameResponse(): Response {
  const headers = finalizeHeaders(
    new Headers({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    })
  );
  headers.set('Content-Security-Policy', BOX_CONTENT_SECURITY_POLICY);
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(PREVIEW_FRAME_HTML, { headers });
}
