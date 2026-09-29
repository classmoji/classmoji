/**
 * The Cloudinary → media migration's WRITE half (plan §13.2). Everything it
 * touches comes in through `ExecuteDeps`, so it is tested with fakes; the
 * Trigger task wires the live ones, and only when the payload says
 * `{ dryRun: false, confirm: 'MIGRATE' }`.
 *
 * The dry-run CLI never imports this module (a test enforces it).
 *
 * ## Order, per run
 *
 *   1. Every work item (asset × classroom), in plan order: make the classroom's
 *      copy — the first classroom streams the ORIGINAL from Cloudinary into R2,
 *      a later one is an R2 CopyObject of a verified copy — as a system import:
 *      a media row under the deterministic id `mediaIdFor(publicId,
 *      classroomId)`, Pro gate and quota bypassed (lapsed classrooms keep
 *      serving, decision 3), VIDEO, `optimise`, `keep_original`, no student
 *      download; READY, then `onMediaReady` (the P4 job).
 *   2. Verify it: mint the served URL and HEAD it through the delivery origin —
 *      200 and the asset's byte length — BEFORE any deck points at it. An item
 *      that does not verify is reported and its references stay on Cloudinary.
 *   3. Rewrite each deck's files: every URL form of a VERIFIED asset → that
 *      classroom's `media://{id}`, committed with sha protection (re-read and
 *      re-applied on conflict, bounded).
 *
 * Nothing on Cloudinary is ever deleted, and nothing is rolled back
 * automatically.
 *
 * ## Idempotent
 *
 * A READY row under the derived id is reused (no transfer); an UPLOADING one is
 * an earlier run's abandoned reservation and is replaced; any other status
 * (DELETED — somebody removed the migrated copy) is reported, not recreated. A
 * deck whose files no longer carry a verified asset's URL commits nothing. The
 * task runs one at a time (queue concurrency 1), so no two runs race for an id.
 */

import { join } from 'node:path';

import { rewriteText } from './cloudinaryUrls.ts';
import type { CloudinaryAsset, MigrationPlan, WorkItem } from './cloudinaryPlan.ts';

export interface ExistingMediaRow {
  id: string;
  classroom_id: string;
  status: string;
}

export interface NewMediaRow {
  id: string;
  classroomId: string;
  filename: string;
  ext: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string;
}

export interface ExecuteDeps {
  cloudName: string;
  /** `uuidv5(publicId + ':' + classroomId)` under the migration's namespace. */
  mediaIdFor(publicId: string, classroomId: string): string;
  /** The R2 key of a variant (`mediaKey` from content-signing). */
  mediaKey(classroomId: string, mediaId: string, variant: string): string;
  contentTypeFor(ext: string): string;
  /** Deployment AND classroom can serve signed media (else refs render missing). */
  canServeMedia(classroomId: string): Promise<boolean>;

  findMediaRow(mediaId: string): Promise<ExistingMediaRow | null>;
  /** Insert the row UPLOADING — a system import: no Pro gate, no quota check. */
  reserveRow(row: NewMediaRow): Promise<void>;
  /** Delete the row if it is still UPLOADING. */
  releaseRow(mediaId: string): Promise<void>;
  /** UPLOADING → READY; false when the row was not UPLOADING. */
  markReady(mediaId: string): Promise<boolean>;
  onMediaReady(mediaId: string, classroomId: string): Promise<void>;

  makeTmpDir(): Promise<string>;
  removeTmpDir(dir: string): Promise<void>;
  /** Stream the asset's untransformed original (`secureUrl`) to `file`. */
  downloadOriginal(asset: CloudinaryAsset, file: string): Promise<void>;
  putObject(key: string, file: string, sizeBytes: number, contentType: string): Promise<void>;
  copyObject(fromKey: string, toKey: string): Promise<void>;
  headObject(key: string): Promise<number | null>;
  deleteObject(key: string): Promise<void>;

  /** The served URL a viewer of this classroom would load `media://{id}` from. */
  servedUrl(classroomId: string, mediaId: string): Promise<string | null>;
  headUrl(url: string): Promise<{ status: number; length: number | null }>;

  /** A deck file from the default branch, uncached. */
  readDeckFile(classroomId: string, path: string): Promise<{ text: string; sha: string } | null>;
  /**
   * Commit `files` in one commit, only if each path's blob sha at the base
   * commit is still `expectedShas[path]`; 'conflict' otherwise.
   */
  commitDeckFiles(
    classroomId: string,
    files: { path: string; text: string }[],
    expectedShas: Record<string, string>,
    message: string
  ): Promise<'conflict' | 'committed'>;

  log?(message: string, detail?: Record<string, unknown>): void;
}

export type ItemOutcome = 'uploaded' | 'copied' | 'reused' | 'skipped' | 'failed';
export type DeckOutcome = 'rewritten' | 'unchanged' | 'skipped' | 'failed';

export interface ExecuteReport {
  items: {
    publicId: string;
    classroomId: string;
    mediaId: string | null;
    bytes: number;
    outcome: ItemOutcome;
    detail?: string;
  }[];
  decks: {
    slideId: string;
    classroomId: string;
    outcome: DeckOutcome;
    replaced: number;
    attempts: number;
    detail?: string;
  }[];
  /** Preview branches still carrying Cloudinary URLs (never rewritten here). */
  previewBranchesNotRewritten: MigrationPlan['previewReferences'];
  bytesByClassroom: Record<string, number>;
  counts: {
    assets: number;
    migrated: number;
    reused: number;
    skipped: number;
    failed: number;
    decksRewritten: number;
    decksUnchanged: number;
    decksFailed: number;
  };
}

export const COMMIT_MESSAGE = 'Move Cloudinary videos to media storage';
/** Tries per deck commit (the first included) before giving up on a conflict. */
export const COMMIT_TRIES = 3;

const EXT = /^[a-z0-9]{1,8}$/;

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The row's display name: the public_id's last segment plus the format. */
export function migratedFilename(asset: Pick<CloudinaryAsset, 'publicId' | 'format'>): string {
  const tail = asset.publicId.slice(asset.publicId.lastIndexOf('/') + 1) || 'video';
  return `${tail}.${asset.format.toLowerCase()}`;
}

interface Verified {
  classroomId: string;
  mediaId: string;
  ext: string;
}

async function transferOne(
  deps: ExecuteDeps,
  item: WorkItem,
  asset: CloudinaryAsset,
  mediaId: string,
  ext: string,
  source: Verified | undefined
): Promise<'uploaded' | 'copied'> {
  const key = deps.mediaKey(item.classroomId, mediaId, `orig.${ext}`);
  const contentType = deps.contentTypeFor(ext);
  await deps.reserveRow({
    id: mediaId,
    classroomId: item.classroomId,
    filename: migratedFilename(asset),
    ext,
    contentType,
    sizeBytes: asset.bytes,
    uploadedBy: item.uploadedBy,
  });

  let how: 'uploaded' | 'copied' = 'uploaded';
  try {
    let copied = false;
    if (source) {
      try {
        await deps.copyObject(
          deps.mediaKey(source.classroomId, source.mediaId, `orig.${ext}`),
          key
        );
        copied = true;
        how = 'copied';
      } catch (error) {
        deps.log?.('R2 copy failed; fetching from Cloudinary instead', {
          publicId: item.publicId,
          classroomId: item.classroomId,
          error: errText(error),
        });
      }
    }
    if (!copied) {
      const dir = await deps.makeTmpDir();
      try {
        const file = join(dir, `orig.${ext}`);
        await deps.downloadOriginal(asset, file);
        await deps.putObject(key, file, asset.bytes, contentType);
      } finally {
        await deps.removeTmpDir(dir);
      }
    }
    const stored = await deps.headObject(key);
    if (stored !== asset.bytes) {
      throw new Error(`stored ${stored ?? 'nothing'} of ${asset.bytes} bytes`);
    }
    if (!(await deps.markReady(mediaId))) throw new Error('the reservation changed while copying');
  } catch (error) {
    await deps.deleteObject(key).catch(() => {});
    await deps.releaseRow(mediaId).catch(() => {});
    throw error;
  }
  await deps.onMediaReady(mediaId, item.classroomId);
  return how;
}

export async function executeMigration(
  plan: MigrationPlan,
  deps: ExecuteDeps
): Promise<ExecuteReport> {
  const log = deps.log ?? (() => {});
  const assets = new Map<string, CloudinaryAsset>(
    plan.assets.map(asset => [
      asset.publicId,
      {
        publicId: asset.publicId,
        format: asset.format,
        bytes: asset.bytes,
        version: asset.version,
        secureUrl: asset.secureUrl,
        createdAt: null,
      },
    ])
  );
  // The plan's own resolution set, not just its assets: a URL must resolve to
  // the same public_id here as it did in the reviewed plan.
  const known = new Set(plan.knownPublicIds);
  const report: ExecuteReport = {
    items: [],
    decks: [],
    previewBranchesNotRewritten: plan.previewReferences,
    bytesByClassroom: {},
    counts: {
      assets: 0,
      migrated: 0,
      reused: 0,
      skipped: 0,
      failed: 0,
      decksRewritten: 0,
      decksUnchanged: 0,
      decksFailed: 0,
    },
  };

  /** The first verified copy of each asset — the CopyObject source for the rest. */
  const firstCopy = new Map<string, Verified>();
  /** classroomId → publicId → media id, verified through the delivery origin. */
  const verified = new Map<string, Map<string, string>>();
  const servable = new Map<string, boolean>();

  // ── 1 + 2: copies, each verified before anything references it ────────────
  for (const item of plan.work) {
    const asset = assets.get(item.publicId);
    const record = (outcome: ItemOutcome, mediaId: string | null, detail?: string) => {
      report.items.push({
        publicId: item.publicId,
        classroomId: item.classroomId,
        mediaId,
        bytes: item.bytes,
        outcome,
        ...(detail ? { detail } : {}),
      });
    };
    if (!asset) {
      record('skipped', null, 'asset not in the plan inventory');
      continue;
    }
    const ext = asset.format.toLowerCase();
    if (!EXT.test(ext)) {
      record('skipped', null, `unusable format "${asset.format}"`);
      continue;
    }
    if (!servable.has(item.classroomId)) {
      servable.set(item.classroomId, await deps.canServeMedia(item.classroomId));
    }
    if (!servable.get(item.classroomId)) {
      record(
        'skipped',
        null,
        'this classroom cannot serve media; its decks keep the Cloudinary URL'
      );
      continue;
    }

    const mediaId = deps.mediaIdFor(item.publicId, item.classroomId);
    let outcome: ItemOutcome;
    try {
      const existing = await deps.findMediaRow(mediaId);
      if (existing && existing.classroom_id !== item.classroomId) {
        record('failed', mediaId, 'the derived id belongs to another classroom');
        continue;
      }
      if (existing?.status === 'READY') {
        outcome = 'reused';
      } else if (existing && existing.status !== 'UPLOADING') {
        record('skipped', mediaId, `the migrated copy is ${existing.status}; not recreated`);
        continue;
      } else {
        if (existing) await deps.releaseRow(mediaId);
        outcome = await transferOne(deps, item, asset, mediaId, ext, firstCopy.get(item.publicId));
      }

      const url = await deps.servedUrl(item.classroomId, mediaId);
      if (!url) throw new Error('no served URL could be signed');
      const head = await deps.headUrl(url);
      if (head.status !== 200 || head.length !== asset.bytes) {
        throw new Error(
          `delivery check failed: HTTP ${head.status}, ${head.length ?? '?'} of ${asset.bytes} bytes`
        );
      }
    } catch (error) {
      record('failed', mediaId, errText(error));
      log('Migration item failed', {
        publicId: item.publicId,
        classroomId: item.classroomId,
        error: errText(error),
      });
      continue;
    }

    if (!firstCopy.has(item.publicId)) {
      firstCopy.set(item.publicId, { classroomId: item.classroomId, mediaId, ext });
    }
    const map = verified.get(item.classroomId) ?? new Map<string, string>();
    map.set(item.publicId, mediaId);
    verified.set(item.classroomId, map);
    report.bytesByClassroom[item.classroomId] =
      (report.bytesByClassroom[item.classroomId] ?? 0) + (outcome === 'reused' ? 0 : item.bytes);
    record(outcome, mediaId);
  }

  // ── 3: rewrite, only to verified copies ──────────────────────────────────
  for (const deck of plan.decks) {
    const mapping = verified.get(deck.classroomId);
    const replacements = new Map<string, string>();
    for (const [publicId, mediaId] of mapping ?? []) {
      replacements.set(publicId, `media://${mediaId}`);
    }
    const entry = {
      slideId: deck.slideId,
      classroomId: deck.classroomId,
      outcome: 'skipped' as DeckOutcome,
      replaced: 0,
      attempts: 0,
    } as ExecuteReport['decks'][number];
    report.decks.push(entry);
    if (replacements.size === 0) {
      entry.detail = 'no verified copy for this classroom';
      continue;
    }

    try {
      for (let attempt = 1; attempt <= COMMIT_TRIES; attempt++) {
        entry.attempts = attempt;
        const changed: { path: string; text: string }[] = [];
        const expected: Record<string, string> = {};
        let replaced = 0;
        for (const { path } of deck.files) {
          const current = await deps.readDeckFile(deck.classroomId, path);
          if (!current) continue;
          const next = rewriteText(current.text, deps.cloudName, known, replacements);
          if (next.replaced === 0) continue;
          changed.push({ path, text: next.text });
          expected[path] = current.sha;
          replaced += next.replaced;
        }
        if (changed.length === 0) {
          entry.outcome = 'unchanged';
          break;
        }
        const result = await deps.commitDeckFiles(
          deck.classroomId,
          changed,
          expected,
          COMMIT_MESSAGE
        );
        if (result === 'committed') {
          entry.outcome = 'rewritten';
          entry.replaced = replaced;
          break;
        }
        log('Deck changed while rewriting; re-reading', { slideId: deck.slideId, attempt });
        if (attempt === COMMIT_TRIES) {
          entry.outcome = 'failed';
          entry.detail = `still conflicting after ${COMMIT_TRIES} tries`;
        }
      }
    } catch (error) {
      entry.outcome = 'failed';
      entry.detail = errText(error);
    }
  }

  const items = report.items;
  report.counts = {
    assets: new Set(items.map(item => item.publicId)).size,
    migrated: items.filter(i => i.outcome === 'uploaded' || i.outcome === 'copied').length,
    reused: items.filter(i => i.outcome === 'reused').length,
    skipped: items.filter(i => i.outcome === 'skipped').length,
    failed: items.filter(i => i.outcome === 'failed').length,
    decksRewritten: report.decks.filter(d => d.outcome === 'rewritten').length,
    decksUnchanged: report.decks.filter(d => d.outcome === 'unchanged').length,
    decksFailed: report.decks.filter(d => d.outcome === 'failed').length,
  };
  return report;
}
