/**
 * The input limits end to end (src/mcp/inputLimits.ts), on a real spawned
 * server with the production Node options (as in apps/mcp/Dockerfile): many
 * concurrent calls at the element limit, plus bodies at the body limit made
 * of empty objects, from several users at once. The server answers every one
 * (tool errors and 413s) and stays healthy.
 *
 * Needs the seeded database (npm run db:seed) like the other suites; writes
 * nothing but the tokens it mints, which it deletes.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE, deleteMintedTokens, mintToken, startServer, type ServerHandle } from './helpers.ts';

const UUID = '00000000-0000-0000-0000-000000000000';
const LIMIT = 25_000;
/** MAX_BODY_JSON_VALUES: the JSON values a body may carry before parsing. */
const BODY_VALUES_LIMIT = 100_000;

let server: ServerHandle;
const tokens: string[] = [];

beforeAll(async () => {
  server = await startServer({ env: { NODE_OPTIONS: '--max-old-space-size=384' } });
  for (const login of ['fake-teacher', 'fake-ta', 'fake-student-1', 'fake-student-2']) {
    tokens.push((await mintToken({ login, scopes: ['read', 'write'] })).access_token);
  }
});

afterAll(async () => {
  await deleteMintedTokens();
  await server?.stop();
});

/** page_content_apply ops whose `position` matches neither branch: one issue per op. */
function invalidMoves(elements: number) {
  const ops = Array.from({ length: Math.floor((elements - 3) / 5) }, () => ({
    op: 'move',
    id: 'x',
    position: { a: 1 },
  }));
  return { classroom: 'dev-org/classmoji-dev-winter-2025', page_id: UUID, ops };
}

/** A body at the 8 MiB limit made of empty objects. */
function emptyObjectsBody() {
  const head =
    '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{"a":[';
  const tail = ']}}}';
  const room = 8 * 1024 * 1024 - head.length - tail.length - 16;
  return (
    head +
    Array(Math.floor(room / 3))
      .fill('{}')
      .join(',') +
    tail
  );
}

async function post(token: string, body: string) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body,
  });
  return { status: res.status, text: await res.text() };
}

describe('input limits on a spawned server', () => {
  it('stays healthy under concurrent maximal calls and maximal bodies', async () => {
    const call = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'page_content_apply', arguments: invalidMoves(LIMIT) },
    });
    const body = emptyObjectsBody();

    const results = await Promise.all([
      ...Array.from({ length: 24 }, (_, i) => post(tokens[i % tokens.length], call)),
      ...Array.from({ length: 3 }, (_, i) => post(tokens[i % tokens.length], body)),
    ]);

    const calls = results.slice(0, 24);
    const bodies = results.slice(24);
    for (const r of calls) {
      expect(r.status).toBe(200);
      const envelope = JSON.parse(r.text) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(envelope.result.isError).toBe(true);
      expect(envelope.result.content[0].text.length).toBeLessThanOrEqual(4_096);
    }
    for (const r of bodies) expect(r.status).toBe(413);

    expect(server.process.exitCode).toBeNull();
    expect((await fetch(`${BASE}/health`)).status).toBe(200);
  });

  it('answers a call over the element limit with a tool error naming the limit', async () => {
    const r = await post(
      tokens[0],
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'big',
        method: 'tools/call',
        params: { name: 'page_content_apply', arguments: invalidMoves(LIMIT + 100) },
      })
    );
    const envelope = JSON.parse(r.text) as {
      id: string;
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(envelope.id).toBe('big');
    expect(JSON.parse(envelope.result.content[0].text)).toMatchObject({
      error: 'invalid_params',
      code: 'INPUT_TOO_LARGE',
    });
  });

  it('refuses an oversize request before parsing it', async () => {
    const r = await post(
      tokens[1],
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'page_content_apply',
          arguments: invalidMoves(Math.round(1.5 * BODY_VALUES_LIMIT)),
        },
      })
    );
    expect(r.status).toBe(413);
    expect((await fetch(`${BASE}/health`)).status).toBe(200);
  });
});
