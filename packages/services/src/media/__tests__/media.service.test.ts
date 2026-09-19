/**
 * The media service, with R2 and Prisma mocked.
 *
 * What these guard is the arithmetic and the ordering, which is where this
 * service can actually be wrong:
 *
 *   - the quota is a SUM over rows, so every rule about WHICH rows count (a
 *     reservation inside its window, a processed row billed for its rendition
 *     rather than its original) is a rule about that sum and nothing else;
 *   - the checks run in a fixed order, so a free classroom is told it needs Pro
 *     rather than that it is over a quota of zero;
 *   - `completeUpload` verifies the size it reserved against, which is the only
 *     thing standing between a declared number and a bucket a client can fill.
 *
 * The S3 layer is a recorder: each command is a plain object naming itself, and
 * `send` pushes it onto a list. That is enough to assert WHICH calls were made
 * with WHAT keys, which is the whole contract with R2 — the SDK's own
 * behaviour is not this file's to re-test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: { name: string; input: Record<string, unknown> }[] = [];
const sendImpl = vi.fn();
const getSignedUrl = vi.fn();

function command(name: string) {
  return class {
    readonly __name = name;
    constructor(public input: Record<string, unknown>) {}
  };
}

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    async send(cmd: { __name: string; input: Record<string, unknown> }) {
      sent.push({ name: cmd.__name, input: cmd.input });
      return sendImpl(cmd.__name, cmd.input);
    }
  },
  AbortMultipartUploadCommand: command('AbortMultipartUpload'),
  CompleteMultipartUploadCommand: command('CompleteMultipartUpload'),
  CreateMultipartUploadCommand: command('CreateMultipartUpload'),
  DeleteObjectCommand: command('DeleteObject'),
  HeadObjectCommand: command('HeadObject'),
  UploadPartCommand: command('UploadPart'),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => getSignedUrl(...args),
}));

const prisma = {
  mediaObject: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  },
};
vi.mock('@classmoji/database', () => ({ default: () => prisma }));

const getProStateForClassroomId = vi.fn();
vi.mock('../../classmoji/subscription.service.ts', () => ({
  getProStateForClassroomId: (...args: unknown[]) => getProStateForClassroomId(...args),
}));

const { abortUpload, completeUpload, createUpload, deleteMedia, listMedia, signParts, usage } =
  await import('../media.service.ts');
const { PART_SIZE_BYTES, PER_FILE_MAX_BYTES, PRO_QUOTA_BYTES } = await import('../mediaQuota.ts');
const { resetR2Client } = await import('../r2Client.ts');

const CLASSROOM_ID = '11111111-2222-4333-8444-555555555555';
const MEDIA_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const classroom = { id: CLASSROOM_ID };
const GIB = 1024 * 1024 * 1024;
const HOUR = 60 * 60 * 1000;

/** A READY row, with only what a test cares about overridden. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: MEDIA_ID,
    classroom_id: CLASSROOM_ID,
    kind: 'VIDEO',
    filename: 'lecture.mp4',
    ext: 'mp4',
    content_type: 'video/mp4',
    size_bytes: BigInt(1000),
    status: 'READY',
    upload_id: null,
    uploaded_by: 'user-1',
    optimise: true,
    keep_original: true,
    allow_download: false,
    processing: 'NONE',
    processing_error: null,
    rendition_key: null,
    rendition_bytes: null,
    poster_key: null,
    duration_ms: null,
    width: null,
    height: null,
    created_at: new Date(),
    ready_at: new Date(),
    original_deleted_at: null,
    ...overrides,
  };
}

function configure(): void {
  process.env.MEDIA_R2_ACCOUNT_ID = 'acct';
  process.env.MEDIA_R2_ACCESS_KEY_ID = 'key';
  process.env.MEDIA_R2_SECRET_ACCESS_KEY = 'secret';
  process.env.MEDIA_R2_BUCKET = 'classmoji-media-test';
  resetR2Client();
}

function unconfigure(): void {
  delete process.env.MEDIA_R2_ACCOUNT_ID;
  delete process.env.MEDIA_R2_ACCESS_KEY_ID;
  delete process.env.MEDIA_R2_SECRET_ACCESS_KEY;
  delete process.env.MEDIA_R2_BUCKET;
  resetR2Client();
}

/** The one key every variant of the fixture row lives under. */
const ORIG_KEY = `m/${CLASSROOM_ID}/${MEDIA_ID}/orig.mp4`;

beforeEach(() => {
  sent.length = 0;
  sendImpl.mockReset();
  getSignedUrl.mockReset();
  getSignedUrl.mockResolvedValue('https://r2.example/signed');
  for (const fn of Object.values(prisma.mediaObject)) fn.mockReset();
  prisma.mediaObject.findMany.mockResolvedValue([]);
  prisma.mediaObject.findFirst.mockResolvedValue(null);
  prisma.mediaObject.update.mockImplementation(async ({ data }: { data: object }) =>
    row({ ...data })
  );
  prisma.mediaObject.updateMany.mockResolvedValue({ count: 1 });
  getProStateForClassroomId.mockResolvedValue({ isPro: true });
  configure();
});

afterEach(() => {
  unconfigure();
  vi.restoreAllMocks();
});

describe('usage', () => {
  it('sums a READY row at its original size', async () => {
    prisma.mediaObject.findMany.mockResolvedValue([row({ size_bytes: BigInt(5 * GIB) })]);
    await expect(usage(classroom)).resolves.toMatchObject({
      usedBytes: 5 * GIB,
      quotaBytes: PRO_QUOTA_BYTES,
      perFileBytes: PER_FILE_MAX_BYTES,
      isPro: true,
    });
  });

  it('bills a processed row for its RENDITION once the original is gone', async () => {
    // The whole point of `original_deleted_at`: a 4 GiB upload that transcoded
    // to 800 MB and had its original dropped costs 800 MB, not 4.8 GiB and not
    // 4 GiB.
    prisma.mediaObject.findMany.mockResolvedValue([
      row({
        size_bytes: BigInt(4 * GIB),
        rendition_bytes: BigInt(800 * 1024 * 1024),
        rendition_key: 'web',
        original_deleted_at: new Date(),
      }),
    ]);
    await expect(usage(classroom)).resolves.toMatchObject({
      usedBytes: 800 * 1024 * 1024,
    });
  });

  it('still bills the original while the rendition sits beside it', async () => {
    prisma.mediaObject.findMany.mockResolvedValue([
      row({
        size_bytes: BigInt(4 * GIB),
        rendition_bytes: BigInt(100),
        rendition_key: 'web',
        original_deleted_at: null,
      }),
    ]);
    await expect(usage(classroom)).resolves.toMatchObject({ usedBytes: 4 * GIB });
  });

  it('asks only for READY rows and reservations inside the window', async () => {
    await usage(classroom);
    const where = prisma.mediaObject.findMany.mock.calls[0][0].where;
    expect(where.classroom_id).toBe(CLASSROOM_ID);
    const [ready, uploading] = where.OR;
    expect(ready).toEqual({ status: 'READY' });
    expect(uploading.status).toBe('UPLOADING');
    // 24h back, give or take the milliseconds the call itself took.
    const cutoff = uploading.created_at.gte.getTime();
    expect(Date.now() - cutoff).toBeGreaterThan(23.9 * HOUR);
    expect(Date.now() - cutoff).toBeLessThan(24.1 * HOUR);
  });

  it('gives a free classroom a quota of zero', async () => {
    getProStateForClassroomId.mockResolvedValue({ isPro: false });
    await expect(usage(classroom)).resolves.toMatchObject({ quotaBytes: 0, isPro: false });
  });
});

describe('listMedia', () => {
  it('returns records with numbers rather than bigints, and the ref', async () => {
    prisma.mediaObject.findMany.mockResolvedValue([row({ size_bytes: BigInt(4096) })]);
    const [record] = await listMedia(classroom);
    expect(record.sizeBytes).toBe(4096);
    expect(typeof record.sizeBytes).toBe('number');
    expect(record.ref).toBe(`media://${MEDIA_ID}`);
    // Must survive the trip to a browser; a bigint here would throw.
    expect(() => JSON.stringify(record)).not.toThrow();
  });
});

describe('createUpload', () => {
  beforeEach(() => {
    prisma.mediaObject.create.mockResolvedValue(row({ status: 'UPLOADING' }));
    sendImpl.mockResolvedValue({ UploadId: 'upload-1' });
  });

  it('opens the multipart with the SERVER content type and returns it', async () => {
    const created = await createUpload({
      classroom,
      userId: 'user-1',
      filename: 'lecture.mp4',
      sizeBytes: 100 * 1024 * 1024,
    });

    expect(created).toMatchObject({
      mediaId: MEDIA_ID,
      uploadId: 'upload-1',
      contentType: 'video/mp4',
      partSize: PART_SIZE_BYTES,
      partCount: 4,
    });

    const create = sent.find(call => call.name === 'CreateMultipartUpload');
    expect(create?.input).toMatchObject({
      Bucket: 'classmoji-media-test',
      Key: ORIG_KEY,
      ContentType: 'video/mp4',
    });
    expect(prisma.mediaObject.update).toHaveBeenCalledWith({
      where: { id: MEDIA_ID },
      data: { upload_id: 'upload-1' },
    });
  });

  it('refuses in order: configured, kind, per-file, Pro, quota', async () => {
    unconfigure();
    await expect(
      createUpload({ classroom, userId: 'u', filename: 'a.mp4', sizeBytes: 1 })
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    configure();

    await expect(
      createUpload({ classroom, userId: 'u', filename: 'a.html', sizeBytes: 1 })
    ).rejects.toMatchObject({ code: 'KIND_NOT_ALLOWED' });

    await expect(
      createUpload({ classroom, userId: 'u', filename: 'a.mp4', sizeBytes: PER_FILE_MAX_BYTES + 1 })
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });

    // A free classroom hears PRO_REQUIRED, never "you are 1 byte over 0".
    getProStateForClassroomId.mockResolvedValue({ isPro: false });
    await expect(
      createUpload({ classroom, userId: 'u', filename: 'a.mp4', sizeBytes: 1 })
    ).rejects.toMatchObject({ code: 'PRO_REQUIRED' });

    // Nothing was written or opened on any of those paths.
    expect(prisma.mediaObject.create).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('refuses a file that would not fit, and says by how much', async () => {
    prisma.mediaObject.findMany.mockResolvedValue([row({ size_bytes: BigInt(9 * GIB) })]);
    await expect(
      createUpload({ classroom, userId: 'u', filename: 'a.mp4', sizeBytes: 2 * GIB })
    ).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      usedBytes: 9 * GIB,
      quotaBytes: PRO_QUOTA_BYTES,
    });
  });

  it('counts an open reservation against the quota', async () => {
    // Two uploads a second apart must not both fit in the same free space; the
    // UPLOADING row from the first is what refuses the second.
    prisma.mediaObject.findMany.mockResolvedValue([
      row({ status: 'UPLOADING', size_bytes: BigInt(9.5 * GIB), created_at: new Date() }),
    ]);
    await expect(
      createUpload({ classroom, userId: 'u', filename: 'a.mp4', sizeBytes: GIB })
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('defaults a video to optimise + keep original, and forces them off elsewhere', async () => {
    await createUpload({ classroom, userId: 'u', filename: 'a.mp4', sizeBytes: 10 });
    expect(prisma.mediaObject.create.mock.calls[0][0].data).toMatchObject({
      optimise: true,
      keep_original: true,
      allow_download: false,
    });

    prisma.mediaObject.create.mockClear();
    await createUpload({
      classroom,
      userId: 'u',
      filename: 'notes.pdf',
      sizeBytes: 10,
      // A PDF cannot be transcoded, so the video options are ignored rather
      // than stored and later acted on.
      options: { optimise: true, allowDownload: true },
    });
    expect(prisma.mediaObject.create.mock.calls[0][0].data).toMatchObject({
      kind: 'DOCUMENT',
      optimise: false,
      keep_original: true,
      allow_download: false,
    });
  });

  it('drops the reserving row when R2 will not open the upload', async () => {
    sendImpl.mockRejectedValue(new Error('r2 is down'));
    await expect(
      createUpload({ classroom, userId: 'u', filename: 'a.mp4', sizeBytes: 10 })
    ).rejects.toThrow('r2 is down');
    // Otherwise the classroom pays for a reservation with nothing behind it.
    expect(prisma.mediaObject.delete).toHaveBeenCalledWith({ where: { id: MEDIA_ID } });
  });
});

describe('signParts', () => {
  beforeEach(() => {
    // Two parts' worth of declared bytes, so asking for part 2 is legitimate.
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ status: 'UPLOADING', upload_id: 'up-1', size_bytes: BigInt(PART_SIZE_BYTES + 1) })
    );
  });

  it('presigns each part against this object, with an expiry the client can see', async () => {
    const { urls } = await signParts({ classroom, mediaId: MEDIA_ID, partNumbers: [1, 2] });

    expect(urls).toHaveLength(2);
    expect(urls[0]).toMatchObject({ partNumber: 1, url: 'https://r2.example/signed' });
    expect(Date.parse(urls[0].expiresAt)).toBeGreaterThan(Date.now());

    const inputs = getSignedUrl.mock.calls.map(call => (call[1] as { input: object }).input);
    expect(inputs).toEqual([
      { Bucket: 'classmoji-media-test', Key: ORIG_KEY, UploadId: 'up-1', PartNumber: 1 },
      { Bucket: 'classmoji-media-test', Key: ORIG_KEY, UploadId: 'up-1', PartNumber: 2 },
    ]);
    expect(getSignedUrl.mock.calls[0][2]).toMatchObject({ expiresIn: 15 * 60 });
  });

  it('refuses a row that is not open, and one that is not this classroom', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(row({ status: 'READY' }));
    await expect(
      signParts({ classroom, mediaId: MEDIA_ID, partNumbers: [1] })
    ).rejects.toMatchObject({ code: 'BAD_STATE' });

    // A foreign id is simply absent: the lookup is scoped in SQL, so there is
    // no branch where another classroom's row is in hand.
    prisma.mediaObject.findFirst.mockResolvedValue(null);
    await expect(
      signParts({ classroom, mediaId: MEDIA_ID, partNumbers: [1] })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.mediaObject.findFirst.mock.calls.at(-1)?.[0].where).toEqual({
      id: MEDIA_ID,
      classroom_id: CLASSROOM_ID,
    });
  });

  it('caps a batch and refuses part numbers outside S3 range', async () => {
    await expect(
      signParts({
        classroom,
        mediaId: MEDIA_ID,
        partNumbers: Array.from({ length: 51 }, (_, i) => i + 1),
      })
    ).rejects.toMatchObject({ code: 'BAD_STATE' });

    await expect(
      signParts({ classroom, mediaId: MEDIA_ID, partNumbers: [0, 10001, -1] })
    ).rejects.toMatchObject({ code: 'BAD_STATE' });
  });

  it('refuses a part number the declared size cannot have', async () => {
    // 1 MB is one part. Part 2 is not the end of this file, it is bytes the
    // quota reservation never covered — and a signed URL for it is a write.
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ status: 'UPLOADING', upload_id: 'up-1', size_bytes: BigInt(1024 * 1024) })
    );

    await expect(
      signParts({ classroom, mediaId: MEDIA_ID, partNumbers: [2] })
    ).rejects.toMatchObject({ code: 'BAD_STATE' });
    // Nothing was signed on the refused batch, not even the valid members.
    await expect(
      signParts({ classroom, mediaId: MEDIA_ID, partNumbers: [1, 2] })
    ).rejects.toMatchObject({ code: 'BAD_STATE' });
    expect(getSignedUrl).not.toHaveBeenCalled();

    const { urls } = await signParts({ classroom, mediaId: MEDIA_ID, partNumbers: [1] });
    expect(urls).toHaveLength(1);
  });
});

describe('completeUpload', () => {
  beforeEach(() => {
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ status: 'UPLOADING', upload_id: 'up-1', size_bytes: BigInt(4096) })
    );
  });

  it('assembles in ascending order, verifies the size, and marks READY', async () => {
    sendImpl.mockImplementation(async (name: string) =>
      name === 'HeadObject' ? { ContentLength: 4096 } : {}
    );

    const result = await completeUpload({
      classroom,
      mediaId: MEDIA_ID,
      // Arriving in completion order, which is what a parallel client has.
      parts: [
        { partNumber: 2, etag: '"two"' },
        { partNumber: 1, etag: '"one"' },
      ],
    });

    const complete = sent.find(call => call.name === 'CompleteMultipartUpload');
    expect(complete?.input.MultipartUpload).toEqual({
      Parts: [
        { PartNumber: 1, ETag: '"one"' },
        { PartNumber: 2, ETag: '"two"' },
      ],
    });

    expect(result).toMatchObject({ mediaId: MEDIA_ID, ref: `media://${MEDIA_ID}` });
    expect(prisma.mediaObject.update.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: 'READY',
      upload_id: null,
      // The row asked to be optimised, so the phase-2 job has something to pick up.
      processing: 'PENDING',
    });
  });

  it('quotes an etag a client stripped, and leaves a quoted one alone', async () => {
    sendImpl.mockImplementation(async (name: string) =>
      name === 'HeadObject' ? { ContentLength: 4096 } : {}
    );

    await completeUpload({
      classroom,
      mediaId: MEDIA_ID,
      parts: [
        { partNumber: 1, etag: 'bare' },
        { partNumber: 2, etag: '"quoted"' },
      ],
    });

    expect(sent.find(c => c.name === 'CompleteMultipartUpload')?.input.MultipartUpload).toEqual({
      Parts: [
        { PartNumber: 1, ETag: '"bare"' },
        { PartNumber: 2, ETag: '"quoted"' },
      ],
    });
  });

  it('deletes the object and the row when the size is not what was reserved', async () => {
    // The check that makes the quota real: everything before this trusted a
    // number the client declared.
    sendImpl.mockImplementation(async (name: string) =>
      name === 'HeadObject' ? { ContentLength: 99_999_999 } : {}
    );

    await expect(
      completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
    ).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });

    expect(sent.find(call => call.name === 'DeleteObject')?.input).toMatchObject({ Key: ORIG_KEY });
    expect(prisma.mediaObject.updateMany.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { id: MEDIA_ID, status: 'UPLOADING' },
      data: expect.objectContaining({ status: 'DELETED' }),
    });
  });

  it('retries the size check once before giving up on it', async () => {
    let heads = 0;
    sendImpl.mockImplementation(async (name: string) => {
      if (name !== 'HeadObject') return {};
      if (++heads === 1) throw new Error('503 slow down');
      return { ContentLength: 4096 };
    });

    const result = await completeUpload({
      classroom,
      mediaId: MEDIA_ID,
      parts: [{ partNumber: 1, etag: '"a"' }],
    });

    expect(heads).toBe(2);
    expect(result).toMatchObject({ mediaId: MEDIA_ID });
    expect(prisma.mediaObject.update.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: 'READY',
    });
  });

  it('discards an object it could not read back at all', async () => {
    // Unverified bytes in the bucket behind a row that ages out of the quota is
    // the one outcome worse than a refusal.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'HeadObject') throw new Error('r2 is down');
      return {};
    });

    await expect(
      completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
    ).rejects.toMatchObject({ code: 'VERIFY_FAILED' });

    expect(sent.filter(call => call.name === 'HeadObject')).toHaveLength(2);
    expect(sent.find(call => call.name === 'DeleteObject')?.input).toMatchObject({ Key: ORIG_KEY });
    expect(prisma.mediaObject.updateMany.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { id: MEDIA_ID, status: 'UPLOADING' },
      data: expect.objectContaining({ status: 'DELETED' }),
    });
  });

  it('aborts and tombstones when the assembly itself fails', async () => {
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'CompleteMultipartUpload') throw new Error('bad part');
      return {};
    });

    await expect(
      completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
    ).rejects.toThrow('bad part');

    expect(sent.some(call => call.name === 'AbortMultipartUpload')).toBe(true);
    expect(prisma.mediaObject.updateMany.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { id: MEDIA_ID, status: 'UPLOADING' },
      data: expect.objectContaining({ status: 'DELETED' }),
    });
  });

  it('cannot un-READY a row another call already finished', async () => {
    // The lost-response retry: `complete` runs twice, the first one assembles
    // the object and marks the row READY, and R2 answers the second with
    // NoSuchUpload because there is no multipart left. The second call's
    // cleanup must not land on the row the first one finished.
    const state = { status: 'UPLOADING' };
    prisma.mediaObject.findFirst.mockImplementation(async () =>
      // A stale read is what makes this a race at all: both calls believe the
      // row is still open.
      row({ status: 'UPLOADING', upload_id: 'up-1', size_bytes: BigInt(4096) })
    );
    prisma.mediaObject.update.mockImplementation(async ({ data }: { data: { status: string } }) => {
      state.status = data.status;
      return row({ ...data });
    });
    prisma.mediaObject.updateMany.mockImplementation(
      async ({ where }: { where: { status: string } }) => {
        if (where.status !== state.status) return { count: 0 };
        state.status = 'DELETED';
        return { count: 1 };
      }
    );

    let completes = 0;
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'CompleteMultipartUpload' && ++completes > 1) {
        throw new Error('NoSuchUpload');
      }
      return name === 'HeadObject' ? { ContentLength: 4096 } : {};
    });

    await completeUpload({
      classroom,
      mediaId: MEDIA_ID,
      parts: [{ partNumber: 1, etag: '"a"' }],
    });
    expect(state.status).toBe('READY');

    await expect(
      completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
    ).rejects.toThrow('NoSuchUpload');

    // The file exists and is being served; the second call's conclusion about
    // it was out of date.
    expect(state.status).toBe('READY');
  });

  it('answers a second complete with a refusal, not a second assembly', async () => {
    const state = { status: 'UPLOADING' };
    prisma.mediaObject.findFirst.mockImplementation(async () =>
      row({ status: state.status, upload_id: state.status === 'UPLOADING' ? 'up-1' : null })
    );
    prisma.mediaObject.update.mockImplementation(async ({ data }: { data: { status: string } }) => {
      state.status = data.status;
      return row({ ...data });
    });
    sendImpl.mockImplementation(async (name: string) =>
      name === 'HeadObject' ? { ContentLength: 1000 } : {}
    );

    await completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] });
    await expect(
      completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
    ).rejects.toMatchObject({ code: 'BAD_STATE' });

    expect(state.status).toBe('READY');
    expect(prisma.mediaObject.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an empty parts list before touching R2', async () => {
    await expect(completeUpload({ classroom, mediaId: MEDIA_ID, parts: [] })).rejects.toMatchObject(
      { code: 'BAD_STATE' }
    );
    expect(sent).toHaveLength(0);
  });
});

describe('abortUpload', () => {
  it('aborts the multipart and tombstones the row', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(row({ status: 'UPLOADING', upload_id: 'up-1' }));
    sendImpl.mockResolvedValue({});

    await abortUpload({ classroom, mediaId: MEDIA_ID });

    expect(sent).toEqual([
      {
        name: 'AbortMultipartUpload',
        input: { Bucket: 'classmoji-media-test', Key: ORIG_KEY, UploadId: 'up-1' },
      },
    ]);
    // Only from UPLOADING: a complete that won the race must not be undone.
    expect(prisma.mediaObject.updateMany.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { id: MEDIA_ID, status: 'UPLOADING' },
      data: expect.objectContaining({ status: 'DELETED' }),
    });
  });

  it('will not quietly delete a finished file', async () => {
    // "Cancel the upload" and "delete the file" are different intentions.
    prisma.mediaObject.findFirst.mockResolvedValue(row({ status: 'READY' }));
    await expect(abortUpload({ classroom, mediaId: MEDIA_ID })).rejects.toMatchObject({
      code: 'BAD_STATE',
    });
    expect(sent).toHaveLength(0);
  });
});

describe('deleteMedia', () => {
  beforeEach(() => sendImpl.mockResolvedValue({}));

  it('removes all three variants, because two of them may exist', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(row());
    await deleteMedia({ classroom, mediaId: MEDIA_ID });

    expect(sent.map(call => call.input.Key)).toEqual([
      ORIG_KEY,
      `m/${CLASSROOM_ID}/${MEDIA_ID}/web.mp4`,
      `m/${CLASSROOM_ID}/${MEDIA_ID}/poster.webp`,
    ]);
    expect(prisma.mediaObject.updateMany.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { id: MEDIA_ID, status: { in: ['UPLOADING', 'READY'] } },
      data: expect.objectContaining({ status: 'DELETED' }),
    });
  });

  it('aborts first when the upload is still open', async () => {
    // Without the abort, R2 holds the uploaded parts until its own 7-day expiry.
    prisma.mediaObject.findFirst.mockResolvedValue(row({ status: 'UPLOADING', upload_id: 'up-1' }));
    await deleteMedia({ classroom, mediaId: MEDIA_ID });
    expect(sent[0].name).toBe('AbortMultipartUpload');
    expect(sent.filter(call => call.name === 'DeleteObject')).toHaveLength(3);
  });

  it('is NOT_FOUND for an id already gone, or one in another classroom', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(row({ status: 'DELETED' }));
    await expect(deleteMedia({ classroom, mediaId: MEDIA_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    prisma.mediaObject.findFirst.mockResolvedValue(null);
    await expect(deleteMedia({ classroom, mediaId: MEDIA_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(sent).toHaveLength(0);
  });
});
