/**
 * The media settings tab's loader and action.
 *
 * Three things are worth pinning here, and none of them is visible in the
 * markup:
 *
 *   - the page is OWNER-gated but NOT Pro-gated. A free classroom is supposed
 *     to reach it and see an empty meter; asserting Pro in the loader would
 *     403 the tab and there would be nothing left to upsell to;
 *   - the SIZE a row is shown at is the size the quota counted, so the meter
 *     and the table cannot contradict each other in front of the person
 *     deciding what to delete;
 *   - the download action never throws. A fetcher turns a 4xx into a thrown
 *     error and replaces the page with the error boundary, so every refusal
 *     comes back as `{ error }` beside the row instead.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomAdmin: vi.fn(),
  usage: vi.fn(),
  listMedia: vi.fn(),
  isMediaConfigured: vi.fn(),
  findMediaRow: vi.fn(),
  toMediaRecord: vi.fn(),
  mediaDownloadUrl: vi.fn(),
  mediaPosterUrl: vi.fn(),
  canServeSignedContent: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomAdmin: (...a: unknown[]) => mocks.requireClassroomAdmin(...a),
}));

vi.mock('@classmoji/database', async () => ({
  ...(await vi.importActual<typeof import('@classmoji/database/gitIdentity')>(
    '@classmoji/database/gitIdentity'
  )),

  default: () => ({ user: { findMany: (...a: unknown[]) => mocks.userFindMany(...a) } }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    media: {
      PRO_QUOTA_BYTES: 10 * 1024 ** 3,
      usage: (...a: unknown[]) => mocks.usage(...a),
      listMedia: (...a: unknown[]) => mocks.listMedia(...a),
      isMediaConfigured: () => mocks.isMediaConfigured(),
      findMediaRow: (...a: unknown[]) => mocks.findMediaRow(...a),
      toMediaRecord: (...a: unknown[]) => mocks.toMediaRecord(...a),
    },
    contentDelivery: {
      mediaDownloadUrl: (...a: unknown[]) => mocks.mediaDownloadUrl(...a),
      mediaPosterUrl: (...a: unknown[]) => mocks.mediaPosterUrl(...a),
      canServeSignedContent: (...a: unknown[]) => mocks.canServeSignedContent(...a),
    },
  },
}));

const { loader, action } = await import('../route');

const CLASS_SLUG = 'cs52-26w';
const CLASSROOM = {
  id: 'class-1',
  content_key_version: 1,
  content_repo: 'content-org-cs52',
  content_delivery_enabled: true,
  git_organization: { login: 'org' },
};
const MEDIA_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const GiB = 1024 ** 3;

/** A service `MediaRecord`, with only the fields the page reads filled in. */
const record = (over: Record<string, unknown> = {}) => ({
  id: MEDIA_ID,
  classroomId: CLASSROOM.id,
  kind: 'VIDEO',
  filename: 'week-1.mp4',
  ext: 'mp4',
  sizeBytes: 2 * GiB,
  renditionBytes: null,
  originalDeletedAt: null,
  status: 'READY',
  processing: 'NONE',
  processingError: null,
  posterKey: null,
  optimise: true,
  keepOriginal: true,
  allowDownload: false,
  uploadedBy: 'user-1',
  createdAt: new Date('2026-09-18T10:00:00.000Z'),
  ...over,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const args = (request: Request, params = { class: CLASS_SLUG }): any => ({ request, params });

const get = () => new Request(`https://app.test/admin/${CLASS_SLUG}/settings/media`);
const post = (body: unknown) =>
  new Request(`https://app.test/admin/${CLASS_SLUG}/settings/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.requireClassroomAdmin.mockResolvedValue({ classroom: CLASSROOM, userId: 'user-1' });
  mocks.usage.mockResolvedValue({
    usedBytes: 2 * GiB,
    quotaBytes: 10 * GiB,
    perFileBytes: 2 * GiB,
    isPro: true,
  });
  mocks.listMedia.mockResolvedValue([record()]);
  mocks.isMediaConfigured.mockReturnValue(true);
  mocks.canServeSignedContent.mockReturnValue(true);
  mocks.userFindMany.mockResolvedValue([
    {
      id: 'user-1',
      name: 'Tim',
      accounts: [{ provider_id: 'github', account_id: '1', username: 'tregubov' }],
    },
  ]);
});

describe('loader', () => {
  it('is owner-gated, and gated on nothing else', async () => {
    await loader(args(get()));

    expect(mocks.requireClassroomAdmin).toHaveBeenCalledWith(
      expect.any(Request),
      CLASS_SLUG,
      expect.objectContaining({ resourceType: 'MEDIA', action: 'view_media' })
    );
  });

  it('returns the usage and the list together', async () => {
    const data = await loader(args(get()));

    expect(data.usage).toMatchObject({ usedBytes: 2 * GiB, quotaBytes: 10 * GiB, isPro: true });
    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({
      id: MEDIA_ID,
      filename: 'week-1.mp4',
      kind: 'VIDEO',
      uploadedByName: 'Tim',
      createdAt: '2026-09-18T10:00:00.000Z',
    });
    expect(data.classroomId).toBe(CLASSROOM.id);
    expect(data.configured).toBe(true);
  });

  it('resolves every uploader in ONE query, not one per file', async () => {
    mocks.listMedia.mockResolvedValue([
      record({ id: 'a', uploadedBy: 'user-1' }),
      record({ id: 'b', uploadedBy: 'user-2' }),
      record({ id: 'c', uploadedBy: 'user-1' }),
    ]);
    mocks.userFindMany.mockResolvedValue([
      {
        id: 'user-1',
        name: 'Tim',
        accounts: [{ provider_id: 'github', account_id: '1', username: 't' }],
      },
      {
        id: 'user-2',
        name: null,
        accounts: [{ provider_id: 'github', account_id: '1', username: 'pape' }],
      },
    ]);

    const data = await loader(args(get()));

    expect(mocks.userFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['user-1', 'user-2'] } } })
    );
    // Falls back to the git username when there is no display name, and never to a raw id.
    expect(data.items.map(item => item.uploadedByName)).toEqual(['Tim', 'pape', 'Tim']);
  });

  it('asks for no users at all when there is nothing stored', async () => {
    mocks.listMedia.mockResolvedValue([]);

    const data = await loader(args(get()));

    expect(data.items).toEqual([]);
    expect(mocks.userFindMany).not.toHaveBeenCalled();
  });

  it('passes the processing state and its error through for the row label', async () => {
    mocks.listMedia.mockResolvedValue([
      record({ processing: 'FAILED', processingError: 'The video could not be read.' }),
    ]);
    const data = await loader(args(get()));
    expect(data.items[0]).toMatchObject({
      processing: 'FAILED',
      processingError: 'The video could not be read.',
      posterUrl: null,
    });
  });

  it('signs a poster thumbnail only for rows that have one', async () => {
    const POSTER_KEY = `m/class-1/${MEDIA_ID}/poster-0123456789ab.jpg`;
    mocks.listMedia.mockResolvedValue([
      record({ id: 'a', processing: 'DONE', posterKey: POSTER_KEY }),
      record({ id: 'b' }),
    ]);
    mocks.mediaPosterUrl.mockResolvedValue('https://content.test/poster');

    const data = await loader(args(get()));

    expect(mocks.mediaPosterUrl).toHaveBeenCalledTimes(1);
    expect(mocks.mediaPosterUrl).toHaveBeenCalledWith({
      classroom: {
        id: 'class-1',
        content_key_version: 1,
        content_repo: 'content-org-cs52',
        git_organization: { login: 'org' },
        content_delivery_enabled: true,
      },
      record: expect.objectContaining({ id: 'a' }),
    });
    expect(data.items.map(item => item.posterUrl)).toEqual(['https://content.test/poster', null]);
  });

  it('a poster that cannot be signed is a missing thumbnail, not a failed page', async () => {
    mocks.listMedia.mockResolvedValue([record({ posterKey: 'x' })]);
    mocks.mediaPosterUrl.mockRejectedValue(new Error('no secret'));
    const data = await loader(args(get()));
    expect(data.items[0].posterUrl).toBeNull();
  });

  it('shows the rendition size once the original has been dropped', async () => {
    // Otherwise the table would claim a 2 GB cost for a file the meter has
    // already stopped counting at 2 GB — on the same screen.
    mocks.listMedia.mockResolvedValue([
      record({ renditionBytes: 300 * 1024 * 1024, originalDeletedAt: new Date() }),
    ]);

    const data = await loader(args(get()));

    expect(data.items[0].billedBytes).toBe(300 * 1024 * 1024);
    // The page says so under the name.
    expect(data.items[0].originalDeleted).toBe(true);
  });

  it('shows the uploaded size while the original is still kept', async () => {
    mocks.listMedia.mockResolvedValue([
      record({ renditionBytes: 300 * 1024 * 1024, originalDeletedAt: null }),
    ]);

    const data = await loader(args(get()));
    expect(data.items[0].billedBytes).toBe(2 * GiB);
    expect(data.items[0].originalDeleted).toBe(false);
  });

  it('renders for a free classroom rather than refusing it', async () => {
    // The Pro gate lives in the service, where uploading is actually refused.
    // Here a free owner gets an empty meter and the upsell beside it.
    mocks.usage.mockResolvedValue({
      usedBytes: 0,
      quotaBytes: 0,
      perFileBytes: 2 * GiB,
      isPro: false,
    });
    mocks.listMedia.mockResolvedValue([]);

    const data = await loader(args(get()));

    expect(data.usage).toMatchObject({ usedBytes: 0, quotaBytes: 0, isPro: false });
    expect(data.proQuotaBytes).toBe(10 * GiB);
  });

  it('still lists what is stored when the deployment has no bucket', async () => {
    mocks.isMediaConfigured.mockReturnValue(false);

    const data = await loader(args(get()));

    expect(data.configured).toBe(false);
    // Reading is plain SQL; only adding needs R2.
    expect(data.items).toHaveLength(1);
  });

  it('asks the delivery layer itself whether this class could be served', async () => {
    // The same predicate `createUpload` refuses on, against the same classroom
    // — otherwise the button and the refusal drift apart and an owner spends a
    // 2 GB upload finding out.
    const data = await loader(args(get()));

    expect(mocks.canServeSignedContent).toHaveBeenCalledWith(CLASSROOM);
    expect(data.canDeliver).toBe(true);
  });

  it('offers nothing new on a deployment that cannot sign, bucket and Pro or not', async () => {
    // The symptom state: R2 is configured and the class is Pro, but the
    // deployment has no signing secret or delivery origin. The class half
    // alone would say yes; the service refuses every upload.
    mocks.isMediaConfigured.mockReturnValue(true);
    mocks.canServeSignedContent.mockReturnValue(false);

    const data = await loader(args(get()));

    expect(data.configured).toBe(true);
    expect(data.usage.isPro).toBe(true);
    expect(data.canDeliver).toBe(false);
  });

  it('reports a class the layer cannot sign for, with the list intact', async () => {
    mocks.canServeSignedContent.mockReturnValue(false);

    const data = await loader(args(get()));

    expect(data.canDeliver).toBe(false);
    // Nothing new can be added; what is already there still shows.
    expect(data.configured).toBe(true);
    expect(data.items).toHaveLength(1);
  });
});

describe('action — minting a download URL', () => {
  beforeEach(() => {
    mocks.findMediaRow.mockResolvedValue({ id: MEDIA_ID, status: 'READY' });
    mocks.toMediaRecord.mockImplementation((row: unknown) => row);
    mocks.mediaDownloadUrl.mockResolvedValue(
      'https://content.test/c/class-1/media/x/orig.mp4?sig=1'
    );
  });

  it('is owner-gated in its own right', async () => {
    await action(args(post({ mediaId: MEDIA_ID })));

    expect(mocks.requireClassroomAdmin).toHaveBeenCalledWith(
      expect.any(Request),
      CLASS_SLUG,
      expect.objectContaining({ resourceType: 'MEDIA', action: 'download_media' })
    );
  });

  it('looks the row up scoped to the classroom, so a foreign id is simply absent', async () => {
    await action(args(post({ mediaId: MEDIA_ID })));

    expect(mocks.findMediaRow).toHaveBeenCalledWith(CLASSROOM.id, MEDIA_ID);
  });

  it('mints as staff, whatever the uploader chose for students', async () => {
    const result = await action(args(post({ mediaId: MEDIA_ID })));

    expect(mocks.mediaDownloadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ classroom: CLASSROOM, forStudent: false })
    );
    expect(result).toEqual({ url: 'https://content.test/c/class-1/media/x/orig.mp4?sig=1' });
  });

  it('refuses an id that is not in this classroom without minting anything', async () => {
    mocks.findMediaRow.mockResolvedValue(null);

    const result = await action(args(post({ mediaId: MEDIA_ID })));

    expect(result).toEqual({ error: 'That file is no longer available.' });
    expect(mocks.mediaDownloadUrl).not.toHaveBeenCalled();
  });

  it('refuses a row that has not finished uploading', async () => {
    mocks.findMediaRow.mockResolvedValue({ id: MEDIA_ID, status: 'UPLOADING' });

    const result = await action(args(post({ mediaId: MEDIA_ID })));

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(mocks.mediaDownloadUrl).not.toHaveBeenCalled();
  });

  it('refuses a body with no media id, without touching the database', async () => {
    const result = await action(args(post({})));

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(mocks.findMediaRow).not.toHaveBeenCalled();
  });

  it('reports an unsignable classroom as a message rather than a thrown status', async () => {
    // A thrown 4xx would take the whole page to the error boundary; the owner
    // needs the rest of the list and one line about this row.
    mocks.mediaDownloadUrl.mockResolvedValue(null);

    const result = await action(args(post({ mediaId: MEDIA_ID })));

    expect(result).toEqual({ error: "Downloading isn't available right now." });
  });

  it('never answers with a Response, so a fetcher cannot turn it into an error', async () => {
    mocks.findMediaRow.mockResolvedValue(null);
    const refusal = await action(args(post({ mediaId: MEDIA_ID })));
    const success = await (async () => {
      mocks.findMediaRow.mockResolvedValue({ id: MEDIA_ID, status: 'READY' });
      return action(args(post({ mediaId: MEDIA_ID })));
    })();

    expect(refusal).not.toBeInstanceOf(Response);
    expect(success).not.toBeInstanceOf(Response);
  });
});
