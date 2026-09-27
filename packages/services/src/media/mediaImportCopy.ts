import { CopyObjectCommand, DeleteObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import getPrisma from '@classmoji/database';
import { isMediaConfigured, mediaBucket } from './mediaConfig.ts';
import { mediaKey } from './mediaKeys.ts';
import type { MediaKind } from './mediaKinds.ts';
import {
  billedBytes,
  findMediaRow,
  liveRowsWhere,
  mediaRef,
  type MediaRow,
} from './mediaLookup.ts';
import { quotaBytesFor } from './mediaQuota.ts';
import { r2Client } from './r2Client.ts';
import { uploadCapabilityFor } from './uploadCapability.ts';

/**
 * Copying a classroom's media objects into another classroom, for an import.
 *
 * Course content is copied between classrooms two ways — the class-to-class
 * import (`contentImport.service.ts`, page by page and deck by deck) and the
 * term rollover (`packages/tasks`, one whole-repo clone). Both carry the TEXT
 * of the content across, and for anything in git that is the whole job: the
 * bytes come along in the same commit. A media reference is different. It
 * names a row in `media_objects`, and that row belongs to the SOURCE
 * classroom — the resolver looks a `media://{id}` up scoped to the classroom
 * rendering it, so in the copy it is simply not found and renders as the
 * `/missing/` placeholder. The copy has to bring the object with it.
 *
 * So for every media object the copied content references, this module:
 *
 *   1. PROVES the object is the source classroom's, in SQL — `classroom_id =
 *      source AND status = 'READY'` in the WHERE clause, the same shape as
 *      every other media read. A reference to some third classroom's object is
 *      never in hand, so it cannot be copied; it is left exactly as it was and
 *      named in a warning;
 *   2. asks whether the destination can hold media at all — Pro, a configured
 *      bucket, a classroom whose content can be served (`uploadCapabilityFor`).
 *      If not, nothing is copied and each object is named in a warning;
 *   3. RESERVES the destination's quota before a byte moves, with the exact
 *      lock-sum-insert `createUpload` uses: `SELECT … FOR UPDATE` on the
 *      destination classroom, the live-rows sum, and an UPLOADING row, all in
 *      one transaction. Two imports into one classroom serialize on that lock,
 *      and so does an import racing an ordinary upload;
 *   4. R2 `CopyObject`s the original — and the rendition and poster when the
 *      row has them — to the same variant names under a NEW id in the
 *      destination's prefix. Server-side: the bytes never pass through this
 *      process, which matters for a 2 GiB lecture recording;
 *   5. and only when every copy of that object has landed, flips the row to
 *      READY. A copy that fails deletes whatever landed (best effort), removes
 *      the reservation, warns, and the object counts as not copied.
 *
 * The old→new id map lives for the whole import run, so one video embedded in
 * twelve pages is copied once, and a later pass (the slides after the pages,
 * the page covers after the tree) finds it already done.
 *
 * ## Across runs: a retried import reuses its copies
 *
 * The term rollover persists each old→new pair as it lands (`onCopied` →
 * `ImportIdMaps.media` on the job row) and hands the map back to the next run
 * as `knownCopies`. A retried run reuses a known copy only if the destination
 * still has it READY — proven in SQL scoped to the destination, the same shape
 * as the source proof — and copies again when the copy is gone (deleted, or
 * never finished). So a retry never bills the destination twice for one
 * object, and never repoints a reference at a copy that does not exist.
 *
 * The pair can be lost — the rollover's progress writes are debounced and
 * best effort, and a hard kill loses the last one — so a run that has a stable
 * id of its own (the import job's) passes it as `copyIdSeed`, and every copy's
 * id is DERIVED from it and the source id (`importCopyId`, a name-based uuid).
 * A retry of the same job then finds a copy by id alone, READY in the
 * destination, whether or not the pair was ever written down. A reservation an
 * earlier attempt left UPLOADING under that id is taken over (its keys are the
 * same, so the copy overwrites whatever half landed); an id whose row is gone
 * for good (a discarded copy, tombstoned) is not reused, and the copy gets a
 * fresh random id.
 *
 * Because two attempts of one job write the SAME keys under a derived id, no
 * attempt treats those keys as its own to delete. Before any cleanup under a
 * derived id the row is read again, and when another attempt has already
 * flipped it READY its objects are left alone and the copy is REUSED — it is
 * the same source object, byte for byte. A reused copy is not this run's to
 * `discard`, exactly like one from `knownCopies`. A reservation this attempt
 * meant to take over but found already gone from UPLOADING is never counted as
 * taken over. And each attempt flips, releases and cleans up only the row it
 * inserted itself, told apart by the `created_at` it wrote (see `copyOne`), so
 * a reservation another attempt re-inserted under the same id stays that
 * attempt's — to finish, or to discard.
 *
 * A caller whose commit of the rewritten content FAILED calls `discard`: the
 * copies this run made are deleted (`deleteMedia` — tombstone, then the
 * objects), because nothing references them and a destination should not pay
 * for them. Copies reused from `knownCopies` are left alone — content an
 * earlier run DID commit may point at them. A discarded pair can stay in the
 * persisted map; the next run finds its copy gone and copies again. A run that
 * commits more than once (the pages, then the decks) calls `keep` as each
 * commit lands, so a LATER commit that fails discards only its own copies, never
 * ones the committed content already names.
 *
 * ## "Never a half-rewritten file", decided
 *
 * `rewrite` repoints a reference only when its object was copied and its new
 * row is READY; every other `media://` reference in the same file is left
 * byte-for-byte as it was, and a signed URL naming the source whose object was
 * not copied becomes the bare `media://{sourceId}` (so no source signature is
 * ever carried into the copy; see "Signed URLs are references too"). The
 * invariant that holds is the one the plan cares about: NO file ever points at
 * a new id whose object does not exist. The alternative — leave
 * the whole file untouched when any one of its objects could not be copied —
 * was weighed and rejected: it would strand the copies that DID succeed (billed
 * to the destination, referenced by nothing) and leave more broken references
 * in the copy, not fewer. A reference that could not be copied is broken in the
 * copy either way; this keeps the ones that could be fixed, fixed.
 *
 * ## Signed URLs are references too
 *
 * A `media://` reference is what content stores, but a signed delivery URL —
 * `https://{origin}/c/{classroomId}/media/{mediaId}/{variant}?…` — can reach
 * storage as well (pasted from a rendered page, or saved before the editor
 * canonicalized its own URLs). One naming the SOURCE classroom is treated
 * exactly like `media://{mediaId}`: copied, and rewritten to `media://{newId}`,
 * which the destination signs for itself on render — and when it could NOT be
 * copied, still rewritten, to the bare `media://{mediaId}`: the signature is
 * the source's, and it never travels into the copy. Any variant — the original,
 * the rendition, the poster — becomes the bare reference, the same rule
 * `canonicalizeAssetRef` applies on save. A signed URL naming any OTHER
 * classroom is the third-classroom case and is left alone with a warning; it
 * was already unusable outside that classroom, and a copy cannot change that.
 *
 * Matched by PATH shape, never parsed as a URL: in `index.html` the query
 * string's `&` arrives as `&amp;`, which a strict parse rejects, and the path
 * carries everything this needs. The host is deliberately not checked (unlike
 * `canonicalizeAssetRef`'s save path): what binds a rewrite to a real object
 * here is the SQL proof in step 1, not the string — a URL naming the source
 * classroom and one of its READY objects is copied as that object, whatever
 * host it was written against, which also keeps URLs minted before a delivery
 * origin changed working.
 *
 * ## The AWS SDK boundary
 *
 * This module imports `@aws-sdk/client-s3`, so it is reached ONLY through a
 * dynamic `import()` — from `contentImport.service.ts`, and only once some
 * copied text actually contains a media reference. See `openImportMediaCopy`
 * there.
 */

/** What an import tells its user; the caller scopes and caps it. */
export type MediaCopyWarn = (detail: string) => void;

export interface MediaImportCopyOptions {
  sourceClassroomId: string;
  targetClassroomId: string;
  /**
   * Who is running the import. The copies are recorded as uploaded by them —
   * they are the one who put the object in this classroom. Falls back to the
   * source row's uploader when the caller has nobody to name.
   */
  importedBy?: string | null;
  warn: MediaCopyWarn;
  /**
   * Copies an earlier run of the same import already made: source id →
   * destination id. Reused when the destination row is still READY; anything
   * else is copied again. See the header.
   */
  knownCopies?: Readonly<Record<string, string>> | null;
  /** Called once per object this run copies, so the caller can persist the pair. */
  onCopied?: (sourceMediaId: string, copyMediaId: string) => void;
  /**
   * A stable id for the whole import (the job's), so each copy's id is derived
   * from it and the source id and a retry finds its copies without the
   * persisted map. See the header. Absent: every copy gets a random id.
   */
  copyIdSeed?: string | null;
}

export interface MediaImportCopier {
  /**
   * Copy every media object the given texts reference that this run has not
   * already dealt with. Never throws for a per-object failure — those are
   * warned about and the object stays uncopied.
   */
  prepare(texts: readonly string[]): Promise<void>;
  /** Rewrite the references whose objects were copied; everything else verbatim. */
  rewrite(text: string): string;
  /** The destination id a source object was copied to, or null. */
  copiedIdFor(sourceMediaId: string): string | null;
  /**
   * Delete every copy THIS run made since the last `keep` (never one reused
   * from `knownCopies`, nor one found READY under its derived id that another
   * attempt made), for a caller whose content never landed — see the
   * header. Afterwards `rewrite` no longer repoints at them, and a later
   * `prepare` copies those objects again. Never throws.
   */
  discard(): Promise<void>;
  /**
   * Every copy made so far is now referenced by committed content: a later
   * `discard` (a LATER commit that failed) leaves it alone.
   */
  keep(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Finding and rewriting references (pure)
// ─────────────────────────────────────────────────────────────────────────────

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * `media://{uuid}` — lowercase, exactly as `parseMediaRef` accepts it. A ref in
 * any other spelling does not resolve in the source either, so it is not one to
 * copy. The lookahead stops a longer token that merely starts with a uuid from
 * being read as one.
 */
const MEDIA_REF_PATTERN = new RegExp(`media://(${UUID})(?![0-9A-Za-z-])`, 'g');

/**
 * A signed media URL: an optional scheme and host, then
 * `/c/{classroomId}/media/{mediaId}/{variant}` and an optional query.
 *
 * Without a host, the path must start a value — the start of the text, a quote,
 * a bracket, whitespace, a comma or a semicolon (`srcset` lists, `&quot;`) — so
 * the tail of somebody else's URL that happens to contain the same segments is
 * never rewritten from the middle.
 *
 * The query stops at a comma (a `srcset` or `data-background-video` list) and at
 * a backslash (a `\"` inside deck.json's HTML-in-JSON); signed query values are
 * base64url and numbers, so neither can occur inside one. It runs THROUGH `&`
 * and `;`, which is what lets an `&amp;`-escaped query in `index.html` be taken
 * whole — but it stops before an HTML-escaped quote (`&quot;`, `&#34;`,
 * `&#39;`), so `url(&quot;…?p=x&amp;sig=y&quot;)` in an inline style loses only
 * the URL, never the closing quote.
 */
const SIGNED_MEDIA_URL_PATTERN = new RegExp(
  `(?:https?:\\/\\/[^\\s"'()<>\\/\\\\]+|(?<![^\\s"'(<>,;]))` +
    `\\/c\\/([0-9a-fA-F-]{36})\\/media\\/(${UUID})\\/[A-Za-z0-9._-]+` +
    `(?:\\?(?:(?!&(?:quot|#34|#39);)[^\\s"'()<>,\\\\])*)?`,
  'gi'
);

/** What one piece of text references, split by whose it claims to be. */
export interface CollectedMediaRefs {
  /** Candidate SOURCE object ids — still to be proven by SQL. */
  ids: Set<string>;
  /**
   * Signed URLs naming a classroom other than the source — as their
   * `/c/{classroomId}/media/{mediaId}` path, never with the signature.
   */
  foreignUrls: Set<string>;
}

/**
 * Every media object a text references: `media://` ids, and the ids inside
 * signed URLs that name the SOURCE classroom. A signed URL naming any other
 * classroom is reported separately — it is not a candidate at all.
 *
 * A `media://` reference carries no classroom, so it is only a CANDIDATE here;
 * whether the source actually owns it is the SQL's question, not the string's.
 */
export function collectMediaRefs(text: string, sourceClassroomId: string): CollectedMediaRefs {
  const ids = new Set<string>();
  const foreignUrls = new Set<string>();
  if (typeof text !== 'string' || text.length === 0) return { ids, foreignUrls };

  for (const [, id] of text.matchAll(MEDIA_REF_PATTERN)) ids.add(id);

  const source = sourceClassroomId.toLowerCase();
  for (const match of text.matchAll(SIGNED_MEDIA_URL_PATTERN)) {
    const [, classroomId, mediaId] = match;
    if (classroomId.toLowerCase() === source) ids.add(mediaId.toLowerCase());
    // The PATH only. The full URL carries a live signature, and a warning is
    // persisted on the import job and shown in a banner.
    else foreignUrls.add(`/c/${classroomId.toLowerCase()}/media/${mediaId.toLowerCase()}`);
  }
  return { ids, foreignUrls };
}

/**
 * Replace every reference whose object was copied with `media://{newId}`, and
 * every signed URL naming the source with a bare reference.
 *
 * Only ids in `copied` move to a new id. A `media://` reference whose object
 * was not copied, and a signed URL for another classroom, come back exactly as
 * they were; a signed URL naming the SOURCE whose object was not copied comes
 * back as `media://{sourceId}` — never with its signature. See the header.
 */
export function rewriteMediaRefs(
  text: string,
  sourceClassroomId: string,
  copied: ReadonlyMap<string, string>
): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  const source = sourceClassroomId.toLowerCase();

  // EVERY signed URL naming the source becomes a bare reference, copied or
  // not: its object's copy when there is one, otherwise the SOURCE id. A URL
  // carries a live signature for the source classroom, and a copy that could
  // not be made must not carry it into the destination's content (where it
  // would keep serving the source's bytes until it expired). The bare source
  // reference resolves, in the destination, to the `/missing/` placeholder —
  // the lookup is scoped to the classroom rendering it — which is exactly what
  // an uncopied object is there.
  const withUrls = text.replace(
    SIGNED_MEDIA_URL_PATTERN,
    (url: string, classroomId: string, mediaId: string) => {
      if (classroomId.toLowerCase() !== source) return url;
      const id = mediaId.toLowerCase();
      return mediaRef(copied.get(id) ?? id);
    }
  );
  if (copied.size === 0) return withUrls;

  return withUrls.replace(MEDIA_REF_PATTERN, (ref: string, mediaId: string) => {
    const next = copied.get(mediaId);
    return next ? mediaRef(next) : ref;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Copying objects
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The namespace `importCopyId` hashes under. Fixed forever: changing it would
 * make every retry of a job started before the change miss its own copies.
 */
const IMPORT_COPY_NAMESPACE = '6f1c6a52-0f3e-4f8e-9b7a-3c2d8e4a1b90';

/** An RFC 4122 version-5 (SHA-1, name-based) uuid, lowercase. */
export function uuidV5(namespace: string, name: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The id an import with this seed gives its copy of `sourceMediaId`. See the header. */
export function importCopyId(seed: string, sourceMediaId: string): string {
  return uuidV5(IMPORT_COPY_NAMESPACE, `${seed}:${sourceMediaId}`);
}

/** How a kind reads in a warning: `Skipped video "lecture.mp4": …`. */
const KIND_LABEL: Record<MediaKind, string> = {
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document',
  ARCHIVE: 'archive',
  IMAGE: 'image',
  OTHER: 'file',
};

function describe(row: Pick<MediaRow, 'kind' | 'filename'>): string {
  return `${KIND_LABEL[row.kind] ?? 'file'} "${row.filename}"`;
}

/** Why an object was skipped when the destination's media storage had no room for it. */
export const DESTINATION_FULL_REASON =
  "the destination class's media storage is full (contact hello@classmoji.io to upgrade)";

/** How many files a skip summary names before it counts the rest. */
const SKIPPED_NAMED_MAX = 5;

/**
 * Every object a pass could not copy for one shared reason, as one warning:
 * `Skipped video "a.mp4": …` for one, `Skipped 12 media files (video "a.mp4",
 * …, and 7 more): …` for many.
 */
export function skippedSummary(
  rows: readonly Pick<MediaRow, 'kind' | 'filename'>[],
  reason: string
): string {
  if (rows.length === 1) return `Skipped ${describe(rows[0])}: ${reason}`;
  const named = rows.slice(0, SKIPPED_NAMED_MAX).map(describe);
  const more = rows.length - named.length;
  return (
    `Skipped ${rows.length} media files (${named.join(', ')}` +
    `${more > 0 ? `, and ${more} more` : ''}): ${reason}`
  );
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `CopySource` is `{bucket}/{key}`, URL-encoded, with the key's own slashes kept
 * literal. Our keys are uuids and a closed list of variant names, so the
 * encoding is a formality — but it is the SDK's documented contract, and a key
 * shape that ever grows a character that needs it must not break copies here.
 */
function copySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/** The last path segment of a stored key — the variant name it was written as. */
function variantOf(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

/**
 * Why the destination cannot take media at all, or null when it can.
 *
 * `uploadCapabilityFor` answers the question the editor's upload button asks —
 * Pro, a configured bucket, a classroom whose content can be served — but only
 * as yes/no. The warning has to say WHICH, because each one is a different
 * thing for the instructor to do, so the reason is recovered from the pieces in
 * the same order `createUpload` checks them.
 */
async function destinationRefusal(targetClassroomId: string): Promise<string | null> {
  if (!isMediaConfigured()) return 'media storage is not configured on this deployment';
  const capability = await uploadCapabilityFor({ id: targetClassroomId });
  if (capability.media) return null;
  if (!capability.isPro) return 'the destination class has no media storage (Pro)';
  return 'the destination class cannot serve media (content delivery is not available for it)';
}

/** Delete keys one at a time, and never let one failure stop the rest. */
async function deleteQuietly(client: S3Client, bucket: string, keys: string[]): Promise<void> {
  for (const key of keys) {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch (error) {
      console.warn(`[media] Could not delete ${key} after a failed import copy:`, errText(error));
    }
  }
}

type Reservation =
  /** `createdAt`: the marker the reservation was inserted with. */
  | { ok: true; createdAt: Date }
  | { ok: false; full: true; usedBytes: number; quotaBytes: number }
  /** The reservation to take over had already left UPLOADING (READY, or deleted). */
  | { ok: false; full: false };

/**
 * What `copyOne` settled on: the destination id, and whether THIS attempt made
 * the copy (`made`) or found another attempt's copy READY under the derived id
 * and reused it — which, like a known copy, is not this run's to discard.
 */
type CopyOutcome = { id: string; made: boolean };

/**
 * One object: reserve, copy, READY — or back out and say why.
 *
 * Returns the outcome, or null when the object was not copied (already warned).
 */
async function copyOne({
  client,
  bucket,
  row,
  opts,
  onQuotaFull,
}: {
  client: S3Client;
  bucket: string;
  row: MediaRow;
  opts: MediaImportCopyOptions;
  /** The destination had no room for this object; the caller warns. */
  onQuotaFull: (row: MediaRow) => void;
}): Promise<CopyOutcome | null> {
  const { sourceClassroomId, targetClassroomId, warn } = opts;

  // The copy's id: derived when the run has a seed, so a retry finds it (see
  // the header), unless a row that cannot be taken over already holds it.
  let newId: string = randomUUID();
  /**
   * The id is the derived one, so another attempt of this import can be
   * writing the same keys and may flip the row READY at any point.
   */
  let derived = false;
  /** An earlier attempt's UPLOADING reservation under this id, to take over. */
  let takeOver = false;
  /**
   * This attempt's mark on the row it reserves: the `created_at` it writes,
   * set once the insert is decided. See the reservation below.
   */
  let marker: Date | null = null;
  if (opts.copyIdSeed) {
    const derivedId = importCopyId(opts.copyIdSeed, row.id);
    let holder: { classroom_id: string; status: string } | null;
    try {
      holder = (await getPrisma().mediaObject.findUnique({
        where: { id: derivedId },
        select: { classroom_id: true, status: true },
      })) as { classroom_id: string; status: string } | null;
    } catch (error) {
      warn(`Could not copy ${describe(row)} into this class: ${errText(error)}`);
      return null;
    }
    if (!holder) {
      newId = derivedId;
      derived = true;
    } else if (holder.classroom_id === targetClassroomId && holder.status === 'UPLOADING') {
      newId = derivedId;
      derived = true;
      takeOver = true;
    }
  }

  /**
   * Whose the row and keys under `newId` are, asked before any cleanup. A
   * random id is this attempt's alone ('free'). A derived one is shared with
   * every other attempt of the import, so the row is read again and told apart
   * by its marker (`created_at`):
   *
   *   - 'free': no row, a tombstone, or this attempt's own reservation — the
   *     keys are this attempt's to clean up;
   *   - 'mine': READY and carrying this attempt's marker — its own copy;
   *   - 'ready': READY under another attempt's marker — that attempt's finished
   *     copy, reused and never deleted;
   *   - 'other': another attempt's reservation, still in flight — left alone;
   *   - 'unknown': the read failed. Nothing is deleted (a stray object costs
   *     little; deleting a served one does not) and nothing is reused (a
   *     reference must never point at a copy not proven READY).
   */
  const keysState = async (): Promise<'free' | 'mine' | 'ready' | 'other' | 'unknown'> => {
    if (!derived) return 'free';
    let fresh: MediaRow | null;
    try {
      fresh = await findMediaRow(targetClassroomId, newId);
    } catch (error) {
      console.warn(`[media] Could not re-read import copy ${newId}:`, errText(error));
      return 'unknown';
    }
    if (!fresh || fresh.status === 'DELETED') return 'free';
    const ours = marker !== null && fresh.created_at?.getTime() === marker.getTime();
    if (fresh.status === 'READY') return ours ? 'mine' : 'ready';
    return ours ? 'free' : 'other';
  };
  /** The warning for a copy this attempt could neither finish nor account for. */
  const unconfirmed = () =>
    warn(`Could not copy ${describe(row)} into this class: could not confirm the copy`);

  // Every key is built — and validated by `mediaKey` — before anything is
  // written, so a variant the grammar does not accept is a refusal for this
  // one object rather than a reservation with nothing behind it.
  //
  // The ORIGINAL is skipped when the rendition job has dropped it: the key
  // names bytes that are gone, and a CopyObject would fail a copy that is
  // otherwise complete. The rendition and poster are copied from the key the
  // ROW names (the job records where it wrote them) to the same variant name
  // under the new id.
  let copies: { from: string; to: string }[];
  let renditionKey: string | null = null;
  let posterKey: string | null = null;
  try {
    copies = [];
    if (row.original_deleted_at === null) {
      copies.push({
        from: mediaKey(sourceClassroomId, row.id, `orig.${row.ext}`),
        to: mediaKey(targetClassroomId, newId, `orig.${row.ext}`),
      });
    }
    if (row.rendition_key) {
      renditionKey = mediaKey(targetClassroomId, newId, variantOf(row.rendition_key));
      copies.push({ from: row.rendition_key, to: renditionKey });
    }
    if (row.poster_key) {
      posterKey = mediaKey(targetClassroomId, newId, variantOf(row.poster_key));
      copies.push({ from: row.poster_key, to: posterKey });
    }
  } catch (error) {
    warn(`Could not copy ${describe(row)} into this class: ${errText(error)}`);
    return null;
  }
  if (copies.length === 0) {
    warn(`Could not copy ${describe(row)} into this class: the source object has no stored bytes`);
    return null;
  }

  // The reservation, exactly as `createUpload` makes one: the sum and the
  // insert it authorizes in ONE transaction, behind a row lock on the
  // destination classroom. Charged at what the source row is BILLED — a row
  // whose original was dropped costs its rendition, and so does its copy.
  //
  // The row's `created_at` doubles as this attempt's marker. Under a derived
  // id, two attempts of one import can each hold a reservation for the same id
  // in turn (a takeover deletes one and inserts the next), and the READY flip,
  // the release and every cleanup must touch only the row THIS attempt
  // inserted — never the one that replaced it. So the insert writes
  // `created_at` itself (the moment the column's own default would record), and
  // the flip and release match on it. Every reader already reads the column as
  // "when this row was inserted", which it still is.
  //
  // Two reservations for one id can never carry the same value. Inserting one
  // takes the destination classroom's lock, so they are inserted one after
  // another; a takeover reads the row it replaces under that lock and writes a
  // marker strictly after it; and an insert into a free id comes after the
  // commit that freed it, several round trips later. (The column is
  // millisecond precision, `TIMESTAMP(3)`, the same as a JS Date.)
  const bytes = billedBytes(row);
  const quotaBytes = quotaBytesFor(true);
  let reserved: Reservation;
  try {
    reserved = await getPrisma().$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM classrooms WHERE id = ${targetClassroomId} FOR UPDATE`;

      // An earlier attempt's reservation under this id stops counting, and the
      // one made below replaces it (same id, same keys). When it is no longer
      // there to remove, that attempt got further (READY) or the row was
      // deleted; either way it was not taken over, and there is nothing to
      // reserve — the id is taken.
      let after = 0;
      if (takeOver) {
        const replaced = (await tx.mediaObject.findUnique({
          where: { id: newId },
          select: { created_at: true },
        })) as { created_at?: Date | null } | null;
        const { count } = await tx.mediaObject.deleteMany({
          where: { id: newId, classroom_id: targetClassroomId, status: 'UPLOADING' },
        });
        if (count === 0) return { ok: false, full: false };
        if (replaced?.created_at) after = replaced.created_at.getTime() + 1;
      }

      const live = (await tx.mediaObject.findMany({
        where: liveRowsWhere(targetClassroomId),
      })) as MediaRow[];
      const usedBytes = live.reduce((total, other) => total + billedBytes(other), 0);
      if (usedBytes + bytes > quotaBytes) return { ok: false, full: true, usedBytes, quotaBytes };

      const createdAt = new Date(Math.max(Date.now(), after));
      marker = createdAt;
      await tx.mediaObject.create({
        data: {
          id: newId,
          classroom_id: targetClassroomId,
          kind: row.kind,
          filename: row.filename,
          ext: row.ext,
          content_type: row.content_type,
          size_bytes: row.size_bytes,
          // A reservation until every copy has landed: counted by the quota sum
          // (`liveRowsWhere`), invisible to the resolver (READY only), and aged
          // out of the sum on its own if this process dies before the flip.
          status: 'UPLOADING',
          uploaded_by: opts.importedBy || row.uploaded_by,
          optimise: row.optimise,
          keep_original: row.keep_original,
          allow_download: row.allow_download,
          rendition_key: renditionKey,
          rendition_bytes: row.rendition_bytes,
          poster_key: posterKey,
          duration_ms: row.duration_ms,
          width: row.width,
          height: row.height,
          original_deleted_at: row.original_deleted_at,
          created_at: createdAt,
        },
      });
      return { ok: true, createdAt };
    });
  } catch (error) {
    // Nothing is in R2 yet, so there is nothing to clean up; the rest of the
    // pass carries on without this object. Nothing was inserted either.
    marker = null;
    warn(`Could not copy ${describe(row)} into this class: ${errText(error)}`);
    return null;
  }

  if (!reserved.ok && !reserved.full) {
    // The reservation to take over left UPLOADING before this attempt's lock:
    // another attempt flipped it READY (its copy is whole — reuse it), or it
    // was deleted. Nothing was written, so nothing is cleaned up.
    const state = await keysState();
    if (state === 'ready') return { id: newId, made: false };
    if (state === 'free') {
      warn(`Could not copy ${describe(row)} into this class: the copy was removed while it ran`);
    } else {
      unconfirmed();
    }
    return null;
  }

  if (!reserved.ok) {
    // Only a reservation THIS attempt took over (the transaction removed it
    // before the sum) leaves keys with no row to reach them through — and even
    // then, not if another attempt has since made the id READY again.
    if (takeOver && (await keysState()) === 'free') {
      await deleteQuietly(
        client,
        bucket,
        copies.map(copy => copy.to)
      );
    }
    // Named by the caller, in one summary for the whole pass.
    onQuotaFull(row);
    return null;
  }

  const landed: string[] = [];
  try {
    for (const { from, to } of copies) {
      // `MetadataDirective: 'COPY'` (the S3 default, stated) carries the
      // source object's content type across. That is the right one: it was
      // decided from the extension when the source was uploaded, and the
      // Worker serves whatever the object says. A single CopyObject covers the
      // whole object — R2 takes up to 5 GiB in one, and the per-file ceiling is
      // 2 GiB.
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: to,
          CopySource: copySource(bucket, from),
          MetadataDirective: 'COPY',
        })
      );
      landed.push(to);
    }
  } catch (error) {
    // Another attempt of this import finished the same copy and flipped the
    // row READY: its objects are whole (a failed CopyObject replaces nothing),
    // so they stay, the row stays, and the copy is reused. ('mine' cannot
    // happen — this attempt has not flipped — and is treated the same way.)
    const state = await keysState();
    if (state === 'ready' || state === 'mine') return { id: newId, made: false };
    // Every destination key, not just the ones that answered: a copy that
    // timed out may still have landed, and with the row gone nothing would
    // ever find it. R2 answers a delete of a missing key with success.
    if (state === 'free') {
      await deleteQuietly(
        client,
        bucket,
        copies.map(copy => copy.to)
      );
    }
    await releaseReservation(newId, reserved.createdAt);
    warn(`Could not copy ${describe(row)} into this class: ${errText(error)}`);
    return null;
  }

  // READY only FROM the reservation. The copy mirrors the source's processing
  // state: DONE stays DONE (the rendition came along), anything else is NONE —
  // PENDING would claim a job is queued for the copy, and none is.
  //
  // And only from THIS attempt's reservation (its marker, `created_at`): a row
  // another attempt re-inserted under the same id after taking this one over
  // is that attempt's to flip, and to discard.
  let count: number;
  try {
    ({ count } = await getPrisma().mediaObject.updateMany({
      where: { id: newId, status: 'UPLOADING', created_at: reserved.createdAt },
      data: {
        status: 'READY',
        ready_at: new Date(),
        processing: row.processing === 'DONE' ? 'DONE' : 'NONE',
      },
    }));
  } catch (error) {
    // The copies are in place and the flip to READY failed. Whether it landed
    // is asked, not assumed — a lost response looks exactly like a failed
    // write — the way `putMediaObject` asks. Loaded here, not at the top, for
    // the reason `discard` gives.
    //
    // Under a derived id the row is read first: it may not be this attempt's
    // any more, and `afterFailedReadyFlip` tombstones whatever UPLOADING row it
    // finds.
    const state = await keysState();
    if (state === 'ready') return { id: newId, made: false };
    if (state === 'mine') return { id: newId, made: true };
    if (state === 'other' || state === 'unknown') {
      unconfirmed();
      return null;
    }
    const { afterFailedReadyFlip } = await import('./media.service.ts');
    const outcome = await afterFailedReadyFlip(targetClassroomId, newId, 'UPLOADING');
    if (outcome !== 'ready') {
      // 'released': the row is tombstoned and nothing will ever serve these
      // keys. 'unknown': a READY row might be serving them, so they stay —
      // `deleteMedia` and the classroom purge still reach them through it.
      if (outcome === 'released') await deleteQuietly(client, bucket, landed);
      warn(`Could not copy ${describe(row)} into this class: ${errText(error)}`);
      return null;
    }
    count = 1;
  }
  if (count === 0) {
    // Under a derived id, another attempt of this import may have taken this
    // reservation over and flipped its own row first: the same source object,
    // identical bytes — reuse it, and leave its objects alone. Still in flight,
    // it is left to that attempt.
    const state = await keysState();
    if (state === 'ready') return { id: newId, made: false };
    if (state === 'mine') return { id: newId, made: true };
    if (state === 'other' || state === 'unknown') {
      unconfirmed();
      return null;
    }
    // Somebody deleted the reservation underneath us (the media page lists
    // UPLOADING rows and can delete them). Nothing will serve these bytes.
    await deleteQuietly(client, bucket, landed);
    warn(`Could not copy ${describe(row)} into this class: the copy was removed while it ran`);
    return null;
  }
  return { id: newId, made: true };
}

/**
 * Drop a reservation whose copy failed. Best effort: a row this cannot remove
 * is an UPLOADING row, which leaves the quota sum when its window passes and is
 * never served. UPLOADING only, and only the row carrying this attempt's
 * marker, in the WHERE clause: a READY row is never removed here, whoever
 * flipped it, and neither is another attempt's reservation.
 */
async function releaseReservation(mediaId: string, marker: Date): Promise<void> {
  try {
    await getPrisma().mediaObject.deleteMany({
      where: { id: mediaId, status: 'UPLOADING', created_at: marker },
    });
  } catch (error) {
    console.warn(`[media] Could not release import reservation ${mediaId}:`, errText(error));
  }
}

/**
 * One copier per import run. The map it holds is the run's old→new id map.
 */
export function createMediaImportCopier(opts: MediaImportCopyOptions): MediaImportCopier {
  const { sourceClassroomId, targetClassroomId, warn } = opts;

  /** source id → destination id, for the objects that made it. */
  const copied = new Map<string, string>();
  /**
   * Every id this run has ALREADY decided about, copied or not, so a later
   * `prepare` neither copies an object twice nor warns about it twice.
   */
  const settled = new Set<string>();
  /** Foreign signed URLs already warned about. */
  const warnedUrls = new Set<string>();
  /** source id → copy id, for the copies THIS run made (what `discard` removes). */
  const created = new Map<string, string>();
  /** Asked once per run, and only when there is an object to copy. */
  let refusal: Promise<string | null> | null = null;
  const knownCopies = opts.knownCopies ?? {};

  /**
   * Take over the copies an earlier run made, for the wanted ids that have one
   * still READY in the destination; those leave `wanted`.
   */
  async function reuseKnownCopies(wanted: Set<string>): Promise<void> {
    /** source id → the ids its copy may have, in order of preference. */
    const candidates = new Map<string, string[]>();
    for (const id of wanted) {
      const ids: string[] = [];
      const known = knownCopies[id];
      if (typeof known === 'string' && known.length > 0) ids.push(known);
      if (opts.copyIdSeed) {
        const derived = importCopyId(opts.copyIdSeed, id);
        if (!ids.includes(derived)) ids.push(derived);
      }
      if (ids.length > 0) candidates.set(id, ids);
    }
    if (candidates.size === 0) return;
    const live = (await getPrisma().mediaObject.findMany({
      where: {
        classroom_id: targetClassroomId,
        status: 'READY',
        id: { in: [...candidates.values()].flat() },
      },
      select: { id: true },
    })) as { id: string }[];
    const ready = new Set(live.map(row => row.id));
    for (const [id, ids] of candidates) {
      const copy = ids.find(candidate => ready.has(candidate));
      if (!copy) continue;
      settled.add(id);
      copied.set(id, copy);
      wanted.delete(id);
    }
  }

  async function prepare(texts: readonly string[]): Promise<void> {
    const wanted = new Set<string>();
    for (const text of texts) {
      const { ids, foreignUrls } = collectMediaRefs(text, sourceClassroomId);
      for (const id of ids) if (!settled.has(id)) wanted.add(id);
      for (const url of foreignUrls) {
        if (warnedUrls.has(url)) continue;
        warnedUrls.add(url);
        warn(`Left a media link unchanged: it belongs to a class other than the source (${url})`);
      }
    }
    if (wanted.size === 0) return;

    await reuseKnownCopies(wanted);
    if (wanted.size === 0) return;

    // The proof. Scoped to the source and to READY in the query itself, so an
    // object of any other classroom — or one deleted, or still uploading — is
    // simply not in the result, and there is no branch that holds a foreign
    // row and then has to decide to refuse it.
    const rows = (await getPrisma().mediaObject.findMany({
      where: { classroom_id: sourceClassroomId, status: 'READY', id: { in: [...wanted] } },
    })) as MediaRow[];
    const found = new Map(rows.map(row => [row.id, row]));

    for (const id of wanted) {
      if (found.has(id)) continue;
      settled.add(id);
      warn(`Left ${mediaRef(id)} unchanged: it is not a file in the source class's media`);
    }
    if (rows.length === 0) return;

    // Cached for the run, but not a FAILURE: a lookup that threw once must not
    // answer every later pass with the same rejection.
    refusal ??= destinationRefusal(targetClassroomId).catch(error => {
      refusal = null;
      throw error;
    });
    const reason = await refusal;
    const client = r2Client();
    const bucket = mediaBucket();
    if (reason || !client || !bucket) {
      for (const row of rows) settled.add(row.id);
      // ONE warning for the lot: every object is skipped for the same reason,
      // and a course with forty videos would otherwise fill the import's
      // bounded warning list with forty copies of one sentence.
      warn(skippedSummary(rows, reason ?? 'media storage is not configured on this deployment'));
      return;
    }

    // One object at a time. Each holds the destination's lock only for its own
    // SUM and INSERT, and the copies are server-side, so running them in
    // parallel would buy little and would race this run's own reservations
    // against each other for no reason.
    const noRoom: MediaRow[] = [];
    for (const row of rows) {
      settled.add(row.id);
      const outcome = await copyOne({
        client,
        bucket,
        row,
        opts,
        onQuotaFull: full => noRoom.push(full),
      });
      if (!outcome) continue;
      copied.set(row.id, outcome.id);
      // A copy another attempt made is reused like a known one: not this run's
      // to discard, and findable by its derived id, so there is no pair to add.
      if (outcome.made) {
        created.set(row.id, outcome.id);
        opts.onCopied?.(row.id, outcome.id);
      }
    }
    if (noRoom.length > 0) warn(skippedSummary(noRoom, DESTINATION_FULL_REASON));
  }

  async function discard(): Promise<void> {
    if (created.size === 0) return;
    // Loaded here, not at the top: `media.service.ts` is the rest of the media
    // store, and a run that never discards has no reason to load it.
    const { deleteMedia } = await import('./media.service.ts');
    for (const [sourceId, copyId] of [...created]) {
      created.delete(sourceId);
      copied.delete(sourceId);
      // Undecided again: a later pass that references the same object (the
      // slides after a page commit that failed) copies it afresh rather than
      // leaving its reference pointing at the source.
      settled.delete(sourceId);
      try {
        await deleteMedia({ classroom: { id: targetClassroomId }, mediaId: copyId });
      } catch (error) {
        console.warn(`[media] Could not remove unused import copy ${copyId}:`, errText(error));
      }
    }
  }

  return {
    prepare,
    rewrite: text => rewriteMediaRefs(text, sourceClassroomId, copied),
    copiedIdFor: sourceMediaId => copied.get(sourceMediaId) ?? null,
    discard,
    keep: () => created.clear(),
  };
}
