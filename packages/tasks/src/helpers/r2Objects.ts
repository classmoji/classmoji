import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { VideoRefusal } from './videoPlan.ts';

/**
 * The video job's own view of the media bucket: whole files to and from
 * local disk, streamed, never held in memory.
 *
 * ## Why a client here and not the services' one
 *
 * The services' `r2Client()` is not exported (its module is the AWS SDK
 * boundary of the lazily loaded write half), and nothing there moves a FILE:
 * `putMediaObject` takes a Buffer, which for a 3 GB rendition is exactly what
 * this job must not do (plan §12.6). So this builds the same client from the
 * same four env vars with the same settings — see `r2Client.ts` for why each
 * one is there — and does a plain S3 multipart upload off read streams.
 *
 * Hand-rolled rather than `@aws-sdk/lib-storage`'s `Upload`: the multipart
 * here is ~40 lines over the client the services already depend on, the input
 * is a file of known size (so every part is a ranged read stream with an exact
 * `ContentLength` — no buffering, no unknown-length handling, which is most of
 * what `Upload` exists for), and it keeps a new package out of the Trigger
 * image and the lockfile.
 */

export interface MediaStore {
  client: S3Client;
  bucket: string;
}

let cached: { key: string; store: MediaStore } | null = null;

/** The bucket, or null when this deployment has no media env configured. */
export function mediaStore(): MediaStore | null {
  const accountId = process.env.MEDIA_R2_ACCOUNT_ID;
  const accessKeyId = process.env.MEDIA_R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.MEDIA_R2_SECRET_ACCESS_KEY;
  const bucket = process.env.MEDIA_R2_BUCKET;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;

  const key = `${accountId}|${accessKeyId}|${bucket}`;
  if (cached?.key === key) return cached.store;
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    // As in `r2Client.ts`. It also keeps streamed bodies plain: with a
    // checksum required on every upload the SDK would switch a stream body to
    // aws-chunked encoding with a trailing checksum.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  cached = { key, store: { client, bucket } };
  return cached.store;
}

/**
 * Each part of a multipart rendition upload. R2 needs every part but the last
 * to be the same size (≥ 5 MiB); 64 MiB puts a 3 GB rendition at 48 parts.
 */
export const PART_BYTES = 64 * 1024 * 1024;

/** Parts in flight at once — each is a file read stream, not a buffer. */
const PART_CONCURRENCY = 4;

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Stream an object to a local file. The byte count must be exactly
 * `expectedBytes` (the row's `size_bytes`, verified at upload): more is cut off
 * at the limit rather than filling the disk, and either way a mismatch is a
 * refusal — the stored object is not the one that was uploaded.
 */
export async function downloadToFile(
  store: MediaStore,
  key: string,
  file: string,
  expectedBytes: number
): Promise<void> {
  let body: unknown;
  try {
    const object = await store.client.send(
      new GetObjectCommand({ Bucket: store.bucket, Key: key })
    );
    body = object.Body;
  } catch (error) {
    if (isNotFound(error)) throw new VideoRefusal('ORIGINAL_MISSING');
    throw error;
  }
  if (!(body instanceof Readable)) throw new Error(`media: no stream body for ${key}`);

  let seen = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > expectedBytes) {
        callback(new VideoRefusal('ORIGINAL_MISMATCH', `more than ${expectedBytes} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(body, limit, createWriteStream(file, { flags: 'wx' }));
  if (seen !== expectedBytes) {
    throw new VideoRefusal('ORIGINAL_MISMATCH', `${seen} of ${expectedBytes} bytes`);
  }
}

/** SHA-256 of a file, hex, streamed. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * Upload a local file of known size. One PUT when it fits in a part,
 * otherwise a multipart upload that is aborted if any part fails.
 */
export async function uploadFile(
  store: MediaStore,
  key: string,
  file: string,
  sizeBytes: number,
  contentType: string
): Promise<void> {
  const { client, bucket } = store;
  if (sizeBytes <= PART_BYTES) {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: createReadStream(file),
        ContentLength: sizeBytes,
        ContentType: contentType,
      })
    );
    return;
  }

  const created = await client.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType })
  );
  const uploadId = created.UploadId;
  if (!uploadId) throw new Error(`media: no upload id for ${key}`);

  try {
    const partCount = Math.ceil(sizeBytes / PART_BYTES);
    const etags: string[] = new Array(partCount);
    let next = 0;
    const worker = async () => {
      while (next < partCount) {
        const i = next++;
        const start = i * PART_BYTES;
        const end = Math.min(sizeBytes, start + PART_BYTES); // exclusive
        const part = await client.send(
          new UploadPartCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: i + 1,
            Body: createReadStream(file, { start, end: end - 1 }),
            ContentLength: end - start,
          })
        );
        if (!part.ETag) throw new Error(`media: part ${i + 1} of ${key} returned no ETag`);
        etags[i] = part.ETag;
      }
    };
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, partCount) }, worker));
    await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: etags.map((ETag, i) => ({ ETag, PartNumber: i + 1 })) },
      })
    );
  } catch (error) {
    await client
      .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }))
      .catch(() => {});
    throw error;
  }
}

/** The stored size of an object, or null when it is not there. */
export async function headBytes(store: MediaStore, key: string): Promise<number | null> {
  try {
    const head = await store.client.send(new HeadObjectCommand({ Bucket: store.bucket, Key: key }));
    return typeof head.ContentLength === 'number' ? head.ContentLength : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Delete one object. A missing object is already deleted. */
export async function deleteObject(store: MediaStore, key: string): Promise<void> {
  await store.client.send(new DeleteObjectCommand({ Bucket: store.bucket, Key: key }));
}
