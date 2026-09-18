/**
 * slideFile.service.ts — the write and read paths for a slide that is NOT a deck.
 *
 * A FILE slide is one uploaded document (PDF/PPT/PPTX/KEY) committed into the
 * classroom's own content repo at `slides/<slug>/<storage-name>`, beside where
 * a deck's `deck.json` would live. A LINK slide is a row and nothing else — no
 * commit, no folder, just an https destination the viewer is redirected to.
 *
 * ## Why the file goes in the content repo at all
 *
 * Because everything a deck already gets comes with it: the asset map records
 * the blob sha at commit time, the delivery Worker serves it from R2 by that
 * sha under a signed, expiring URL, `deleteSlide` removes the folder and drops
 * the rows, and a class-to-class import copies it like any other content. The
 * alternative — a bucket of our own — would need every one of those built
 * again, and would put the one kind of slide content that is NOT in the repo
 * outside the instructor's ability to see, fork or take with them.
 *
 * ## Why the commit is `uploadBatch` and not `upload`
 *
 * `ContentService.upload` validates against the SHARED policy in
 * `validateFile.ts` — 5 MB, and an extension list built for page images — and
 * would refuse a 40 MB lecture PDF. `uploadBatch` validates nothing, which is
 * why every call below runs `validateSlideFile` explicitly first. It is also
 * the path that routes a >1 MB body through the Git blobs API, which is
 * mandatory here: the Contents API caps at 1 MB and a slide file is usually
 * larger than that.
 */

import getPrisma from '@classmoji/database';
import { ContentService } from '../content/ContentService.ts';
import {
  isDeliverableClassroom,
  recordContentAssets,
  removeContentAssets,
  type DeliverableClassroom,
} from '../classmoji/contentAssets.service.ts';
import * as contentManifestService from '../classmoji/contentManifest.service.ts';
import { ensureContentRepo } from '../classmoji/page.service.ts';
import {
  contentDispositionFor,
  normalizeDownloadFilename,
  resolveSlideDownloadUrl,
  type SlideDownloadRefusal,
  type SlideDownloadResult,
} from '../classmoji/contentDelivery.service.ts';
import {
  isSlideSlugConflict,
  prepareSlideCreate,
  slideContentPathConflict,
} from './slide.service.ts';
import type { SlideContentTarget } from './slideContent.service.ts';
import {
  assertFileSlide,
  assertLinkSlide,
  slideFileSourceProblem,
  slideFileStorageName,
  validateSlideFile,
  validateSlideLinkUrl,
} from './slideSource.ts';

/** Thrown when an upload or a link is refused by policy. 400, not 500. */
export class SlideSourceError extends Error {
  status = 400 as const;
  code = 'SLIDE_SOURCE_REJECTED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SlideSourceError';
  }
}

/**
 * A slide row with the classroom join every path here needs.
 *
 * Structural rather than a Prisma payload type so a narrowed `select` can
 * satisfy it too, and so the unit tests can hand over a literal. It extends the
 * deck engine's target because the repo resolution and the delivery context are
 * the same two questions for both kinds.
 */
export interface SlideFileTarget extends SlideContentTarget {
  /**
   * Narrower than the deck engine's, and required where that one is optional.
   *
   * `content_key_version` and `content_delivery_enabled` decide which key signs
   * a download and whether one is signed at all, and they used to be defaulted
   * here (`?? 0`, `=== true`) for a caller that did not select them. That is
   * exactly the silent failure `ResolveClassroom` in contentDelivery.service.ts
   * made impossible on purpose: the difference between "the gate is off" and
   * "the caller forgot to ask" is the difference between a safe rollout and a
   * classroom served with the wrong key version. Typed as required so the
   * compiler names every builder, and checked again at runtime by
   * `slideDownloadUrl` — because a `select` list is not something tsc verified.
   */
  classroom?:
    | (NonNullable<SlideContentTarget['classroom']> & {
        id: string;
        content_key_version: number;
        content_delivery_enabled: boolean;
      })
    | null;
  source_path?: string | null;
  source_filename?: string | null;
  source_mime?: string | null;
  source_size?: number | null;
  source_url?: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a FILE slide: validate → collision check → ensure the repo → ONE
 * commit → asset row → DB row → manifest refresh.
 *
 * The order is `createSlide`'s, for `createSlide`'s reasons. The collision
 * check runs BEFORE any GitHub write because slug drives the content path, so
 * an unchecked create would overwrite another slide's folder before the DB
 * refused it. The asset row is written from the commit response rather than
 * left to the push webhook, because a download URL is signed from the map and
 * an upload nobody can download for the next thirty seconds is a broken upload.
 *
 * @param file     the whole document, in memory. The caller is responsible for
 *                 refusing an over-cap body BEFORE buffering it — this is the
 *                 last check, not the first one.
 * @param filename the name the browser sent. Sanitized for the git path,
 *                 preserved (as `source_filename`) for the download.
 */
export async function createFileSlide({
  classroomId,
  title,
  createdBy,
  filename,
  file,
}: {
  classroomId: string;
  title: string;
  createdBy: string;
  filename: string;
  file: Buffer;
}) {
  const validation = validateSlideFile({ filename, size: file.length });
  if (!validation.valid) throw new SlideSourceError(validation.error);

  const { classroom, orgLogin, repo, slug, contentPath } = await prepareSlideCreate({
    classroomId,
    title,
  });

  const storageName = slideFileStorageName(filename, slug);
  if (!storageName) throw new SlideSourceError('That filename cannot be used for a slide file.');
  const sourcePath = `${contentPath}/${storageName}`;

  await ensureContentRepo(classroomId);

  const commit = await commitSlideFile({
    gitOrganization: classroom.git_organization,
    repo,
    path: sourcePath,
    file,
    message: `Add slide file: ${title}`,
  });

  // BEFORE the row, and fatal when it fails: the download URL is signed from
  // the map, so a slide whose row exists and whose map row does not is an
  // upload that reported success and 404s (`not_in_map`) until the next sync
  // sweeps the path in — up to a day later. Refusing here leaves an orphan blob
  // in the repo instead, which costs repo size and is fixed by uploading again.
  await recordSlideFileAsset(classroom, {
    path: sourcePath,
    sha: commit.sha,
    size: file.length,
  });

  let slide;
  try {
    slide = await getPrisma().slide.create({
      data: {
        title,
        slug,
        content_path: contentPath,
        classroom_id: classroomId,
        created_by: createdBy,
        kind: 'FILE',
        source_path: sourcePath,
        source_filename: displayFilename(filename, storageName),
        source_mime: validation.mime,
        source_size: file.length,
      },
    });
  } catch (error: unknown) {
    // The collision check in `prepareSlideCreate` is a read, and the commit
    // above sits between it and this insert — a second create for the same
    // title started in that window passed the same read. The loser gets the
    // refusal the read would have given it, and its upload is cleaned up.
    if (!isSlideSlugConflict(error)) throw error;
    await discardLostUpload({
      classroomId,
      gitOrganization: classroom.git_organization,
      repo,
      path: sourcePath,
      title,
    });
    throw slideContentPathConflict(contentPath);
  }

  await refreshManifest(classroomId, 'slide file creation');

  return { slide, orgLogin, path: sourcePath, sha: commit.sha, commit: commit.commit };
}

/**
 * Create a LINK slide. No commit, no folder, no repo call.
 *
 * `content_path` is still set to `slides/<slug>`: it is the row's identity in
 * the content repo, it is what a later kind change or a `deleteSlide` would
 * act on, and leaving it empty would make the column nullable for one kind and
 * force every reader to learn a second shape. Nothing is written there, which
 * is why `ensureContentRepo` is not called — a link is usable in a classroom
 * whose content repo has not been provisioned yet, and provisioning one to
 * store a URL would be a GitHub round trip for nothing.
 */
export async function createLinkSlide({
  classroomId,
  title,
  createdBy,
  url,
}: {
  classroomId: string;
  title: string;
  createdBy: string;
  url: string;
}) {
  const link = validateSlideLinkUrl(url);
  if (!link.ok) throw new SlideSourceError(link.error);

  const { slug, contentPath } = await prepareSlideCreate({ classroomId, title });

  // Same race as the other two creates, with nothing to clean up: a link that
  // lost the slug wrote no file. See `createSlide` for the window itself.
  let slide;
  try {
    slide = await getPrisma().slide.create({
      data: {
        title,
        slug,
        content_path: contentPath,
        classroom_id: classroomId,
        created_by: createdBy,
        kind: 'LINK',
        source_url: link.url,
      },
    });
  } catch (error: unknown) {
    if (isSlideSlugConflict(error)) throw slideContentPathConflict(contentPath);
    throw error;
  }

  await refreshManifest(classroomId, 'link slide creation');

  return { slide, host: link.host };
}

// ─────────────────────────────────────────────────────────────────────────────
// Update
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Swap the document behind a FILE slide, keeping the same slide id and URL.
 *
 * ## The order is the whole design
 *
 * Commit the new file, point the row at it, and only THEN remove the old one.
 * A failure anywhere in the first two steps leaves the slide serving the
 * document it was already serving — which is the outcome that matters, because
 * the alternative ordering (delete, then upload) turns a GitHub hiccup into a
 * slide with no file at all, five minutes before a lecture.
 *
 * The old path is removed only when it DIFFERS from the new one. Re-uploading a
 * file with the same name writes the same path, and the removal would delete
 * the document that was just committed — the exact failure this ordering exists
 * to prevent, arrived at from the other side.
 *
 * Both the delete and the asset-row cleanup are best effort: a leftover blob
 * costs repo size, and the row is overwritten by the same commit's write-
 * through anyway. Neither is worth failing a replace that has already landed.
 */
export async function replaceSlideFile({
  slideId,
  filename,
  file,
}: {
  slideId: string;
  filename: string;
  file: Buffer;
}) {
  const validation = validateSlideFile({ filename, size: file.length });
  if (!validation.valid) throw new SlideSourceError(validation.error);

  const slide = await loadSlideWithClassroom(slideId);
  if (!slide) throw new Error('Slide not found');
  assertFileSlide(slide, 'Replacing a slide file');

  const gitOrganization = slide.classroom?.git_organization;
  const repo = slide.classroom?.content_repo;
  if (!gitOrganization?.login) throw new Error('Git organization not configured');
  if (!repo) throw new Error('Classroom content repo not configured');

  const storageName = slideFileStorageName(filename, slide.slug);
  if (!storageName) throw new SlideSourceError('That filename cannot be used for a slide file.');
  const sourcePath = `${slide.content_path}/${storageName}`;
  const previousPath = slide.source_path;

  const commit = await commitSlideFile({
    gitOrganization,
    repo,
    path: sourcePath,
    file,
    message: `Replace slide file: ${slide.title}`,
  });

  // BEFORE the row moves, and fatal when it fails — the same rule as the
  // create, one step stronger here: a replace whose map row did not land would
  // point the slide at a document nobody can download, and the document it was
  // serving a second ago is still there and still fine. Failing keeps it.
  await recordSlideFileAsset(slide.classroom, {
    path: sourcePath,
    sha: commit.sha,
    size: file.length,
  });

  const updated = await getPrisma().slide.update({
    where: { id: slideId },
    data: {
      source_path: sourcePath,
      source_filename: displayFilename(filename, storageName),
      source_mime: validation.mime,
      source_size: file.length,
      updated_at: new Date(),
    },
  });

  if (previousPath && previousPath !== sourcePath) {
    try {
      await ContentService.delete({
        gitOrganization,
        repo,
        path: previousPath,
        message: `Remove replaced slide file: ${slide.title}`,
      });
    } catch (error: unknown) {
      console.error('[slideFile] Could not remove the replaced slide file:', error);
    }
    // The map row outlives the file otherwise, and a row is all the signer
    // needs — the old document would stay downloadable from R2 by anyone
    // holding a URL minted before the replace, for as long as the row survived.
    await removeContentAssets(slide.classroom_id, [previousPath]);
  }

  return { slide: updated, path: sourcePath, sha: commit.sha, commit: commit.commit };
}

/** Point a LINK slide at a different destination. Validation is the same one. */
export async function updateSlideLink({ slideId, url }: { slideId: string; url: string }) {
  const link = validateSlideLinkUrl(url);
  if (!link.ok) throw new SlideSourceError(link.error);

  const current = await getPrisma().slide.findUnique({
    where: { id: slideId },
    select: { kind: true },
  });
  if (!current) throw new Error('Slide not found');
  assertLinkSlide(current, 'Editing a slide link');

  const slide = await getPrisma().slide.update({
    where: { id: slideId },
    data: { source_url: link.url, updated_at: new Date() },
  });

  return { slide, host: link.host };
}

// ─────────────────────────────────────────────────────────────────────────────
// Read — what a viewer actually gets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The signed download URL for a FILE slide, from a row that has its classroom.
 *
 * A thin wrapper over `contentDelivery.resolveSlideDownloadUrl` whose only job
 * is building the delivery context out of the joined classroom, so a route does
 * not have to know the shape of one. Everything that decides the URL — the
 * `download` tier, the `dl` filename, the asset-map proof — lives in the signer.
 */
export async function slideDownloadUrl(slide: SlideFileTarget): Promise<SlideDownloadResult> {
  const classroom = slide.classroom;
  const login = classroom?.git_organization?.login;
  if (!classroom?.id || !classroom.content_repo || !login) {
    return { ok: false, reason: 'delivery_off' };
  }
  // The two the type now demands, asked again at the boundary. A row built by a
  // `select` the compiler never saw can still arrive without them, and the
  // defaults that used to stand in here (`?? 0`, `=== true`) turned that into a
  // signature made with the wrong key version, or a silently disabled gate.
  // Neither is a state to guess at, so it is a refusal with its own name.
  if (
    typeof classroom.content_key_version !== 'number' ||
    typeof classroom.content_delivery_enabled !== 'boolean'
  ) {
    return { ok: false, reason: 'incomplete_classroom' };
  }
  return resolveSlideDownloadUrl(
    {
      id: classroom.id,
      content_key_version: classroom.content_key_version,
      content_repo: classroom.content_repo,
      content_delivery_enabled: classroom.content_delivery_enabled,
      git_organization: { login },
    },
    {
      kind: slide.kind ?? 'DECK',
      content_path: slide.content_path,
      source_path: slide.source_path ?? null,
      source_filename: slide.source_filename ?? null,
      source_size: slide.source_size ?? null,
    }
  );
}

/**
 * The file's bytes, read straight from GitHub — the legacy path.
 *
 * This is the FILE twin of what a deck does when its classroom's delivery gate
 * is off: `fetchContentText` falls back to the contents API, and the app serves
 * what it read. The Git blobs API is used rather than the Contents API because
 * the latter caps at 1 MB and a slide file is usually bigger.
 *
 * Null when the path is gone from the repo. Everything else throws — a rate
 * limit or a revoked installation is not "no such file", and a route that
 * rendered the two the same way would tell a student their lecture has been
 * deleted because GitHub was busy.
 */
export async function readSlideFileBytes(
  slide: SlideFileTarget
): Promise<{ body: Buffer; contentType: string; filename: string } | null> {
  const gitOrganization = slide.classroom?.git_organization;
  const repo = slide.classroom?.content_repo;
  const path = slide.source_path;
  if (!gitOrganization?.login || !repo || !path) return null;

  // The same self-defence the signed path applies, for the reader that has no
  // signer in front of it: this one hands `source_path` straight to the git
  // blobs API, so a row naming a path outside the slide's own folder would read
  // any file in the content repo, and a row claiming 400 MB would buffer it.
  const problem = slideFileSourceProblem(slide);
  if (problem) {
    console.warn(`[slideFile] Refusing to read ${path} for slide ${slide.id}: ${problem}`);
    return null;
  }

  const file = await ContentService.getLargeContent({
    gitOrganization,
    repo,
    path,
  });
  if (!file) return null;

  return {
    body: Buffer.from(file.content, 'base64'),
    contentType: slide.source_mime || 'application/octet-stream',
    filename: downloadNameFor(slide),
  };
}

/** What the slides route should do with a FILE slide for this viewer. */
export type SlideFileDelivery =
  /** Send a 302 to the Worker. The bytes never touch this app. */
  | { mode: 'redirect'; url: string; filename: string }
  /** The classroom has no delivery layer — stream these bytes ourselves. */
  | {
      mode: 'stream';
      body: Buffer;
      filename: string;
      contentType: string;
      /** The `Content-Disposition` the Worker would have sent, byte for byte. */
      disposition: string;
    }
  /** Nothing to serve. `reason` is for the log, not for the student. */
  | { mode: 'unavailable'; reason: SlideDownloadRefusal | 'missing_bytes' };

/**
 * One call for the route: redirect, stream, or nothing.
 *
 * The two live paths differ in who moves the bytes, not in what the browser
 * sees — both end in an attachment carrying the original filename, which is why
 * the stream branch formats its header with the SAME `contentDispositionFor`
 * the Worker uses on the signed one.
 *
 * `delivery_off` is the only refusal that falls through to the stream: it means
 * "this classroom has no Worker", which is a configuration state, not a fault.
 * `not_in_map`, `no_source` and `unsignable` mean the file itself is missing or
 * unaddressable, and reading it from GitHub would be papering over a real
 * problem with a 75 MB request.
 */
export async function openSlideFile(slide: SlideFileTarget): Promise<SlideFileDelivery> {
  if (slide.kind !== 'FILE') return { mode: 'unavailable', reason: 'not_a_file' };

  const signed = await slideDownloadUrl(slide);
  if (signed.ok) return { mode: 'redirect', url: signed.url, filename: signed.filename };
  if (signed.reason !== 'delivery_off') {
    return { mode: 'unavailable', reason: signed.reason };
  }

  const bytes = await readSlideFileBytes(slide);
  if (!bytes) return { mode: 'unavailable', reason: 'missing_bytes' };

  return {
    mode: 'stream',
    body: bytes.body,
    filename: bytes.filename,
    contentType: bytes.contentType,
    disposition: contentDispositionFor(bytes.filename),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The name the download is saved under: the stored display name when there is
 * one, the storage name otherwise.
 *
 * Re-validated rather than trusted. `source_filename` is a column, and a value
 * written before this rule existed (or by a future writer that forgot it) must
 * not reach a response header — `normalizeDownloadFilename` is the same gate
 * the signer applies to `dl`, so the legacy path and the signed path cannot
 * disagree about what a legal filename is.
 */
function downloadNameFor(slide: SlideFileTarget): string {
  const stored = slide.source_filename ? normalizeDownloadFilename(slide.source_filename) : null;
  if (stored) return stored;
  const tail = (slide.source_path ?? '').split('/').pop() ?? '';
  return normalizeDownloadFilename(tail) ?? 'download';
}

/**
 * The display name to STORE for an upload: the browser's own, when it survives
 * normalization, and the sanitized storage name when it does not.
 *
 * A fallback rather than a refusal on purpose. A filename with a bidi override
 * or 300 bytes of emoji in it is a name we will not put in a header, but it is
 * not a reason to reject the lecture the instructor is trying to post — and the
 * storage name is always legal, being ASCII we generated ourselves.
 */
function displayFilename(filename: string, storageName: string): string {
  const tail = filename.split(/[/\\]/).pop() ?? '';
  return normalizeDownloadFilename(tail) ?? storageName;
}

/**
 * Write the asset-map row for a just-committed slide document, or refuse.
 *
 * `recordContentAssets` never throws and answers `false` for two very different
 * things: a classroom the delivery layer cannot serve (no GitHub installation —
 * there is no map to write to and never was) and a write that actually failed.
 * Both call sites used to discard that answer, which made the second one
 * invisible: the commit landed, the row landed, and the download 404'd with
 * `not_in_map` until the next sync — up to twenty-four hours of a slide that
 * looks uploaded and cannot be opened.
 *
 * So the deliverable case is asked FIRST, with the shared predicate, and only
 * the remaining `false` is treated as a fault. One retry, because the thing it
 * most often is is a transient database blip and the write is an idempotent
 * upsert; then it throws, and the caller has ordered itself so that throwing
 * leaves no row pointing at an unsignable file.
 */
async function recordSlideFileAsset(
  classroom: DeliverableClassroom & { id: string },
  entry: { path: string; sha: string; size: number }
): Promise<void> {
  if (!isDeliverableClassroom(classroom)) return;
  if (await recordContentAssets(classroom.id, [entry])) return;
  if (await recordContentAssets(classroom.id, [entry])) return;
  throw new Error(
    `Could not record ${entry.path} in the content asset map — the upload was not completed. ` +
      'Try again in a moment.'
  );
}

/**
 * Best-effort removal of a document whose slide row never landed.
 *
 * Only ever reached after a slug conflict, which means some OTHER slide now
 * owns this folder — and, if the create that won uploaded a file with the same
 * name, this exact path. Deleting it then would take the winner's document out
 * from under it, so the rows are asked who owns the path and anything but
 * "nobody" leaves the blob where it is. A leftover blob costs repo size;
 * deleting the wrong one costs a lecture. The whole thing is wrapped, because a
 * failed cleanup must not replace the conflict the caller is about to report.
 */
async function discardLostUpload({
  classroomId,
  gitOrganization,
  repo,
  path,
  title,
}: {
  classroomId: string;
  gitOrganization: NonNullable<NonNullable<SlideContentTarget['classroom']>['git_organization']>;
  repo: string;
  path: string;
  title: string;
}): Promise<void> {
  try {
    const owner = await getPrisma().slide.findFirst({
      where: { classroom_id: classroomId, source_path: path },
      select: { id: true },
    });
    if (owner) {
      console.warn(`[slideFile] Left ${path} in place — slide ${owner.id} now owns it.`);
      return;
    }
    await ContentService.delete({
      gitOrganization,
      repo,
      path,
      message: `Remove abandoned slide file: ${title}`,
    });
    await removeContentAssets(classroomId, [path]);
  } catch (error: unknown) {
    console.error('[slideFile] Could not remove the abandoned slide file:', error);
  }
}

/** The single-file commit both write paths share. */
async function commitSlideFile({
  gitOrganization,
  repo,
  path,
  file,
  message,
}: {
  gitOrganization: NonNullable<NonNullable<SlideContentTarget['classroom']>['git_organization']>;
  repo: string;
  path: string;
  file: Buffer;
  message: string;
}): Promise<{ sha: string; commit: string }> {
  const result = await ContentService.uploadBatch({
    gitOrganization,
    repo,
    files: [{ path, content: file.toString('base64'), encoding: 'base64' }],
    branch: 'main',
    message,
  });

  const sha = result.files.find(entry => entry.path === path)?.sha;
  if (!sha) throw new Error('uploadBatch did not return a sha for the slide file');
  return { sha, commit: result.commit };
}

/** The manifest refresh every slide write ends with. Non-fatal, as everywhere. */
async function refreshManifest(classroomId: string, context: string): Promise<void> {
  try {
    await contentManifestService.saveManifest(classroomId);
  } catch (error: unknown) {
    console.error(`Failed to update manifest after ${context}:`, error);
  }
}

/** Literal include, so Prisma statically types `classroom.git_organization`. */
async function loadSlideWithClassroom(slideId: string) {
  return getPrisma().slide.findUnique({
    where: { id: slideId },
    include: { classroom: { include: { git_organization: true } } },
  });
}
