/**
 * The four media routes.
 *
 * They are thin, so what is worth pinning is the seam rather than the logic:
 *
 *   - the ERROR SHAPE. The upload client switches on `body.error` and reads
 *     `usedBytes`/`quotaBytes` off a quota refusal. A route that answered 500
 *     where the service said 409 would make the client give up on an upload it
 *     could have reported honestly;
 *   - the GATE. Three of the four are addressed by media id alone, so the
 *     classroom is read off the row — and a session is required before that
 *     read, so an anonymous caller cannot use the 404 to ask which ids exist;
 *   - that the service, not the route, decides anything about media. The route
 *     passes `classroom` and the body through and maps whatever comes back.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  requireAuth: vi.fn(),
  findUnique: vi.fn(),
  createUpload: vi.fn(),
  signParts: vi.fn(),
  completeUpload: vi.fn(),
  deleteMedia: vi.fn(),
}));

class FakeMediaError extends Error {
  constructor(
    public code: string,
    public usedBytes?: number,
    public quotaBytes?: number
  ) {
    super(code);
    this.name = 'MediaError';
  }
}

vi.mock('@classmoji/auth/server', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
  requireAuth: (...a: unknown[]) => mocks.requireAuth(...a),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({ mediaObject: { findUnique: (...a: unknown[]) => mocks.findUnique(...a) } }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    media: {
      isMediaError: (error: unknown) => (error as Error | null)?.name === 'MediaError',
      createUpload: (...a: unknown[]) => mocks.createUpload(...a),
      signParts: (...a: unknown[]) => mocks.signParts(...a),
      completeUpload: (...a: unknown[]) => mocks.completeUpload(...a),
      deleteMedia: (...a: unknown[]) => mocks.deleteMedia(...a),
    },
  },
}));

const { action: createAction } = await import('../api.media.uploads/route');
const { action: partsAction } = await import('../api.media.uploads_.$mediaId.parts/route');
const { action: completeAction } = await import('../api.media.uploads_.$mediaId.complete/route');
const { action: deleteAction } = await import('../api.media.$mediaId/route');

const CLASSROOM_ID = '11111111-2222-4333-8444-555555555555';
const MEDIA_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

function post(url: string, body: unknown, method = 'POST'): Request {
  return new Request(`https://app.test${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'DELETE' ? undefined : JSON.stringify(body),
  });
}

/** React Router hands the action `{ params, request, context }`; only two matter. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const args = (request: Request, params: Record<string, string> = {}): any => ({
  request,
  params,
  context: {},
});

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.requireAuth.mockResolvedValue({ userId: 'user-1' });
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'user-1',
    classroom: { id: CLASSROOM_ID, status: 'ACTIVE' },
    membership: { role: 'TEACHER' },
  });
  mocks.findUnique.mockResolvedValue({ classroom_id: CLASSROOM_ID });
});

describe('POST /api/media/uploads', () => {
  it('gates on the teaching team and passes the classroom to the service', async () => {
    mocks.createUpload.mockResolvedValue({
      mediaId: MEDIA_ID,
      uploadId: 'up-1',
      contentType: 'video/mp4',
      partSize: 1024,
      partCount: 2,
    });

    const response = await createAction(
      args(
        post('/api/media/uploads', {
          classroomId: CLASSROOM_ID,
          filename: 'a.mp4',
          sizeBytes: 2048,
        })
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ contentType: 'video/mp4' });

    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        classroomId: CLASSROOM_ID,
        allowedRoles: ['OWNER', 'TEACHER', 'ASSISTANT'],
        resourceType: 'MEDIA',
      })
    );
    expect(mocks.createUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        classroom: { id: CLASSROOM_ID },
        filename: 'a.mp4',
        sizeBytes: 2048,
      })
    );
  });

  it('answers a quota refusal with 409 and the numbers the client shows', async () => {
    mocks.createUpload.mockRejectedValue(new FakeMediaError('QUOTA_EXCEEDED', 900, 1000));

    const response = await createAction(
      args(
        post('/api/media/uploads', { classroomId: CLASSROOM_ID, filename: 'a.mp4', sizeBytes: 200 })
      )
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'QUOTA_EXCEEDED',
      usedBytes: 900,
      quotaBytes: 1000,
    });
  });

  it('maps each media refusal to its own status', async () => {
    const cases: [string, number][] = [
      ['NOT_CONFIGURED', 503],
      ['PRO_REQUIRED', 403],
      ['DELIVERY_REQUIRED', 409],
      ['FILE_TOO_LARGE', 413],
      ['KIND_NOT_ALLOWED', 422],
      ['NOT_FOUND', 404],
      ['BAD_STATE', 409],
      ['SIZE_MISMATCH', 409],
      ['VERIFY_FAILED', 409],
    ];

    for (const [code, status] of cases) {
      mocks.createUpload.mockRejectedValue(new FakeMediaError(code));
      const response = await createAction(
        args(
          post('/api/media/uploads', { classroomId: CLASSROOM_ID, filename: 'a.mp4', sizeBytes: 1 })
        )
      );
      expect(response.status, code).toBe(status);
      await expect(response.json()).resolves.toMatchObject({ error: code });
    }
  });

  it('lets an auth refusal through as itself, audit row and all', async () => {
    mocks.assertClassroomAccess.mockRejectedValue(new Response('Forbidden', { status: 403 }));
    const response = await createAction(
      args(
        post('/api/media/uploads', { classroomId: CLASSROOM_ID, filename: 'a.mp4', sizeBytes: 1 })
      )
    );
    expect(response.status).toBe(403);
    expect(mocks.createUpload).not.toHaveBeenCalled();
  });

  it('refuses a body with no classroom or filename before authorizing anything', async () => {
    const response = await createAction(args(post('/api/media/uploads', { sizeBytes: 1 })));
    expect(response.status).toBe(400);
    expect(mocks.assertClassroomAccess).not.toHaveBeenCalled();
  });

  it('calls a missing or unusable size a bad request, not a file too large', async () => {
    // 413 is what the client shows as "your file is over the limit", which is
    // not what a body with no size in it means.
    for (const sizeBytes of [undefined, 'big', Number.NaN, Number.POSITIVE_INFINITY]) {
      const response = await createAction(
        args(
          post('/api/media/uploads', { classroomId: CLASSROOM_ID, filename: 'a.mp4', sizeBytes })
        )
      );
      expect(response.status, String(sizeBytes)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'BAD_REQUEST' });
    }
    expect(mocks.createUpload).not.toHaveBeenCalled();
  });

  it('refuses a body that is too large to be one of ours', async () => {
    const request = new Request('https://app.test/api/media/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'content-length': String(1024 * 1024) },
      body: JSON.stringify({ classroomId: CLASSROOM_ID, filename: 'a.mp4', sizeBytes: 1 }),
    });
    const response = await createAction(args(request));
    expect(response.status).toBe(413);
  });

  it('refuses a GET', async () => {
    const response = await createAction(
      args(new Request('https://app.test/api/media/uploads', { method: 'GET' }))
    );
    expect(response.status).toBe(405);
  });
});

describe('POST /api/media/uploads/:mediaId/parts', () => {
  it('requires a session before it will say whether an id exists', async () => {
    mocks.requireAuth.mockRejectedValue(new Response('Unauthorized', { status: 401 }));

    const response = await partsAction(
      args(post(`/api/media/uploads/${MEDIA_ID}/parts`, { partNumbers: [1] }), {
        mediaId: MEDIA_ID,
      })
    );

    expect(response.status).toBe(401);
    // The row was never read, so a real id and an invented one are the same 401.
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it('reads the classroom off the row and gates on that', async () => {
    mocks.signParts.mockResolvedValue({ urls: [{ partNumber: 1, url: 'u', expiresAt: 'x' }] });

    const response = await partsAction(
      args(post(`/api/media/uploads/${MEDIA_ID}/parts`, { partNumbers: [1, 2] }), {
        mediaId: MEDIA_ID,
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: MEDIA_ID },
      select: { classroom_id: true },
    });
    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ classroomId: CLASSROOM_ID })
    );
    expect(mocks.signParts).toHaveBeenCalledWith({
      classroom: { id: CLASSROOM_ID },
      mediaId: MEDIA_ID,
      partNumbers: [1, 2],
    });
  });

  it('is a 404 for an id that is not a media id at all', async () => {
    const response = await partsAction(
      args(post('/api/media/uploads/nope/parts', { partNumbers: [1] }), { mediaId: 'nope' })
    );
    expect(response.status).toBe(404);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
  });

  it('refuses an empty batch', async () => {
    const response = await partsAction(
      args(post(`/api/media/uploads/${MEDIA_ID}/parts`, { partNumbers: [] }), { mediaId: MEDIA_ID })
    );
    expect(response.status).toBe(400);
  });
});

describe('POST /api/media/uploads/:mediaId/complete', () => {
  it('passes the parts through with their etags untouched', async () => {
    mocks.completeUpload.mockResolvedValue({
      mediaId: MEDIA_ID,
      ref: `media://${MEDIA_ID}`,
      sizeBytes: 10,
    });

    const response = await completeAction(
      args(
        post(`/api/media/uploads/${MEDIA_ID}/complete`, {
          parts: [
            { partNumber: 1, etag: '"abc"' },
            { partNumber: 2, etag: '"def"' },
          ],
        }),
        { mediaId: MEDIA_ID }
      )
    );

    expect(response.status).toBe(200);
    expect(mocks.completeUpload).toHaveBeenCalledWith({
      classroom: { id: CLASSROOM_ID },
      mediaId: MEDIA_ID,
      // Quotes intact: the browser read them off the ETag header, and S3 wants
      // them back the same way.
      parts: [
        { partNumber: 1, etag: '"abc"' },
        { partNumber: 2, etag: '"def"' },
      ],
    });
  });

  it('drops malformed part entries and refuses when nothing is left', async () => {
    const response = await completeAction(
      args(
        post(`/api/media/uploads/${MEDIA_ID}/complete`, { parts: [{ partNumber: 'x' }, null] }),
        {
          mediaId: MEDIA_ID,
        }
      )
    );
    expect(response.status).toBe(400);
    expect(mocks.completeUpload).not.toHaveBeenCalled();
  });

  it('reports a size mismatch as 409 SIZE_MISMATCH', async () => {
    mocks.completeUpload.mockRejectedValue(new FakeMediaError('SIZE_MISMATCH'));
    const response = await completeAction(
      args(
        post(`/api/media/uploads/${MEDIA_ID}/complete`, {
          parts: [{ partNumber: 1, etag: '"a"' }],
        }),
        {
          mediaId: MEDIA_ID,
        }
      )
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'SIZE_MISMATCH' });
  });
});

describe('DELETE /api/media/:mediaId', () => {
  it('is 204 with no body on success', async () => {
    mocks.deleteMedia.mockResolvedValue({ mediaId: MEDIA_ID });

    const response = await deleteAction(
      args(post(`/api/media/${MEDIA_ID}`, null, 'DELETE'), { mediaId: MEDIA_ID })
    );

    expect(response.status).toBe(204);
    expect(mocks.deleteMedia).toHaveBeenCalledWith({
      classroom: { id: CLASSROOM_ID },
      mediaId: MEDIA_ID,
    });
  });

  it('is a 404 rather than a throw when the object is already gone', async () => {
    // The upload client fires this best-effort after any failure, so a repeat
    // has to be an ordinary answer.
    mocks.deleteMedia.mockRejectedValue(new FakeMediaError('NOT_FOUND'));
    const response = await deleteAction(
      args(post(`/api/media/${MEDIA_ID}`, null, 'DELETE'), { mediaId: MEDIA_ID })
    );
    expect(response.status).toBe(404);

    mocks.findUnique.mockResolvedValue(null);
    const gone = await deleteAction(
      args(post(`/api/media/${MEDIA_ID}`, null, 'DELETE'), { mediaId: MEDIA_ID })
    );
    expect(gone.status).toBe(404);
  });

  it('refuses a POST to the delete route', async () => {
    const response = await deleteAction(
      args(post(`/api/media/${MEDIA_ID}`, {}), { mediaId: MEDIA_ID })
    );
    expect(response.status).toBe(405);
  });
});

/**
 * The three id-addressed routes must have no reply that means "this exists,
 * elsewhere". A 403 was exactly that reply: it told a signed-in stranger that
 * the uuid they had named was a real object in somebody else's classroom,
 * which is the one fact the id alone was not supposed to be able to buy.
 */
describe('an id in a classroom the caller cannot edit', () => {
  const FOREIGN_CLASSROOM = '99999999-8888-4777-8666-555555555555';

  /** The gate's own refusal: text/plain 403, after the audit row is written. */
  const denied = () => new Response('Access denied', { status: 403 });

  beforeEach(() => {
    mocks.findUnique.mockResolvedValue({ classroom_id: FOREIGN_CLASSROOM });
    mocks.assertClassroomAccess.mockRejectedValue(denied());
  });

  it.each([
    [
      'parts',
      () =>
        partsAction(
          args(post(`/api/media/uploads/${MEDIA_ID}/parts`, { partNumbers: [1] }), {
            mediaId: MEDIA_ID,
          })
        ),
    ],
    [
      'complete',
      () =>
        completeAction(
          args(
            post(`/api/media/uploads/${MEDIA_ID}/complete`, {
              parts: [{ partNumber: 1, etag: '"a"' }],
            }),
            {
              mediaId: MEDIA_ID,
            }
          )
        ),
    ],
    [
      'delete',
      () =>
        deleteAction(args(post(`/api/media/${MEDIA_ID}`, null, 'DELETE'), { mediaId: MEDIA_ID })),
    ],
  ])('answers %s with the same 404 an unknown id gets', async (_name, call) => {
    const response = await call();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'NOT_FOUND' });
    // The service was never reached, so nothing was aborted or deleted either.
    expect(mocks.signParts).not.toHaveBeenCalled();
    expect(mocks.completeUpload).not.toHaveBeenCalled();
    expect(mocks.deleteMedia).not.toHaveBeenCalled();
  });

  it('is byte-identical to the answer for an id that was never issued', async () => {
    const foreign = await deleteAction(
      args(post(`/api/media/${MEDIA_ID}`, null, 'DELETE'), { mediaId: MEDIA_ID })
    );

    mocks.findUnique.mockResolvedValue(null);
    const unknown = await deleteAction(
      args(post(`/api/media/${MEDIA_ID}`, null, 'DELETE'), { mediaId: MEDIA_ID })
    );

    expect(foreign.status).toBe(unknown.status);
    await expect(foreign.text()).resolves.toBe(await unknown.text());
  });

  it('still writes the audit row, so a real attempt is not invisible to us', async () => {
    await deleteAction(args(post(`/api/media/${MEDIA_ID}`, null, 'DELETE'), { mediaId: MEDIA_ID }));

    // `assertClassroomAccess` writes it before it throws; masking the status
    // must not mean skipping the call that records the attempt.
    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ classroomId: FOREIGN_CLASSROOM, attemptedAction: 'delete_media' })
    );
  });

  it('leaves the locked-classroom refusal alone, since that one reveals nothing', async () => {
    // A member of the classroom, refused for a reason they can act on: telling
    // them "no such media object" would send them hunting a deleted file.
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: 'user-1',
      classroom: { id: FOREIGN_CLASSROOM, status: 'LOCKED' },
      membership: { role: 'TEACHER' },
    });
    mocks.assertClassroomMutationAllowed.mockImplementation(() => {
      throw new Response(JSON.stringify({ error: 'CLASSROOM_LOCKED' }), { status: 403 });
    });

    const response = await deleteAction(
      args(post(`/api/media/${MEDIA_ID}`, null, 'DELETE'), { mediaId: MEDIA_ID })
    );

    expect(response.status).toBe(403);
  });
});
