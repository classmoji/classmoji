/**
 * Cloudinary video URLs in deck text: find them, map each to its `public_id`,
 * and rewrite the ones that were migrated. Pure — no imports — so the dry-run
 * CLI can load it without pulling anything that talks to a database.
 *
 * ## What our code produced (plan §13.4)
 *
 * Both producers (the editor's "Upload to Cloudinary" route and the slides.com
 * import's `uploadVideoBuffer`) stored exactly one URL shape:
 *
 *   https://res.cloudinary.com/{cloud}/video/upload/f_auto,q_auto/v1/classmoji/slides/{slideId}/{tail}?_a={token}
 *
 * `v1` is the SDK's `force_version` literal, the tail is percent-encoded (the
 * SDK leaves `'()*!~.` raw), and `?_a=` varies by SDK version. People can also
 * paste other forms of the same asset — another transformation, the real
 * `v{version}`, an extension, `http:` — so the match accepts any of them and
 * resolves each one against public_ids Cloudinary actually has (the
 * `classmoji/slides/` listing, plus hand-uploaded videos elsewhere in our cloud
 * looked up one by one — plan §13.5) rather than trusting a pattern alone. An
 * extension (`.mp4`, `.mov`) is a delivery format, so both forms of one id are
 * one asset.
 *
 * ## Why resolution is against the listing
 *
 * The tail may contain characters that also end a URL in markup (`'` and `)`
 * are left raw by the SDK), so a scan cannot know where the URL stops from the
 * text alone. The scanner takes the longest plausible run and `resolveCandidate`
 * cuts it back at those characters until a prefix names a public_id that
 * exists. A URL that never resolves is REPORTED and never rewritten.
 *
 * ## Stills are not videos
 *
 * A video resource asked for with an image extension (`…/abc.jpg`) is a frame
 * Cloudinary renders from the video — a poster. Rewriting it to `media://{id}`
 * would put a video into an `<img>`, so those are classified `still`, reported,
 * and left alone.
 */

/** Extensions Cloudinary renders a still frame of a video resource as. */
const STILL_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'tiff']);

/** One transformation component, `f_auto`, `c_scale`, `so_2.5`, `t_named`. */
const TRANSFORM_COMPONENT = '[a-z]{1,3}_[^/,]*';
const TRANSFORM_SEGMENT = new RegExp(`^${TRANSFORM_COMPONENT}(?:,${TRANSFORM_COMPONENT})*$`);
/** A signed delivery URL's signature segment. */
const SIGNATURE_SEGMENT = /^s--[A-Za-z0-9_-]{8,}--$/;
const VERSION_SEGMENT = /^v\d+$/;
/** A trailing `.ext` a URL may add to ask for a format. */
const EXTENSION = /\.([A-Za-z0-9]{2,5})$/;

/**
 * Characters that may belong to a tail (the SDK leaves them raw) but may also
 * be the markup around a URL. A candidate is cut back at these, longest first.
 */
const AMBIGUOUS_TAIL = new Set(["'", ')', '(', '*', '!', '~', ',', ';', '.', '&']);

/** A negative lookahead: not the start of an HTML-escaped quote. */
const ESCAPED_QUOTE = '(?!&(?:quot|#34|#39|apos);)';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The scan regex for one cloud name: scheme (or protocol-relative), host,
 * `/video/upload/`, then the path, an optional query and fragment.
 *
 * The path stops at whitespace, quotes, angle brackets, a backslash (a JSON
 * escape), a backtick, `?`, `#`, and a comma that starts another URL. `'`, `(`
 * and `)` are allowed in the path — the SDK leaves them raw — and cut back by
 * `resolveCandidate`.
 *
 * The query and the fragment carry nothing of ours (`?_a=…`, `#t=10`), so they
 * are strict: they also stop at `'`, `(`, `)`, a comma, and an HTML-escaped
 * quote (`&quot;` `&#34;` `&#39;` `&apos;`) — otherwise a rewrite would swallow
 * the markup after the URL (`[watch](URL?_a=x)`, `url(&quot;URL&quot;)`).
 * `&amp;` between query parameters stays part of the URL.
 */
export function cloudinaryUrlPattern(cloudName: string): RegExp {
  const cloud = escapeRegExp(cloudName);
  return new RegExp(
    `(?:https?:)?//(?:res(?:-\\d+)?\\.cloudinary\\.com/${cloud}|${cloud}-res\\.cloudinary\\.com)` +
      // A comma belongs to the path (`f_auto,q_auto`) unless it starts the
      // next source of a comma-separated list (`data-background-video`).
      '/video/upload/(?:[^\\s"<>\\\\?#`,]|,(?!(?:https?:)?//))+' +
      `(?:\\?(?:${ESCAPED_QUOTE}[^\\s"'<>\\\\#\`,()])*)?` +
      `(?:#(?:${ESCAPED_QUOTE}[^\\s"'<>\\\\\`,()])*)?`,
    'gi'
  );
}

export interface ParsedCloudinaryPath {
  /** The public_id as the Admin API names it, extension stripped, decoded. */
  publicId: string;
  /** The same path with its extension kept (public_ids may contain dots). */
  publicIdWithExt: string;
  /** The extension the URL asked for, lowercased, or null. */
  ext: string | null;
  /** The URL asks for a still frame of the video, not the video. */
  still: boolean;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The part of a Cloudinary delivery URL after `/video/upload/` → public_id.
 *
 * Leading transformation segments, a signature segment and a version segment
 * are skipped (never the last segment — that is always the public_id's tail).
 * The query and fragment are ignored. Null when nothing is left.
 */
export function parseUploadPath(afterUpload: string): ParsedCloudinaryPath | null {
  const path = afterUpload.split(/[?#]/, 1)[0] ?? '';
  const segments = path.split('/').filter(segment => segment.length > 0);
  let at = 0;
  while (
    at < segments.length - 1 &&
    (TRANSFORM_SEGMENT.test(segments[at]!) || SIGNATURE_SEGMENT.test(segments[at]!))
  ) {
    at++;
  }
  if (at < segments.length - 1 && VERSION_SEGMENT.test(segments[at]!)) at++;
  const rest = segments.slice(at).map(decodeSegment);
  if (rest.length === 0) return null;

  const publicIdWithExt = rest.join('/');
  const match = EXTENSION.exec(publicIdWithExt);
  const ext = match ? match[1]!.toLowerCase() : null;
  const publicId = match ? publicIdWithExt.slice(0, -match[0].length) : publicIdWithExt;
  if (publicId.length === 0) return null;
  return { publicId, publicIdWithExt, ext, still: ext !== null && STILL_EXTENSIONS.has(ext) };
}

/** Parse a whole URL of `cloudName`; null when it is not one of its video URLs. */
export function parseCloudinaryUrl(url: string, cloudName: string): ParsedCloudinaryPath | null {
  const pattern = cloudinaryUrlPattern(cloudName);
  pattern.lastIndex = 0;
  const match = pattern.exec(url);
  if (!match || match.index !== 0 || match[0].length !== url.length) return null;
  return parseUploadPath(afterUploadOf(url));
}

function afterUploadOf(url: string): string {
  const at = url.toLowerCase().indexOf('/video/upload/');
  return at === -1 ? '' : url.slice(at + '/video/upload/'.length);
}

export interface UrlCandidate {
  /** The longest run the scan took. */
  raw: string;
  /** Offset of `raw` in the scanned text. */
  index: number;
  /** Where it sits: a `data-background-video` value, or anywhere else. */
  context: ReferenceContext;
}

/**
 * `background`: the value of a section's `data-background-video` — HTML
 * (`data-background-video="…"`, also inside a JSON string with `\"`) or a
 * deck.json attrs entry (`"data-background-video": "…"`). The slides.com import
 * wrote our URLs there, and that attribute is a comma-separated source list, so
 * the `f_auto,q_auto` comma split one URL into two broken sources. The whole
 * URL is one match here, so rewriting it to `media://{id}` fixes them.
 */
export type ReferenceContext = 'background' | 'other';

const BACKGROUND_CONTEXT = /data-background-video\\?["']?\s*[:=]\s*\\?["']?$/i;

function contextAt(text: string, index: number): ReferenceContext {
  return BACKGROUND_CONTEXT.test(text.slice(Math.max(0, index - 64), index))
    ? 'background'
    : 'other';
}

/** Every candidate video URL of `cloudName` in `text`, in order. */
export function findCloudinaryCandidates(text: string, cloudName: string): UrlCandidate[] {
  const out: UrlCandidate[] = [];
  const pattern = cloudinaryUrlPattern(cloudName);
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    out.push({ raw: match[0], index: match.index, context: contextAt(text, match.index) });
  }
  return out;
}

export type ResolvedReference =
  /** A video URL of a listed asset. `raw` is exactly the text to replace. */
  | { kind: 'video'; raw: string; index: number; context: ReferenceContext; publicId: string }
  /** A still frame of a listed asset — reported, never rewritten. */
  | { kind: 'still'; raw: string; index: number; context: ReferenceContext; publicId: string }
  /** Our cloud, but no listed asset matches — reported, never rewritten. */
  | {
      kind: 'unknown';
      raw: string;
      index: number;
      context: ReferenceContext;
      guess: string | null;
    };

/**
 * Cut a candidate back until a prefix names a known public_id (`attemptsOf`).
 * For each attempt, the public_id without the URL's extension is tried first,
 * then with it.
 */
export function resolveCandidate(
  candidate: UrlCandidate,
  known: ReadonlySet<string>
): ResolvedReference {
  const { raw, index, context } = candidate;
  for (const attempt of attemptsOf(raw)) {
    const parsed = parseUploadPath(afterUploadOf(attempt));
    if (!parsed) continue;
    const id = known.has(parsed.publicId)
      ? parsed.publicId
      : known.has(parsed.publicIdWithExt)
        ? parsed.publicIdWithExt
        : null;
    if (id === null) continue;
    // A with-extension id is the asset's own name, so its "extension" is not a
    // format request and cannot make it a still.
    const still = id === parsed.publicId && parsed.still;
    return { kind: still ? 'still' : 'video', raw: attempt, index, context, publicId: id };
  }
  const guess = parseUploadPath(afterUploadOf(pathOf(raw)));
  return { kind: 'unknown', raw, index, context, guess: guess?.publicId ?? null };
}

function pathOf(raw: string): string {
  const queryAt = raw.search(/[?#]/);
  return queryAt === -1 ? raw : raw.slice(0, queryAt);
}

/**
 * The prefixes `resolveCandidate` tries, longest first: the full candidate
 * (query and fragment included), the path alone, then the path cut at each
 * ambiguous character from the right.
 */
function attemptsOf(raw: string): string[] {
  const pathOnly = pathOf(raw);
  const uploadAt = pathOnly.toLowerCase().indexOf('/video/upload/') + '/video/upload/'.length;
  const tries: string[] = [raw];
  if (pathOnly !== raw) tries.push(pathOnly);
  for (let at = pathOnly.length - 1; at > uploadAt; at--) {
    if (AMBIGUOUS_TAIL.has(pathOnly[at]!)) tries.push(pathOnly.slice(0, at));
  }
  return tries;
}

/**
 * The public_ids a candidate could name, in the order `resolveCandidate` would
 * accept them: for each attempt, the id without the URL's extension (`.mp4`
 * and `.mov` are delivery formats of ONE public_id), then the id with it (a
 * public_id may itself contain a dot). Deduplicated. This is what an
 * unlisted URL is looked up by, one at a time, until one exists.
 */
export function candidatePublicIds(candidate: Pick<UrlCandidate, 'raw'>): string[] {
  const out: string[] = [];
  const full = parseUploadPath(afterUploadOf(pathOf(candidate.raw)));
  if (!full) return out;
  for (const attempt of attemptsOf(candidate.raw)) {
    const parsed = parseUploadPath(afterUploadOf(attempt));
    // A cut inside the transformation (`f_auto,q_auto` → `f_auto`) is not a
    // shorter tail of the same id; only cuts within the public_id are.
    if (!parsed || !full.publicIdWithExt.startsWith(parsed.publicId)) continue;
    for (const id of [parsed.publicId, parsed.publicIdWithExt]) {
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** Every Cloudinary reference of `cloudName` in `text`, resolved. */
export function scanText(
  text: string,
  cloudName: string,
  known: ReadonlySet<string>
): ResolvedReference[] {
  return findCloudinaryCandidates(text, cloudName).map(candidate =>
    resolveCandidate(candidate, known)
  );
}

/**
 * Replace every VIDEO reference whose public_id is in `replacements` with its
 * replacement, span by span (never a global string replace: one URL can be a
 * prefix of another). Stills, unknown URLs and unmapped assets are untouched.
 */
export function rewriteText(
  text: string,
  cloudName: string,
  known: ReadonlySet<string>,
  replacements: ReadonlyMap<string, string>
): { text: string; replaced: number } {
  let out = '';
  let cursor = 0;
  let replaced = 0;
  for (const ref of scanText(text, cloudName, known)) {
    if (ref.kind !== 'video') continue;
    const replacement = replacements.get(ref.publicId);
    if (replacement === undefined) continue;
    out += text.slice(cursor, ref.index) + replacement;
    cursor = ref.index + ref.raw.length;
    replaced++;
  }
  return { text: out + text.slice(cursor), replaced };
}
