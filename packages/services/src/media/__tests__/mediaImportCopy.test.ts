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
    findUnique: vi.fn(),
    findFirst: vi.fn(),
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

const deleteMedia = vi.fn();
const afterFailedReadyFlip = vi.fn();
vi.mock('../media.service.ts', () => ({
  deleteMedia: (...args: unknown[]) => deleteMedia(...args),
  afterFailedReadyFlip: (...args: unknown[]) => afterFailedReadyFlip(...args),
}));

const {
  collectMediaRefs,
  createMediaImportCopier,
  importCopyId,
  rewriteMediaRefs,
  skippedSummary,
  uuidV5,
} = await import('../mediaImportCopy.ts');
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
  prisma.mediaObject.findUnique.mockResolvedValue(null);
  prisma.mediaObject.findFirst.mockResolvedValue(null);
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

describe('rewriteMediaRefs: HTML-escaped quotes', () => {
  const NEW = '44444444-4444-4444-8444-444444444444';

  it('stops an &amp;-escaped query before &quot; — the closing quote survives', () => {
    const style = `<div style="background: url(&quot;${signed(SOURCE, VIDEO, 'orig.png', '&amp;')}&quot;)">`;
    expect(rewriteMediaRefs(style, SOURCE, new Map([[VIDEO, NEW]]))).toBe(
      `<div style="background: url(&quot;media://${NEW}&quot;)">`
    );
  });

  it('stops before &#34; and &#39; too', () => {
    for (const quote of ['&#34;', '&#39;']) {
      const text = `url(${quote}${signed(SOURCE, VIDEO, 'orig.png', '&amp;')}${quote})`;
      expect(rewriteMediaRefs(text, SOURCE, new Map([[VIDEO, NEW]]))).toBe(
        `url(${quote}media://${NEW}${quote})`
      );
    }
  });

  it('still takes an &amp;-escaped query whole when nothing follows it', () => {
    const text = `<video src="${signed(SOURCE, VIDEO, 'web.mp4', '&amp;')}">`;
    expect(rewriteMediaRefs(text, SOURCE, new Map([[VIDEO, NEW]]))).toBe(
      `<video src="media://${NEW}">`
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
    // The insert writes its own created_at — the attempt's marker — and the
    // flip matches on it, so it can only ever flip the row this run inserted.
    expect(created.created_at).toBeInstanceOf(Date);
    expect(prisma.mediaObject.updateMany).toHaveBeenCalledWith({
      where: { id: newId, status: 'UPLOADING', created_at: created.created_at },
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

  it('collapses many skipped objects into ONE warning with a count', async () => {
    uploadCapabilityFor.mockResolvedValue({ isPro: false, media: null });
    const ids = Array.from({ length: 7 }, (_, i) => `7777777${i}-8888-4999-8aaa-bbbbbbbbbbbb`);
    database({
      sourceRows: ids.map((id, i) => row({ id, filename: `lecture-${i}.mp4` })),
    });
    const { list, warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
    });

    await copier.prepare([ids.map(id => `media://${id}`).join(' ')]);

    expect(sent).toEqual([]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatch(/^Skipped 7 media files \(video "lecture-0\.mp4", /);
    expect(list[0]).toContain('video "lecture-4.mp4", and 2 more');
    expect(list[0]).not.toContain('lecture-5.mp4');
    expect(list[0]).toMatch(/: the destination class has no media storage \(Pro\)$/);
  });

  it('skippedSummary: one object reads as before', () => {
    expect(skippedSummary([{ kind: 'IMAGE', filename: 'a.png' }], 'why')).toBe(
      'Skipped image "a.png": why'
    );
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
      'Skipped video "lecture.mp4": the destination class\'s media storage is full ' +
        '(contact hello@classmoji.io to upgrade)',
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
    const videoMarker = prisma.mediaObject.create.mock.calls[0][0].data.created_at as Date;
    // Both destination keys of the failed object are deleted — the one that
    // landed and the one that may have.
    expect(sent.filter(s => s.name === 'DeleteObject').map(s => s.input.Key)).toEqual([
      `m/${TARGET}/${videoCopy}/orig.mp4`,
      `m/${TARGET}/${videoCopy}/poster.webp`,
    ]);
    expect(prisma.mediaObject.deleteMany).toHaveBeenCalledWith({
      where: { id: videoCopy, status: 'UPLOADING', created_at: videoMarker },
    });
    // A random id is this attempt's alone: nothing is re-read before the delete.
    expect(prisma.mediaObject.findFirst).not.toHaveBeenCalled();
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

describe('createMediaImportCopier: the READY write fails', () => {
  const twoRows = () =>
    database({
      sourceRows: [row(), row({ id: PDF, kind: 'DOCUMENT', filename: 'notes.pdf', ext: 'pdf' })],
    });

  /** The READY write for the FIRST reservation throws; every other one lands. */
  function failFirstReadyWrite() {
    let first = true;
    prisma.mediaObject.updateMany.mockImplementation(async () => {
      order.push('ready');
      if (first) {
        first = false;
        throw new Error('connection reset');
      }
      return { count: 1 };
    });
  }

  it('released: deletes what landed, warns, and copies the rest of the pass', async () => {
    twoRows();
    failFirstReadyWrite();
    afterFailedReadyFlip.mockResolvedValue('released');
    const { list, warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
    });
    const text = `media://${VIDEO} media://${PDF}`;

    await expect(copier.prepare([text])).resolves.toBeUndefined();

    const videoCopy = prisma.mediaObject.create.mock.calls[0][0].data.id as string;
    expect(afterFailedReadyFlip).toHaveBeenCalledWith(TARGET, videoCopy, 'UPLOADING');
    expect(sent.filter(s => s.name === 'DeleteObject').map(s => s.input.Key)).toEqual([
      `m/${TARGET}/${videoCopy}/orig.mp4`,
    ]);
    expect(copier.copiedIdFor(VIDEO)).toBeNull();
    // The PDF after it was still copied and repointed.
    const pdfCopy = copier.copiedIdFor(PDF);
    expect(pdfCopy).not.toBeNull();
    expect(sent.filter(s => s.name === 'CopyObject')).toHaveLength(2);
    expect(copier.rewrite(text)).toBe(`media://${VIDEO} media://${pdfCopy}`);
    expect(list).toEqual(['Could not copy video "lecture.mp4" into this class: connection reset']);
  });

  it('the write landed after all: the copy counts', async () => {
    database();
    failFirstReadyWrite();
    afterFailedReadyFlip.mockResolvedValue('ready');
    const onCopied = vi.fn();
    const { list, warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
      onCopied,
    });

    await copier.prepare([`media://${VIDEO}`]);

    const copy = copier.copiedIdFor(VIDEO);
    expect(copy).not.toBeNull();
    expect(onCopied).toHaveBeenCalledWith(VIDEO, copy);
    expect(sent.filter(s => s.name === 'DeleteObject')).toEqual([]);
    expect(list).toEqual([]);
  });

  it('unknown: keeps the objects (a READY row may serve them) and warns', async () => {
    database();
    failFirstReadyWrite();
    afterFailedReadyFlip.mockResolvedValue('unknown');
    const { list, warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
    });

    await copier.prepare([`media://${VIDEO}`]);

    expect(copier.copiedIdFor(VIDEO)).toBeNull();
    expect(sent.filter(s => s.name === 'DeleteObject')).toEqual([]);
    expect(list).toHaveLength(1);
  });

  it('a reservation that throws is one warning, and the pass goes on', async () => {
    twoRows();
    let first = true;
    prisma.mediaObject.create.mockImplementation(async ({ data }: { data: { id: string } }) => {
      if (first) {
        first = false;
        throw new Error('deadlock detected');
      }
      return data;
    });
    const { list, warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
    });

    await expect(copier.prepare([`media://${VIDEO} media://${PDF}`])).resolves.toBeUndefined();

    expect(copier.copiedIdFor(VIDEO)).toBeNull();
    expect(copier.copiedIdFor(PDF)).not.toBeNull();
    expect(sent.filter(s => s.name === 'CopyObject')).toHaveLength(1);
    expect(list).toEqual(['Could not copy video "lecture.mp4" into this class: deadlock detected']);
  });
});

describe('createMediaImportCopier: a partial copy never leaks a source signature', () => {
  it('one copied, one refused for quota: new ref, bare source ref, one summary warning', async () => {
    const BIG = row({
      id: PDF,
      kind: 'DOCUMENT',
      filename: 'huge.pdf',
      ext: 'pdf',
      size_bytes: BigInt(PRO_QUOTA_BYTES + 1),
    });
    database({ sourceRows: [row(), BIG] });
    const { list, warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
    });
    const html =
      `<video src="${signed(SOURCE, VIDEO, 'web.mp4', '&amp;')}"></video>` +
      `<a href="${signed(SOURCE, PDF, 'orig.pdf', '&amp;')}">notes</a>` +
      `<img src="${signed(THIRD, FOREIGN, 'orig.png')}">`;

    await copier.prepare([html]);
    const out = copier.rewrite(html);

    const copy = copier.copiedIdFor(VIDEO)!;
    expect(copier.copiedIdFor(PDF)).toBeNull();
    expect(out).toBe(
      `<video src="media://${copy}"></video>` +
        `<a href="media://${PDF}">notes</a>` +
        `<img src="${signed(THIRD, FOREIGN, 'orig.png')}">`
    );
    // No signature naming the SOURCE survives anywhere in the copy.
    expect(out).not.toContain(`/c/${SOURCE}/`);
    expect(list.filter(line => line.includes('storage is full'))).toEqual([
      'Skipped document "huge.pdf": the destination class\'s media storage is full ' +
        '(contact hello@classmoji.io to upgrade)',
    ]);
  });

  it('canonicalizes a source signed URL even when nothing was copied', () => {
    const text = `url(&quot;${signed(SOURCE, VIDEO, 'orig.png', '&amp;')}&quot;)`;
    expect(rewriteMediaRefs(text, SOURCE, new Map())).toBe(`url(&quot;media://${VIDEO}&quot;)`);
  });
});

describe('createMediaImportCopier: resuming from a persisted map', () => {
  const COPY = '55555555-5555-4555-8555-555555555555';

  /** The destination answers READY for the ids in `readyCopies` only. */
  function withReadyCopies(readyCopies: string[]) {
    prisma.mediaObject.findMany.mockImplementation(
      async ({
        where,
      }: {
        where: { classroom_id: string; status?: string; id?: { in: string[] } };
      }) => {
        if (where.classroom_id === SOURCE) {
          order.push('findMany:source');
          return [row()].filter(r => where.id?.in.includes(r.id));
        }
        if (where.status === 'READY') {
          order.push('findMany:known');
          return readyCopies.filter(id => where.id?.in.includes(id)).map(id => ({ id }));
        }
        order.push('findMany:target');
        return [];
      }
    );
  }

  it('reuses a copy still READY in the destination: no lookup, no reservation, no copy', async () => {
    withReadyCopies([COPY]);
    const onCopied = vi.fn();
    const { list, warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
      knownCopies: { [VIDEO]: COPY },
      onCopied,
    });

    await copier.prepare([`media://${VIDEO}`]);

    // Proven in SQL scoped to the DESTINATION and READY.
    const known = prisma.mediaObject.findMany.mock.calls[0][0];
    expect(known.where).toEqual({ classroom_id: TARGET, status: 'READY', id: { in: [COPY] } });
    expect(order).toEqual(['findMany:known']);
    expect(sent).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(copier.copiedIdFor(VIDEO)).toBe(COPY);
    expect(copier.rewrite(`media://${VIDEO}`)).toBe(`media://${COPY}`);
    expect(onCopied).not.toHaveBeenCalled();
    expect(list).toEqual([]);
  });

  it('copies again when the known copy is gone, and records the new pair', async () => {
    withReadyCopies([]); // deleted, or never finished
    const onCopied = vi.fn();
    const { warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
      knownCopies: { [VIDEO]: COPY },
      onCopied,
    });

    await copier.prepare([`media://${VIDEO}`]);

    const fresh = copier.copiedIdFor(VIDEO);
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(COPY);
    expect(sent.filter(s => s.name === 'CopyObject')).toHaveLength(1);
    expect(onCopied).toHaveBeenCalledWith(VIDEO, fresh);
  });

  it('a retry after a failed run copies nothing twice', async () => {
    // Run 1 copies the video and records the pair; the run then fails later.
    const persisted: Record<string, string> = {};
    const first = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn: () => {},
      knownCopies: persisted,
      onCopied: (source, copy) => {
        persisted[source] = copy;
      },
    });
    await first.prepare([`media://${VIDEO}`]);
    const copy = first.copiedIdFor(VIDEO)!;
    expect(persisted).toEqual({ [VIDEO]: copy });
    expect(sent.filter(s => s.name === 'CopyObject')).toHaveLength(1);

    // Run 2 (the retry) starts from the persisted map; the copy is READY.
    sent.length = 0;
    withReadyCopies([copy]);
    const second = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn: () => {},
      knownCopies: { ...persisted },
      onCopied: (source, next) => {
        persisted[source] = next;
      },
    });
    await second.prepare([`media://${VIDEO}`, `"${signed(SOURCE, VIDEO)}"`]);

    expect(sent.filter(s => s.name === 'CopyObject')).toHaveLength(0);
    expect(second.copiedIdFor(VIDEO)).toBe(copy);
    expect(persisted).toEqual({ [VIDEO]: copy });
  });
});

describe('createMediaImportCopier: copy ids derived from the import', () => {
  const JOB = 'job-123';

  /** The destination answers READY for the ids in `readyCopies` only. */
  function withReadyCopies(readyCopies: string[]) {
    prisma.mediaObject.findMany.mockImplementation(
      async ({
        where,
      }: {
        where: { classroom_id: string; status?: string; id?: { in: string[] } };
      }) => {
        if (where.classroom_id === SOURCE) return [row()].filter(r => where.id?.in.includes(r.id));
        if (where.status === 'READY') {
          return readyCopies.filter(id => where.id?.in.includes(id)).map(id => ({ id }));
        }
        return [];
      }
    );
  }

  it('uuidV5 matches the RFC 4122 construction', () => {
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2'
    );
    const id = importCopyId(JOB, VIDEO);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(importCopyId(JOB, VIDEO)).toBe(id);
    expect(importCopyId('job-456', VIDEO)).not.toBe(id);
    expect(importCopyId(JOB, PDF)).not.toBe(id);
  });

  it('a retry whose pair was never persisted finds the copy by id: nothing copied twice', async () => {
    withReadyCopies([]);
    const onCopied = vi.fn();
    const first = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn: () => {},
      copyIdSeed: JOB,
      onCopied,
    });
    await first.prepare([`media://${VIDEO}`]);
    const derived = importCopyId(JOB, VIDEO);
    expect(first.copiedIdFor(VIDEO)).toBe(derived);
    expect(prisma.mediaObject.create.mock.calls[0][0].data.id).toBe(derived);
    expect(sent.filter(s => s.name === 'CopyObject').map(s => s.input.Key)).toEqual([
      `m/${TARGET}/${derived}/orig.mp4`,
    ]);

    // The retry: the progress write carrying the pair was lost, so the persisted
    // map is empty — but the copy is READY under its derived id.
    sent.length = 0;
    vi.mocked(prisma.$transaction).mockClear();
    withReadyCopies([derived]);
    const second = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn: () => {},
      knownCopies: {},
      copyIdSeed: JOB,
    });
    await second.prepare([`media://${VIDEO}`]);

    const reuse = prisma.mediaObject.findMany.mock.calls.at(-1)![0];
    expect(reuse.where).toEqual({ classroom_id: TARGET, status: 'READY', id: { in: [derived] } });
    expect(sent).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(second.copiedIdFor(VIDEO)).toBe(derived);
    expect(second.rewrite(`media://${VIDEO}`)).toBe(`media://${derived}`);
  });

  it('takes over a reservation an earlier attempt left UPLOADING under the id', async () => {
    withReadyCopies([]);
    const derived = importCopyId(JOB, VIDEO);
    prisma.mediaObject.findUnique.mockResolvedValue({ classroom_id: TARGET, status: 'UPLOADING' });
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn: () => {},
      copyIdSeed: JOB,
    });

    await copier.prepare([`media://${VIDEO}`]);

    expect(prisma.mediaObject.findUnique).toHaveBeenCalledWith({
      where: { id: derived },
      select: { classroom_id: true, status: true },
    });
    // The stale reservation goes inside the same locked transaction, before the
    // sum, and the new one reuses the id.
    expect(prisma.mediaObject.deleteMany).toHaveBeenCalledWith({
      where: { id: derived, classroom_id: TARGET, status: 'UPLOADING' },
    });
    expect(prisma.mediaObject.create.mock.calls[0][0].data.id).toBe(derived);
    expect(copier.copiedIdFor(VIDEO)).toBe(derived);
  });

  it('a taken-over reservation refused for quota: its half-copied keys are removed', async () => {
    const derived = importCopyId(JOB, VIDEO);
    prisma.mediaObject.findUnique.mockResolvedValue({ classroom_id: TARGET, status: 'UPLOADING' });
    prisma.mediaObject.findMany.mockImplementation(
      async ({
        where,
      }: {
        where: { classroom_id: string; status?: string; id?: { in: string[] } };
      }) => {
        if (where.classroom_id === SOURCE) return [row()].filter(r => where.id?.in.includes(r.id));
        if (where.status === 'READY') return [];
        return [row({ id: PDF, classroom_id: TARGET, size_bytes: BigInt(PRO_QUOTA_BYTES) })];
      }
    );
    const { list, warn } = warnings();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
      copyIdSeed: JOB,
    });

    await copier.prepare([`media://${VIDEO}`]);

    expect(copier.copiedIdFor(VIDEO)).toBeNull();
    expect(prisma.mediaObject.create).not.toHaveBeenCalled();
    expect(sent.filter(s => s.name === 'CopyObject')).toEqual([]);
    expect(sent.filter(s => s.name === 'DeleteObject').map(s => s.input.Key)).toEqual([
      `m/${TARGET}/${derived}/orig.mp4`,
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]).toContain('storage is full');
  });

  it('an id whose row is gone for good (a discarded copy) is not reused', async () => {
    withReadyCopies([]);
    const derived = importCopyId(JOB, VIDEO);
    prisma.mediaObject.findUnique.mockResolvedValue({ classroom_id: TARGET, status: 'DELETED' });
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn: () => {},
      copyIdSeed: JOB,
    });

    await copier.prepare([`media://${VIDEO}`]);

    const fresh = copier.copiedIdFor(VIDEO)!;
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(derived);
    expect(prisma.mediaObject.deleteMany).not.toHaveBeenCalled();
    expect(sent.filter(s => s.name === 'CopyObject').map(s => s.input.Key)).toEqual([
      `m/${TARGET}/${fresh}/orig.mp4`,
    ]);
  });

  it('without a seed, ids stay random and nothing is looked up by id', async () => {
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn: () => {},
    });
    await copier.prepare([`media://${VIDEO}`]);
    expect(prisma.mediaObject.findUnique).not.toHaveBeenCalled();
    expect(copier.copiedIdFor(VIDEO)).not.toBe(importCopyId(JOB, VIDEO));
  });
});

describe('createMediaImportCopier: two attempts writing one derived id', () => {
  // Attempt A and this attempt (B) share every key under the derived id. In
  // each case below A flips the row READY first; B must reuse A's copy, delete
  // none of its objects, and never count it as its own to discard.
  const JOB = 'job-123';
  const derived = () => importCopyId(JOB, VIDEO);
  /** Another attempt's marker: never the one this attempt writes. */
  const OTHER_MARKER = new Date('2026-01-01T00:00:00.000Z');
  const readyRow = () =>
    row({ id: derived(), classroom_id: TARGET, status: 'READY', created_at: OTHER_MARKER });
  const inFlightRow = () =>
    row({ id: derived(), classroom_id: TARGET, status: 'UPLOADING', created_at: OTHER_MARKER });

  function destination({ live = [] as ReturnType<typeof row>[] } = {}) {
    prisma.mediaObject.findMany.mockImplementation(
      async ({
        where,
      }: {
        where: { classroom_id: string; status?: string; id?: { in: string[] } };
      }) => {
        if (where.classroom_id === SOURCE) return [row()].filter(r => where.id?.in.includes(r.id));
        if (where.status === 'READY') return [];
        return live;
      }
    );
  }

  function attemptB(warn: (detail: string) => void = () => {}) {
    const onCopied = vi.fn();
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn,
      copyIdSeed: JOB,
      onCopied,
    });
    return { copier, onCopied };
  }

  /** B reused A's copy: repointed, nothing deleted, not B's to discard. */
  async function expectReusedNotOwned(
    copier: ReturnType<typeof createMediaImportCopier>,
    onCopied: ReturnType<typeof vi.fn>
  ) {
    expect(copier.copiedIdFor(VIDEO)).toBe(derived());
    expect(copier.rewrite(`media://${VIDEO}`)).toBe(`media://${derived()}`);
    expect(sent.filter(s => s.name === 'DeleteObject')).toEqual([]);
    expect(onCopied).not.toHaveBeenCalled();
    deleteMedia.mockResolvedValue({});
    await copier.discard();
    expect(deleteMedia).not.toHaveBeenCalled();
  }

  it('quota path: the reservation to take over is already READY — reused, nothing deleted', async () => {
    // B saw UPLOADING; A flipped it READY before B's lock. The destination is
    // over quota counting A's READY row, which must not turn into a refusal
    // that deletes A's objects.
    destination({
      live: [row({ id: PDF, classroom_id: TARGET, size_bytes: BigInt(PRO_QUOTA_BYTES) })],
    });
    prisma.mediaObject.findUnique.mockResolvedValue({ classroom_id: TARGET, status: 'UPLOADING' });
    prisma.mediaObject.deleteMany.mockResolvedValue({ count: 0 });
    prisma.mediaObject.findFirst.mockResolvedValue(readyRow());
    const { list, warn } = warnings();
    const { copier, onCopied } = attemptB(warn);

    await copier.prepare([`media://${VIDEO}`]);

    expect(prisma.mediaObject.create).not.toHaveBeenCalled();
    expect(sent.filter(s => s.name === 'CopyObject')).toEqual([]);
    expect(prisma.mediaObject.findFirst).toHaveBeenCalledWith({
      where: { id: derived(), classroom_id: TARGET },
    });
    expect(list).toEqual([]);
    await expectReusedNotOwned(copier, onCopied);
  });

  it('quota path: the reservation to take over was deleted — warned, nothing deleted', async () => {
    destination();
    prisma.mediaObject.findUnique.mockResolvedValue({ classroom_id: TARGET, status: 'UPLOADING' });
    prisma.mediaObject.deleteMany.mockResolvedValue({ count: 0 });
    prisma.mediaObject.findFirst.mockResolvedValue(
      row({ id: derived(), classroom_id: TARGET, status: 'DELETED' })
    );
    const { list, warn } = warnings();
    const { copier } = attemptB(warn);

    await copier.prepare([`media://${VIDEO}`]);

    expect(copier.copiedIdFor(VIDEO)).toBeNull();
    expect(prisma.mediaObject.create).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(list).toEqual([
      'Could not copy video "lecture.mp4" into this class: the copy was removed while it ran',
    ]);
  });

  it('quota path: a real takeover refused, but the id is READY again — its objects stay', async () => {
    destination({
      live: [row({ id: PDF, classroom_id: TARGET, size_bytes: BigInt(PRO_QUOTA_BYTES) })],
    });
    prisma.mediaObject.findUnique.mockResolvedValue({ classroom_id: TARGET, status: 'UPLOADING' });
    prisma.mediaObject.findFirst.mockResolvedValue(readyRow());
    const { list, warn } = warnings();
    const { copier } = attemptB(warn);

    await copier.prepare([`media://${VIDEO}`]);

    expect(copier.copiedIdFor(VIDEO)).toBeNull();
    expect(sent.filter(s => s.name === 'DeleteObject')).toEqual([]);
    expect(list).toHaveLength(1);
    expect(list[0]).toContain('storage is full');
  });

  it('CopyObject fails after A flipped the row READY — reused, no delete, no release', async () => {
    destination();
    prisma.mediaObject.findUnique.mockResolvedValue({ classroom_id: TARGET, status: 'UPLOADING' });
    prisma.mediaObject.findFirst.mockResolvedValue(readyRow());
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'CopyObject') throw new Error('R2 is having a moment');
      return {};
    });
    const { list, warn } = warnings();
    const { copier, onCopied } = attemptB(warn);

    await copier.prepare([`media://${VIDEO}`]);

    // Only the takeover's own delete, inside the transaction — no release of
    // the READY row after the failure.
    expect(prisma.mediaObject.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.mediaObject.deleteMany).toHaveBeenCalledWith({
      where: { id: derived(), classroom_id: TARGET, status: 'UPLOADING' },
    });
    expect(list).toEqual([]);
    await expectReusedNotOwned(copier, onCopied);
  });

  it('CopyObject fails and the id is not READY — backs out as before', async () => {
    destination();
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'CopyObject') throw new Error('R2 is having a moment');
      return {};
    });
    const { list, warn } = warnings();
    const { copier } = attemptB(warn);

    await copier.prepare([`media://${VIDEO}`]);

    expect(prisma.mediaObject.findFirst).toHaveBeenCalledTimes(1);
    expect(sent.filter(s => s.name === 'DeleteObject').map(s => s.input.Key)).toEqual([
      `m/${TARGET}/${derived()}/orig.mp4`,
    ]);
    expect(prisma.mediaObject.deleteMany).toHaveBeenCalledWith({
      where: {
        id: derived(),
        status: 'UPLOADING',
        created_at: prisma.mediaObject.create.mock.calls[0][0].data.created_at,
      },
    });
    expect(copier.copiedIdFor(VIDEO)).toBeNull();
    expect(list).toEqual([
      'Could not copy video "lecture.mp4" into this class: R2 is having a moment',
    ]);
  });

  it('CopyObject fails and the re-read fails — nothing deleted, nothing reused', async () => {
    destination();
    prisma.mediaObject.findFirst.mockRejectedValue(new Error('connection reset'));
    sendImpl.mockImplementation(async (name: string) => {
      if (name === 'CopyObject') throw new Error('R2 is having a moment');
      return {};
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { list, warn } = warnings();
    const { copier } = attemptB(warn);

    await copier.prepare([`media://${VIDEO}`]);

    expect(sent.filter(s => s.name === 'DeleteObject')).toEqual([]);
    expect(copier.copiedIdFor(VIDEO)).toBeNull();
    expect(list).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it('the READY flip finds nothing because A flipped first — reused, nothing deleted', async () => {
    destination();
    prisma.mediaObject.updateMany.mockResolvedValue({ count: 0 });
    prisma.mediaObject.findFirst.mockResolvedValue(readyRow());
    const { list, warn } = warnings();
    const { copier, onCopied } = attemptB(warn);

    await copier.prepare([`media://${VIDEO}`]);

    expect(sent.filter(s => s.name === 'CopyObject')).toHaveLength(1);
    expect(list).toEqual([]);
    await expectReusedNotOwned(copier, onCopied);
  });

  it('the READY flip finds nothing and the row is gone — deletes what landed, as before', async () => {
    destination();
    prisma.mediaObject.updateMany.mockResolvedValue({ count: 0 });
    const { list, warn } = warnings();
    const { copier } = attemptB(warn);

    await copier.prepare([`media://${VIDEO}`]);

    expect(sent.filter(s => s.name === 'DeleteObject').map(s => s.input.Key)).toEqual([
      `m/${TARGET}/${derived()}/orig.mp4`,
    ]);
    expect(copier.copiedIdFor(VIDEO)).toBeNull();
    expect(list).toEqual([
      'Could not copy video "lecture.mp4" into this class: the copy was removed while it ran',
    ]);
  });

  it('without a seed, a flip that finds nothing deletes what landed without a re-read', async () => {
    prisma.mediaObject.updateMany.mockResolvedValue({ count: 0 });
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn: () => {},
    });

    await copier.prepare([`media://${VIDEO}`]);

    expect(prisma.mediaObject.findFirst).not.toHaveBeenCalled();
    expect(sent.filter(s => s.name === 'DeleteObject')).toHaveLength(1);
    expect(copier.copiedIdFor(VIDEO)).toBeNull();
  });

  it('A’s flip matches only its own row: B took it over and is still copying', async () => {
    // A reserved the derived id; B then took that reservation over and
    // inserted its own row under the same id. A's flip must not land on B's
    // row — it would make B's reservation A's copy, and A's discard would
    // delete what B's content names.
    destination();
    prisma.mediaObject.updateMany.mockImplementation(
      async ({ where }: { where: { created_at?: Date } }) => ({
        // B's row carries B's marker, so only an unscoped flip would match it.
        count: where.created_at && where.created_at.getTime() !== OTHER_MARKER.getTime() ? 0 : 1,
      })
    );
    prisma.mediaObject.findFirst.mockResolvedValue(inFlightRow());
    const { list, warn } = warnings();
    const { copier, onCopied } = attemptB(warn);

    await copier.prepare([`media://${VIDEO}`]);

    expect(copier.copiedIdFor(VIDEO)).toBeNull();
    expect(onCopied).not.toHaveBeenCalled();
    expect(sent.filter(s => s.name === 'DeleteObject')).toEqual([]);
    expect(list).toEqual([
      'Could not copy video "lecture.mp4" into this class: could not confirm the copy',
    ]);
    deleteMedia.mockResolvedValue({});
    await copier.discard();
    expect(deleteMedia).not.toHaveBeenCalled();
  });

  it('A’s flip matches only its own row: B took it over and already flipped it', async () => {
    destination();
    prisma.mediaObject.updateMany.mockImplementation(
      async ({ where }: { where: { created_at?: Date } }) => ({
        count: where.created_at && where.created_at.getTime() !== OTHER_MARKER.getTime() ? 0 : 1,
      })
    );
    prisma.mediaObject.findFirst.mockResolvedValue(readyRow());
    const { list, warn } = warnings();
    const { copier, onCopied } = attemptB(warn);

    await copier.prepare([`media://${VIDEO}`]);

    expect(list).toEqual([]);
    await expectReusedNotOwned(copier, onCopied);
  });

  it('a takeover writes a marker strictly after the row it replaces', async () => {
    destination();
    const replaced = new Date(Date.now() + 60_000);
    prisma.mediaObject.findUnique.mockResolvedValue({
      classroom_id: TARGET,
      status: 'UPLOADING',
      created_at: replaced,
    });
    const { copier } = attemptB();

    await copier.prepare([`media://${VIDEO}`]);

    const marker = prisma.mediaObject.create.mock.calls[0][0].data.created_at as Date;
    expect(marker.getTime()).toBe(replaced.getTime() + 1);
    expect(prisma.mediaObject.updateMany.mock.calls[0][0].where).toEqual({
      id: derived(),
      status: 'UPLOADING',
      created_at: marker,
    });
    expect(copier.copiedIdFor(VIDEO)).toBe(derived());
  });

  it('a READY write that throws while B holds the id: left to B, nothing deleted', async () => {
    destination();
    prisma.mediaObject.updateMany.mockRejectedValue(new Error('connection reset'));
    prisma.mediaObject.findFirst.mockResolvedValue(inFlightRow());
    const { list, warn } = warnings();
    const { copier } = attemptB(warn);

    await copier.prepare([`media://${VIDEO}`]);

    expect(afterFailedReadyFlip).not.toHaveBeenCalled();
    expect(sent.filter(s => s.name === 'DeleteObject')).toEqual([]);
    expect(copier.copiedIdFor(VIDEO)).toBeNull();
    expect(list).toEqual([
      'Could not copy video "lecture.mp4" into this class: could not confirm the copy',
    ]);
  });

  it('a READY write that throws but landed: the copy is this attempt’s', async () => {
    destination();
    prisma.mediaObject.updateMany.mockRejectedValue(new Error('connection reset'));
    prisma.mediaObject.findFirst.mockImplementation(async () =>
      row({
        id: derived(),
        classroom_id: TARGET,
        status: 'READY',
        created_at: prisma.mediaObject.create.mock.calls[0][0].data.created_at,
      })
    );
    const { list, warn } = warnings();
    const { copier, onCopied } = attemptB(warn);

    await copier.prepare([`media://${VIDEO}`]);

    expect(afterFailedReadyFlip).not.toHaveBeenCalled();
    expect(copier.copiedIdFor(VIDEO)).toBe(derived());
    expect(onCopied).toHaveBeenCalledWith(VIDEO, derived());
    expect(list).toEqual([]);
  });

  it('a lost takeover whose re-read fails says it could not confirm, not that it was removed', async () => {
    destination();
    prisma.mediaObject.findUnique.mockResolvedValue({ classroom_id: TARGET, status: 'UPLOADING' });
    prisma.mediaObject.deleteMany.mockResolvedValue({ count: 0 });
    prisma.mediaObject.findFirst.mockRejectedValue(new Error('connection reset'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { list, warn } = warnings();
    const { copier } = attemptB(warn);

    await copier.prepare([`media://${VIDEO}`]);

    expect(copier.copiedIdFor(VIDEO)).toBeNull();
    expect(sent).toEqual([]);
    expect(list).toEqual([
      'Could not copy video "lecture.mp4" into this class: could not confirm the copy',
    ]);
    warnSpy.mockRestore();
  });

  it('discard removes a copy this attempt made under the derived id', async () => {
    destination();
    deleteMedia.mockResolvedValue({});
    const { copier, onCopied } = attemptB();

    await copier.prepare([`media://${VIDEO}`]);
    expect(onCopied).toHaveBeenCalledWith(VIDEO, derived());
    await copier.discard();

    expect(deleteMedia).toHaveBeenCalledWith({ classroom: { id: TARGET }, mediaId: derived() });
  });
});

describe('createMediaImportCopier: discard', () => {
  const KEPT = '66666666-6666-4666-8666-666666666666';

  it('deletes only the copies this run made, and stops repointing at them', async () => {
    deleteMedia.mockResolvedValue({});
    // The PDF has a copy from an earlier run, still READY; the video is new.
    prisma.mediaObject.findMany.mockImplementation(
      async ({
        where,
      }: {
        where: { classroom_id: string; status?: string; id?: { in: string[] } };
      }) => {
        if (where.classroom_id === SOURCE) return [row()].filter(r => where.id?.in.includes(r.id));
        if (where.status === 'READY') return where.id?.in.includes(KEPT) ? [{ id: KEPT }] : [];
        return [];
      }
    );
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn: () => {},
      knownCopies: { [PDF]: KEPT },
    });
    const text = `media://${VIDEO} media://${PDF}`;
    await copier.prepare([text]);
    const made = copier.copiedIdFor(VIDEO)!;

    await copier.discard();

    expect(deleteMedia).toHaveBeenCalledTimes(1);
    expect(deleteMedia).toHaveBeenCalledWith({ classroom: { id: TARGET }, mediaId: made });
    expect(copier.copiedIdFor(VIDEO)).toBeNull();
    expect(copier.copiedIdFor(PDF)).toBe(KEPT);
    expect(copier.rewrite(text)).toBe(`media://${VIDEO} media://${KEPT}`);

    // A second discard has nothing left to do.
    await copier.discard();
    expect(deleteMedia).toHaveBeenCalledTimes(1);
  });

  it('after keep, discards only the copies made since, and a later pass copies again', async () => {
    deleteMedia.mockResolvedValue({});
    database({
      sourceRows: [row(), row({ id: PDF, kind: 'DOCUMENT', filename: 'notes.pdf', ext: 'pdf' })],
    });
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn: () => {},
    });

    // Pass 1 (the pages) copies the video, and its commit lands.
    await copier.prepare([`media://${VIDEO}`]);
    const video = copier.copiedIdFor(VIDEO)!;
    copier.keep();

    // Pass 2 (the decks) copies the PDF, and its commit fails.
    await copier.prepare([`media://${VIDEO} media://${PDF}`]);
    const pdf = copier.copiedIdFor(PDF)!;
    await copier.discard();

    expect(deleteMedia).toHaveBeenCalledTimes(1);
    expect(deleteMedia).toHaveBeenCalledWith({ classroom: { id: TARGET }, mediaId: pdf });
    expect(copier.copiedIdFor(VIDEO)).toBe(video);
    expect(copier.copiedIdFor(PDF)).toBeNull();

    // A later pass that references the PDF copies it afresh.
    sent.length = 0;
    await copier.prepare([`media://${PDF}`]);
    const again = copier.copiedIdFor(PDF);
    expect(again).not.toBeNull();
    expect(again).not.toBe(pdf);
    expect(sent.filter(s => s.name === 'CopyObject')).toHaveLength(1);
  });

  it('never throws when a delete fails', async () => {
    deleteMedia.mockRejectedValue(new Error('R2 is down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const copier = createMediaImportCopier({
      sourceClassroomId: SOURCE,
      targetClassroomId: TARGET,
      warn: () => {},
    });
    await copier.prepare([`media://${VIDEO}`]);
    await expect(copier.discard()).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });
});
