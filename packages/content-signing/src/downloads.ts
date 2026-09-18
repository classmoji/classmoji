import { fromBase64Url, toBase64Url, utf8 } from './canonical.ts';

/**
 * The display filename a `download` URL carries, and the header it turns into.
 *
 * A blob URL names a sha, not a file: `blobs/{sha}` is shared by every classroom
 * whose content repo holds those bytes, so the name a student should see cannot
 * live with the object. It travels in the URL instead, inside the signature —
 * `dl` is a field of the canonical string, so a filename cannot be swapped,
 * lengthened, or injected by anyone who was not handed the URL.
 *
 * Everything in here exists to make one guarantee hold: whatever comes back out
 * of a verified `dl` is a plain single-segment filename, and putting it in a
 * `Content-Disposition` header cannot smuggle a second header, a path, or a
 * different-looking name than the one the instructor uploaded.
 */

/**
 * Cap on the raw filename, in UTF-8 BYTES rather than characters — the encoded
 * form rides in a URL, and a 200-character CJK name is 600 bytes there.
 *
 * Long enough for any real slide deck, short enough that `dl` cannot dominate a
 * URL that also has to carry a signature.
 */
export const MAX_DOWNLOAD_FILENAME_BYTES = 200;

/**
 * Ceiling on the ENCODED value as it arrives in the query.
 *
 * base64url is 4 characters per 3 bytes, so 200 bytes encode to at most 267;
 * the round number above it leaves room without letting a forged URL hand the
 * decoder an unbounded string.
 */
export const MAX_ENCODED_DOWNLOAD_FILENAME = 280;

/** Bidi overrides and isolates: characters that can make `x.fdp.exe` read as `x.exe`. */
function isBidiControl(code: number): boolean {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/** The joiner inside every multi-person and profession emoji. Deliberately allowed. */
const ZWJ = '\u200d';

/**
 * Format characters (general category Cf), plus the two separators that are
 * line breaks under another name (U+2028 is Zl, U+2029 is Zp).
 *
 * Every one of them is invisible, which is the problem: `deck\u200b.pdf` and
 * `deck.pdf` are different names that render identically in a save dialog and
 * in a directory listing, and `\ufeff` or `\u00ad` can hide inside an extension
 * the same way. The bidi controls the explicit check above names are Cf too, so
 * this subsumes them — that check is kept because the attack it describes is
 * worth spelling out, not because it is the only thing catching them.
 *
 * ZWJ (U+200D) is Cf and is EXEMPT on purpose: it is what holds `👩‍🏫.png`
 * together, so refusing it would reject names instructors legitimately type. It
 * joins adjacent glyphs rather than reordering or concealing them, so it buys a
 * forger nothing the visible characters do not already give. Variation
 * selectors (U+FE0F and friends) are Mn rather than Cf and never reach here.
 *
 * `\p{Cf}` needs the `u` flag; both targets — workerd and Node 22 — are V8.
 */
const INVISIBLE_FORMAT = /[\p{Cf}\u2028\u2029]/u;

function isInvisibleFormat(char: string): boolean {
  return char !== ZWJ && INVISIBLE_FORMAT.test(char);
}

/** C0 controls and DEL — a newline here would be a second HTTP header. */
function isControl(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

/** Leading or trailing whitespace and dots: `.bashrc`, `name.`, `..`, ` name`. */
function hasEdgeJunk(name: string): boolean {
  return /^[\s.]/.test(name) || /[\s.]$/.test(name);
}

function byteLength(value: string): number {
  return utf8(value).byteLength;
}

/**
 * Split a filename into its base and its extension, dot included (`['deck', '.pdf']`).
 *
 * A leading dot is never an extension — but `normalizeDownloadFilename` has
 * already refused those by the time this runs, so the guard is about `lastIndexOf`
 * returning 0, not about hidden files.
 */
function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

/**
 * Cut a string to at most `limit` UTF-8 bytes, on a CODE POINT boundary.
 *
 * Iterating the string (rather than slicing by index) is what keeps a surrogate
 * pair whole: half of an emoji is not a character, and a lone surrogate would
 * make the round-trip through `decodeDownloadFilename` fail on a name we
 * ourselves produced.
 */
function truncateToBytes(value: string, limit: number): string {
  let out = '';
  let used = 0;
  for (const char of value) {
    const size = byteLength(char);
    if (used + size > limit) break;
    out += char;
    used += size;
  }
  return out;
}

/**
 * The one definition of "a filename we are willing to sign", used on both sides.
 *
 * Returns the cleaned name, or null when there is nothing safe to make of it.
 * Rejecting rather than sanitizing is deliberate for everything except the
 * directory prefix and the length: a name silently rewritten into something else
 * is a name the instructor did not choose, and the upload path can say so.
 *
 * What it does:
 *   - takes the BASENAME, so a browser that sent `C:\Users\ada\deck.pdf` or
 *     `talks/deck.pdf` still yields `deck.pdf`;
 *   - normalizes to NFC, so the same visible name is the same bytes and the
 *     decoder's round-trip check is stable across platforms (macOS sends NFD);
 *   - caps the length, truncating the BASE and never the extension — a `.pdf`
 *     that lost its suffix is a file the browser no longer knows how to open.
 *
 * What it refuses: empty, control characters (a newline would be a second HTTP
 * header), path separators, bidi controls (`x.fdp\u202eexe` renders as
 * `x.exe`), the other invisible format characters (a zero-width space or a BOM
 * makes two different names look like one), and leading or trailing whitespace
 * or dots (`.bashrc`, `deck.`). ZWJ is the one exception — see `ZWJ` above.
 */
export function normalizeDownloadFilename(name: string): string | null {
  if (typeof name !== 'string') return null;

  const normalized = name.normalize('NFC');
  const cut = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  const base = cut === -1 ? normalized : normalized.slice(cut + 1);

  if (base.length === 0) return null;
  if (hasEdgeJunk(base)) return null;
  for (const char of base) {
    const code = char.codePointAt(0) ?? 0;
    if (isControl(code) || isBidiControl(code) || isInvisibleFormat(char)) return null;
    // Unreachable after the basename cut above, and kept anyway: this is the
    // invariant the header formatter relies on, not an incidental consequence.
    if (char === '/' || char === '\\') return null;
  }

  if (byteLength(base) <= MAX_DOWNLOAD_FILENAME_BYTES) return base;

  const [stem, extension] = splitExtension(base);
  const room = MAX_DOWNLOAD_FILENAME_BYTES - byteLength(extension);
  // An "extension" long enough to eat the whole budget is not an extension.
  if (room <= 0) return null;

  // The cut can land on a space or a dot that was interior before it, and a
  // name ending in one is exactly what the edge check above refuses — so the
  // truncated stem is tidied rather than the whole name being thrown away over
  // where character 200 happened to fall.
  const trimmed = truncateToBytes(stem, room).replace(/[\s.]+$/, '');
  if (trimmed.length === 0) return null;
  return trimmed + extension;
}

/**
 * base64url of the UTF-8 bytes — URL-safe, and opaque enough that the query
 * carries no readable path fragment for a scanner to act on.
 *
 * Strict on purpose: it encodes only a name `normalizeDownloadFilename` already
 * accepts VERBATIM, so encode and decode are exact inverses and a caller cannot
 * sign a name the verifier will later refuse to hand back.
 */
export function encodeDownloadFilename(name: string): string {
  if (normalizeDownloadFilename(name) !== name) {
    throw new TypeError(`content-signing: unusable download filename (got ${String(name)})`);
  }
  return toBase64Url(utf8(name));
}

/**
 * The inverse, and the only way a filename re-enters the world.
 *
 * Runs AFTER the signature has been checked — the canonical string covers the
 * encoded value exactly as it arrived, so this decode is reading bytes we
 * minted, not bytes a caller chose. It is still strict about every step:
 *
 *   - bounded length, so the base64 decode cannot be handed a huge string;
 *   - `fatal: true`, so invalid UTF-8 is an error rather than a run of U+FFFD;
 *   - and the round-trip check, which is the real guard: the decoded name must
 *     be one `normalizeDownloadFilename` returns UNCHANGED. Anything that would
 *     have been trimmed, truncated, or refused at mint time is refused here too,
 *     even though it carries a valid signature.
 *
 * Returns null instead of throwing: callers turn that into `malformed`.
 */
export function decodeDownloadFilename(encoded: string): string | null {
  if (typeof encoded !== 'string') return null;
  if (encoded.length === 0 || encoded.length > MAX_ENCODED_DOWNLOAD_FILENAME) return null;

  const bytes = fromBase64Url(encoded);
  if (!bytes) return null;

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }

  return normalizeDownloadFilename(decoded) === decoded ? decoded : null;
}

/** RFC 8187 attr-char: what may appear unescaped in the `filename*` form. */
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

/**
 * Percent-encode UTF-8 per RFC 8187, uppercase hex.
 *
 * `encodeURIComponent` is close but wrong here: it leaves `!`, `'`, `(`, `)` and
 * `*` alone, and `'` is the delimiter of the `UTF-8''value` form itself.
 */
function percentEncode(value: string): string {
  let out = '';
  for (const byte of utf8(value)) {
    const char = String.fromCharCode(byte);
    out += ATTR_CHAR.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * The ASCII half of the header: a quoted-string every client can read.
 *
 * Non-ASCII collapses to `_` rather than being dropped, so the fallback keeps
 * the shape of the name (and its extension) for the handful of clients that
 * ignore `filename*`. Quotes and backslashes are escaped as quoted-pairs, which
 * is what stops a name ending the quoted string early and appending parameters
 * of its own.
 *
 * `%` collapses too, though it is perfectly ordinary ASCII: RFC 6266 App. D
 * advises against it here because some clients percent-decode the quoted form,
 * which would turn a literal `a%2Fb.pdf` into the path `a/b.pdf`. It is only
 * the fallback that loses it — `filename*` carries the real name, with the `%`
 * encoded as `%25`.
 */
function asciiFallback(name: string): string {
  let out = '';
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '"' || char === '\\') out += `\\${char}`;
    else if (char === '%') out += '_';
    else if (code >= 0x20 && code < 0x7f) out += char;
    else out += '_';
  }
  return out;
}

/**
 * `Content-Disposition` for one verified filename.
 *
 * Both forms, in the order RFC 6266 §4.3 recommends: every client understands
 * the quoted ASCII `filename`, and every client that understands `filename*`
 * prefers it — which is what delivers `Übung 1.pdf` intact.
 *
 * Header injection is not possible by construction rather than by escaping:
 * `normalizeDownloadFilename` has already refused every control character, so
 * neither half can contain a CR or an LF to split the header on.
 */
export function contentDispositionFor(filename: string): string {
  return `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${percentEncode(filename)}`;
}
