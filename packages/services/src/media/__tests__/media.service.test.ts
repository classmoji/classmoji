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
  ListObjectsV2Command: command('ListObjectsV2'),
  PutObjectCommand: command('PutObject'),
  UploadPartCommand: command('UploadPart'),
}));

const trigger = vi.fn();
vi.mock('@trigger.dev/sdk', () => ({ tasks: { trigger: (...a: unknown[]) => trigger(...a) } }));

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => getSignedUrl(...args),
}));

/**
 * How deep inside `$transaction` the call currently running is.
 *
 * The quota's whole correctness claim is that the sum and the insert happen in
 * ONE transaction, which is not something the return value can show — so the
 * fake transaction raises this while the callback runs and the tests assert on
 * it.
 */
let txDepth = 0;

const prisma = {
  mediaObject: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  },
  classroom: {
    findUnique: vi.fn(),
  },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
};
vi.mock('@classmoji/database', () => ({ default: () => prisma }));

const getProStateForClassroomId = vi.fn();
vi.mock('../../classmoji/subscription.service.ts', () => ({
  getProStateForClassroomId: (...args: unknown[]) => getProStateForClassroomId(...args),
}));

const {
  abortUpload,
  completeUpload,
  createUpload,
  deleteMedia,
  listMedia,
  onMediaReady,
  purgeClassroomMedia,
  putMediaObject,
  signParts,
  SINGLE_PUT_MAX_BYTES,
  usage,
  VIDEO_ENQUEUE_FAILED_REASON,
} = await import('../media.service.ts');
const { toMediaRecord } = await import('../mediaLookup.ts');
const { PART_SIZE_BYTES, PER_FILE_MAX_BYTES, PRO_QUOTA_BYTES, RESERVATION_WINDOW_MS } =
  await import('../mediaQuota.ts');
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
    destination: null,
    stage_target_type: null,
    stage_target_id: null,
    placed_ref: null,
    placement_error: null,
    ...overrides,
  };
}

/** Where an agent upload's bytes wait (see `stageKey`). */
const STAGE_KEY_FIXTURE = () => `stage/${CLASSROOM_ID}/${MEDIA_ID}`;

function configure(): void {
  process.env.MEDIA_R2_ACCOUNT_ID = 'acct';
  process.env.MEDIA_R2_ACCESS_KEY_ID = 'key';
  process.env.MEDIA_R2_SECRET_ACCESS_KEY = 'secret';
  process.env.MEDIA_R2_BUCKET = 'classmoji-media-test';
  // The delivery layer's two env vars: media is only ever served signed, so a
  // deployment that cannot sign is refused DELIVERY_REQUIRED at the door.
  process.env.CONTENT_SIGNING_SECRET = 'secret';
  process.env.CONTENT_DELIVERY_ORIGIN = 'https://content.test';
  resetR2Client();
}

function unconfigure(): void {
  delete process.env.MEDIA_R2_ACCOUNT_ID;
  delete process.env.MEDIA_R2_ACCESS_KEY_ID;
  delete process.env.MEDIA_R2_SECRET_ACCESS_KEY;
  delete process.env.MEDIA_R2_BUCKET;
  delete process.env.CONTENT_SIGNING_SECRET;
  delete process.env.CONTENT_DELIVERY_ORIGIN;
  resetR2Client();
}

/** The conditional write that flipped a row READY. */
const readyFlip = () =>
  prisma.mediaObject.updateMany.mock.calls
    .map(call => call[0])
    .find(arg => (arg as { data?: { status?: string } }).data?.status === 'READY');

/** The one key every variant of the fixture row lives under. */
const ORIG_KEY = `m/${CLASSROOM_ID}/${MEDIA_ID}/orig.mp4`;

beforeEach(() => {
  sent.length = 0;
  sendImpl.mockReset();
  trigger.mockReset();
  trigger.mockResolvedValue({ id: 'run_1' });
  getSignedUrl.mockReset();
  getSignedUrl.mockResolvedValue('https://r2.example/signed');
  for (const fn of Object.values(prisma.mediaObject)) fn.mockReset();
  prisma.mediaObject.findMany.mockResolvedValue([]);
  prisma.mediaObject.findFirst.mockResolvedValue(null);
  prisma.mediaObject.update.mockImplementation(async ({ data }: { data: object }) =>
    row({ ...data })
  );
  prisma.mediaObject.updateMany.mockResolvedValue({ count: 1 });
  txDepth = 0;
  prisma.$queryRaw.mockReset();
  prisma.$queryRaw.mockResolvedValue([{ id: CLASSROOM_ID }]);
  prisma.$transaction.mockReset();
  prisma.$transaction.mockImplementation(
    async (run: (tx: typeof prisma) => Promise<unknown>): Promise<unknown> => {
      txDepth += 1;
      try {
        return await run(prisma);
      } finally {
        txDepth -= 1;
      }
    }
  );
  getProStateForClassroomId.mockResolvedValue({ isPro: true });
  // A classroom whose references the delivery layer can actually sign. Media
  // has no legacy serving path, so this is a precondition for uploading.
  prisma.classroom.findUnique.mockReset();
  prisma.classroom.findUnique.mockResolvedValue({
    content_delivery_enabled: true,
    content_repo: 'content-dartmouth-cs52-cs52-25s',
    git_organization: {
      login: 'dartmouth-cs52',
      provider: 'GITHUB',
      github_installation_id: '12345',
    },
  });
  configure();
});

afterEach(() => {
  unconfigure();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Drive a call that has to sit through the size check's retry pause, without
 * sitting through it.
 *
 * The pause is the point of the retry — a second `HeadObject` in the same tick
 * asks the same overloaded node the same question — so the tests that reach the
 * second attempt step time forward instead of waiting. Repeated advances rather
 * than one: the timer is only scheduled once the first attempt has failed, so
 * the loop has to hand control back to the promise chain in between.
 */
async function settleThroughRetry<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(
    value => () => value,
    (error: unknown) => () => {
      throw error;
    }
  );
  for (let i = 0; i < 5; i += 1) await vi.advanceTimersByTimeAsync(1_000);
  return (await settled)();
}

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
        rendition_key: `m/${CLASSROOM_ID}/${MEDIA_ID}/web-0123456789ab.mp4`,
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
        rendition_key: `m/${CLASSROOM_ID}/${MEDIA_ID}/web-0123456789ab.mp4`,
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
    // A browser upload and an agent's staged upload reserve alike.
    expect(uploading.status).toEqual({ in: ['UPLOADING', 'STAGING'] });
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

  it('leaves out agent uploads that are still waiting to be placed', async () => {
    // STAGING rows count against the quota (usage) but are not media yet —
    // most are on their way into the course repository.
    prisma.mediaObject.findMany.mockResolvedValue([
      row({ id: 'a', status: 'READY' }),
      row({ id: 'b', status: 'STAGING', destination: 'repo' }),
      row({ id: 'c', status: 'UPLOADING', upload_id: 'u' }),
    ]);
    const records = await listMedia(classroom);
    expect(records.map(record => record.id)).toEqual(['a', 'c']);
  });
});

describe('createUpload', () => {
  /** The id the service minted for this create — it is not the DB's any more. */
  const reservedId = (): string =>
    prisma.mediaObject.create.mock.calls[0][0].data.id as unknown as string;

  beforeEach(() => {
    // Echo the id back, as Postgres would: the key was built from it before
    // the row existed, so a fixture with a different id would hide a mismatch.
    prisma.mediaObject.create.mockImplementation(async ({ data }: { data: object }) =>
      row({ status: 'UPLOADING', ...data })
    );
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
      mediaId: reservedId(),
      uploadId: 'upload-1',
      contentType: 'video/mp4',
      partSize: PART_SIZE_BYTES,
      partCount: 4,
    });
    expect(created.mediaId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );

    const create = sent.find(call => call.name === 'CreateMultipartUpload');
    expect(create?.input).toMatchObject({
      Bucket: 'classmoji-media-test',
      Key: `m/${CLASSROOM_ID}/${created.mediaId}/orig.mp4`,
      ContentType: 'video/mp4',
    });
    expect(prisma.mediaObject.update).toHaveBeenCalledWith({
      where: { id: created.mediaId },
      data: { upload_id: 'upload-1' },
    });
  });

  it('allows media uploads for a connected GitLab classroom', async () => {
    prisma.classroom.findUnique.mockImplementation(async ({ select }) => ({
      content_delivery_enabled: true,
      content_repo: 'content-repo',
      git_organization: {
        login: 'org',
        provider: 'GITLAB',
        ...(select.git_organization.select.gitlab_connection_id
          ? { gitlab_connection_id: 'connection' }
          : {}),
      },
    }));
    await expect(
      createUpload({ classroom, userId: 'u', filename: 'a.mp4', sizeBytes: 10 })
    ).resolves.toMatchObject({ uploadId: 'upload-1' });
  });

  it('refuses a classroom whose content cannot be delivered', async () => {
    // Uploading into a classroom the Worker cannot sign for would store bytes
    // that render as a /missing/ placeholder and nothing else.
    for (const classroomRow of [
      null,
      { content_delivery_enabled: false, content_repo: 'r', git_organization: null },
      {
        content_delivery_enabled: true,
        content_repo: 'r',
        // The org never finished installing the GitHub App.
        git_organization: { login: 'o', provider: 'GITHUB', github_installation_id: null },
      },
    ]) {
      prisma.classroom.findUnique.mockResolvedValue(classroomRow);
      await expect(
        createUpload({ classroom, userId: 'u', filename: 'a.mp4', sizeBytes: 10 })
      ).rejects.toMatchObject({ code: 'DELIVERY_REQUIRED' });
    }

    expect(prisma.mediaObject.create).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('refuses where R2 is configured but the deployment cannot sign delivery URLs', async () => {
    delete process.env.CONTENT_SIGNING_SECRET;
    await expect(
      createUpload({ classroom, userId: 'u', filename: 'a.mp4', sizeBytes: 10 })
    ).rejects.toMatchObject({ code: 'DELIVERY_REQUIRED' });
    expect(prisma.mediaObject.create).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('builds the key before it reserves anything', async () => {
    // `mediaKey` validates every part of the string it makes. If that refusal
    // landed after the INSERT, the classroom would hold a reservation for a
    // day with no upload behind it.
    await expect(
      createUpload({
        classroom: { id: 'not-a-classroom-id' },
        userId: 'u',
        filename: 'a.mp4',
        sizeBytes: 10,
      })
    ).rejects.toThrow();

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.mediaObject.create).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('refuses in order: configured, kind, Pro, per-file, quota', async () => {
    unconfigure();
    await expect(
      createUpload({ classroom, userId: 'u', filename: 'a.mp4', sizeBytes: 1 })
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    configure();

    await expect(
      createUpload({ classroom, userId: 'u', filename: 'README', sizeBytes: 1 })
    ).rejects.toMatchObject({ code: 'KIND_NOT_ALLOWED' });

    // Pro comes BEFORE the numbers, so a free classroom hears PRO_REQUIRED even
    // for a file that is also too big — "you cannot store media" is the useful
    // half of that answer.
    getProStateForClassroomId.mockResolvedValue({ isPro: false });
    await expect(
      createUpload({ classroom, userId: 'u', filename: 'a.mp4', sizeBytes: PER_FILE_MAX_BYTES + 1 })
    ).rejects.toMatchObject({ code: 'PRO_REQUIRED' });

    getProStateForClassroomId.mockResolvedValue({ isPro: true });
    await expect(
      createUpload({ classroom, userId: 'u', filename: 'a.mp4', sizeBytes: PER_FILE_MAX_BYTES + 1 })
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });

    // Nothing was written or opened on any of those paths.
    expect(prisma.mediaObject.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('refuses a file that would not fit, and says by how much', async () => {
    prisma.mediaObject.findMany.mockResolvedValue([row({ size_bytes: BigInt(9 * GIB) })]);
    await expect(
      createUpload({ classroom, userId: 'u', filename: 'a.mp4', sizeBytes: PER_FILE_MAX_BYTES })
    ).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      // Tim's decision (2026-09-27): full means full — say so, and how to get more.
      message: "This class's media storage is full. Contact hello@classmoji.io to upgrade.",
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

  it('limits one gallery uploader across forms while including pending reservations', async () => {
    prisma.mediaObject.findMany.mockResolvedValue([
      row({
        uploaded_by: 'student',
        gallery_form_id: 'previous-form',
        status: 'UPLOADING',
        size_bytes: 950_000_000n,
      }),
      row({ uploaded_by: 'other-student', gallery_form_id: 'form', size_bytes: 500_000_000n }),
    ]);
    await expect(
      createUpload({
        classroom,
        userId: 'student',
        filename: 'demo.mp4',
        sizeBytes: 60_000_000,
        gallery: { formId: 'form', fieldId: 'video' },
      })
    ).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      usedBytes: 950_000_000,
      quotaBytes: 1_000_000_000,
    });
    expect(prisma.mediaObject.create).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('bounds tiny gallery uploads independently of the byte quota', async () => {
    prisma.mediaObject.findMany.mockResolvedValue(
      Array.from({ length: 50 }, () =>
        row({ uploaded_by: 'student', gallery_form_id: 'form', size_bytes: 10n })
      )
    );
    await expect(
      createUpload({
        classroom,
        userId: 'student',
        filename: 'a.mp4',
        sizeBytes: 10,
        gallery: { formId: 'form', fieldId: 'video' },
      })
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(prisma.mediaObject.create).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('locks the classroom, sums and inserts inside ONE transaction', async () => {
    // Ageing the reservation out only works if nothing can slip between the
    // sum and the insert — which is a claim about WHERE the calls happen, not
    // about what they return.
    const where: string[] = [];
    prisma.mediaObject.findMany.mockImplementation(async () => {
      where.push(txDepth > 0 ? 'sum inside' : 'sum outside');
      return [];
    });
    prisma.mediaObject.create.mockImplementation(async () => {
      where.push(txDepth > 0 ? 'insert inside' : 'insert outside');
      return row({ status: 'UPLOADING' });
    });

    await createUpload({ classroom, userId: 'u', filename: 'a.mp4', sizeBytes: 10 });

    expect(where).toEqual(['sum inside', 'insert inside']);

    // The lock itself, taken first and on this classroom's row.
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0] as [string[], ...unknown[]];
    expect(strings.join('?')).toContain('FOR UPDATE');
    expect(values).toEqual([CLASSROOM_ID]);
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.mediaObject.findMany.mock.invocationCallOrder[0]
    );

    // R2 is NOT inside: the lock blocks every other upload in the classroom.
    expect(sent.every(call => call.name === 'CreateMultipartUpload')).toBe(true);
    expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      // The multipart is opened after the transaction has committed.
      prisma.mediaObject.update.mock.invocationCallOrder[0]
    );
  });

  it('takes any extension, typing an unknown one as an opaque download', async () => {
    // §7.10: media is where a Pro classroom's large files go, whatever they
    // are. What it must never do is serve one as something runnable.
    sendImpl.mockResolvedValue({ UploadId: 'up-1' });
    for (const [filename, ext] of [
      ['Week 3.ipynb', 'ipynb'],
      ['page.HTML', 'html'],
      ['diagram.svg', 'svg'],
    ]) {
      prisma.mediaObject.create.mockClear();
      sent.length = 0;
      // `explicit`: small non-video files reach media only from Settings → Media.
      const created = await createUpload({
        classroom,
        userId: 'u',
        filename,
        sizeBytes: 10,
        options: { explicit: true },
      });

      expect(created.contentType).toBe('application/octet-stream');
      expect(prisma.mediaObject.create.mock.calls[0][0].data).toMatchObject({
        kind: 'OTHER',
        ext,
        content_type: 'application/octet-stream',
        allow_download: true,
      });
      expect(sent.find(call => call.name === 'CreateMultipartUpload')?.input).toMatchObject({
        ContentType: 'application/octet-stream',
      });
    }
  });

  it('keeps a small non-video file in the repository unless the upload is explicit', async () => {
    // §7.10: media is for video and for what the repository cannot take.
    getProStateForClassroomId.mockClear();
    for (const filename of ['notes.pdf', 'diagram.png', 'data.csv']) {
      await expect(
        createUpload({ classroom, userId: 'u', filename, sizeBytes: 5 * 1024 * 1024 }),
        filename
      ).rejects.toMatchObject({ code: 'USE_REPO' });
    }
    // At the cap is still the repository's.
    await expect(
      createUpload({ classroom, userId: 'u', filename: 'a.pdf', sizeBytes: 35 * 1024 * 1024 })
    ).rejects.toMatchObject({ code: 'USE_REPO' });
    // Refused before anything is looked up, reserved or opened — and before
    // Pro, since where a file goes is the same answer for every classroom.
    expect(getProStateForClassroomId).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('takes a non-video file over the repository cap, and any video, without explicit', async () => {
    await createUpload({
      classroom,
      userId: 'u',
      filename: 'dataset.zip',
      sizeBytes: 35 * 1024 * 1024 + 1,
    });
    await createUpload({ classroom, userId: 'u', filename: 'clip.mp4', sizeBytes: 10 });
    expect(prisma.mediaObject.create).toHaveBeenCalledTimes(2);
  });

  it('takes a small non-video file when the upload is explicit (Settings → Media)', async () => {
    await createUpload({
      classroom,
      userId: 'u',
      filename: 'notes.pdf',
      sizeBytes: 10,
      options: { explicit: true },
    });
    expect(prisma.mediaObject.create.mock.calls[0][0].data).toMatchObject({ kind: 'DOCUMENT' });
  });

  it('refuses a name with no extension, or one the variant cannot carry', async () => {
    for (const [filename, words] of [
      ['Makefile', 'needs an extension'],
      ['.gitignore', 'needs an extension'],
      ['notes.データ', 'needs an extension'],
      ['export.longextension', 'at most 8'],
    ]) {
      await expect(
        createUpload({ classroom, userId: 'u', filename, sizeBytes: 10 }),
        filename
      ).rejects.toMatchObject({
        code: 'KIND_NOT_ALLOWED',
        message: expect.stringContaining(words),
      });
    }
    expect(prisma.mediaObject.create).not.toHaveBeenCalled();
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
      options: { optimise: true, allowDownload: true, explicit: true },
    });
    expect(prisma.mediaObject.create.mock.calls[0][0].data).toMatchObject({
      kind: 'DOCUMENT',
      optimise: false,
      keep_original: true,
      // Download control is a VIDEO setting; a PDF is the file itself.
      allow_download: true,
    });

    prisma.mediaObject.create.mockClear();
    await createUpload({
      classroom,
      userId: 'u',
      filename: 'handout.zip',
      sizeBytes: 10,
      options: { allowDownload: false, explicit: true },
    });
    expect(prisma.mediaObject.create.mock.calls[0][0].data).toMatchObject({
      kind: 'ARCHIVE',
      allow_download: true,
    });
  });

  it('keeps the original whenever there will be no rendition to replace it', async () => {
    // "Do not transcode, and delete the only copy" is a request to delete the
    // file, so the second half cannot be honoured on its own.
    await createUpload({
      classroom,
      userId: 'u',
      filename: 'a.mp4',
      sizeBytes: 10,
      options: { optimise: false, keepOriginal: false },
    });
    expect(prisma.mediaObject.create.mock.calls[0][0].data).toMatchObject({
      optimise: false,
      keep_original: true,
    });

    // With optimise on, the uploader's choice stands.
    prisma.mediaObject.create.mockClear();
    await createUpload({
      classroom,
      userId: 'u',
      filename: 'a.mp4',
      sizeBytes: 10,
      options: { optimise: true, keepOriginal: false },
    });
    expect(prisma.mediaObject.create.mock.calls[0][0].data).toMatchObject({
      optimise: true,
      keep_original: false,
    });
  });

  it('drops the reserving row when R2 will not open the upload', async () => {
    sendImpl.mockRejectedValue(new Error('r2 is down'));
    await expect(
      createUpload({ classroom, userId: 'u', filename: 'a.mp4', sizeBytes: 10 })
    ).rejects.toThrow('r2 is down');
    // Otherwise the classroom pays for a reservation with nothing behind it.
    expect(prisma.mediaObject.delete).toHaveBeenCalledWith({ where: { id: reservedId() } });
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
      {
        Bucket: 'classmoji-media-test',
        Key: ORIG_KEY,
        UploadId: 'up-1',
        PartNumber: 1,
        ContentLength: PART_SIZE_BYTES,
      },
      // The last part is the remainder: PART_SIZE_BYTES + 1 declared bytes.
      {
        Bucket: 'classmoji-media-test',
        Key: ORIG_KEY,
        UploadId: 'up-1',
        PartNumber: 2,
        ContentLength: 1,
      },
    ]);
    expect(getSignedUrl.mock.calls[0][2]).toMatchObject({ expiresIn: 15 * 60 });
    // The length is what the rule rests on, so it is named as signed rather
    // than left to the presigner's default.
    expect(
      (getSignedUrl.mock.calls[0][2] as { signableHeaders: Set<string> }).signableHeaders.has(
        'content-length'
      )
    ).toBe(true);
  });

  it('signs a full last part when the size is an exact multiple of the part size', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ status: 'UPLOADING', upload_id: 'up-1', size_bytes: BigInt(2 * PART_SIZE_BYTES) })
    );
    await signParts({ classroom, mediaId: MEDIA_ID, partNumbers: [1, 2] });
    const lengths = getSignedUrl.mock.calls.map(
      call => (call[1] as { input: { ContentLength: number } }).input.ContentLength
    );
    expect(lengths).toEqual([PART_SIZE_BYTES, PART_SIZE_BYTES]);
  });

  it('signs a one-part file for exactly its own size', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ status: 'UPLOADING', upload_id: 'up-1', size_bytes: BigInt(12_345) })
    );
    await signParts({ classroom, mediaId: MEDIA_ID, partNumbers: [1] });
    expect(
      (getSignedUrl.mock.calls[0][1] as { input: { ContentLength: number } }).input.ContentLength
    ).toBe(12_345);
  });

  it('refuses and cancels an upload older than its reservation window', async () => {
    // Its bytes stopped counting when the window closed. Letting it go on
    // would store a file the quota never covered.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendImpl.mockResolvedValue({});
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({
        status: 'UPLOADING',
        upload_id: 'up-1',
        created_at: new Date(Date.now() - RESERVATION_WINDOW_MS - 1000),
      })
    );

    await expect(
      signParts({ classroom, mediaId: MEDIA_ID, partNumbers: [1] })
    ).rejects.toMatchObject({ code: 'UPLOAD_EXPIRED' });

    expect(getSignedUrl).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        name: 'AbortMultipartUpload',
        input: { Bucket: 'classmoji-media-test', Key: ORIG_KEY, UploadId: 'up-1' },
      },
    ]);
    expect(prisma.mediaObject.updateMany.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { id: MEDIA_ID, status: 'UPLOADING' },
      data: expect.objectContaining({ status: 'DELETED' }),
    });
  });

  it('still signs an upload just inside its window', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({
        status: 'UPLOADING',
        upload_id: 'up-1',
        created_at: new Date(Date.now() - RESERVATION_WINDOW_MS + 60_000),
      })
    );
    const { urls } = await signParts({ classroom, mediaId: MEDIA_ID, partNumbers: [1] });
    expect(urls).toHaveLength(1);
    expect(prisma.mediaObject.updateMany).not.toHaveBeenCalled();
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

    expect(result).toEqual({ mediaId: MEDIA_ID, ref: `media://${MEDIA_ID}`, sizeBytes: 4096 });
    // READY only FROM UPLOADING: a conditional write, never an unconditional one.
    expect(prisma.mediaObject.update).not.toHaveBeenCalled();
    expect(readyFlip()).toMatchObject({
      where: { id: MEDIA_ID, status: 'UPLOADING' },
      data: {
        status: 'READY',
        upload_id: null,
        // NONE even for a row that asked to be optimised: PENDING is written by
        // `onMediaReady`, in the step that queues the job, and nowhere else.
        processing: 'NONE',
      },
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

  it('retries the size check once, after a pause, before giving up on it', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let heads = 0;
    const at: number[] = [];
    sendImpl.mockImplementation(async (name: string) => {
      if (name !== 'HeadObject') return {};
      at.push(Date.now());
      if (++heads === 1) throw new Error('503 slow down');
      return { ContentLength: 4096 };
    });

    const result = await settleThroughRetry(
      completeUpload({
        classroom,
        mediaId: MEDIA_ID,
        parts: [{ partNumber: 1, etag: '"a"' }],
      })
    );

    expect(heads).toBe(2);
    // Not in the same tick: a second head issued immediately asks the same
    // overloaded node the same question.
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(250);
    expect(result).toMatchObject({ mediaId: MEDIA_ID });
    expect(readyFlip()?.data).toMatchObject({
      status: 'READY',
    });
  });

  it('discards an object it could not read back at all', async () => {
    // Unverified bytes in the bucket behind a row that ages out of the quota is
    // the one outcome worse than a refusal.
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'HeadObject') throw new Error('r2 is down');
      return {};
    });

    await expect(
      settleThroughRetry(
        completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
      )
    ).rejects.toMatchObject({ code: 'VERIFY_FAILED' });

    expect(sent.filter(call => call.name === 'HeadObject')).toHaveLength(2);
    expect(sent.find(call => call.name === 'DeleteObject')?.input).toMatchObject({ Key: ORIG_KEY });
    expect(prisma.mediaObject.updateMany.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { id: MEDIA_ID, status: 'UPLOADING' },
      data: expect.objectContaining({ status: 'DELETED' }),
    });
  });

  it('calls a reply with no size unverified, never a size of -1', async () => {
    // `Number(undefined ?? -1)` is a number, so the caller compared -1 to the
    // declared bytes and reported SIZE_MISMATCH — "you uploaded -1 bytes" — for
    // an object nobody had managed to measure.
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    for (const ContentLength of [undefined, null]) {
      sent.length = 0;
      sendImpl.mockImplementation(async (name: string) =>
        name === 'HeadObject' ? { ContentLength } : {}
      );

      await expect(
        settleThroughRetry(
          completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
        ),
        String(ContentLength)
      ).rejects.toMatchObject({ code: 'VERIFY_FAILED' });

      // Same cleanup as any other unverified object: row first, then the bytes.
      expect(sent.filter(call => call.name === 'HeadObject')).toHaveLength(2);
      expect(sent.find(call => call.name === 'DeleteObject')?.input).toMatchObject({
        Key: ORIG_KEY,
      });
    }
  });

  it('retries a Complete that R2 answered with a 5xx once, and finishes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ status: 'UPLOADING', upload_id: 'up-1', size_bytes: BigInt(4096) })
    );
    let completes = 0;
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'CompleteMultipartUpload' && ++completes === 1) {
        throw Object.assign(new Error('internal'), {
          name: 'InternalError',
          $metadata: { httpStatusCode: 500 },
        });
      }
      if (name === 'HeadObject') return { ContentLength: 4096 };
      return {};
    });

    await expect(
      completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
    ).resolves.toMatchObject({ mediaId: MEDIA_ID, sizeBytes: 4096 });

    expect(completes).toBe(2);
    expect(sent.some(call => call.name === 'AbortMultipartUpload')).toBe(false);
    expect(sent.some(call => call.name === 'DeleteObject')).toBe(false);
  });

  it('reads a NoSuchUpload on the retry as "the first attempt landed" and verifies the size', async () => {
    // The first Complete assembled the object but its answer was a 5xx. The
    // retry then meets a multipart that no longer exists; the size check is
    // what decides, and here the object is there and the right size.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ status: 'UPLOADING', upload_id: 'up-1', size_bytes: BigInt(4096) })
    );
    let completes = 0;
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'CompleteMultipartUpload') {
        completes += 1;
        throw completes === 1
          ? Object.assign(new Error('bad gateway'), { $metadata: { httpStatusCode: 502 } })
          : Object.assign(new Error('gone'), { name: 'NoSuchUpload' });
      }
      if (name === 'HeadObject') return { ContentLength: 4096 };
      return {};
    });

    await expect(
      completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
    ).resolves.toMatchObject({ mediaId: MEDIA_ID });
    expect(sent.some(call => call.name === 'AbortMultipartUpload')).toBe(false);
  });

  it('does not retry a 4xx, and aborts after a second 5xx', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ status: 'UPLOADING', upload_id: 'up-1', size_bytes: BigInt(4096) })
    );

    // A 4xx: the request is wrong, one attempt only.
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'CompleteMultipartUpload') {
        throw Object.assign(new Error('InvalidPart'), { $metadata: { httpStatusCode: 400 } });
      }
      return {};
    });
    await expect(
      completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
    ).rejects.toThrow('InvalidPart');
    expect(sent.filter(call => call.name === 'CompleteMultipartUpload')).toHaveLength(1);
    expect(sent.some(call => call.name === 'AbortMultipartUpload')).toBe(true);

    // Two 5xx in a row: retried once, then the ordinary abort path.
    sent.length = 0;
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'CompleteMultipartUpload') {
        throw Object.assign(new Error('unavailable'), { $metadata: { httpStatusCode: 503 } });
      }
      return {};
    });
    await expect(
      completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
    ).rejects.toThrow('unavailable');
    expect(sent.filter(call => call.name === 'CompleteMultipartUpload')).toHaveLength(2);
    expect(sent.some(call => call.name === 'AbortMultipartUpload')).toBe(true);
  });

  it('refuses an agent upload (STAGING), even one holding a multipart id', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ status: 'STAGING', upload_id: 'up-1', destination: 'media' })
    );
    await expect(
      completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
    ).rejects.toMatchObject({ code: 'BAD_STATE' });
    expect(sent).toHaveLength(0);
  });

  it('aborts, tombstones, then deletes the object when the assembly itself fails', async () => {
    // A complete that errors may still have assembled the object on R2's side
    // (a timeout, a dropped response). Once the row is DELETED nothing would
    // ever bill or find it, so it goes — after the tombstone, never before.
    const order: string[] = [];
    prisma.mediaObject.updateMany.mockImplementation(async () => {
      order.push('tombstone');
      return { count: 1 };
    });
    sendImpl.mockImplementation(async (name: string) => {
      order.push(name);
      if (name === 'CompleteMultipartUpload') throw new Error('bad part');
      return {};
    });

    await expect(
      completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
    ).rejects.toThrow('bad part');

    expect(order).toEqual([
      'CompleteMultipartUpload',
      'AbortMultipartUpload',
      'tombstone',
      'DeleteObject',
    ]);
    expect(sent.find(call => call.name === 'DeleteObject')?.input).toMatchObject({ Key: ORIG_KEY });
    expect(prisma.mediaObject.updateMany.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { id: MEDIA_ID, status: 'UPLOADING' },
      data: expect.objectContaining({ status: 'DELETED' }),
    });
  });

  it('deletes what it may have assembled when the assembly fails for a call that lost to a cancel', async () => {
    // The row went DELETED while this call was assembling. Its tombstone
    // matches nothing and the caller hears what an abort would have told it.
    // An abort only cancels the multipart, so if R2 assembled the object
    // anyway, nothing else would ever delete it — and a DELETED row never
    // becomes READY again, so these cannot be live bytes.
    let reads = 0;
    prisma.mediaObject.findFirst.mockImplementation(async () =>
      ++reads === 1
        ? row({ status: 'UPLOADING', upload_id: 'up-1', size_bytes: BigInt(4096) })
        : row({ status: 'DELETED', upload_id: null, size_bytes: BigInt(4096) })
    );
    prisma.mediaObject.updateMany.mockResolvedValue({ count: 0 });
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'CompleteMultipartUpload') throw new Error('NoSuchUpload');
      return {};
    });

    await expect(
      completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(sent.filter(call => call.name === 'DeleteObject').map(c => c.input.Key)).toEqual([
      ORIG_KEY,
    ]);
  });

  it('cannot un-READY a row another call already finished', async () => {
    // Two completes of the same upload racing: both read the row as open, the
    // first assembles the object and marks it READY, and R2 answers the second
    // with NoSuchUpload because there is no multipart left. The second call's
    // cleanup must not land on the row the first one finished — and since the
    // file exists, the second caller is told it succeeded.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = { status: 'UPLOADING' };
    let stale = true;
    prisma.mediaObject.findFirst.mockImplementation(async () =>
      // A stale read is what makes this a race at all: both calls believe the
      // row is still open. The fresh re-read after the lost race sees the truth.
      row({
        status: stale ? 'UPLOADING' : state.status,
        upload_id: 'up-1',
        size_bytes: BigInt(4096),
      })
    );
    prisma.mediaObject.updateMany.mockImplementation(
      async ({ where, data }: { where: { status: string }; data: { status: string } }) => {
        // `onMediaReady`'s processing claim writes no status; not this race.
        if (data.status === undefined) return { count: 0 };
        if (where.status !== state.status) return { count: 0 };
        state.status = data.status;
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

    const second = completeUpload({
      classroom,
      mediaId: MEDIA_ID,
      parts: [{ partNumber: 1, etag: '"a"' }],
    });
    // The stale read happens first; everything after it is fresh.
    queueMicrotask(() => (stale = false));
    await expect(second).resolves.toEqual({
      mediaId: MEDIA_ID,
      ref: `media://${MEDIA_ID}`,
      sizeBytes: 4096,
    });

    // The file exists and is being served; the second call's conclusion about
    // it was out of date.
    expect(state.status).toBe('READY');
    expect(sent.some(call => call.name === 'DeleteObject')).toBe(false);
  });

  it('leaves the object alone when it cannot verify a file another call already finished', async () => {
    // Two completes of one upload: A assembles, verifies and marks READY. B read
    // the row while it was still open, R2 accepted B's complete as a replay of
    // the finished upload, and then B could not read the object back. The bytes
    // B failed to measure ARE A's file — B must not delete them, and since the
    // file exists, B's caller is told it succeeded.
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = { status: 'UPLOADING' };
    let staleReads = 0;
    prisma.mediaObject.findFirst.mockImplementation(async () => {
      if (staleReads > 0) {
        staleReads -= 1;
        return row({ status: 'UPLOADING', upload_id: 'up-1', size_bytes: BigInt(4096) });
      }
      return row({
        status: state.status,
        upload_id: state.status === 'UPLOADING' ? 'up-1' : null,
        size_bytes: BigInt(4096),
      });
    });
    prisma.mediaObject.updateMany.mockImplementation(
      async ({ where, data }: { where: { status: string }; data: { status: string } }) => {
        // `onMediaReady`'s processing claim writes no status; not this race.
        if (data.status === undefined) return { count: 0 };
        if (where.status !== state.status) return { count: 0 };
        state.status = data.status;
        return { count: 1 };
      }
    );
    let headFails = false;
    sendImpl.mockImplementation(async (name: string) => {
      if (name !== 'HeadObject') return {};
      if (headFails) throw new Error('r2 is down');
      return { ContentLength: 4096 };
    });

    const a = await completeUpload({
      classroom,
      mediaId: MEDIA_ID,
      parts: [{ partNumber: 1, etag: '"a"' }],
    });
    expect(state.status).toBe('READY');

    // B's first read is from before A finished; its re-read after the lost
    // tombstone is fresh.
    staleReads = 1;
    headFails = true;
    sent.length = 0;
    const b = await settleThroughRetry(
      completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
    );

    expect(sent.filter(call => call.name === 'HeadObject')).toHaveLength(2);
    expect(b).toEqual(a);
    expect(state.status).toBe('READY');
    expect(sent.some(call => call.name === 'DeleteObject')).toBe(false);
  });

  it('deletes the object when it cannot verify an upload cancelled underneath it', async () => {
    // The row went DELETED between this call's read and its tombstone: the
    // conditional tombstone matches nothing, and this call is told what an
    // abort would have told it. The object goes too — the abort only cancelled
    // the multipart, and a DELETED row can never serve these bytes.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let reads = 0;
    prisma.mediaObject.findFirst.mockImplementation(async () =>
      ++reads === 1
        ? row({ status: 'UPLOADING', upload_id: 'up-1', size_bytes: BigInt(4096) })
        : row({ status: 'DELETED', upload_id: null, size_bytes: BigInt(4096) })
    );
    prisma.mediaObject.updateMany.mockResolvedValue({ count: 0 });
    sendImpl.mockImplementation(async (name: string) =>
      name === 'HeadObject' ? { ContentLength: 99_999_999 } : {}
    );

    await expect(
      completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(sent.filter(call => call.name === 'DeleteObject').map(c => c.input.Key)).toEqual([
      ORIG_KEY,
    ]);
  });

  it('answers a repeated complete with the same result, touching nothing', async () => {
    // The lost-response retry: the first complete finished, its answer never
    // reached the browser, and the browser asks again.
    const state = { status: 'UPLOADING' };
    prisma.mediaObject.findFirst.mockImplementation(async () =>
      row({ status: state.status, upload_id: state.status === 'UPLOADING' ? 'up-1' : null })
    );
    prisma.mediaObject.updateMany.mockImplementation(
      async ({ data }: { data: { status: string } }) => {
        if (data.status === undefined) return { count: 0 };
        state.status = data.status;
        return { count: 1 };
      }
    );
    sendImpl.mockImplementation(async (name: string) =>
      name === 'HeadObject' ? { ContentLength: 1000 } : {}
    );

    const first = await completeUpload({
      classroom,
      mediaId: MEDIA_ID,
      parts: [{ partNumber: 1, etag: '"a"' }],
    });
    const sendsAfterFirst = sent.length;
    const writesAfterFirst = prisma.mediaObject.updateMany.mock.calls.length;

    const again = await completeUpload({
      classroom,
      mediaId: MEDIA_ID,
      parts: [{ partNumber: 1, etag: '"a"' }],
    });

    expect(again).toEqual(first);
    expect(again).toEqual({ mediaId: MEDIA_ID, ref: `media://${MEDIA_ID}`, sizeBytes: 1000 });
    expect(state.status).toBe('READY');
    // Not R2, not the row.
    expect(sent.length).toBe(sendsAfterFirst);
    expect(prisma.mediaObject.updateMany.mock.calls.length).toBe(writesAfterFirst);
  });

  it('is NOT_FOUND for a row that was cancelled, expired or deleted', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(row({ status: 'DELETED' }));
    await expect(
      completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(sent).toHaveLength(0);
  });

  it('discards the assembled object when the upload was cancelled underneath it', async () => {
    // An abort landed between this call's read and its READY write: the row is
    // DELETED, so nothing would ever serve, bill or delete the object.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let reads = 0;
    prisma.mediaObject.findFirst.mockImplementation(async () =>
      ++reads === 1
        ? row({ status: 'UPLOADING', upload_id: 'up-1', size_bytes: BigInt(4096) })
        : row({ status: 'DELETED', upload_id: null, size_bytes: BigInt(4096) })
    );
    prisma.mediaObject.updateMany.mockResolvedValue({ count: 0 });
    sendImpl.mockImplementation(async (name: string) =>
      name === 'HeadObject' ? { ContentLength: 4096 } : {}
    );

    await expect(
      completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(sent.filter(call => call.name === 'DeleteObject').map(c => c.input.Key)).toEqual([
      ORIG_KEY,
    ]);
  });

  it('refuses and cancels an upload older than its reservation window', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendImpl.mockResolvedValue({});
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({
        status: 'UPLOADING',
        upload_id: 'up-1',
        size_bytes: BigInt(4096),
        created_at: new Date(Date.now() - RESERVATION_WINDOW_MS - 1000),
      })
    );

    await expect(
      completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
    ).rejects.toMatchObject({ code: 'UPLOAD_EXPIRED' });

    // Aborted, never assembled, and the row tombstoned only from UPLOADING.
    expect(sent.map(call => call.name)).toEqual(['AbortMultipartUpload']);
    expect(prisma.mediaObject.updateMany.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { id: MEDIA_ID, status: 'UPLOADING' },
      data: expect.objectContaining({ status: 'DELETED' }),
    });
    expect(prisma.mediaObject.update).not.toHaveBeenCalled();
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
    // "Cancel the upload" and "delete the file" are different intentions. The
    // client's cleanup calls this after a failure it cannot always see the
    // bottom of, so a finished file answers with a no-op, not an error.
    for (const status of ['READY', 'DELETED']) {
      prisma.mediaObject.findFirst.mockResolvedValue(row({ status }));
      await expect(abortUpload({ classroom, mediaId: MEDIA_ID })).resolves.toEqual({
        mediaId: MEDIA_ID,
        aborted: false,
      });
    }
    expect(sent).toHaveLength(0);
    expect(prisma.mediaObject.updateMany).not.toHaveBeenCalled();
  });

  it('cancels an agent upload: tombstones from STAGING, then deletes the staged object', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ status: 'STAGING', destination: 'repo', upload_id: null })
    );
    sendImpl.mockResolvedValue({});

    await expect(abortUpload({ classroom, mediaId: MEDIA_ID, userId: 'user-1' })).resolves.toEqual({
      mediaId: MEDIA_ID,
      aborted: true,
    });
    expect(prisma.mediaObject.updateMany.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { id: MEDIA_ID, status: 'STAGING' },
      data: expect.objectContaining({ status: 'DELETED' }),
    });
    expect(sent).toEqual([
      { name: 'DeleteObject', input: { Bucket: 'classmoji-media-test', Key: STAGE_KEY_FIXTURE() } },
    ]);
  });

  it('aborts a URL import still streaming into its staged multipart', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ status: 'STAGING', destination: 'media', upload_id: 'up-7' })
    );
    sendImpl.mockResolvedValue({});
    await abortUpload({ classroom, mediaId: MEDIA_ID, userId: 'user-1' });
    expect(sent[0]).toEqual({
      name: 'AbortMultipartUpload',
      input: { Bucket: 'classmoji-media-test', Key: STAGE_KEY_FIXTURE(), UploadId: 'up-7' },
    });
  });

  it('leaves the staged object alone when placement won the race', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ status: 'STAGING', destination: 'media', upload_id: null })
    );
    prisma.mediaObject.updateMany.mockResolvedValue({ count: 0 });
    await expect(abortUpload({ classroom, mediaId: MEDIA_ID, userId: 'user-1' })).resolves.toEqual({
      mediaId: MEDIA_ID,
      aborted: false,
    });
    expect(sent).toHaveLength(0);
  });

  it('is NOT_FOUND for an id it has never seen', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(null);
    await expect(abortUpload({ classroom, mediaId: MEDIA_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('is NOT_FOUND for somebody else’s agent upload still staging — and touches nothing', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ status: 'STAGING', destination: 'media', upload_id: 'up-7' })
    );
    for (const userId of ['user-2', undefined]) {
      await expect(abortUpload({ classroom, mediaId: MEDIA_ID, userId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    }
    expect(sent).toHaveLength(0);
    expect(prisma.mediaObject.updateMany).not.toHaveBeenCalled();
  });

  it('still cancels a browser upload (UPLOADING) for any teaching-team caller', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(row({ status: 'UPLOADING', upload_id: 'up-1' }));
    sendImpl.mockResolvedValue({});
    await expect(abortUpload({ classroom, mediaId: MEDIA_ID, userId: 'user-2' })).resolves.toEqual({
      mediaId: MEDIA_ID,
      aborted: true,
    });
  });
});

describe('deleteMedia', () => {
  const PREFIX = `m/${CLASSROOM_ID}/${MEDIA_ID}/`;
  const WEB_KEY = `${PREFIX}web-0123456789ab.mp4`;
  const POSTER_KEY = `${PREFIX}poster-0123456789ab.jpg`;
  /** A replay's pair the row never recorded — the reason the prefix is listed. */
  const STRAY_KEY = `${PREFIX}web-ffffffffffff.mp4`;

  /** R2 answers the prefix listing with `keys`, and every other call with `{}`. */
  function listing(keys: string[]) {
    sendImpl.mockImplementation(async (name: string) =>
      name === 'ListObjectsV2' ? { Contents: keys.map(Key => ({ Key })), IsTruncated: false } : {}
    );
  }

  const deletedKeys = () =>
    sent.filter(call => call.name === 'DeleteObject').map(call => call.input.Key);

  beforeEach(() => listing([ORIG_KEY, WEB_KEY, POSTER_KEY]));

  it('removes every object under the row’s own prefix, named in a column or not', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ rendition_key: WEB_KEY, rendition_bytes: BigInt(100), poster_key: POSTER_KEY })
    );
    listing([ORIG_KEY, WEB_KEY, POSTER_KEY, STRAY_KEY]);

    await deleteMedia({ classroom, mediaId: MEDIA_ID });

    const list = sent.find(call => call.name === 'ListObjectsV2');
    expect(list?.input).toMatchObject({ Bucket: 'classmoji-media-test', Prefix: PREFIX });
    expect(deletedKeys()).toEqual([ORIG_KEY, WEB_KEY, POSTER_KEY, STRAY_KEY]);
    expect(prisma.mediaObject.updateMany.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { id: MEDIA_ID, status: { in: ['UPLOADING', 'READY', 'STAGING'] } },
      data: expect.objectContaining({ status: 'DELETED' }),
    });
  });

  it('follows a truncated listing to the end', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(row());
    sendImpl.mockImplementation(async (name: string, input: Record<string, unknown>) => {
      if (name !== 'ListObjectsV2') return {};
      return input.ContinuationToken === 'page-2'
        ? { Contents: [{ Key: WEB_KEY }], IsTruncated: false }
        : { Contents: [{ Key: ORIG_KEY }], IsTruncated: true, NextContinuationToken: 'page-2' };
    });

    await deleteMedia({ classroom, mediaId: MEDIA_ID });
    expect(deletedKeys()).toEqual([ORIG_KEY, WEB_KEY]);
  });

  it('never deletes a listed key outside the row’s prefix', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(row());
    listing([ORIG_KEY, `m/${CLASSROOM_ID}/77777777-8888-4999-8aaa-bbbbbbbbbbbc/orig.mp4`]);
    await deleteMedia({ classroom, mediaId: MEDIA_ID });
    expect(deletedKeys()).toEqual([ORIG_KEY]);
  });

  it('falls back to the keys the row names when the listing fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ rendition_key: WEB_KEY, poster_key: POSTER_KEY })
    );
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'ListObjectsV2') throw new Error('list failed');
      return {};
    });

    await expect(deleteMedia({ classroom, mediaId: MEDIA_ID })).resolves.toEqual({
      mediaId: MEDIA_ID,
    });
    expect(deletedKeys()).toEqual([ORIG_KEY, WEB_KEY, POSTER_KEY]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not list'), 'list failed');
  });

  it('in the fallback, deletes only rendition and poster keys that parse', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ rendition_key: 'web.mp4', poster_key: '../../elsewhere/poster.webp' })
    );
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'ListObjectsV2') throw new Error('list failed');
      return {};
    });

    await deleteMedia({ classroom, mediaId: MEDIA_ID });
    expect(deletedKeys()).toEqual([ORIG_KEY]);
  });

  it('tombstones the row before it touches a single object', async () => {
    // The order is the invariant: a half-done delete must leave an orphan in
    // the bucket, never a READY row whose bytes are gone.
    prisma.mediaObject.findFirst.mockResolvedValue(row());
    const order: string[] = [];
    prisma.mediaObject.updateMany.mockImplementation(async () => {
      order.push('tombstone');
      return { count: 1 };
    });
    sendImpl.mockImplementation(async (name: string) => {
      order.push(name);
      return name === 'ListObjectsV2' ? { Contents: [{ Key: ORIG_KEY }] } : {};
    });

    await deleteMedia({ classroom, mediaId: MEDIA_ID });
    expect(order).toEqual(['tombstone', 'ListObjectsV2', 'DeleteObject']);
  });

  it('keeps deleting the other keys when one delete fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prisma.mediaObject.findFirst.mockResolvedValue(row());
    let failed = false;
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'ListObjectsV2') {
        return { Contents: [ORIG_KEY, WEB_KEY, POSTER_KEY].map(Key => ({ Key })) };
      }
      if (!failed) {
        failed = true;
        throw new Error('r2 said no');
      }
      return {};
    });

    await expect(deleteMedia({ classroom, mediaId: MEDIA_ID })).resolves.toMatchObject({
      mediaId: MEDIA_ID,
    });

    // All three were attempted, the row is still a tombstone, and the failure
    // was reported rather than swallowed silently.
    expect(deletedKeys()).toHaveLength(3);
    expect(prisma.mediaObject.updateMany.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: 'DELETED',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not delete'), 'r2 said no');
  });

  it('lets the loser of a double delete finish the object deletes too', async () => {
    // The winner tombstoned the row between the loser's read and its write.
    // The loser does not tombstone again, but repeating the deletes is safe
    // and is what a retry of a half-failed delete needs.
    prisma.mediaObject.findFirst.mockResolvedValue(row());
    prisma.mediaObject.updateMany.mockResolvedValue({ count: 0 });

    await expect(deleteMedia({ classroom, mediaId: MEDIA_ID })).resolves.toEqual({
      mediaId: MEDIA_ID,
    });
    expect(deletedKeys()).toHaveLength(3);
  });

  it('aborts first when the upload is still open', async () => {
    // Without the abort, R2 holds the uploaded parts until its own 7-day expiry.
    prisma.mediaObject.findFirst.mockResolvedValue(row({ status: 'UPLOADING', upload_id: 'up-1' }));
    listing([ORIG_KEY]);
    await deleteMedia({ classroom, mediaId: MEDIA_ID });
    expect(sent[0].name).toBe('AbortMultipartUpload');
    expect(deletedKeys()).toEqual([ORIG_KEY]);
  });

  it('re-attempts the object deletes for a row that is already deleted', async () => {
    // A delete whose R2 half failed left a tombstone and some bytes. Asking
    // again must finish the job, not answer NOT_FOUND and strand them.
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ status: 'DELETED', rendition_key: WEB_KEY })
    );
    listing([WEB_KEY, POSTER_KEY]);

    await expect(deleteMedia({ classroom, mediaId: MEDIA_ID })).resolves.toEqual({
      mediaId: MEDIA_ID,
    });

    expect(deletedKeys()).toEqual([WEB_KEY, POSTER_KEY]);
    // The tombstone is not rewritten: `deleted_at` keeps the first delete's time.
    expect(prisma.mediaObject.updateMany).not.toHaveBeenCalled();
  });

  it('deletes a staged agent upload, tombstoning it from STAGING', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ status: 'STAGING', destination: 'media', upload_id: 'up-3' })
    );
    listing([]);
    await deleteMedia({ classroom, mediaId: MEDIA_ID, userId: 'user-1' });

    expect(prisma.mediaObject.updateMany.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { id: MEDIA_ID, status: { in: ['UPLOADING', 'READY', 'STAGING'] } },
    });
    expect(sent[0]).toEqual({
      name: 'AbortMultipartUpload',
      input: { Bucket: 'classmoji-media-test', Key: STAGE_KEY_FIXTURE(), UploadId: 'up-3' },
    });
    expect(deletedKeys()).toContain(STAGE_KEY_FIXTURE());
  });

  it('is NOT_FOUND for somebody else’s agent upload still staging', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ status: 'STAGING', destination: 'media', upload_id: 'up-3' })
    );
    await expect(
      deleteMedia({ classroom, mediaId: MEDIA_ID, userId: 'user-2' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(sent).toHaveLength(0);
    expect(prisma.mediaObject.updateMany).not.toHaveBeenCalled();
  });

  it('deletes a READY object for any caller, as before', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(row({ uploaded_by: 'user-1' }));
    await expect(
      deleteMedia({ classroom, mediaId: MEDIA_ID, userId: 'user-2' })
    ).resolves.toMatchObject({ mediaId: MEDIA_ID });
  });

  it('also clears the stage key of a media row that began as an agent upload', async () => {
    // Placed into media (READY) — the stage object should already be gone, but
    // a placement whose cleanup failed left it, and deleting is idempotent.
    prisma.mediaObject.findFirst.mockResolvedValue(row({ destination: 'media' }));
    await deleteMedia({ classroom, mediaId: MEDIA_ID });
    expect(deletedKeys()).toEqual([ORIG_KEY, WEB_KEY, POSTER_KEY, STAGE_KEY_FIXTURE()]);
  });

  it('is NOT_FOUND for an id this classroom never had', async () => {
    prisma.mediaObject.findFirst.mockResolvedValue(null);
    await expect(deleteMedia({ classroom, mediaId: MEDIA_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(sent).toHaveLength(0);
  });
});

describe('purgeClassroomMedia', () => {
  const PREFIX = `m/${CLASSROOM_ID}/`;
  const STAGE_PREFIX = `stage/${CLASSROOM_ID}/`;

  it('deletes staged agent uploads too, and aborts a staged multipart at its stage key', async () => {
    prisma.mediaObject.findMany.mockResolvedValue([
      { id: MEDIA_ID, ext: 'mp4', upload_id: 'up-s', status: 'STAGING' },
    ]);
    sendImpl.mockImplementation(async (name: string, input: Record<string, unknown>) => {
      if (name !== 'ListObjectsV2') return {};
      return input.Prefix === STAGE_PREFIX
        ? { Contents: [{ Key: STAGE_KEY_FIXTURE() }], IsTruncated: false }
        : { Contents: [], IsTruncated: false };
    });

    await expect(purgeClassroomMedia(CLASSROOM_ID)).resolves.toEqual({ deleted: 1 });

    expect(prisma.mediaObject.findMany.mock.calls[0][0].where).toMatchObject({
      status: { in: ['UPLOADING', 'STAGING'] },
    });
    expect(sent[0]).toEqual({
      name: 'AbortMultipartUpload',
      input: { Bucket: 'classmoji-media-test', Key: STAGE_KEY_FIXTURE(), UploadId: 'up-s' },
    });
    expect(sent.filter(call => call.name === 'DeleteObject').map(call => call.input.Key)).toEqual([
      STAGE_KEY_FIXTURE(),
    ]);
  });

  beforeEach(() => {
    // A classroom that has had media: the purge only goes to R2 for one of these.
    prisma.mediaObject.findFirst.mockResolvedValue({ id: MEDIA_ID });
  });

  it('does nothing on a deployment with no media store', async () => {
    unconfigure();
    await expect(purgeClassroomMedia(CLASSROOM_ID)).resolves.toEqual({ deleted: 0 });
    expect(sent).toHaveLength(0);
    expect(prisma.mediaObject.findMany).not.toHaveBeenCalled();
  });

  it('never asks R2 about a classroom that has had no media, so an outage cannot block it', async () => {
    // Rows are written before any object can exist, and outlive their bytes as
    // tombstones — no row in any status means nothing under the prefix.
    prisma.mediaObject.findFirst.mockResolvedValue(null);
    sendImpl.mockImplementation(async () => {
      throw new Error('r2 is down');
    });

    await expect(purgeClassroomMedia(CLASSROOM_ID)).resolves.toEqual({ deleted: 0 });

    expect(sent).toHaveLength(0);
    // Any status: a DELETED row can still have bytes a failed delete left.
    expect(prisma.mediaObject.findFirst.mock.calls[0][0].where).toEqual({
      classroom_id: CLASSROOM_ID,
    });
  });

  it('deletes every object under the classroom prefix, across pages', async () => {
    sendImpl.mockImplementation(async (name: string, input: Record<string, unknown>) => {
      if (name !== 'ListObjectsV2') return {};
      if (input.Prefix === STAGE_PREFIX) return { Contents: [], IsTruncated: false };
      return input.ContinuationToken === 'page-2'
        ? { Contents: [{ Key: `${PREFIX}c/orig.zip` }], IsTruncated: false }
        : {
            Contents: [{ Key: `${PREFIX}a/orig.mp4` }, { Key: `${PREFIX}a/web.mp4` }],
            IsTruncated: true,
            NextContinuationToken: 'page-2',
          };
    });

    await expect(purgeClassroomMedia(CLASSROOM_ID)).resolves.toEqual({ deleted: 3 });

    const lists = sent.filter(call => call.name === 'ListObjectsV2');
    expect(lists.map(call => call.input)).toEqual([
      { Bucket: 'classmoji-media-test', Prefix: PREFIX, ContinuationToken: undefined },
      { Bucket: 'classmoji-media-test', Prefix: PREFIX, ContinuationToken: 'page-2' },
      { Bucket: 'classmoji-media-test', Prefix: STAGE_PREFIX, ContinuationToken: undefined },
    ]);
    expect(sent.filter(call => call.name === 'DeleteObject').map(call => call.input.Key)).toEqual([
      `${PREFIX}a/orig.mp4`,
      `${PREFIX}a/web.mp4`,
      `${PREFIX}c/orig.zip`,
    ]);
  });

  it('aborts the open uploads first, which a listing cannot see', async () => {
    prisma.mediaObject.findMany.mockResolvedValue([
      { id: MEDIA_ID, ext: 'mp4', upload_id: 'up-9' },
    ]);
    sendImpl.mockImplementation(async (name: string) =>
      name === 'ListObjectsV2' ? { Contents: [], IsTruncated: false } : {}
    );

    await purgeClassroomMedia(CLASSROOM_ID);

    expect(prisma.mediaObject.findMany.mock.calls[0][0].where).toMatchObject({
      classroom_id: CLASSROOM_ID,
      status: { in: ['UPLOADING', 'STAGING'] },
    });
    expect(sent[0]).toEqual({
      name: 'AbortMultipartUpload',
      input: { Bucket: 'classmoji-media-test', Key: ORIG_KEY, UploadId: 'up-9' },
    });
    expect(sent[1].name).toBe('ListObjectsV2');
  });

  it('throws when the listing fails, so the classroom is not deleted', async () => {
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'ListObjectsV2') throw new Error('r2 is down');
      return {};
    });
    await expect(purgeClassroomMedia(CLASSROOM_ID)).rejects.toThrow('r2 is down');
  });

  it('tries every object, then throws when any of them could not be deleted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendImpl.mockImplementation(async (name: string, input: Record<string, unknown>) => {
      if (name === 'ListObjectsV2') {
        if (input.Prefix === STAGE_PREFIX) return { Contents: [], IsTruncated: false };
        return {
          Contents: [{ Key: `${PREFIX}a/orig.mp4` }, { Key: `${PREFIX}b/orig.pdf` }],
          IsTruncated: false,
        };
      }
      if (name === 'DeleteObject' && input.Key === `${PREFIX}a/orig.mp4`) {
        throw new Error('r2 said no');
      }
      return {};
    });

    await expect(purgeClassroomMedia(CLASSROOM_ID)).rejects.toThrow('1 media object');
    expect(sent.filter(call => call.name === 'DeleteObject')).toHaveLength(2);
  });

  it('refuses anything that is not a whole classroom id', async () => {
    // An empty id would be the prefix `m//`; a partial one matches neighbours.
    for (const bad of ['', '1111', `${CLASSROOM_ID}/..`]) {
      await expect(purgeClassroomMedia(bad)).rejects.toThrow(TypeError);
    }
    expect(sent).toHaveLength(0);
    expect(prisma.mediaObject.findMany).not.toHaveBeenCalled();
  });
});

describe('putMediaObject', () => {
  beforeEach(() => {
    prisma.mediaObject.create.mockImplementation(async ({ data }: { data: object }) =>
      row({ status: 'UPLOADING', ...data })
    );
    prisma.mediaObject.findFirst.mockImplementation(async () => row());
  });

  const reservedId = (): string =>
    prisma.mediaObject.create.mock.calls[0][0].data.id as unknown as string;

  it('reserves under the lock, PUTs with the server type and exact length, verifies, READY', async () => {
    const bytes = Buffer.alloc(4096, 1);
    sendImpl.mockImplementation(async (name: string) =>
      name === 'HeadObject' ? { ContentLength: 4096 } : {}
    );

    const result = await putMediaObject({
      classroom,
      userId: 'user-1',
      filename: 'intro.mp4',
      bytes,
    });

    expect(result).toEqual({ mediaId: reservedId(), ref: `media://${reservedId()}` });
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.mediaObject.create.mock.calls[0][0].data).toMatchObject({
      size_bytes: BigInt(4096),
      content_type: 'video/mp4',
    });
    const key = `m/${CLASSROOM_ID}/${reservedId()}/orig.mp4`;
    expect(sent.map(call => call.name)).toEqual(['PutObject', 'HeadObject']);
    expect(sent[0].input).toEqual({
      Bucket: 'classmoji-media-test',
      Key: key,
      Body: bytes,
      ContentType: 'video/mp4',
      ContentLength: 4096,
    });
    expect(readyFlip()).toMatchObject({
      where: { id: reservedId(), status: 'UPLOADING' },
      data: expect.objectContaining({ status: 'READY' }),
    });
  });

  it('removes the object and the reservation when the READY flip throws', async () => {
    sendImpl.mockImplementation(async (name: string) =>
      name === 'HeadObject' ? { ContentLength: 10 } : {}
    );
    prisma.mediaObject.findFirst.mockImplementation(async () => row({ status: 'UPLOADING' }));
    prisma.mediaObject.updateMany.mockImplementation(
      async ({ data }: { data: { status?: string } }) => {
        if (data.status === 'READY') throw new Error('connection reset');
        return { count: 1 };
      }
    );

    await expect(
      putMediaObject({ classroom, userId: 'u', filename: 'intro.mp4', bytes: Buffer.alloc(10) })
    ).rejects.toThrow('connection reset');

    expect(prisma.mediaObject.updateMany.mock.calls.at(-1)?.[0]).toMatchObject({
      where: { id: reservedId(), status: 'UPLOADING' },
      data: expect.objectContaining({ status: 'DELETED' }),
    });
    expect(sent.filter(call => call.name === 'DeleteObject').map(call => call.input.Key)).toEqual([
      `m/${CLASSROOM_ID}/${reservedId()}/orig.mp4`,
    ]);
  });

  it('succeeds when the READY flip landed but its answer was lost', async () => {
    sendImpl.mockImplementation(async (name: string) =>
      name === 'HeadObject' ? { ContentLength: 10 } : {}
    );
    prisma.mediaObject.findFirst.mockImplementation(async () => row({ status: 'READY' }));
    prisma.mediaObject.updateMany.mockImplementation(
      async ({ data }: { data: { status?: string } }) => {
        if (data.status === 'READY') throw new Error('connection reset');
        return { count: 1 };
      }
    );

    const result = await putMediaObject({
      classroom,
      userId: 'u',
      filename: 'intro.mp4',
      bytes: Buffer.alloc(10),
    });
    expect(result.mediaId).toBe(reservedId());
    expect(sent.some(call => call.name === 'DeleteObject')).toBe(false);
  });

  it('applies createUpload’s rules: USE_REPO unless explicit, then Pro', async () => {
    await expect(
      putMediaObject({ classroom, userId: 'u', filename: 'a.png', bytes: Buffer.alloc(10) })
    ).rejects.toMatchObject({ code: 'USE_REPO' });

    getProStateForClassroomId.mockResolvedValue({ isPro: false });
    await expect(
      putMediaObject({
        classroom,
        userId: 'u',
        filename: 'a.png',
        bytes: Buffer.alloc(10),
        options: { explicit: true },
      })
    ).rejects.toMatchObject({ code: 'PRO_REQUIRED' });
    expect(prisma.mediaObject.create).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('refuses over the quota before writing anything', async () => {
    prisma.mediaObject.findMany.mockResolvedValue([row({ size_bytes: BigInt(PRO_QUOTA_BYTES) })]);
    await expect(
      putMediaObject({ classroom, userId: 'u', filename: 'a.mp4', bytes: Buffer.alloc(10) })
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    expect(sent).toHaveLength(0);
  });

  it('tombstones and removes the object when the size does not verify', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendImpl.mockImplementation(async (name: string) =>
      name === 'HeadObject' ? { ContentLength: 5 } : {}
    );
    await expect(
      putMediaObject({ classroom, userId: 'u', filename: 'a.mp4', bytes: Buffer.alloc(10) })
    ).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    expect(prisma.mediaObject.updateMany.mock.calls[0][0]).toMatchObject({
      where: { status: 'UPLOADING' },
      data: expect.objectContaining({ status: 'DELETED' }),
    });
    expect(sent.at(-1)?.name).toBe('DeleteObject');
  });

  it('tombstones the reservation when the PUT fails', async () => {
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'PutObject') throw new Error('r2 down');
      return {};
    });
    await expect(
      putMediaObject({ classroom, userId: 'u', filename: 'a.mp4', bytes: Buffer.alloc(10) })
    ).rejects.toThrow('r2 down');
    expect(prisma.mediaObject.updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'DELETED',
    });
  });

  it('writes in parts above the single-PUT limit', async () => {
    const size = SINGLE_PUT_MAX_BYTES + 5;
    const bytes = Buffer.allocUnsafe(size);
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'CreateMultipartUpload') return { UploadId: 'up-big' };
      if (name === 'UploadPart') return { ETag: '"e"' };
      if (name === 'HeadObject') return { ContentLength: size };
      return {};
    });

    await putMediaObject({ classroom, userId: 'u', filename: 'a.mp4', bytes });

    const parts = sent.filter(call => call.name === 'UploadPart');
    expect(parts.length).toBe(Math.ceil(size / PART_SIZE_BYTES));
    expect(parts.reduce((total, call) => total + (call.input.ContentLength as number), 0)).toBe(
      size
    );
    expect(sent.some(call => call.name === 'PutObject')).toBe(false);
    expect(sent.some(call => call.name === 'CompleteMultipartUpload')).toBe(true);
  });
});

describe('onMediaReady', () => {
  /** The claim: NONE → PENDING, only while the row is READY. */
  const claim = () =>
    prisma.mediaObject.updateMany.mock.calls
      .map(call => call[0])
      .find(arg => (arg as { data?: { processing?: string } }).data?.processing === 'PENDING');
  const failure = () =>
    prisma.mediaObject.updateMany.mock.calls
      .map(call => call[0])
      .find(arg => (arg as { data?: { processing?: string } }).data?.processing === 'FAILED');

  const expectEnqueued = (mediaId: string) => {
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(
      'media-video-process',
      { classroomId: CLASSROOM_ID, mediaId },
      { idempotencyKey: `media-video-process:${mediaId}`, idempotencyKeyTTL: '10m' }
    );
  };

  it('claims an optimisable video and queues its job in the same step', async () => {
    const order: string[] = [];
    prisma.mediaObject.updateMany.mockImplementation(async () => {
      order.push('claim');
      return { count: 1 };
    });
    trigger.mockImplementation(async () => {
      order.push('trigger');
      return { id: 'run_1' };
    });

    await onMediaReady(toMediaRecord(row() as never));

    expect(claim()).toEqual({
      where: { id: MEDIA_ID, status: 'READY', processing: 'NONE' },
      data: { processing: 'PENDING', processing_error: null },
    });
    expect(order).toEqual(['claim', 'trigger']);
    expectEnqueued(MEDIA_ID);
  });

  it.each([
    ['a non-video', { kind: 'DOCUMENT', optimise: false }],
    ['a video not marked optimise', { optimise: false }],
    ['a row that is not READY', { status: 'UPLOADING' }],
  ])('does nothing for %s', async (_label, overrides) => {
    await onMediaReady(toMediaRecord(row(overrides) as never));
    expect(prisma.mediaObject.updateMany).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });

  it('queues nothing when the claim matches no row (already PENDING, DONE or FAILED)', async () => {
    prisma.mediaObject.updateMany.mockResolvedValue({ count: 0 });
    await onMediaReady(toMediaRecord(row() as never));
    expect(trigger).not.toHaveBeenCalled();
  });

  it('marks the row FAILED with a short reason when the job cannot be queued — and does not throw', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    trigger.mockRejectedValue(new Error('trigger is down'));

    await expect(onMediaReady(toMediaRecord(row() as never))).resolves.toBeUndefined();

    expect(failure()).toEqual({
      where: { id: MEDIA_ID, processing: 'PENDING' },
      data: { processing: 'FAILED', processing_error: VIDEO_ENQUEUE_FAILED_REASON },
    });
    expect(VIDEO_ENQUEUE_FAILED_REASON.length).toBeLessThan(120);
  });

  it('never throws, even when the database write fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    prisma.mediaObject.updateMany.mockRejectedValue(new Error('db down'));
    await expect(onMediaReady(toMediaRecord(row() as never))).resolves.toBeUndefined();
    expect(trigger).not.toHaveBeenCalled();

    prisma.mediaObject.updateMany
      .mockReset()
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('db down'));
    trigger.mockRejectedValue(new Error('trigger is down'));
    await expect(onMediaReady(toMediaRecord(row() as never))).resolves.toBeUndefined();
  });

  describe('every READY path calls it', () => {
    it('completeUpload', async () => {
      prisma.mediaObject.findFirst.mockResolvedValue(
        row({ status: 'UPLOADING', upload_id: 'up-1', size_bytes: BigInt(4096) })
      );
      sendImpl.mockImplementation(async (name: string) =>
        name === 'HeadObject' ? { ContentLength: 4096 } : {}
      );
      await completeUpload({
        classroom,
        mediaId: MEDIA_ID,
        parts: [{ partNumber: 1, etag: '"a"' }],
      });
      expect(claim()).toMatchObject({ where: { id: MEDIA_ID, status: 'READY' } });
      expectEnqueued(MEDIA_ID);
    });

    it('completeUpload, with a failed enqueue: the upload still succeeds, the row is FAILED', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      trigger.mockRejectedValue(new Error('trigger is down'));
      prisma.mediaObject.findFirst.mockResolvedValue(
        row({ status: 'UPLOADING', upload_id: 'up-1', size_bytes: BigInt(4096) })
      );
      sendImpl.mockImplementation(async (name: string) =>
        name === 'HeadObject' ? { ContentLength: 4096 } : {}
      );
      await expect(
        completeUpload({ classroom, mediaId: MEDIA_ID, parts: [{ partNumber: 1, etag: '"a"' }] })
      ).resolves.toMatchObject({ mediaId: MEDIA_ID });
      expect(failure()).toMatchObject({ data: { processing: 'FAILED' } });
    });

    it('completeUpload of a non-video queues nothing', async () => {
      prisma.mediaObject.findFirst.mockResolvedValue(
        row({
          status: 'UPLOADING',
          upload_id: 'up-1',
          size_bytes: BigInt(4096),
          kind: 'DOCUMENT',
          optimise: false,
        })
      );
      sendImpl.mockImplementation(async (name: string) =>
        name === 'HeadObject' ? { ContentLength: 4096 } : {}
      );
      await completeUpload({
        classroom,
        mediaId: MEDIA_ID,
        parts: [{ partNumber: 1, etag: '"a"' }],
      });
      expect(trigger).not.toHaveBeenCalled();
    });

    it('putMediaObject (the slides.com import)', async () => {
      let createdId = '';
      prisma.mediaObject.create.mockImplementation(async ({ data }: { data: { id: string } }) => {
        createdId = data.id;
        return row({ status: 'UPLOADING', ...data });
      });
      prisma.mediaObject.findFirst.mockImplementation(async () => row({ id: createdId }));
      sendImpl.mockImplementation(async (name: string) =>
        name === 'HeadObject' ? { ContentLength: 4096 } : {}
      );

      await putMediaObject({
        classroom,
        userId: 'user-1',
        filename: 'intro.mp4',
        bytes: Buffer.alloc(4096, 1),
      });
      expect(claim()).toMatchObject({ where: { id: createdId, status: 'READY' } });
      expectEnqueued(createdId);
    });

    it('putMediaObject queues from the row it wrote — no read after the flip can skip the job', async () => {
      let createdId = '';
      prisma.mediaObject.create.mockImplementation(async ({ data }: { data: { id: string } }) => {
        createdId = data.id;
        return row({ status: 'UPLOADING', ...data });
      });
      // Any read after the READY flip fails: the write must neither throw nor
      // skip the video's job because of it.
      prisma.mediaObject.findFirst.mockRejectedValue(new Error('db down'));
      sendImpl.mockImplementation(async (name: string) =>
        name === 'HeadObject' ? { ContentLength: 4096 } : {}
      );

      const result = await putMediaObject({
        classroom,
        userId: 'user-1',
        filename: 'intro.mp4',
        bytes: Buffer.alloc(4096, 1),
      });
      expect(result).toEqual({ mediaId: createdId, ref: `media://${createdId}` });
      expect(prisma.mediaObject.findFirst).not.toHaveBeenCalled();
      expect(claim()).toMatchObject({ where: { id: createdId, status: 'READY' } });
      expectEnqueued(createdId);
    });
  });
});
