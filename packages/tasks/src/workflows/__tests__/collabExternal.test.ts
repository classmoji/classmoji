import { describe, it, expect, vi } from 'vitest';

/**
 * `collab-external`: one POST to collab per outside-pushed doc, retried on
 * anything another attempt can change, final on everything else.
 */

vi.mock('@trigger.dev/sdk', () => {
  class AbortTaskRunError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AbortTaskRunError';
    }
  }
  return {
    AbortTaskRunError,
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
    task: (definition: unknown) => definition,
  };
});

const {
  collabExternal,
  CollabExternalRefused,
  COLLAB_EXTERNAL_TASK,
  isRetryableStatus,
  postCollabExternal,
} = await import('../collabExternal.ts');

const payload = {
  classroomId: 'c1',
  kind: 'page' as const,
  docId: 'page-1',
  sha: 'c'.repeat(40),
  before: 'a'.repeat(40),
};
const env = { NODE_ENV: 'test', COLLAB_URL: 'http://collab.test/', COLLAB_INTERNAL_SECRET: 's3' };
const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('postCollabExternal', () => {
  it('POSTs { sha, before } to /internal/:kind/:id/external with the secret', async () => {
    const fetch = respond(200, { action: 'merged', version: 4 });

    const result = await postCollabExternal(payload, { fetch, env });

    expect(result).toEqual({ status: 200, body: { action: 'merged', version: 4 } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://collab.test/internal/page/page-1/external');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ sha: payload.sha, before: payload.before });
    expect((init.headers as Record<string, string>)['x-collab-secret']).toBe('s3');
  });

  it.each([500, 502, 503, 429, 409])('HTTP %i is retryable (plain Error)', async status => {
    const err = await postCollabExternal(payload, {
      fetch: respond(status, { error: 'busy' }),
      env,
    }).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(CollabExternalRefused);
  });

  it.each([400, 401, 403, 404, 422])('HTTP %i is final', async status => {
    await expect(
      postCollabExternal(payload, { fetch: respond(status, { error: 'nope' }), env })
    ).rejects.toBeInstanceOf(CollabExternalRefused);
  });

  it('a 409 content-missing is final', async () => {
    await expect(
      postCollabExternal(payload, { fetch: respond(409, { error: 'content-missing' }), env })
    ).rejects.toBeInstanceOf(CollabExternalRefused);
    expect(isRetryableStatus(409, { error: 'slide-locked' })).toBe(true);
  });

  it('a network error propagates as retryable', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(postCollabExternal(payload, { fetch, env })).rejects.toBeInstanceOf(TypeError);
  });

  it('no collab configured (production without env) is final', async () => {
    await expect(
      postCollabExternal(payload, { fetch: respond(200, {}), env: { NODE_ENV: 'production' } })
    ).rejects.toBeInstanceOf(CollabExternalRefused);
  });
});

describe('the task', () => {
  const definition = collabExternal as unknown as {
    id: string;
    queue: { name: string; concurrencyLimit: number };
    retry: { maxAttempts: number };
    run: (p: typeof payload) => Promise<unknown>;
  };

  it('is id collab-external on a concurrency-1 queue with retries', () => {
    expect(definition.id).toBe(COLLAB_EXTERNAL_TASK);
    expect(COLLAB_EXTERNAL_TASK).toBe('collab-external');
    expect(definition.queue).toEqual({ name: 'collab-external', concurrencyLimit: 1 });
    expect(definition.retry.maxAttempts).toBeGreaterThan(1);
  });

  it('turns a final answer into AbortTaskRunError and lets a retryable one throw', async () => {
    vi.stubEnv('COLLAB_URL', 'http://collab.test');
    vi.stubEnv('COLLAB_INTERNAL_SECRET', 's3');
    try {
      vi.stubGlobal('fetch', respond(404, { error: 'not-found' }));
      await expect(definition.run(payload)).rejects.toMatchObject({ name: 'AbortTaskRunError' });

      vi.stubGlobal('fetch', respond(503, { error: 'down' }));
      const err = (await definition.run(payload).catch(e => e)) as Error;
      expect(err.name).not.toBe('AbortTaskRunError');

      vi.stubGlobal('fetch', respond(200, { action: 'reseeded', epoch: 3 }));
      await expect(definition.run(payload)).resolves.toEqual({ action: 'reseeded', epoch: 3 });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
