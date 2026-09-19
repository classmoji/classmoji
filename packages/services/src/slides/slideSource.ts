/**
 * slideSource.ts — the policy for a slide that is NOT a deck.
 *
 * A `Slide` is a reveal.js deck (`kind: 'DECK'`), an uploaded document students
 * download (`'FILE'`), or an external URL they are redirected to (`'LINK'`).
 * This file holds everything that decides what those two are ALLOWED to be:
 * which extensions and how many bytes a file may carry, what its path in the
 * content repo is named, and what counts as a link.
 *
 * ## Pure, and deliberately so
 *
 * No Prisma, no GitHub, no `@classmoji/content-signing`. It is exported through
 * the ROOT services barrel as well as the `./slides` subpath, so the webapp can
 * render a kind chip and validate a link without pulling the deck engine (and
 * cheerio with it) into its bundle. Anything here that needs a network or a
 * database belongs in `slideFile.service.ts` instead.
 *
 * ## Why these constants are not `validateFile.ts`'s
 *
 * `MAX_FILE_SIZE` (5 MB) and `ALLOWED_EXTENSIONS` in
 * `content/utils/validateFile.ts` govern the images and PDFs dropped into a
 * page or a deck, and `ContentService.upload` enforces them on every caller.
 * A slide FILE is a different thing with a different ceiling (75 MB, decided
 * with Tim) and a narrower list, and widening the shared globals to fit it
 * would silently raise the cap for every image upload in the product. So this
 * policy is separate, and the slide upload path commits through
 * `ContentService.uploadBatch` — which does no validation of its own — after
 * checking it HERE, explicitly.
 */

/** 75 MB. Above this an upload is refused before a byte is committed. */
export const SLIDE_FILE_MAX_BYTES = 75 * 1024 * 1024;

/** The only extensions a FILE slide may carry. Lowercase, no leading dot. */
export const SLIDE_FILE_EXTENSIONS = ['pdf', 'ppt', 'pptx', 'key'] as const;

export type SlideFileExtension = (typeof SLIDE_FILE_EXTENSIONS)[number];

/**
 * The stored `source_mime` for each extension.
 *
 * Derived from the extension rather than trusted from the upload: a browser's
 * `Content-Type` on a multipart part is whatever the client felt like sending,
 * and this value ends up in a response header. `key` is Apple's own registered
 * type; the Worker serves whatever it serves and the download is an attachment
 * either way, so a wrong guess here costs an icon, never a broken file.
 */
export const SLIDE_FILE_MIME: Record<SlideFileExtension, string> = {
  pdf: 'application/pdf',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  key: 'application/vnd.apple.keynote',
};

/**
 * Names the deck engine owns inside a `slides/<slug>/` folder.
 *
 * None of them can collide with an allowed extension today, which is exactly
 * why the check is cheap enough to keep: it costs nothing now and is the thing
 * that stops a future extension addition from letting an upload overwrite the
 * artifact a deck is rendered from.
 */
export const RESERVED_SLIDE_FILENAMES = ['deck.json', 'index.html', 'thumbnail.webp'] as const;

/** Longest link we store. Comfortably past every real URL, short of a DoS. */
export const SLIDE_LINK_MAX_LENGTH = 2048;

/** The last path segment of a name a browser handed us (`a\b\c.pdf` → `c.pdf`). */
function basenameOf(name: string): string {
  const parts = String(name ?? '').split(/[/\\]/);
  return parts[parts.length - 1] ?? '';
}

/**
 * The allowed extension of `filename`, or null.
 *
 * Case-insensitive on the way in and lowercase on the way out, because the
 * extension is used to pick a MIME type, to build a storage path and to sign a
 * URL — three places that must agree on one spelling.
 */
export function slideFileExtension(filename: string): SlideFileExtension | null {
  const base = basenameOf(filename).toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1);
  return (SLIDE_FILE_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as SlideFileExtension)
    : null;
}

export type SlideFileValidation =
  | { valid: true; extension: SlideFileExtension; mime: string }
  | { valid: false; error: string };

/**
 * Is this upload one we will take? Extension and size only.
 *
 * Deliberately not a content sniff. The bytes are committed to a private-by-
 * default git repo and served as an attachment with a locked-down CSP, so the
 * thing a sniff would defend against — a "PDF" that is really HTML rendering in
 * the viewer's origin — is already closed by the Worker's download headers.
 */
export function validateSlideFile({
  filename,
  size,
}: {
  filename: string;
  size: number;
}): SlideFileValidation {
  const extension = slideFileExtension(filename);
  if (!extension) {
    return {
      valid: false,
      error: `Slide files must be one of: ${SLIDE_FILE_EXTENSIONS.map(ext => `.${ext}`).join(', ')}`,
    };
  }
  if (!Number.isFinite(size) || size <= 0) {
    return { valid: false, error: 'That file is empty.' };
  }
  if (size > SLIDE_FILE_MAX_BYTES) {
    return {
      valid: false,
      error: `That file is too large. The limit is ${Math.round(SLIDE_FILE_MAX_BYTES / (1024 * 1024))} MB.`,
    };
  }
  return { valid: true, extension, mime: SLIDE_FILE_MIME[extension] };
}

/**
 * The name the uploaded file is COMMITTED under, inside `slides/<slug>/`.
 *
 * ASCII, lowercase, no spaces: it is a git path in a repo the whole classroom
 * shares, and it travels through the Contents API, the asset map and a CDN URL
 * before anyone sees it. The name the STUDENT sees is a different string
 * entirely — `Slide.source_filename`, validated by `normalizeDownloadFilename`
 * and replayed in `Content-Disposition` per request — so nothing about the
 * original spelling is lost by sanitizing here.
 *
 * `fallbackBase` (the slide's slug) covers a name that sanitizes to nothing:
 * `講義.pdf` has no ASCII to keep, and `.pdf` is not a filename.
 *
 * Null when the extension is not allowed, or when the result would collide with
 * a name the deck engine owns.
 */
export function slideFileStorageName(filename: string, fallbackBase: string): string | null {
  const extension = slideFileExtension(filename);
  if (!extension) return null;

  const base = basenameOf(filename).slice(0, -(extension.length + 1));
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');

  const stem = sanitized || fallbackBase.replace(/[^a-z0-9-]/g, '') || 'slide';
  const name = `${stem}.${extension}`;
  return (RESERVED_SLIDE_FILENAMES as readonly string[]).includes(name) ? null : name;
}

/** Why a stored FILE row's document will not be read or signed. Null = it will. */
export type SlideFileSourceProblem =
  /** The row has no `source_path` at all. Broken data, not a policy refusal. */
  | 'no_source'
  /** `source_path` names something outside the slide's own `content_path/`. */
  | 'escapes_folder'
  /** The recorded size is past the policy cap this file's first line states. */
  | 'too_large';

/**
 * Is this row's document one we will serve? Containment and size, from the row.
 *
 * Self-defence, not validation: every write path already sanitizes the storage
 * name and checks the cap, so a row that fails here is one no create or replace
 * in this codebase could have produced. It is checked again on the READ because
 * the two are separated by a database — a hand-edited row, a restored backup or
 * a future writer that forgot the rule would otherwise turn `source_path` into
 * a caller-supplied path that the download signs and the GitHub reader fetches.
 *
 * `slides/lecture-1/../../.env` is the shape that matters: a path that is not
 * strictly UNDER `${content_path}/` is not this slide's to hand out, whatever
 * the row says. The size check is the same idea one step further — a row
 * claiming 400 MB is either wrong or a document nobody agreed to serve, and
 * reading it would be a 400 MB buffer in this process either way.
 */
export function slideFileSourceProblem(slide: {
  content_path?: string | null;
  source_path?: string | null;
  source_size?: number | null;
}): SlideFileSourceProblem | null {
  const path = typeof slide.source_path === 'string' ? slide.source_path : '';
  if (!path) return 'no_source';

  const folder = typeof slide.content_path === 'string' ? slide.content_path : '';
  const prefix = `${folder.replace(/\/+$/, '')}/`;
  if (!folder || !path.startsWith(prefix) || path.length === prefix.length) {
    return 'escapes_folder';
  }
  // `..` anywhere, not just at the front: the prefix test above is satisfied by
  // `slides/lecture-1/../../secret`, which climbs straight back out of it.
  const tail = path.slice(prefix.length).split('/');
  if (tail.some(segment => segment === '' || segment === '.' || segment === '..')) {
    return 'escapes_folder';
  }

  if (typeof slide.source_size === 'number' && slide.source_size > SLIDE_FILE_MAX_BYTES) {
    return 'too_large';
  }
  return null;
}

export type SlideLinkValidation =
  | { ok: true; url: string; host: string }
  | { ok: false; error: string };

/**
 * Is this a link we will store and redirect to?
 *
 * Absolute `https:` only, no credentials in the authority, no control
 * characters, and 2,048 characters at most. The host comes back ASCII because
 * `URL` punycodes it, which is what stops `аpple.com` (Cyrillic а) from being
 * stored as one string and displayed as another.
 *
 * NOT a reachability or a safety check, and on purpose. There is no DNS lookup
 * and no private-range refusal: nothing in this product ever FETCHES the
 * destination — the browser is redirected to it — so an RFC1918 address is a
 * link that will not load for the student, not an SSRF. Classmoji controls who
 * sees the link, never who may open what is on the other end; that sentence is
 * in the link form's copy for the same reason it is in this comment.
 *
 * `url` is `URL`'s normalized serialization, so `https://Example.COM` is stored
 * as `https://example.com/`. A path is preserved exactly; a bare origin gains
 * the trailing slash the spec says it has.
 */
export function validateSlideLinkUrl(raw: string): SlideLinkValidation {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return { ok: false, error: 'Enter a link.' };
  if (trimmed.length > SLIDE_LINK_MAX_LENGTH) {
    return { ok: false, error: `Links must be ${SLIDE_LINK_MAX_LENGTH} characters or fewer.` };
  }
  // Before `new URL`, which silently strips tab/CR/LF rather than refusing
  // them — a stored link must be the one that was typed, or nothing.
  // eslint-disable-next-line no-control-regex
  if (/[ -]/.test(trimmed)) {
    return { ok: false, error: 'That link contains characters we cannot store.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Enter a full link, starting with https://' };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Links must start with https://' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Links cannot carry a username or password.' };
  }
  if (!parsed.hostname) {
    return { ok: false, error: 'That link has no website in it.' };
  }

  // `https://.` and `https://a..b` parse cleanly — `URL` takes any non-empty
  // authority — and resolve nowhere. One TRAILING dot is the exception: it is
  // the legal absolute-root form of a name, so it is stripped rather than
  // refused, which also stops `example.com.` being stored as a second spelling
  // of a host we already have. Everything else with an empty label is a link
  // that cannot load, and storing it would put a dead destination behind a
  // slide nobody can tell is dead until they click it. An IP literal has no
  // empty labels and passes — deliberately; see the note above.
  const hostname = parsed.hostname.endsWith('.') ? parsed.hostname.slice(0, -1) : parsed.hostname;
  if (!hostname || hostname.split('.').some(label => label.length === 0)) {
    return { ok: false, error: 'That link has no website in it.' };
  }
  if (hostname !== parsed.hostname) parsed.hostname = hostname;

  const url = parsed.toString();
  if (url.length > SLIDE_LINK_MAX_LENGTH) {
    return { ok: false, error: `Links must be ${SLIDE_LINK_MAX_LENGTH} characters or fewer.` };
  }
  return { ok: true, url, host: parsed.hostname };
}

/** The host of a stored link, for a chip or a list row. Null when unparseable. */
export function slideLinkHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * The short word a list row shows for a slide: `deck`, the file's extension, or
 * `link`. One function so the webapp's chip and any other surface agree.
 */
export function slideKindLabel(slide: {
  kind?: string | null;
  source_filename?: string | null;
  source_path?: string | null;
}): string {
  if (slide.kind === 'LINK') return 'link';
  if (slide.kind !== 'FILE') return 'deck';
  const extension =
    slideFileExtension(slide.source_filename ?? '') ?? slideFileExtension(slide.source_path ?? '');
  return extension ?? 'file';
}

/** True for the only kind the deck engine may touch. Absent `kind` reads as DECK. */
export function isDeckSlide(slide: { kind?: string | null } | null | undefined): boolean {
  return !slide?.kind || slide.kind === 'DECK';
}

/**
 * "That operation does not apply to this kind of slide."
 *
 * 409 rather than 404 or 400: the slide exists and the caller may see it — what
 * is wrong is that a deck operation was aimed at a file, or a file operation at
 * a link. A route can map this one class to one status and one sentence, which
 * is the whole reason it is a class and not a string thrown from six places.
 */
export class SlideKindError extends Error {
  status = 409 as const;
  code = 'SLIDE_KIND_MISMATCH' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SlideKindError';
  }
}

/**
 * Refuse a deck operation on a slide that is not a deck.
 *
 * `slide.kind` absent reads as DECK on purpose: `saveDeck`'s target is a
 * structural type, and two legitimate callers (`createSlide` before the row
 * exists, the importer's synthetic target) build one by hand with no kind. Both
 * are creating decks. Every caller that loaded a ROW carries the column, which
 * is exactly where the guard has to bite.
 */
export function assertDeckSlide(
  slide: { kind?: string | null } | null | undefined,
  operation: string
): void {
  if (isDeckSlide(slide)) return;
  throw new SlideKindError(
    `${operation} is only available for slide decks (this slide is a ${String(slide?.kind).toLowerCase()}).`
  );
}

/** Refuse a FILE operation on a slide that is not one. Mirrors `assertDeckSlide`. */
export function assertFileSlide(
  slide: { kind?: string | null } | null | undefined,
  operation: string
): void {
  if (slide?.kind === 'FILE') return;
  throw new SlideKindError(`${operation} is only available for uploaded slide files.`);
}

/** Refuse a LINK operation on a slide that is not one. Mirrors `assertDeckSlide`. */
export function assertLinkSlide(
  slide: { kind?: string | null } | null | undefined,
  operation: string
): void {
  if (slide?.kind === 'LINK') return;
  throw new SlideKindError(`${operation} is only available for linked slides.`);
}
