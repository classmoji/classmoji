import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { collabPort, DEFAULT_COLLAB_PORT } from '../src/server.ts';
import { startServer, type TestServer } from './helpers.ts';

describe('collab server HTTP', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('answers GET /health with 200', async () => {
    const res = await fetch(`${server.httpUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('answers anything else with 404, not the Hocuspocus banner', async () => {
    const res = await fetch(`${server.httpUrl}/`);
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
