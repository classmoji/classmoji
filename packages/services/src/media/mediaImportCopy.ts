import { CopyObjectCommand, DeleteObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import getPrisma from '@classmoji/database';
import { isMediaConfigured, mediaBucket } from './mediaConfig.ts';
import { mediaKey } from './mediaKeys.ts';
import type { MediaKind } from './mediaKinds.ts';
import { billedBytes, liveRowsWhere, mediaRef, type MediaRow } from './mediaLookup.ts';
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
 * ## "Never a half-rewritten file", decided
 *
 * `rewrite` replaces a reference only when its object was copied and its new
 * row is READY; every other reference in the same file is left byte-for-byte as
 * it was. The invariant that holds is the one the plan cares about: NO file
 * ever points at a new id whose object does not exist. The alternative — leave
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
 * which the destination signs for itself on render. Any variant — the original,
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
 * whole.
 */
const SIGNED_MEDIA_URL_PATTERN = new RegExp(
  `(?:https?:\\/\\/[^\\s"'()<>\\/\\\\]+|(?<![^\\s"'(<>,;]))` +
    `\\/c\\/([0-9a-fA-F-]{36})\\/media\\/(${UUID})\\/[A-Za-z0-9._-]+` +
    `(?:\\?[^\\s"'()<>,\\\\]*)?`,
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
 * Replace every reference whose object was copied with `media://{newId}`.
 *
 * Only ids in `copied` move; everything else — an object that could not be
 * copied, one that was never the source's, a signed URL for another classroom —
 * comes back exactly as it was. See the header for why that is the rule.
 */
export function rewriteMediaRefs(
  text: string,
  sourceClassroomId: string,
  copied: ReadonlyMap<string, string>
): string {
  if (copied.size === 0 || typeof text !== 'string' || text.length === 0) return text;
  const source = sourceClassroomId.toLowerCase();

  const withUrls = text.replace(
    SIGNED_MEDIA_URL_PATTERN,
    (url: string, classroomId: string, mediaId: string) => {
      if (classroomId.toLowerCase() !== source) return url;
      const next = copied.get(mediaId.toLowerCase());
      return next ? mediaRef(next) : url;
    }
  );

  return withUrls.replace(MEDIA_REF_PATTERN, (ref: string, mediaId: string) => {
    const next = copied.get(mediaId);
    return next ? mediaRef(next) : ref;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Copying objects
// ─────────────────────────────────────────────────────────────────────────────

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

type Reservation = { ok: true } | { ok: false; usedBytes: number; quotaBytes: number };

/**
 * One object: reserve, copy, READY — or back out and say why.
 *
 * Returns the new id, or null when the object was not copied (already warned).
 */
async function copyOne({
  client,
  bucket,
  row,
  opts,
}: {
  client: S3Client;
  bucket: string;
  row: MediaRow;
  opts: MediaImportCopyOptions;
}): Promise<string | null> {
  const { sourceClassroomId, targetClassroomId, warn } = opts;
  const newId = randomUUID();

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
  const bytes = billedBytes(row);
  const quotaBytes = quotaBytesFor(true);
  const reserved: Reservation = await getPrisma().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM classrooms WHERE id = ${targetClassroomId} FOR UPDATE`;

    const live = (await tx.mediaObject.findMany({
      where: liveRowsWhere(targetClassroomId),
    })) as MediaRow[];
    const usedBytes = live.reduce((total, other) => total + billedBytes(other), 0);
    if (usedBytes + bytes > quotaBytes) return { ok: false, usedBytes, quotaBytes };

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
      },
    });
    return { ok: true };
  });

  if (!reserved.ok) {
    warn(`Skipped ${describe(row)}: the destination class is over its media storage quota`);
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
    // Every destination key, not just the ones that answered: a copy that
    // timed out may still have landed, and with the row gone nothing would
    // ever find it. R2 answers a delete of a missing key with success.
    await deleteQuietly(
      client,
      bucket,
      copies.map(copy => copy.to)
    );
    await releaseReservation(newId);
    warn(`Could not copy ${describe(row)} into this class: ${errText(error)}`);
    return null;
  }

  // READY only FROM the reservation. The copy mirrors the source's processing
  // state: DONE stays DONE (the rendition came along), anything else is NONE —
  // PENDING would claim a job is queued for the copy, and none is.
  const { count } = await getPrisma().mediaObject.updateMany({
    where: { id: newId, status: 'UPLOADING' },
    data: {
      status: 'READY',
      ready_at: new Date(),
      processing: row.processing === 'DONE' ? 'DONE' : 'NONE',
    },
  });
  if (count === 0) {
    // Somebody deleted the reservation underneath us (the media page lists
    // UPLOADING rows and can delete them). Nothing will serve these bytes.
    await deleteQuietly(client, bucket, landed);
    warn(`Could not copy ${describe(row)} into this class: the copy was removed while it ran`);
    return null;
  }
  return newId;
}

/**
 * Drop a reservation whose copy failed. Best effort: a row this cannot remove
 * is an UPLOADING row, which leaves the quota sum when its window passes and is
 * never served.
 */
async function releaseReservation(mediaId: string): Promise<void> {
  try {
    await getPrisma().mediaObject.deleteMany({ where: { id: mediaId, status: 'UPLOADING' } });
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
  /** Asked once per run, and only when there is an object to copy. */
  let refusal: Promise<string | null> | null = null;
  const knownCopies = opts.knownCopies ?? {};

  /**
   * Take over the copies an earlier run made, for the wanted ids that have one
   * still READY in the destination; those leave `wanted`.
   */
  async function reuseKnownCopies(wanted: Set<string>): Promise<void> {
    const candidates = [...wanted].filter(
      id => typeof knownCopies[id] === 'string' && knownCopies[id].length > 0
    );
    if (candidates.length === 0) return;
    const live = (await getPrisma().mediaObject.findMany({
      where: {
        classroom_id: targetClassroomId,
        status: 'READY',
        id: { in: candidates.map(id => knownCopies[id]) },
      },
      select: { id: true },
    })) as { id: string }[];
    const ready = new Set(live.map(row => row.id));
    for (const id of candidates) {
      const copy = knownCopies[id];
      if (!ready.has(copy)) continue;
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
      for (const row of rows) {
        settled.add(row.id);
        warn(
          `Skipped ${describe(row)}: ${reason ?? 'media storage is not configured on this deployment'}`
        );
      }
      return;
    }

    // One object at a time. Each holds the destination's lock only for its own
    // SUM and INSERT, and the copies are server-side, so running them in
    // parallel would buy little and would race this run's own reservations
    // against each other for no reason.
    for (const row of rows) {
      settled.add(row.id);
      const newId = await copyOne({ client, bucket, row, opts });
      if (newId) {
        copied.set(row.id, newId);
        opts.onCopied?.(row.id, newId);
      }
    }
  }

  return {
    prepare,
    rewrite: text => rewriteMediaRefs(text, sourceClassroomId, copied),
    copiedIdFor: sourceMediaId => copied.get(sourceMediaId) ?? null,
  };
}
