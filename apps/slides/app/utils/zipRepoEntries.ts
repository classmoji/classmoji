/**
 * zipRepoEntries.ts — which entries of an imported ZIP the course repository
 * can take, and what happens to the deck's references to the ones it cannot.
 *
 * The slides.com import commits everything it keeps in ONE `uploadBatch`, and
 * GitHub refuses a single file over the REST ceiling by refusing the whole
 * commit. So each entry is measured before it is read, and one over
 * `REPO_REST_MAX_BYTES` is left out with a warning that names it, instead of
 * taking the import down with it.
 *
 * A file left out must not leave a reference behind that points at nothing:
 * `resolveMediaRef` tells the importer, for each reference in the deck's HTML,
 * whether it names a file that was kept (rewrite it), one that was skipped
 * (remove it), or neither (leave it alone).
 *
 * Its own module, with nothing but JSZip's types and the shared limit, so the
 * rules can be unit tested without the importer's database and GitHub imports.
 */

import type JSZip from 'jszip';
import { REPO_REST_MAX_BYTES, repoFileSkippedWarning } from '@classmoji/utils/repo-limits';

/** An entry the import left out. `path` is its path inside the ZIP. */
export interface SkippedEntry {
  path: string;
  name: string;
  bytes: number;
  /**
   * The warning, when the entry was left out for something other than the
   * repository's size cap — a video media storage refused (`skip`). Absent for
   * the cap, whose sentence is built from the size.
   */
  reason?: string;
}

/**
 * The size the ZIP's own directory declares for an entry once decompressed, or
 * null when JSZip holds none.
 *
 * JSZip keeps it on the entry's private `_data` (a `CompressedObject` for every
 * entry of a loaded archive — `lib/load.js` hands the parsed entry's
 * `decompressed` object to `zip.file`), and does not type it. Read defensively:
 * an entry added in memory holds its raw bytes there instead.
 */
export function declaredUncompressedSize(entry: JSZip.JSZipObject): number | null {
  const data = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data;
  const size = data?.uncompressedSize;
  return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null;
}

export class RepoEntryGate {
  /** Every entry left out, in the order they were met. */
  readonly skipped: SkippedEntry[] = [];

  /** True when `bytes` fit; otherwise records `name` (at `path`) as skipped. */
  admit(name: string, bytes: number, path: string = name): boolean {
    if (bytes <= REPO_REST_MAX_BYTES) return true;
    this.skipped.push({ path, name, bytes });
    return false;
  }

  /**
   * The entry's bytes when they fit, or null (recorded as skipped) when not.
   *
   * The declared size is checked BEFORE decompressing, so an entry that is too
   * large is never inflated into memory at all. The bytes are measured again
   * afterwards, because a header is only a claim.
   */
  async read(entry: JSZip.JSZipObject, name: string): Promise<Buffer | null> {
    const declared = declaredUncompressedSize(entry);
    if (declared !== null && !this.admit(name, declared, entry.name)) return null;

    const buffer = await entry.async('nodebuffer');
    return this.admit(name, buffer.length, entry.name) ? buffer : null;
  }

  /**
   * Record an entry left out for a reason of the caller's own, with the
   * sentence its warning says — a video bound for media storage whose write
   * failed. Through the gate rather than beside it, so the entry takes the
   * same road as one over the cap: its references are removed from the deck
   * (`skippedPaths`) and its warning names the slides that used it.
   */
  skip(name: string, bytes: number, path: string, sentence: string): void {
    this.skipped.push({ path, name, bytes, reason: sentence });
  }

  /** The zip paths of the entries left out so far. */
  skippedPaths(): Set<string> {
    return new Set(this.skipped.map(entry => entry.path));
  }

  /**
   * One sentence per entry left out, naming the slides that used it where the
   * importer found any: `Slide 3: Skipped lecture.mp4 (40 MB) — …`.
   */
  warnings(slidesByPath: ReadonlyMap<string, readonly string[]> = new Map()): string[] {
    return this.skipped.map(entry => {
      const sentence = entry.reason ?? repoFileSkippedWarning(entry.name, entry.bytes);
      const slides = slidesByPath.get(entry.path) ?? [];
      if (slides.length === 0) return sentence;
      return `${slides.length === 1 ? 'Slide' : 'Slides'} ${slides.join(', ')}: ${sentence}`;
    });
  }
}

/** What a reference in the deck's HTML names. */
export type MediaRef = { kind: 'kept'; url: string } | { kind: 'skipped'; path: string } | null;

/** A reference as it would name a zip path: no query, fragment, `./` or `/`. */
function normalizeRef(value: string): string {
  let ref = value.split(/[?#]/)[0];
  while (ref.startsWith('./')) ref = ref.slice(2);
  while (ref.startsWith('/')) ref = ref.slice(1);
  try {
    return decodeURI(ref);
  } catch {
    return ref;
  }
}

const basename = (path: string) => path.split('/').pop() ?? path;

/**
 * Resolve one reference against the files the import kept and the ones it left
 * out.
 *
 * `kept` is the importer's map — each kept file under its zip path AND its bare
 * filename, to the URL it now lives at. `skipped` is zip paths.
 *
 * Exact matches first, skipped then kept, and only then the importer's fuzzy
 * rule (same filename at the end of the reference, or the path somewhere in
 * it). The order is the point: a skipped `media/b/intro.mp4` named exactly by
 * the deck must be removed, not rewritten to a kept `media/a/intro.mp4` that
 * happens to share its filename.
 */
export function resolveMediaRef(
  value: string,
  kept: ReadonlyMap<string, string>,
  skipped: ReadonlySet<string>
): MediaRef {
  const ref = normalizeRef(value);

  // Skipped first: `kept` also holds every kept file under its bare filename,
  // so a skipped file named exactly by its path must win over that key.
  if (skipped.has(value)) return { kind: 'skipped', path: value };
  if (skipped.has(ref)) return { kind: 'skipped', path: ref };
  const exact = kept.get(value) ?? kept.get(ref);
  if (exact !== undefined) return { kind: 'kept', url: exact };

  // A whole zip path inside the reference (`../media/b/intro.mp4`) names that
  // file more precisely than a shared filename does — longest path wins,
  // kept or skipped.
  let best: MediaRef = null;
  let bestLength = 0;
  for (const [oldPath, url] of kept) {
    if (oldPath.includes('/') && oldPath.length > bestLength && value.includes(oldPath)) {
      best = { kind: 'kept', url };
      bestLength = oldPath.length;
    }
  }
  for (const path of skipped) {
    if (path.includes('/') && path.length > bestLength && value.includes(path)) {
      best = { kind: 'skipped', path };
      bestLength = path.length;
    }
  }
  if (best) return best;

  // Then the filename alone, the importer's long-standing fallback.
  for (const [oldPath, url] of kept) {
    if (value.endsWith('/' + basename(oldPath)) || value.includes(oldPath)) {
      return { kind: 'kept', url };
    }
  }
  for (const path of skipped) {
    const name = basename(path);
    if (ref === name || ref.endsWith('/' + name)) {
      return { kind: 'skipped', path };
    }
  }
  return null;
}

/**
 * Where a node sits in the deck, as Reveal numbers slides: `3` for the third
 * slide, `3.2` for the second slide of the third vertical stack. Null for a
 * node outside every slide.
 *
 * Takes the node's ancestor `<section>`s, innermost first, and each one's
 * position among its sibling sections — computed by the caller with whatever
 * HTML library it holds, so this stays free of one.
 */
export function slideNumberLabel(sectionIndexes: readonly number[]): string | null {
  if (sectionIndexes.length === 0) return null;
  // Outermost first: the horizontal index, then the vertical one inside it.
  return [...sectionIndexes]
    .reverse()
    .slice(0, 2)
    .map(index => String(index + 1))
    .join('.');
}
