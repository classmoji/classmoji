/**
 * Phase 1 integration tests — real seeded DB + a real spawned MCP server
 * (plan §8.1 layer 2; S2, S5, S7, S8 acceptance).
 *
 * The server is spawned as a child process on port 8103 (ports 8101/8102 are
 * reserved for sibling Phase-1 work; 8100 is the dev default) with the S8
 * dev-mint gates enabled, and driven over plain HTTP: raw JSON-RPC POSTs to
 * /mcp with bearer tokens minted via POST /dev/mint-token.
 *
 * Identity discipline (plan §8.1 critical guard): assertions use fake-ta /
 * fake-student-* — NEVER prof-classmoji or timofei7, whose OWNER+ASSISTANT+
 * STUDENT memberships make every denial assertion vacuously pass.
 *
 * Cleanup targets ONLY rows this file created (minted tokens are tracked by
 * accessToken value) — sibling agents mint their own dev tokens concurrently.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(APP_DIR, '../..');

// DATABASE_URL comes from the repo-root .env (see .dev-context) when the
// runner didn't provide one. loadEnvFile never overrides existing vars.
if (!process.env.DATABASE_URL) {
  process.loadEnvFile(path.join(REPO_ROOT, '.env'));
}

const PORT = 8103;
const BASE = `http://localhost:${PORT}`;
const EXPECTED_CHALLENGE = `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`;

// Deferred so the .env load above happens before Prisma is constructed.
const { default: getPrisma } = await import('@classmoji/database');

let server: ChildProcess | null = null;
let serverOutput = '';
const mintedTokens: string[] = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function waitForHealth(timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server && server.exitCode !== null) {
      throw new Error(`MCP server exited early (code ${server.exitCode}).\n${serverOutput}`);
    }
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`MCP server did not become healthy within ${timeoutMs}ms.\n${serverOutput}`);
}

interface MintOptions {
  login: string;
  scopes?: string[];
  expiresInSeconds?: number;
}

async function mintToken({ login, scopes, expiresInSeconds }: MintOptions) {
  const res = await fetch(`${BASE}/dev/mint-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, scopes, expiresInSeconds }),
  });
  expect(res.status, `mint-token failed for '${login}' — is the DB seeded?`).toBe(201);
  const body = (await res.json()) as {
    access_token: string;
    user_id: string;
    login: string;
  };
  mintedTokens.push(body.access_token);
  return body;
}

let rpcId = 0;

async function rpcRaw(token: string | null, method: string, params: unknown = {}) {
  rpcId += 1;
  return fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
  });
}

interface JsonRpcEnvelope {
  jsonrpc: string;
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function rpc(token: string | null, method: string, params: unknown = {}) {
  const res = await rpcRaw(token, method, params);
  expect(res.status).toBe(200);
  return (await res.json()) as JsonRpcEnvelope;
}

const INITIALIZE_PARAMS = {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'phase1-integration-test', version: '0.0.0' },
};

// ─── Lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  server = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ENABLE_TEST_LOGIN: 'true', // S8 double gate — both flags required
      MCP_PORT: String(PORT),
      MCP_PUBLIC_URL: BASE,
      WEBAPP_URL: 'http://localhost:3000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', chunk => (serverOutput += chunk));
  server.stderr?.on('data', chunk => (serverOutput += chunk));

  await waitForHealth();
});

afterAll(async () => {
  // Delete ONLY the token rows this file minted (tracked by value); the shared
  // 'classmoji-dev-mint' oauth application row is left for sibling agents.
  try {
    if (mintedTokens.length > 0) {
      await getPrisma().oauthAccessToken.deleteMany({
        where: { accessToken: { in: mintedTokens } },
      });
    }
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([once(server, 'exit'), new Promise(r => setTimeout(r, 5_000))]);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
    await getPrisma().$disconnect();
  }
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('liveness + metadata', () => {
  it('GET /health returns ok', async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'classmoji-mcp' });
  });

  it('serves RFC 9728 protected-resource metadata with THIS server as the resource', async () => {
    const res = await fetch(`${BASE}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // `resource` must be the RESOURCE SERVER origin (not the webapp/AS).
    expect(body.resource).toBe(BASE);
    expect(body.authorization_servers).toEqual(['http://localhost:3000']);
    expect(body.scopes_supported).toEqual(['read', 'write']);
    expect(body.bearer_methods_supported).toEqual(['header']);
  });
});

describe('401 boundary', () => {
  it('rejects a tokenless request with 401 + RFC 9728 WWW-Authenticate challenge', async () => {
    const res = await rpcRaw(null, 'initialize', INITIALIZE_PARAMS);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(EXPECTED_CHALLENGE);
    expect(res.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');

    const body = (await res.json()) as JsonRpcEnvelope;
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message).toMatch(/unauthorized/i);
    expect(body.id).toBeNull();
  });

  it('rejects a garbage token with 401', async () => {
    const res = await rpcRaw('garbage-token-that-was-never-minted', 'tools/list');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(EXPECTED_CHALLENGE);
  });

  it('rejects an expired token with 401 (expiry enforced by resolveViewer)', async () => {
    const { access_token } = await mintToken({ login: 'fake-ta', expiresInSeconds: -60 });
    const res = await rpcRaw(access_token, 'initialize', INITIALIZE_PARAMS);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(EXPECTED_CHALLENGE);
    const body = (await res.json()) as JsonRpcEnvelope;
    expect(body.error?.message).toMatch(/expired/i);
  });
});

describe('authenticated round-trip (fake-ta, read+write)', () => {
  it('initialize → tools/list → whoami over stateless JSON-RPC', async () => {
    const minted = await mintToken({ login: 'fake-ta' });

    // initialize
    const init = await rpc(minted.access_token, 'initialize', INITIALIZE_PARAMS);
    expect(init.error).toBeUndefined();
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('classmoji-mcp');

    // tools/list — stateless server: every POST is standalone, no session id.
    const list = await rpc(minted.access_token, 'tools/list');
    expect(list.error).toBeUndefined();
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map(t => t.name)).toContain('whoami');

    // tools/call whoami
    const call = await rpc(minted.access_token, 'tools/call', {
      name: 'whoami',
      arguments: {},
    });
    expect(call.error).toBeUndefined();
    const result = call.result as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBeFalsy();

    const identity = JSON.parse(result.content[0].text) as {
      userId: string;
      login: string;
      scopes: string[];
      memberships: Array<{ classroom: string; role: string }>;
    };
    expect(identity.userId).toBe(minted.user_id);
    expect(identity.login).toBe('fake-ta');
    expect(identity.scopes).toEqual(expect.arrayContaining(['read', 'write']));
    // fake-ta is the seeded ASSISTANT in classmoji-dev-winter-2025; memberships
    // are addressed in composite org/slug form.
    const assistant = identity.memberships.find(m => m.role === 'ASSISTANT');
    expect(assistant).toBeDefined();
    expect(assistant?.classroom).toMatch(/^[^/]+\/classmoji-dev-winter-2025$/);
  });
});

describe('S2 — immediate revocation', () => {
  it('rejects a revoked token on the very next request (DB-backed validation)', async () => {
    const minted = await mintToken({ login: 'fake-student-1' });

    // Token works…
    const before = await rpc(minted.access_token, 'tools/list');
    expect(before.error).toBeUndefined();

    // …revoke by deleting the oauth_access_tokens row mid-test…
    const deleted = await getPrisma().oauthAccessToken.deleteMany({
      where: { accessToken: minted.access_token },
    });
    expect(deleted.count).toBe(1);

    // …and the SAME token is rejected immediately (no cache, no grace period).
    const after = await rpcRaw(minted.access_token, 'tools/list');
    expect(after.status).toBe(401);
    expect(after.headers.get('www-authenticate')).toBe(EXPECTED_CHALLENGE);
  });
});

describe('S7 — scope-filtered registration', () => {
  it('a token with only identity scopes sees zero tools', async () => {
    const minted = await mintToken({ login: 'fake-student-2', scopes: ['openid'] });

    const res = await rpcRaw(minted.access_token, 'tools/list');
    // Authenticated (200), but with no read/write scope no tool is registered.
    // The SDK server then omits the tools capability entirely, so tools/list
    // is -32601; an empty list is equally acceptable. Both mean: zero surface.
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonRpcEnvelope;
    if (body.error) {
      expect(body.error.code).toBe(-32601);
    } else {
      expect((body.result as { tools: unknown[] }).tools).toHaveLength(0);
    }
  });

  it('identity-scoped tokens cannot call read tools either (defense in depth)', async () => {
    const minted = await mintToken({ login: 'fake-student-3', scopes: ['openid'] });

    const call = await rpc(minted.access_token, 'tools/call', {
      name: 'whoami',
      arguments: {},
    });
    // whoami is not registered for this token — the call must fail (either
    // JSON-RPC method/tool error or an isError result), never return identity.
    const resultText = JSON.stringify(call);
    expect(call.error ?? (call.result as { isError?: boolean })?.isError).toBeTruthy();
    expect(resultText).not.toContain('fake-student-3');
  });
});
