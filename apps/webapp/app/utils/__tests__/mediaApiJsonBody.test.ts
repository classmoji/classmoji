/**
 * The media routes' JSON body is capped while it streams, not measured after
 * it has all been buffered — a chunked request declares no length at all.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('@classmoji/auth/server', () => ({
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  requireAuth: vi.fn(),
}));
vi.mock('@classmoji/services', () => ({ ClassmojiService: { media: {} } }));

const { readJsonBody } = await import('../mediaApi.server');

/** A chunked body that would send `total` KB, counting how many it was asked for. */
function chunkedRequest(totalKb: number) {
  const state = { pulled: 0 };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulled += 1;
        if (state.pulled > totalKb) controller.close();
        else controller.enqueue(new TextEncoder().encode(' '.repeat(1024)));
      },
    },
    { highWaterMark: 0 }
  );
  const request = new Request('http://localhost/api/media/uploads', {
    method: 'POST',
    body,
    // @ts-expect-error — Node's fetch needs `duplex` for a streamed body.
    duplex: 'half',
  });
  return { request, state };
}

async function refusal(run: Promise<unknown>): Promise<Response> {
  try {
    await run;
  } catch (error: unknown) {
    if (error instanceof Response) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('readJsonBody', () => {
  it('reads a small JSON object', async () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      body: JSON.stringify({ classroomId: 'c1', filename: 'a.mp4', sizeBytes: 10 }),
    });
    expect(await readJsonBody(request)).toEqual({
      classroomId: 'c1',
      filename: 'a.mp4',
      sizeBytes: 10,
    });
  });

  it('stops reading a chunked body as soon as it passes 64 KB', async () => {
    const { request, state } = chunkedRequest(10_240); // would be 10 MB
    const response = await refusal(readJsonBody(request));

    expect(response.status).toBe(413);
    // 64 KB of 1 KB chunks, plus the one that crossed — not the other ten thousand.
    expect(state.pulled).toBeLessThanOrEqual(66);
  });

  it('refuses a declared oversize body without reading it', async () => {
    const { request, state } = chunkedRequest(10_240);
    request.headers.set('content-length', String(1024 * 1024));
    const response = await refusal(readJsonBody(request));

    expect(response.status).toBe(413);
    expect(state.pulled).toBe(0);
  });

  it('answers 400 for a body that is not a JSON object', async () => {
    const request = new Request('http://localhost/x', { method: 'POST', body: '[1,2]' });
    expect((await refusal(readJsonBody(request))).status).toBe(400);
  });
});
