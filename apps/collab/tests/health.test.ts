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

  it('answers GET /health with 200 (db unknown: the test store has no ping)', async () => {
    const res = await fetch(`${server.httpUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'unknown' });
  });

  it('reports a database that does not answer: /health stays 200, /health/db is 503', async () => {
    const store = server.store as typeof server.store & { ping?: () => Promise<void> };
    store.ping = async () => {
      throw new Error('db down');
    };
    try {
      const health = await fetch(`${server.httpUrl}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'degraded', db: 'down' });
      const db = await fetch(`${server.httpUrl}/health/db`);
      expect(db.status).toBe(503);
    } finally {
      delete store.ping;
    }
  });

  it('survives a malformed request target (a scanner probe) and keeps serving', async () => {
    const { request } = await import('node:http');
    const { port, hostname } = new URL(server.httpUrl);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: hostname, port: Number(port), path: '//%2e%2e%2f%2eenv', method: 'GET' },
        res => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(404);
    const health = await fetch(`${server.httpUrl}/health`);
    expect(health.status).toBe(200);
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
