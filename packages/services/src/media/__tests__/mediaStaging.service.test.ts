/**
 * Agent uploads (the MCP staging protocol), with R2, Prisma, Trigger and the
 * content-repo commit mocked.
 *
 * What these guard: the routing and admission checks run before a byte moves;
 * finish verifies the staged size before it places anything; a media placement
 * copies inside R2 with the served type REPLACED from the extension and only
 * flips STAGING → READY; a repo placement is queued once and tombstones its row
 * with the ref; every read is bound to the caller who opened the stage.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  CopyObjectCommand: command('CopyObject'),
  CreateMultipartUploadCommand: command('CreateMultipartUpload'),
  DeleteObjectCommand: command('DeleteObject'),
  GetObjectCommand: command('GetObject'),
  HeadObjectCommand: command('HeadObject'),
  ListObjectsV2Command: command('ListObjectsV2'),
  PutObjectCommand: command('PutObject'),
  UploadPartCommand: command('UploadPart'),
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => getSignedUrl(...args),
}));

const trigger = vi.fn();
vi.mock('@trigger.dev/sdk', () => ({ tasks: { trigger: (...a: unknown[]) => trigger(...a) } }));

const prisma = {
  mediaObject: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  page: { findUnique: vi.fn() },
  slide: { findUnique: vi.fn() },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
};
vi.mock('@classmoji/database', () => ({ default: () => prisma }));

const capability = vi.fn();
const assertRepoTarget = vi.fn();
vi.mock('../uploadCapability.ts', () => ({
  uploadCapabilityFor: (...a: unknown[]) => capability(...a),
  assertRepoTarget: (...a: unknown[]) => assertRepoTarget(...a),
}));

const uploadPageAsset = vi.fn();
vi.mock('../../classmoji/pageContent.service.ts', () => ({
  uploadPageAsset: (...a: unknown[]) => uploadPageAsset(...a),
}));

const contentUpload = vi.fn();
vi.mock('../../content/ContentService.ts', () => ({
  ContentService: { upload: (...a: unknown[]) => contentUpload(...a) },
}));

const recordContentAsset = vi.fn();
vi.mock('../../classmoji/contentAssets.service.ts', () => ({
  recordContentAsset: (...a: unknown[]) => recordContentAsset(...a),
}));

vi.mock('../../classmoji/subscription.service.ts', () => ({
  getProStateForClassroomId: async () => ({ isPro: true }),
}));

const staging = await import('../mediaStaging.service.ts');
const { resetR2Client } = await import('../r2Client.ts');

const CLASSROOM_ID = '11111111-2222-4333-8444-555555555555';
const MEDIA_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const PAGE_ID = '99999999-8888-4777-8666-555555555555';
const USER = 'user-1';
const classroom = { id: CLASSROOM_ID };
const MB = 1024 * 1024;
const GIB = 1024 * MB;
const STAGE_KEY = `stage/${CLASSROOM_ID}/${MEDIA_ID}`;

const FREE_CAP = { repoMaxBytes: 35 * MB, repoFileTypes: 'any', isPro: false, media: null };
const PRO_CAP = {
  repoMaxBytes: 35 * MB,
  repoFileTypes: 'any',
  isPro: true,
  media: { perFileMaxBytes: 2 * GIB, remainingBytes: 10 * GIB },
};

function stagedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MEDIA_ID,
    classroom_id: CLASSROOM_ID,
    kind: 'IMAGE',
    filename: 'diagram.png',
    ext: 'png',
    content_type: 'image/png',
    size_bytes: BigInt(4096),
    status: 'STAGING',
    upload_id: null,
    uploaded_by: USER,
    optimise: false,
    keep_original: true,
    allow_download: true,
    processing: 'NONE',
    processing_error: null,
    rendition_key: null,
    rendition_bytes: null,
    poster_key: null,
    duration_ms: null,
    width: null,
    height: null,
    created_at: new Date(),
    ready_at: null,
    original_deleted_at: null,
    destination: 'repo',
    stage_target_type: 'page',
    stage_target_id: PAGE_ID,
    placed_ref: null,
    placement_error: null,
    ...overrides,
  };
}

beforeEach(() => {
  sent.length = 0;
  sendImpl.mockReset().mockResolvedValue({});
  getSignedUrl.mockReset().mockResolvedValue('https://r2.example/stage-put');
  trigger.mockReset().mockResolvedValue({ id: 'run_1' });
  for (const fn of Object.values(prisma.mediaObject)) fn.mockReset();
  prisma.mediaObject.findMany.mockResolvedValue([]);
  prisma.mediaObject.updateMany.mockResolvedValue({ count: 1 });
  prisma.mediaObject.create.mockResolvedValue({});
  prisma.page.findUnique.mockReset();
  prisma.slide.findUnique.mockReset();
  prisma.$queryRaw.mockReset().mockResolvedValue([]);
  prisma.$transaction
    .mockReset()
    .mockImplementation(async (run: (tx: typeof prisma) => unknown) => run(prisma));
  capability.mockReset().mockResolvedValue(PRO_CAP);
  assertRepoTarget.mockReset().mockResolvedValue(undefined);
  uploadPageAsset.mockReset();
  contentUpload.mockReset();
  recordContentAsset.mockReset();

  process.env.MEDIA_R2_ACCOUNT_ID = 'acct';
  process.env.MEDIA_R2_ACCESS_KEY_ID = 'key';
  process.env.MEDIA_R2_SECRET_ACCESS_KEY = 'secret';
  process.env.MEDIA_R2_BUCKET = 'classmoji-media-test';
  resetR2Client();
});

const target = { type: 'page' as const, id: PAGE_ID };

describe('startStagedUpload', () => {
  it('refuses a Free class a file over the repository cap before anything is reserved', async () => {
    capability.mockResolvedValue(FREE_CAP);
    await expect(
      staging.startStagedUpload({
        classroom,
        userId: USER,
        filename: 'lecture.mp4',
        sizeBytes: 200 * MB,
        target,
      })
    ).rejects.toMatchObject({ code: 'STORAGE_REFUSED', message: expect.stringMatching(/35 MB/) });
    expect(prisma.mediaObject.create).not.toHaveBeenCalled();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('routes a small image to the repo, reserves a STAGING row and signs one fixed-length PUT', async () => {
    const started = await staging.startStagedUpload({
      classroom,
      userId: USER,
      filename: 'diagram.png',
      sizeBytes: 4096,
      target,
    });

    expect(started).toMatchObject({ destination: 'repo', sizeBytes: 4096 });
    const data = prisma.mediaObject.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      id: started.uploadId,
      classroom_id: CLASSROOM_ID,
      status: 'STAGING',
      destination: 'repo',
      stage_target_type: 'page',
      stage_target_id: PAGE_ID,
      uploaded_by: USER,
      processing: 'NONE',
      size_bytes: BigInt(4096),
    });
    // The stage and the INSERT share the classroom lock.
    expect(prisma.$queryRaw).toHaveBeenCalled();

    const [, putCommand, options] = getSignedUrl.mock.calls[0];
    expect(putCommand.__name).toBe('PutObject');
    expect(putCommand.input).toEqual({
      Bucket: 'classmoji-media-test',
      Key: `stage/${CLASSROOM_ID}/${started.uploadId}`,
      ContentLength: 4096,
    });
    expect(options.expiresIn).toBeLessThanOrEqual(15 * 60);
    expect([...options.signableHeaders]).toEqual(['content-length']);
  });

  it('routes a Pro video to media and checks the quota for it', async () => {
    prisma.mediaObject.findMany.mockResolvedValue([
      stagedRow({ status: 'READY', size_bytes: BigInt(10 * GIB - 10), destination: null }),
    ]);
    await expect(
      staging.startStagedUpload({
        classroom,
        userId: USER,
        filename: 'lecture.mp4',
        sizeBytes: 100,
        target,
      })
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(prisma.mediaObject.create).not.toHaveBeenCalled();
  });

  it('refuses when the class already has too much waiting under stage/', async () => {
    prisma.mediaObject.findMany.mockResolvedValue([
      stagedRow({ id: 'a', size_bytes: BigInt(4 * GIB - 100) }),
    ]);
    await expect(
      staging.startStagedUpload({
        classroom,
        userId: USER,
        filename: 'diagram.png',
        sizeBytes: 4096,
        target,
      })
    ).rejects.toMatchObject({ code: 'STAGE_LIMIT' });
  });

  it('refuses a size that is not a positive integer, or over 2 GB', async () => {
    for (const sizeBytes of [0, -1, 1.5, 2 * GIB + 1]) {
      await expect(
        staging.startStagedUpload({ classroom, userId: USER, filename: 'a.mp4', sizeBytes, target })
      ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    }
  });
});

describe('finishStagedUpload', () => {
  it('is NOT_FOUND for another user’s stage, or a browser upload', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(stagedRow({ uploaded_by: 'someone-else' }));
    await expect(
      staging.finishStagedUpload({ classroom, userId: USER, uploadId: MEDIA_ID })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    prisma.mediaObject.findFirst.mockResolvedValue(
      stagedRow({ status: 'UPLOADING', destination: null })
    );
    await expect(
      staging.finishStagedUpload({ classroom, userId: USER, uploadId: MEDIA_ID })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(sent).toHaveLength(0);
  });

  it('says NOT_UPLOADED, and changes nothing, when the object is not there yet', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    prisma.mediaObject.findFirst.mockResolvedValue(stagedRow());
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'HeadObject') throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
      return {};
    });
    await expect(
      staging.finishStagedUpload({ classroom, userId: USER, uploadId: MEDIA_ID })
    ).rejects.toMatchObject({ code: 'NOT_UPLOADED' });
    expect(prisma.mediaObject.updateMany).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });

  it('discards a staged object that is not the declared size', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(stagedRow());
    sendImpl.mockImplementation(async (name: string) =>
      name === 'HeadObject' ? { ContentLength: 9999 } : {}
    );
    await expect(
      staging.finishStagedUpload({ classroom, userId: USER, uploadId: MEDIA_ID })
    ).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    expect(prisma.mediaObject.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: MEDIA_ID, status: 'STAGING' },
      data: expect.objectContaining({ status: 'DELETED' }),
    });
    expect(sent.find(call => call.name === 'DeleteObject')?.input.Key).toBe(STAGE_KEY);
  });

  it('places a media-bound file synchronously: copy with the type REPLACED, READY, stage deleted', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(
      stagedRow({
        kind: 'VIDEO',
        filename: 'lecture.mp4',
        ext: 'mp4',
        content_type: 'video/mp4',
        destination: 'media',
      })
    );
    sendImpl.mockImplementation(async (name: string) =>
      name === 'HeadObject' ? { ContentLength: 4096 } : {}
    );

    await expect(
      staging.finishStagedUpload({ classroom, userId: USER, uploadId: MEDIA_ID })
    ).resolves.toEqual({
      status: 'placed',
      uploadId: MEDIA_ID,
      filename: 'lecture.mp4',
      destination: 'media',
      ref: `media://${MEDIA_ID}`,
    });

    const names = sent.map(call => call.name);
    // Verify the stage, copy inside R2, verify the copy, then delete the stage.
    expect(names).toEqual(['HeadObject', 'CopyObject', 'HeadObject', 'DeleteObject']);
    expect(sent[1].input).toEqual({
      Bucket: 'classmoji-media-test',
      Key: `m/${CLASSROOM_ID}/${MEDIA_ID}/orig.mp4`,
      CopySource: `classmoji-media-test/${STAGE_KEY}`,
      MetadataDirective: 'REPLACE',
      ContentType: 'video/mp4',
    });
    expect(sent[3].input.Key).toBe(STAGE_KEY);
    expect(prisma.mediaObject.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: MEDIA_ID, status: 'STAGING' },
      data: expect.objectContaining({ status: 'READY', placed_ref: `media://${MEDIA_ID}` }),
    });
    expect(trigger).not.toHaveBeenCalled();
  });

  it('answers a concurrent finish that already made the row READY with the same ref', async () => {
    prisma.mediaObject.findFirst
      .mockResolvedValueOnce(stagedRow({ destination: 'media' }))
      .mockResolvedValue(stagedRow({ status: 'READY', placed_ref: `media://${MEDIA_ID}` }));
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'HeadObject') return { ContentLength: 4096 };
      if (name === 'CopyObject') throw Object.assign(new Error('gone'), { name: 'NoSuchKey' });
      return {};
    });
    await expect(
      staging.finishStagedUpload({ classroom, userId: USER, uploadId: MEDIA_ID })
    ).resolves.toMatchObject({ status: 'placed', ref: `media://${MEDIA_ID}` });
  });

  it('queues a repo placement once: claims PENDING, triggers with an idempotency key', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(stagedRow());
    sendImpl.mockImplementation(async (name: string) =>
      name === 'HeadObject' ? { ContentLength: 4096 } : {}
    );

    await expect(
      staging.finishStagedUpload({ classroom, userId: USER, uploadId: MEDIA_ID })
    ).resolves.toMatchObject({ status: 'placing', uploadId: MEDIA_ID });

    expect(prisma.mediaObject.updateMany.mock.calls[0][0]).toEqual({
      where: { id: MEDIA_ID, status: 'STAGING', processing: 'NONE' },
      data: { processing: 'PENDING' },
    });
    expect(trigger).toHaveBeenCalledWith(
      'media-place-staged',
      { mediaId: MEDIA_ID },
      { idempotencyKey: `media-place:${MEDIA_ID}`, concurrencyKey: CLASSROOM_ID }
    );
    expect(sent.some(call => call.name === 'CopyObject')).toBe(false);
  });

  it('answers a repeat finish of a queued placement with placing, queuing nothing', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(stagedRow({ processing: 'PENDING' }));
    await expect(
      staging.finishStagedUpload({ classroom, userId: USER, uploadId: MEDIA_ID })
    ).resolves.toMatchObject({ status: 'placing' });
    expect(trigger).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('gives the claim back when the job cannot be queued', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(stagedRow());
    sendImpl.mockImplementation(async (name: string) =>
      name === 'HeadObject' ? { ContentLength: 4096 } : {}
    );
    trigger.mockRejectedValue(new Error('trigger down'));
    await expect(
      staging.finishStagedUpload({ classroom, userId: USER, uploadId: MEDIA_ID })
    ).rejects.toThrow('trigger down');
    expect(prisma.mediaObject.updateMany.mock.calls.at(-1)?.[0]).toEqual({
      where: { id: MEDIA_ID, status: 'STAGING', processing: 'PENDING' },
      data: { processing: 'NONE' },
    });
  });

  it('refuses — and cleans up — a stage older than the reservation window', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(
      stagedRow({ created_at: new Date(Date.now() - 25 * 60 * 60 * 1000) })
    );
    await expect(
      staging.finishStagedUpload({ classroom, userId: USER, uploadId: MEDIA_ID })
    ).rejects.toMatchObject({ code: 'UPLOAD_EXPIRED' });
    expect(sent.find(call => call.name === 'DeleteObject')?.input.Key).toBe(STAGE_KEY);
  });
});

describe('stagedUploadStatus', () => {
  const status = () => staging.stagedUploadStatus({ classroom, userId: USER, uploadId: MEDIA_ID });

  it('reads each state back', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(stagedRow());
    await expect(status()).resolves.toMatchObject({ status: 'awaiting_upload' });

    prisma.mediaObject.findFirst.mockResolvedValue(stagedRow({ processing: 'PENDING' }));
    await expect(status()).resolves.toMatchObject({ status: 'placing' });

    prisma.mediaObject.findFirst.mockResolvedValue(
      stagedRow({ status: 'DELETED', placed_ref: 'pages/lab-1/assets/x.png' })
    );
    await expect(status()).resolves.toMatchObject({
      status: 'placed',
      ref: 'pages/lab-1/assets/x.png',
    });

    prisma.mediaObject.findFirst.mockResolvedValue(
      stagedRow({ status: 'READY', destination: 'media' })
    );
    await expect(status()).resolves.toMatchObject({ status: 'placed', ref: `media://${MEDIA_ID}` });

    prisma.mediaObject.findFirst.mockResolvedValue(
      stagedRow({ status: 'DELETED', placement_error: 'The page no longer exists.' })
    );
    await expect(status()).resolves.toMatchObject({
      status: 'failed',
      error: 'The page no longer exists.',
    });
  });
});

describe('placeStagedObject', () => {
  it('commits a page file through uploadPageAsset, then tombstones the row with the ref', async () => {
    prisma.mediaObject.findUnique.mockResolvedValue(stagedRow());
    prisma.page.findUnique.mockResolvedValue({
      id: PAGE_ID,
      classroom_id: CLASSROOM_ID,
      title: 'Lab 1',
      content_path: 'pages/lab-1',
      classroom: { id: CLASSROOM_ID },
    });
    sendImpl.mockImplementation(async (name: string) =>
      name === 'GetObject'
        ? { Body: { transformToByteArray: async () => new Uint8Array(4096) } }
        : {}
    );
    uploadPageAsset.mockResolvedValue({ url: 'pages/lab-1/assets/1-diagram.png' });

    await expect(staging.placeStagedObject(MEDIA_ID)).resolves.toEqual({
      status: 'placed',
      ref: 'pages/lab-1/assets/1-diagram.png',
    });
    expect(uploadPageAsset.mock.calls[0][2]).toBe('diagram.png');
    expect((uploadPageAsset.mock.calls[0][1] as Buffer).length).toBe(4096);
    expect(prisma.mediaObject.updateMany.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { id: MEDIA_ID, status: 'STAGING' },
      data: expect.objectContaining({
        status: 'DELETED',
        placed_ref: 'pages/lab-1/assets/1-diagram.png',
      }),
    });
    expect(sent.at(-1)).toEqual({
      name: 'DeleteObject',
      input: { Bucket: 'classmoji-media-test', Key: STAGE_KEY },
    });
  });

  it('commits a slide file into the deck’s images folder with its asset-map row', async () => {
    const slideId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    prisma.mediaObject.findUnique.mockResolvedValue(
      stagedRow({ stage_target_type: 'slide', stage_target_id: slideId })
    );
    prisma.slide.findUnique.mockResolvedValue({
      id: slideId,
      classroom_id: CLASSROOM_ID,
      title: 'Week 1',
      content_path: 'slides/week-1',
      classroom: {
        id: CLASSROOM_ID,
        content_repo: 'content-repo',
        git_organization: { login: 'org', provider: 'GITHUB' },
      },
    });
    sendImpl.mockImplementation(async (name: string) =>
      name === 'GetObject'
        ? { Body: { transformToByteArray: async () => new Uint8Array(4096) } }
        : {}
    );
    contentUpload.mockResolvedValue({ path: 'slides/week-1/images/1-diagram.png', sha: 'abc' });

    await expect(staging.placeStagedObject(MEDIA_ID)).resolves.toEqual({
      status: 'placed',
      ref: 'slides/week-1/images/1-diagram.png',
    });
    expect(assertRepoTarget).toHaveBeenCalled();
    expect(contentUpload.mock.calls[0][0]).toMatchObject({
      repo: 'content-repo',
      folder: 'slides/week-1/images',
      filename: 'diagram.png',
    });
    expect(recordContentAsset).toHaveBeenCalledWith(CLASSROOM_ID, {
      path: 'slides/week-1/images/1-diagram.png',
      sha: 'abc',
      size: 4096,
    });
  });

  it('is a no-op for a row that is no longer STAGING (a duplicate or retried run)', async () => {
    prisma.mediaObject.findUnique.mockResolvedValue(stagedRow({ status: 'DELETED' }));
    await expect(staging.placeStagedObject(MEDIA_ID)).resolves.toEqual({
      status: 'skipped',
      reason: 'not-staging',
    });
    expect(sent).toHaveLength(0);
  });

  it('refuses permanently when the page is gone', async () => {
    prisma.mediaObject.findUnique.mockResolvedValue(stagedRow());
    prisma.page.findUnique.mockResolvedValue(null);
    sendImpl.mockImplementation(async (name: string) =>
      name === 'GetObject'
        ? { Body: { transformToByteArray: async () => new Uint8Array(4096) } }
        : {}
    );
    const error = await staging.placeStagedObject(MEDIA_ID).catch(e => e);
    expect(staging.isPermanentPlacementError(error)).toBe(true);
    expect(staging.isPermanentPlacementError(new Error('GitHub 502'))).toBe(false);
    expect(
      staging.isPermanentPlacementError(Object.assign(new Error('x'), { code: 'FILE_REFUSED' }))
    ).toBe(true);
  });
});

describe('failStagedPlacement', () => {
  it('tombstones from STAGING with the reason and removes the staged bytes', async () => {
    prisma.mediaObject.findUnique.mockResolvedValue(stagedRow({ upload_id: 'up-1' }));
    await staging.failStagedPlacement(MEDIA_ID, 'The URL answered 404.');
    expect(prisma.mediaObject.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: MEDIA_ID, status: 'STAGING' },
      data: expect.objectContaining({ status: 'DELETED', placement_error: 'The URL answered 404.' }),
    });
    expect(sent.map(call => call.name)).toEqual(['AbortMultipartUpload', 'DeleteObject']);
  });
});

describe('streamIntoStage', () => {
  async function* chunks(sizes: number[]) {
    for (const size of sizes) yield new Uint8Array(size);
  }

  it('re-chunks the stream into fixed-size parts and completes', async () => {
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'CreateMultipartUpload') return { UploadId: 'up-9' };
      if (name === 'UploadPart') return { ETag: '"e"' };
      return {};
    });
    const part = staging.STAGE_PART_SIZE_BYTES;
    const total = await staging.streamIntoStage(
      stagedRow() as never,
      chunks([part - 10, 20, part, 5]),
      10 * part
    );
    expect(total).toBe(2 * part + 15);
    const parts = sent.filter(call => call.name === 'UploadPart');
    expect(parts.map(call => call.input.ContentLength)).toEqual([part, part, 15]);
    expect(sent.at(-1)?.name).toBe('CompleteMultipartUpload');
    // The multipart id is on the row while it is open, and cleared after.
    expect(prisma.mediaObject.updateMany.mock.calls[0][0].data).toEqual({ upload_id: 'up-9' });
    expect(prisma.mediaObject.updateMany.mock.calls.at(-1)?.[0].data).toEqual({ upload_id: null });
  });

  it('aborts the multipart the moment the stream passes the cap', async () => {
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'CreateMultipartUpload') return { UploadId: 'up-9' };
      if (name === 'UploadPart') return { ETag: '"e"' };
      return {};
    });
    await expect(
      staging.streamIntoStage(stagedRow() as never, chunks([100, 100, 100]), 250)
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(sent.some(call => call.name === 'AbortMultipartUpload')).toBe(true);
    expect(sent.some(call => call.name === 'CompleteMultipartUpload')).toBe(false);
  });
});

describe('settleStagedImport', () => {
  it('re-routes on the real size: a Pro file over the repo cap goes to media', async () => {
    prisma.mediaObject.findUnique.mockResolvedValue(
      stagedRow({ filename: 'data.zip', ext: 'zip', size_bytes: BigInt(0), processing: 'PENDING' })
    );
    const settled = await staging.settleStagedImport(MEDIA_ID, 100 * MB);
    expect(settled.destination).toBe('media');
    expect(prisma.mediaObject.updateMany.mock.calls[0][0]).toEqual({
      where: { id: MEDIA_ID, status: 'STAGING' },
      data: { size_bytes: BigInt(100 * MB), destination: 'media' },
    });
  });

  it('refuses a Free class a file that turned out over the repo cap', async () => {
    capability.mockResolvedValue(FREE_CAP);
    prisma.mediaObject.findUnique.mockResolvedValue(
      stagedRow({ filename: 'data.zip', ext: 'zip', size_bytes: BigInt(0) })
    );
    await expect(staging.settleStagedImport(MEDIA_ID, 100 * MB)).rejects.toMatchObject({
      code: 'STORAGE_REFUSED',
    });
  });
});

describe('startUrlImport', () => {
  it('refuses http, credentials and odd ports at the door', async () => {
    for (const url of [
      'http://example.com/a.png',
      'https://user:pw@example.com/a.png',
      'https://example.com:8443/a.png',
    ]) {
      await expect(
        staging.startUrlImport({ classroom, userId: USER, url, target })
      ).rejects.toMatchObject({ code: 'STORAGE_REFUSED' });
    }
    expect(trigger).not.toHaveBeenCalled();
  });

  it('opens a zero-byte PENDING stage and queues the import', async () => {
    const started = await staging.startUrlImport({
      classroom,
      userId: USER,
      url: 'https://example.com/files/Lecture%201.mp4',
      target,
    });
    expect(started.filename).toBe('Lecture 1.mp4');
    expect(started.maxBytes).toBe(2 * GIB);
    expect(prisma.mediaObject.create.mock.calls[0][0].data).toMatchObject({
      status: 'STAGING',
      processing: 'PENDING',
      size_bytes: BigInt(0),
      destination: 'media',
    });
    expect(trigger).toHaveBeenCalledWith(
      'media-import-url',
      { mediaId: started.uploadId, url: 'https://example.com/files/Lecture%201.mp4' },
      { idempotencyKey: `media-import:${started.uploadId}`, concurrencyKey: CLASSROOM_ID }
    );
  });

  it('needs an extension from the filename or the URL', async () => {
    await expect(
      staging.startUrlImport({ classroom, userId: USER, url: 'https://example.com/download', target })
    ).rejects.toMatchObject({ code: 'STORAGE_REFUSED' });
  });
});
