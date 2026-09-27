/**
 * The import's media copy, with R2 and Prisma mocked.
 *
 * What these guard is the contract an import depends on:
 *
 *   - which strings count as references (both `media://` and signed URLs that
 *     name the SOURCE classroom, `&amp;`-escaped ones included) and which do not;
 *   - that ownership is decided by SQL scoped to the source classroom, so a
 *     reference to a third classroom's object is never copied;
 *   - that a destination which cannot take media gets NOTHING copied and a
 *     warning that names the file and the reason;
 *   - that the quota is reserved (lock, sum, UPLOADING row) BEFORE any
 *     CopyObject, and a full destination copies nothing;
 *   - the keys: `orig.{ext}` plus the rendition and poster under the NEW id;
 *   - and the half-rewrite rule — a reference is repointed only when its object
 *     is READY in the destination, and a failed copy leaves its references
 *     byte-for-byte as they were.
 *
 * The S3 layer is the same recorder `media.service.test.ts` uses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: { name: string; input: Record<string, unknown> }[] = [];
const sendImpl = vi.fn();

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
  CopyObjectCommand: command('CopyObject'),
  DeleteObjectCommand: command('DeleteObject'),
}));

let txDepth = 0;
/** Every call, in order, across prisma and S3 — for "reserve before copy". */
const order: string[] = [];

const prisma = {
  mediaObject: {
    findMany: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
};
vi.mock('@classmoji/database', () => ({ default: () => prisma }));

const uploadCapabilityFor = vi.fn();
vi.mock('../uploadCapability.ts', () => ({
  uploadCapabilityFor: (...args: unknown[]) => uploadCapabilityFor(...args),
}));

const { collectMediaRefs, createMediaImportCopier, rewriteMediaRefs } =
  await import('../mediaImportCopy.ts');
const { PRO_QUOTA_BYTES } = await import('../mediaQuota.ts');
const { resetR2Client } = await import('../r2Client.ts');

const SOURCE = '11111111-2222-4333-8444-555555555555';
const TARGET = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const THIRD = '33333333-3333-4333-8333-333333333333';
const VIDEO = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const PDF = '12345678-1234-4234-8234-123456789abc';
const FOREIGN = 'abcdefab-cdef-4abc-8def-abcdefabcdef';

const signed = (classroomId: string, mediaId: string, variant = 'orig.mp4', amp = '&') =>
  `https://cdn.classmoji.test/c/${classroomId}/media/${mediaId}/${variant}` +
  `?p=student${amp}v=1${amp}exp=1790000000${amp}sig=AbC_dE-f`;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: VIDEO,
    classroom_id: SOURCE,
    kind: 'VIDEO',
    filename: 'lecture.mp4',
    ext: 'mp4',
    content_type: 'video/mp4',
    size_bytes: BigInt(1000),
    status: 'READY',
    upload_id: null,
    uploaded_by: 'author-1',
    optimise: true,
    keep_original: true,
    allow_download: false,
    processing: 'NONE',
    processing_error: null,
    rendition_key: null,
    rendition_bytes: null,
    poster_key: null,
    duration_ms: 60_000,
    width: 1920,
    height: 1080,
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
  process.env.MEDIA_R2_BUCKET = 'media-bucket';
  resetR2Client();
}

function unconfigure(): void {
  delete process.env.MEDIA_R2_ACCOUNT_ID;
  delete process.env.MEDIA_R2_ACCESS_KEY_ID;
  delete process.env.MEDIA_R2_SECRET_ACCESS_KEY;
  delete process.env.MEDIA_R2_BUCKET;
  resetR2Client();
}

/**
 * The source lookup answers with `sourceRows` (filtered by the ids asked for,
 * as the SQL would); the destination's live-rows read answers with
 * `targetLive`. Told apart by the classroom in the WHERE clause.
 */
function database({
  sourceRows = [row()],
  targetLive = [] as ReturnType<typeof row>[],
}: {
  sourceRows?: ReturnType<typeof row>[];
  targetLive?: ReturnType<typeof row>[];
} = {}) {
  prisma.mediaObject.findMany.mockImplementation(
    async ({ where }: { where: { classroom_id: string; id?: { in: string[] } } }) => {
      order.push(`findMany:${where.classroom_id === SOURCE ? 'source' : 'target'}`);
      if (where.classroom_id === SOURCE) {
        return sourceRows.filter(r => where.id?.in.includes(r.id));
      }
      return targetLive;
    }
  );
}

function warnings() {
  const list: string[] = [];
  return { list, warn: (detail: string) => list.push(detail) };
}

beforeEach(() => {
  sent.length = 0;
  order.length = 0;
  txDepth = 0;
  vi.clearAllMocks();
  configure();
  uploadCapabilityFor.mockResolvedValue({
    isPro: true,
    media: { perFileMaxBytes: 1, remainingBytes: 1 },
  });
  sendImpl.mockImplementation(async (name: string) => {
    order.push(name);
    return {};
  });
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => {
    txDepth += 1;
    try {
      return await fn(prisma);
    } finally {
      txDepth -= 1;
    }
  });
  prisma.$queryRaw.mockImplementation(async () => {
    order.push(`lock:${txDepth}`);
    return [];
  });
  prisma.mediaObject.create.mockImplementation(async ({ data }: { data: { id: string } }) => {
    order.push(`create:${txDepth}`);
    return data;
  });
  prisma.mediaObject.updateMany.mockImplementation(async () => {
    order.push('ready');
    return { count: 1 };
  });
  prisma.mediaObject.deleteMany.mockResolvedValue({ count: 1 });
  database();
});

afterEach(() => {
  unconfigure();
});

describe('collectMediaRefs', () => {
  it('finds media:// refs and signed URLs naming the source, deduped', () => {
    const text = JSON.stringify({
      a: `media://${VIDEO}`,
      b: `media://${VIDEO}`,
      c: signed(SOURCE, PDF, 'orig.pdf'),
    });
    const { ids, foreignUrls } = collectMediaRefs(text, SOURCE);
    expect([...ids].sort()).toEqual([PDF, VIDEO].sort());
    expect(foreignUrls.size).toBe(0);
  });

  it('reads an &amp;-escaped signed URL in HTML whole', () => {
    const html = `<video src="${signed(SOURCE, VIDEO, 'web.mp4', '&amp;')}"></video>`;
    expect([...collectMediaRefs(html, SOURCE).ids]).toEqual([VIDEO]);
  });

  it('reports a signed URL for another classroom by path, never with its signature', () => {
    const { ids, foreignUrls } = collectMediaRefs(`"${signed(THIRD, FOREIGN)}"`, SOURCE);
    expect(ids.size).toBe(0);
    expect([...foreignUrls]).toEqual([`/c/${THIRD}/media/${FOREIGN}`]);
  });

  it('does not claim a /c/…/media/… path from the middle of somebody else’s URL', () => {
    const text = `"https://example.com/proxy/c/${SOURCE}/media/${VIDEO}/orig.mp4"`;
    // The host alternative cannot reach `/proxy/…`, and the bare-path
    // alternative needs a value boundary before `/c/`.
    expect(collectMediaRefs(text, SOURCE).ids.size).toBe(0);
  });

  it('ignores uppercase and over-long media:// spellings', () => {
    expect(collectMediaRefs(`media://${VIDEO.toUpperCase()}`, SOURCE).ids.size).toBe(0);
    expect(collectMediaRefs(`media://${VIDEO}abc`, SOURCE).ids.size).toBe(0);
  });
});

describe('rewriteMediaRefs', () => {
  it('repoints only mapped ids, and turns a source signed URL into a ref', () => {
    const NEW = '44444444-4444-4444-8444-444444444444';
    const text =
      `{"src":"media://${VIDEO}","other":"media://${PDF}",` +
      `"url":"${signed(SOURCE, VIDEO)}","third":"${signed(THIRD, VIDEO)}"}`;
    const out = rewriteMediaRefs(text, SOURCE, new Map([[VIDEO, NEW]]));
    expect(out).toBe(
      `{"src":"media://${NEW}","other":"media://${PDF}",` +
        `"url":"media://${NEW}","third":"${signed(THIRD, VIDEO)}"}`
    );
  });

  it('stops a signed URL at a comma and a backslash', () => {
    const NEW = '44444444-4444-4444-8444-444444444444';
    const srcset = `${signed(SOURCE, VIDEO)} 1x,${signed(SOURCE, VIDEO)} 2x`;
    expect(rewriteMediaRefs(srcset, SOURCE, new Map([[VIDEO, NEW]]))).toBe(
      `media://${NEW} 1x,media://${NEW} 2x`
    );
    const inJson = `"<video src=\\"${signed(SOURCE, VIDEO)}\\">"`;
    expect(rewriteMediaRefs(inJson, SOURCE, new Map([[VIDEO, NEW]]))).toBe(
      `"<video src=\\"media://${NEW}\\">"`
    );
  });
});

describe('createMediaImportCopier: success', () => {
  it('reserves under the lock, copies orig + rendition + poster, then READY', async () => {
    database({
      sourceRows: [
        row({
          processing: 'DONE',
          rendition_key: `m/${SOURCE}/${VIDEO}/web.mp4`,
          rendition_bytes: BigInt(400),
          poster_key: `m/${SOURCE}/${VIDEO}/poster.webp`,
        }),
      ],
    });
    const { list, warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      importedBy: 'importer-1',
      warn,
    });

    await copier.prepare([`{"src":"media://${VIDEO}"}`, `<a href="${signed(SOURCE, VIDEO)}">`]);

    const newId = copier.copiedIdFor(VIDEO);
    expect(newId).toMatch(/^[0-9a-f-]{36}$/);
    expect(newId).not.toBe(VIDEO);
    expect(list).toEqual([]);

    // Copied ONCE although referenced twice.
    const copies = sent.filter(s => s.name === 'CopyObject').map(s => s.input);
    expect(copies).toEqual([
      {
        Bucket: 'media-bucket',
        Key: `m/${TARGET}/${newId}/orig.mp4`,
        CopySource: `media-bucket/m/${SOURCE}/${VIDEO}/orig.mp4`,
        MetadataDirective: 'COPY',
      },
      {
        Bucket: 'media-bucket',
        Key: `m/${TARGET}/${newId}/web.mp4`,
        CopySource: `media-bucket/m/${SOURCE}/${VIDEO}/web.mp4`,
        MetadataDirective: 'COPY',
      },
      {
        Bucket: 'media-bucket',
        Key: `m/${TARGET}/${newId}/poster.webp`,
        CopySource: `media-bucket/m/${SOURCE}/${VIDEO}/poster.webp`,
        MetadataDirective: 'COPY',
      },
    ]);

    // Lock, sum and insert inside the transaction; every copy after it; READY last.
    expect(order).toEqual([
      'findMany:source',
      'lock:1',
      'findMany:target',
      'create:1',
      'CopyObject',
      'CopyObject',
      'CopyObject',
      'ready',
    ]);

    const created = prisma.mediaObject.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      id: newId,
      classroom_id: TARGET,
      status: 'UPLOADING',
      uploaded_by: 'importer-1',
      kind: 'VIDEO',
      filename: 'lecture.mp4',
      ext: 'mp4',
      content_type: 'video/mp4',
      size_bytes: BigInt(1000),
      rendition_key: `m/${TARGET}/${newId}/web.mp4`,
      rendition_bytes: BigInt(400),
      poster_key: `m/${TARGET}/${newId}/poster.webp`,
      duration_ms: 60_000,
    });
    expect(prisma.mediaObject.updateMany).toHaveBeenCalledWith({
      where: { id: newId, status: 'UPLOADING' },
      data: expect.objectContaining({ status: 'READY', processing: 'DONE' }),
    });

    // And the rewrite: both shapes become the new ref.
    expect(copier.rewrite(`media://${VIDEO} ${signed(SOURCE, VIDEO)}`)).toBe(
      `media://${newId} media://${newId}`
    );
  });

  it('dedupes across prepare calls — a later pass finds the copy already made', async () => {
    const { warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
    });
    await copier.prepare([`media://${VIDEO}`]);
    await copier.prepare([`media://${VIDEO}`]);
    expect(sent.filter(s => s.name === 'CopyObject')).toHaveLength(1);
    expect(prisma.mediaObject.findMany.mock.calls.filter(([a]) => a.where.id)).toHaveLength(1);
    // No importer named: the source row's uploader.
    expect(prisma.mediaObject.create.mock.calls[0][0].data.uploaded_by).toBe('author-1');
  });

  it('copies only the rendition and poster when the original was dropped', async () => {
    database({
      sourceRows: [
        row({
          processing: 'DONE',
          original_deleted_at: new Date(),
          rendition_key: `m/${SOURCE}/${VIDEO}/web.mp4`,
          rendition_bytes: BigInt(400),
        }),
      ],
    });
    const { list, warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
    });
    await copier.prepare([`media://${VIDEO}`]);

    const keys = sent.filter(s => s.name === 'CopyObject').map(s => s.input.Key);
    expect(keys).toEqual([`m/${TARGET}/${copier.copiedIdFor(VIDEO)}/web.mp4`]);
    expect(prisma.mediaObject.create.mock.calls[0][0].data.original_deleted_at).toBeInstanceOf(
      Date
    );
    expect(list).toEqual([]);
  });
});

describe('createMediaImportCopier: a destination lookup that failed', () => {
  it('is asked again by the next pass rather than cached as a failure', async () => {
    uploadCapabilityFor.mockRejectedValueOnce(new Error('database blinked'));
    const { warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
    });

    await expect(copier.prepare([`media://${VIDEO}`])).rejects.toThrow('database blinked');
    // Nothing was decided about the first object, and the next pass gets a
    // fresh destination lookup rather than the cached rejection.
    database({ sourceRows: [row({ id: PDF, kind: 'DOCUMENT', filename: 'n.pdf', ext: 'pdf' })] });
    await copier.prepare([`media://${PDF}`]);
    expect(uploadCapabilityFor).toHaveBeenCalledTimes(2);
    expect(copier.copiedIdFor(PDF)).not.toBeNull();
  });
});

describe('createMediaImportCopier: what is not copied', () => {
  it('never copies an object the source does not own, and says so', async () => {
    // The SQL is scoped to the source: a third classroom's id is not returned.
    database({ sourceRows: [row({ id: VIDEO })] });
    const { list, warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
    });
    const text = `media://${FOREIGN} and "${signed(THIRD, FOREIGN)}"`;

    await copier.prepare([text]);

    const lookup = prisma.mediaObject.findMany.mock.calls[0][0];
    expect(lookup.where).toEqual({
      classroom_id: SOURCE,
      status: 'READY',
      id: { in: [FOREIGN] },
    });
    expect(sent).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(copier.rewrite(text)).toBe(text);
    expect(list).toHaveLength(2);
    expect(list.join('\n')).toContain(`media://${FOREIGN}`);
    expect(list.join('\n')).toContain(`/c/${THIRD}/media/${FOREIGN}`);
    expect(list.join('\n')).not.toContain('sig=');
  });

  it('a Free destination copies nothing and leaves the file unchanged, named', async () => {
    uploadCapabilityFor.mockResolvedValue({ isPro: false, media: null });
    const { list, warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
    });
    const text = `{"src":"media://${VIDEO}"}`;

    await copier.prepare([text]);

    expect(sent).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(copier.rewrite(text)).toBe(text);
    expect(list).toEqual([
      'Skipped video "lecture.mp4": the destination class has no media storage (Pro)',
    ]);
  });

  it('names an unconfigured deployment without asking for a capability', async () => {
    unconfigure();
    const { list, warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
    });
    await copier.prepare([`media://${VIDEO}`]);
    expect(uploadCapabilityFor).not.toHaveBeenCalled();
    expect(list).toEqual([
      'Skipped video "lecture.mp4": media storage is not configured on this deployment',
    ]);
  });

  it('names a destination that cannot serve media', async () => {
    uploadCapabilityFor.mockResolvedValue({ isPro: true, media: null });
    const { list, warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
    });
    await copier.prepare([`media://${VIDEO}`]);
    expect(list[0]).toMatch(
      /^Skipped video "lecture.mp4": the destination class cannot serve media/
    );
  });

  it('a full destination: nothing reserved, nothing copied, named', async () => {
    database({ targetLive: [row({ id: PDF, size_bytes: BigInt(PRO_QUOTA_BYTES) })] });
    const { list, warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
    });
    const text = `media://${VIDEO}`;

    await copier.prepare([text]);

    expect(prisma.mediaObject.create).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(copier.rewrite(text)).toBe(text);
    expect(list).toEqual([
      'Skipped video "lecture.mp4": the destination class is over its media storage quota',
    ]);
  });

  it('a failed copy backs out and never repoints the file at it', async () => {
    database({
      sourceRows: [
        row({ id: VIDEO, poster_key: `m/${SOURCE}/${VIDEO}/poster.webp` }),
        row({ id: PDF, kind: 'DOCUMENT', filename: 'notes.pdf', ext: 'pdf' }),
      ],
    });
    // The video's poster copy fails; the PDF copies fine.
    sendImpl.mockImplementation(async (name: string, input: { Key: string }) => {
      order.push(name);
      if (name === 'CopyObject' && input.Key.endsWith('/poster.webp')) {
        throw new Error('R2 is having a moment');
      }
      return {};
    });
    const { list, warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
    });
    const text = `{"video":"media://${VIDEO}","doc":"media://${PDF}"}`;

    await copier.prepare([text]);

    const videoCopy = prisma.mediaObject.create.mock.calls[0][0].data.id as string;
    // Both destination keys of the failed object are deleted — the one that
    // landed and the one that may have.
    expect(sent.filter(s => s.name === 'DeleteObject').map(s => s.input.Key)).toEqual([
      `m/${TARGET}/${videoCopy}/orig.mp4`,
      `m/${TARGET}/${videoCopy}/poster.webp`,
    ]);
    expect(prisma.mediaObject.deleteMany).toHaveBeenCalledWith({
      where: { id: videoCopy, status: 'UPLOADING' },
    });
    expect(copier.copiedIdFor(VIDEO)).toBeNull();
    const pdfCopy = copier.copiedIdFor(PDF);
    expect(pdfCopy).not.toBeNull();

    // The video reference is exactly as it was; the PDF's is repointed.
    expect(copier.rewrite(text)).toBe(`{"video":"media://${VIDEO}","doc":"media://${pdfCopy}"}`);
    expect(list).toEqual([
      'Could not copy video "lecture.mp4" into this class: R2 is having a moment',
    ]);
  });
});
