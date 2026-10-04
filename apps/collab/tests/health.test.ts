import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from '@hocuspocus/server';

import { collabPort, createCollabServer, DEFAULT_COLLAB_PORT } from '../src/server.ts';

describe('collab server HTTP', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createCollabServer({ port: 0, stopOnSignals: false, quiet: true });
    await server.listen();
    base = `http://127.0.0.1:${server.address.port}`;
  });

  afterAll(async () => {
    await server.destroy();
  });

  it('answers GET /health with 200', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('answers anything else with 404, not the Hocuspocus banner', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(404);
  });
});

describe('collabPort', () => {
  it('defaults to 7700 and reads COLLAB_PORT', () => {
    expect(collabPort({})).toBe(DEFAULT_COLLAB_PORT);
    expect(collabPort({ COLLAB_PORT: '7710' })).toBe(7710);
    expect(() => collabPort({ COLLAB_PORT: 'x' })).toThrow();
  });
});
