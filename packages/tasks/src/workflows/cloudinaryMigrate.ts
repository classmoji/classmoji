import { logger, schemaTask } from '@trigger.dev/sdk';
import { CopyObjectCommand } from '@aws-sdk/client-s3';
import getPrisma from '@classmoji/database';
import { mediaKey } from '@classmoji/content-signing';
import { ClassmojiService, ContentService } from '@classmoji/services';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  executeMigration,
  type ExecuteDeps,
  type ExecuteReport,
} from '../helpers/cloudinaryExecute.ts';
import { planMigration, type MigrationPlan } from '../helpers/cloudinaryPlan.ts';
import {
  cloudinaryCredentialsFromEnv,
  createLiveReadDeps,
  gitHubAppCredentialsFromEnv,
  type ReadPrisma,
} from '../helpers/cloudinaryReads.ts';
import {
  deleteObject,
  headBytes,
  mediaStore,
  uploadFile,
  type MediaStore,
} from '../helpers/r2Objects.ts';

/**
 * `cloudinary-migrate` — move the slides' Cloudinary videos into media storage
 * (plan §13.2). Operator-run; never triggered by the app.
 *
 * Payload `{ dryRun = true, limit?, confirm? }`:
 *   - dry run (the default): `planMigration` with live READ deps, the plan as
 *     the run's output. No writes of any kind.
 *   - `{ dryRun: false, confirm: 'MIGRATE' }`: plan, then `executeMigration`.
 *     `dryRun: false` without that exact `confirm` is refused before `run`, so
 *     replaying an old payload or a typo cannot migrate anything.
 *   - `limit`: at most this many (asset, classroom) copies in the run.
 *
 * Not in `src/index.ts` (Trigger finds it through `dirs`): nothing in the apps
 * triggers it, and importing it would put the AWS client into their bundles.
 *
 * One run at a time (queue concurrency 1): the execute path's idempotency
 * assumes no second run is claiming the same derived media ids.
 */

export const CLOUDINARY_MIGRATE_TASK_ID = 'cloudinary-migrate';

/**
 * The uuidv5 namespace migrated media ids are derived under. Fixed forever: a
 * re-run finds its earlier copies by recomputing the id.
 */
export const CLOUDINARY_MIGRATION_NAMESPACE = '2b8f4d0e-6c1a-5e7b-9f3d-8a4c2e6b1d57';

/** The derived media id for one asset's copy in one classroom. */
export function migratedMediaId(publicId: string, classroomId: string): string {
  return ClassmojiService.media.uuidV5(
    CLOUDINARY_MIGRATION_NAMESPACE,
    `${publicId}:${classroomId}`
  );
}

export interface CloudinaryMigratePayload {
  dryRun: boolean;
  limit?: number;
}

export const CONFIRM_EXECUTE = 'MIGRATE';
const PAYLOAD_KEYS = ['dryRun', 'limit', 'confirm'] as const;

const reject = (message: string): never => {
  throw new Error(`[${CLOUDINARY_MIGRATE_TASK_ID}] ${message}`);
};

/**
 * Strict payload validation, run by `schemaTask` BEFORE `run` (hand-written,
 * as `parseBackfillPayload`: tasks has no Zod). Unknown keys fail: a payload
 * the operator believed was a dry run (`{ "dry_run": true }`) must not be read
 * as anything else — and here the default IS the dry run, so a typo can only
 * ever make a run safer.
 */
export function parseMigratePayload(input: unknown): CloudinaryMigratePayload {
  if (input === undefined || input === null) return { dryRun: true };
  if (typeof input !== 'object' || Array.isArray(input)) reject('payload must be an object');
  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(
    key => !(PAYLOAD_KEYS as readonly string[]).includes(key)
  );
  if (unknown.length > 0) {
    reject(
      `unknown payload key(s): ${unknown.join(', ')} — expected only ${PAYLOAD_KEYS.join(', ')}`
    );
  }

  if (raw.dryRun !== undefined && typeof raw.dryRun !== 'boolean') {
    reject('dryRun must be a boolean');
  }
  const dryRun = raw.dryRun !== false;
  if (!dryRun && raw.confirm !== CONFIRM_EXECUTE) {
    reject(`dryRun: false also needs confirm: '${CONFIRM_EXECUTE}'`);
  }

  const payload: CloudinaryMigratePayload = { dryRun };
  if (raw.limit !== undefined) {
    const value = raw.limit;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      reject('limit must be a positive integer');
    }
    payload.limit = value as number;
  }
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Live write deps (execute only)
// ─────────────────────────────────────────────────────────────────────────────

interface ClassroomRow {
  id: string;
  content_key_version: number;
  content_repo: string;
  content_delivery_enabled: boolean;
  git_organization: {
    provider: string;
    login: string;
    github_installation_id: string | null;
  };
}

class DeckChangedError extends Error {
  constructor(path: string) {
    super(`${path} changed since it was read`);
    this.name = 'DeckChangedError';
  }
}

function requireStore(): MediaStore {
  const store = mediaStore();
  if (!store) throw new Error('media: MEDIA_R2_* is not configured for this environment');
  return store;
}

/** `bucket/key` with each key segment encoded, as `mediaImportCopy` sends it. */
function copySource(bucket: string, key: string): string {
  return `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/** Stream a public URL to a file, refusing anything but exactly `expectedBytes`. */
export async function downloadToFileExact(
  url: string,
  file: string,
  expectedBytes: number,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60 * 60 * 1000) });
  if (!response.ok || !response.body) {
    throw new Error(`Cloudinary original fetch failed: HTTP ${response.status}`);
  }
  let seen = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > expectedBytes) {
        callback(new Error(`the original is larger than ${expectedBytes} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
    limit,
    createWriteStream(file, { flags: 'wx' })
  );
  if (seen !== expectedBytes) {
    throw new Error(`the original ended at ${seen} of ${expectedBytes} bytes`);
  }
}

function liveWriteDeps(cloudName: string): ExecuteDeps {
  const classrooms = new Map<string, Promise<ClassroomRow | null>>();
  const classroom = (id: string) => {
    let pending = classrooms.get(id);
    if (!pending) {
      pending = getPrisma().classroom.findUnique({
        where: { id },
        select: {
          id: true,
          content_key_version: true,
          content_repo: true,
          content_delivery_enabled: true,
          git_organization: {
            select: { provider: true, login: true, github_installation_id: true },
          },
        },
      }) as Promise<ClassroomRow | null>;
      classrooms.set(id, pending);
    }
    return pending;
  };
  const requireClassroom = async (id: string): Promise<ClassroomRow> => {
    const row = await classroom(id);
    if (!row?.git_organization || !row.content_repo) {
      throw new Error(`classroom ${id} has no content repo`);
    }
    return row;
  };

  return {
    cloudName,
    mediaIdFor: migratedMediaId,
    mediaKey,
    contentTypeFor: ext => ClassmojiService.media.contentTypeForExt(ext),
    canServeMedia: async classroomId => {
      const row = await classroom(classroomId);
      return (
        ClassmojiService.media.isMediaConfigured() &&
        ClassmojiService.contentDelivery.canServeSignedContent(row)
      );
    },

    findMediaRow: async mediaId =>
      (await getPrisma().mediaObject.findUnique({
        where: { id: mediaId },
        select: { id: true, classroom_id: true, status: true },
      })) as { id: string; classroom_id: string; status: string } | null,
    reserveRow: async row => {
      await getPrisma().mediaObject.create({
        data: {
          id: row.id,
          classroom_id: row.classroomId,
          kind: 'VIDEO',
          filename: row.filename,
          ext: row.ext,
          content_type: row.contentType,
          size_bytes: BigInt(row.sizeBytes),
          status: 'UPLOADING',
          uploaded_by: row.uploadedBy,
          optimise: true,
          keep_original: true,
          allow_download: false,
        },
      });
    },
    releaseRow: async mediaId => {
      await getPrisma().mediaObject.deleteMany({ where: { id: mediaId, status: 'UPLOADING' } });
    },
    markReady: async mediaId =>
      (
        await getPrisma().mediaObject.updateMany({
          where: { id: mediaId, status: 'UPLOADING' },
          data: { status: 'READY', ready_at: new Date() },
        })
      ).count === 1,
    onMediaReady: async (mediaId, classroomId) => {
      const row = await ClassmojiService.media.findMediaRow(classroomId, mediaId);
      if (row) await ClassmojiService.media.onMediaReady(ClassmojiService.media.toMediaRecord(row));
    },

    makeTmpDir: () => mkdtemp(join(tmpdir(), 'cloudinary-migrate-')),
    removeTmpDir: dir => rm(dir, { recursive: true, force: true }),
    downloadOriginal: (asset, file) => downloadToFileExact(asset.secureUrl, file, asset.bytes),
    putObject: (key, file, sizeBytes, contentType) =>
      uploadFile(requireStore(), key, file, sizeBytes, contentType),
    copyObject: async (fromKey, toKey) => {
      const store = requireStore();
      await store.client.send(
        new CopyObjectCommand({
          Bucket: store.bucket,
          Key: toKey,
          CopySource: copySource(store.bucket, fromKey),
          MetadataDirective: 'COPY',
        })
      );
    },
    headObject: key => headBytes(requireStore(), key),
    deleteObject: key => deleteObject(requireStore(), key),

    servedUrl: async (classroomId, mediaId) => {
      const row = await requireClassroom(classroomId);
      const ref = `media://${mediaId}`;
      const url = await ClassmojiService.contentDelivery.resolveAssetUrl(
        {
          classroom: {
            id: row.id,
            content_key_version: row.content_key_version,
            content_repo: row.content_repo,
            git_organization: { login: row.git_organization.login },
            content_delivery_enabled: row.content_delivery_enabled,
          },
          tier: 'edit',
        },
        ref
      );
      // The resolver answers an unresolvable ref with the ref or a placeholder.
      if (!url || url === ref || url.includes('/missing/')) return null;
      return url;
    },
    headUrl: async url => {
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(60_000) });
      const length = response.headers.get('content-length');
      return { status: response.status, length: length === null ? null : Number(length) };
    },

    readDeckFile: async (classroomId, path) => {
      const row = await requireClassroom(classroomId);
      const args = { gitOrganization: row.git_organization, repo: row.content_repo, path };
      const meta = await ContentService.getMeta({ ...args, skipCache: true });
      if (!meta) return null;
      if (meta.size > 1024 * 1024) {
        const large = await ContentService.getLargeContent(args);
        if (!large) return null;
        return { sha: large.sha, text: Buffer.from(large.content, 'base64').toString('utf8') };
      }
      const file = await ContentService.getContent({ ...args, skipCache: true });
      return file ? { sha: file.sha, text: file.content } : null;
    },
    commitDeckFiles: async (classroomId, files, expectedShas, message) => {
      const row = await requireClassroom(classroomId);
      const org = row.git_organization;
      const branch = await ClassmojiService.contentAssets.resolveContentBranch(
        org,
        org.login,
        row.content_repo
      );
      try {
        const result = await ContentService.uploadBatch({
          gitOrganization: org,
          repo: row.content_repo,
          branch,
          message,
          files: files.map(file => ({ path: file.path, content: file.text, encoding: 'utf-8' })),
          verifyBaseTree: async ({ getFileSha }) => {
            for (const file of files) {
              if ((await getFileSha(file.path)) !== expectedShas[file.path]) {
                throw new DeckChangedError(file.path);
              }
            }
          },
        });
        await ClassmojiService.contentAssets.recordContentAssets(classroomId, result.files);
        return 'committed';
      } catch (error) {
        if (error instanceof DeckChangedError) return 'conflict';
        throw error;
      }
    },

    log: (message, detail) => logger.info(message, detail ?? {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The task
// ─────────────────────────────────────────────────────────────────────────────

export type CloudinaryMigrateResult =
  | { mode: 'dry-run'; plan: MigrationPlan }
  | { mode: 'execute'; plan: MigrationPlan; report: ExecuteReport };

/**
 * The run, with its halves injectable so the dry-run/execute switch is tested
 * without Trigger, a database or a network: a dry run must never reach the
 * execute half, whatever it is.
 */
export async function runCloudinaryMigrate(
  payload: CloudinaryMigratePayload,
  halves: {
    plan: (opts: { limit?: number }) => Promise<MigrationPlan>;
    execute: (plan: MigrationPlan) => Promise<ExecuteReport>;
  }
): Promise<CloudinaryMigrateResult> {
  const plan = await halves.plan(payload.limit === undefined ? {} : { limit: payload.limit });
  if (payload.dryRun) return { mode: 'dry-run', plan };
  const report = await halves.execute(plan);
  return { mode: 'execute', plan, report };
}

export const cloudinaryMigrate = schemaTask({
  id: CLOUDINARY_MIGRATE_TASK_ID,
  schema: parseMigratePayload,
  machine: { preset: 'medium-1x' },
  maxDuration: 6 * 60 * 60,
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 1 },
  run: async (payload: CloudinaryMigratePayload) => {
    const cloudinary = cloudinaryCredentialsFromEnv();
    const readDeps = createLiveReadDeps({
      prisma: getPrisma() as unknown as ReadPrisma,
      cloudinary,
      github: gitHubAppCredentialsFromEnv(),
      proQuotaBytes: ClassmojiService.media.PRO_QUOTA_BYTES,
      log: (message, detail) => logger.info(message, detail ?? {}),
    });
    const result = await runCloudinaryMigrate(payload, {
      plan: opts => planMigration(readDeps, opts),
      execute: plan => executeMigration(plan, liveWriteDeps(cloudinary.cloudName)),
    });
    logger.info(`Cloudinary migration ${result.mode}`, {
      totals: result.plan.totals,
      ...(result.mode === 'execute' ? { counts: result.report.counts } : {}),
    });
    return result;
  },
});
