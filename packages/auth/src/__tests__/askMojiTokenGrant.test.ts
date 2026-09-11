/* eslint-disable @typescript-eslint/no-explicit-any -- the Prisma / better-auth
   stand-ins below deliberately accept whatever argument shape the code under test
   passes, so the assertions read the REAL call arguments rather than a typed guess. */
/**
 * Integration test for the two hardening measures in ./server.ts that make an
 * Ask Moji bearer token non-renewable (plan P1-2, security review finding).
 *
 * This drives the REAL exported `auth` — real better-auth router, real mcp
 * plugin, real `hooks.before`, real `disabledPaths` — over `auth.handler`, the
 * same entry point apps/webapp and apps/admin mount at `/api/auth/*`. Only
 * Prisma and the service layer are stood in, because the behaviour under test
 * is routing and authorization, not storage.
 *
 * THE ATTACK THIS CLOSES. better-auth 1.4.18's refresh grant
 * (node_modules/better-auth/dist/plugins/mcp/index.mjs:262-309) verifies the
 * refresh token and the client id and NEVER a client secret, and issues a fresh
 * seven-day refresh credential each time. `/mcp/get-session` (:636-653) hands
 * back the ENTIRE `oauth_access_tokens` row — refresh token included, expiry
 * unchecked — to anyone presenting the access token. Chained, a leaked one-hour
 * Ask Moji bearer becomes an indefinitely renewable credential. Three layers
 * stop it; this file covers two of them (the third, the already-expired
 * `refreshTokenExpiresAt`, is pinned in ./mcpToken.test.ts).
 *
 * The negative controls matter as much as the refusals: a different OAuth
 * client must still be able to use the token endpoint, or we have not hardened
 * Ask Moji, we have broken the Claude.ai connector.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.WEBAPP_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-chars!!';

const OTHER_CLIENT_ID = 'some-other-mcp-client';

const mocks = vi.hoisted(() => {
  const rows: Record<string, unknown>[] = [];
  const created: Record<string, unknown>[] = [];
  const client: any = {
    oauthAccessToken: {
      findFirst: vi.fn(({ where }: any) =>
        Promise.resolve(
          rows.find(r =>
            Object.entries(where ?? {}).every(([k, v]) => (r as Record<string, unknown>)[k] === v)
          ) ?? null
        )
      ),
      findMany: vi.fn(() => Promise.resolve([])),
      create: vi.fn(({ data }: any) => {
        const row = { id: `tok-${created.length}`, ...data };
        created.push(row);
        return Promise.resolve(row);
      }),
      update: vi.fn(({ data }: any) => Promise.resolve(data)),
      delete: vi.fn(() => Promise.resolve({})),
      deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
      count: vi.fn(() => Promise.resolve(0)),
    },
    oauthApplication: {
      findFirst: vi.fn(() => Promise.resolve(null)),
      findMany: vi.fn(() => Promise.resolve([])),
      create: vi.fn(({ data }: any) => Promise.resolve(data)),
      upsert: vi.fn(({ create }: any) => Promise.resolve(create)),
      update: vi.fn(({ data }: any) => Promise.resolve(data)),
      delete: vi.fn(() => Promise.resolve({})),
      count: vi.fn(() => Promise.resolve(0)),
    },
  };
  // Every other model better-auth may touch resolves to "nothing here".
  for (const model of ['user', 'session', 'account', 'verification', 'oauthConsent']) {
    client[model] = {
      findFirst: vi.fn(() => Promise.resolve(null)),
      findMany: vi.fn(() => Promise.resolve([])),
      create: vi.fn(({ data }: any) => Promise.resolve(data)),
      update: vi.fn(({ data }: any) => Promise.resolve(data)),
      delete: vi.fn(() => Promise.resolve({})),
      deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
      count: vi.fn(() => Promise.resolve(0)),
    };
  }
  return { rows, created, client };
});

vi.mock('@classmoji/database', () => ({ default: () => mocks.client }));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: { findById: vi.fn(), findByLogin: vi.fn() },
    classroom: { findBySlug: vi.fn(), getClassroomForUI: (c: unknown) => c },
    classroomMembership: { findByClassroomAndUser: vi.fn() },
    githubUserToken: { getGitHubTokenForUser: vi.fn(async () => null) },
    subscription: { getProStateForClassroomId: vi.fn() },
  },
}));

const { auth } = await import('../server.ts');
const { ASK_MOJI_CLIENT_ID } = await import('../mcpToken.ts');

const BASE = 'http://localhost:3000/api/auth';

function tokenRequest(body: Record<string, string>, extraHeaders: Record<string, string> = {}) {
  return new Request(`${BASE}/mcp/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders },
    body: new URLSearchParams(body).toString(),
  });
}

beforeEach(() => {
  mocks.rows.length = 0;
  mocks.created.length = 0;
});

describe('the Ask Moji client cannot use the token endpoint (refresh grant closed)', () => {
  // MUTATION: delete the hooks.before block in server.ts → this passes with 200
  // and a fresh 7-day refresh_token, i.e. the escalation is back.
  it('REFUSES a refresh grant naming the Ask Moji client', async () => {
    // A live refresh token for the Ask Moji client — the worst case, where the
    // already-expired-refresh defence in mintMcpAccessToken has been undone.
    mocks.rows.push({
      id: 'tok-live',
      accessToken: 'askmoji_leaked',
      refreshToken: 'askmoji_leaked_refresh',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 604_800_000),
      clientId: ASK_MOJI_CLIENT_ID,
      userId: 'user-1',
      scopes: 'read',
    });

    const res = await auth.handler(
      tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: 'askmoji_leaked_refresh',
        client_id: ASK_MOJI_CLIENT_ID,
      })
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/does not use the token endpoint/i);
    // Nothing was minted.
    expect(mocks.created).toHaveLength(0);
  });

  it('REFUSES it when the client id arrives in a Basic authorization header instead', async () => {
    const basic = Buffer.from(`${ASK_MOJI_CLIENT_ID}:whatever`).toString('base64');

    const res = await auth.handler(
      tokenRequest(
        { grant_type: 'refresh_token', refresh_token: 'askmoji_leaked_refresh' },
        { authorization: `Basic ${basic}` }
      )
    );

    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).toMatch(/does not use the token endpoint/i);
  });

  it('REFUSES an authorization_code grant for the client too — it uses no grant at all', async () => {
    const res = await auth.handler(
      tokenRequest({
        grant_type: 'authorization_code',
        code: 'anything',
        client_id: ASK_MOJI_CLIENT_ID,
      })
    );

    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).toMatch(/does not use the token endpoint/i);
  });

  it('REFUSES a JSON-bodied request just as it refuses a form-encoded one', async () => {
    const res = await auth.handler(
      new Request(`${BASE}/mcp/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: 'x',
          client_id: ASK_MOJI_CLIENT_ID,
        }),
      })
    );

    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).toMatch(/does not use the token endpoint/i);
  });

  // The `typeof clientId === 'string'` bypass (defence-in-depth review finding).
  //
  // better-auth does not type-check the presented client id, it coerces it:
  // `token.clientId !== client_id?.toString()` (mcp/index.mjs:278). A JSON body
  // reaches the endpoint as parsed JSON, so a ONE-ELEMENT ARRAY stringifies to
  // the bare client id and matches the stored row — while a string-only check in
  // our hook sees a non-string, returns null, and waves it through.
  //
  // The seeded row here carries a LIVE refresh token on purpose: the
  // already-expired-refresh layer in mintMcpAccessToken is switched off, so the
  // only thing that can produce a 401 is the hook itself. If the hook lets this
  // through, better-auth mints and the assertions below fail on all three counts.
  //
  // MUTATION: restore `if (typeof clientId === 'string' …)` in
  // tokenRequestClientId → 200, a fresh 7-day refresh_token, mocks.created === 1.
  it('REFUSES an ARRAY-valued client_id, which better-auth would stringify into a match', async () => {
    mocks.rows.push({
      id: 'tok-live',
      accessToken: 'askmoji_leaked',
      refreshToken: 'askmoji_leaked_refresh',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      // NOT expired — the hook is the only defence left standing.
      refreshTokenExpiresAt: new Date(Date.now() + 604_800_000),
      clientId: ASK_MOJI_CLIENT_ID,
      userId: 'user-1',
      scopes: 'read',
    });

    const res = await auth.handler(
      new Request(`${BASE}/mcp/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: 'askmoji_leaked_refresh',
          client_id: [ASK_MOJI_CLIENT_ID],
        }),
      })
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/does not use the token endpoint/i);
    expect(JSON.stringify(body)).toMatch(/invalid_client/);
    // Nothing was minted — the refusal happened before better-auth's grant ran.
    expect(mocks.created).toHaveLength(0);
  });

  // The same coercion, one step further from a string: better-auth would compare
  // against `String(…)` of whatever arrived, so a nested array flattens too.
  it('REFUSES a nested-array client_id for the same reason', async () => {
    mocks.rows.push({
      id: 'tok-live-2',
      accessToken: 'askmoji_leaked2',
      refreshToken: 'askmoji_leaked_refresh2',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 604_800_000),
      clientId: ASK_MOJI_CLIENT_ID,
      userId: 'user-1',
      scopes: 'read',
    });

    const res = await auth.handler(
      new Request(`${BASE}/mcp/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: 'askmoji_leaked_refresh2',
          client_id: [[ASK_MOJI_CLIENT_ID]],
        }),
      })
    );

    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).toMatch(/does not use the token endpoint/i);
    expect(mocks.created).toHaveLength(0);
  });

  // A FormData body reaches the endpoint only through an in-process
  // `auth.api.mcpToken({ body })` call, but better-auth flattens it with
  // `Object.fromEntries(body.entries())` — LAST value wins — while
  // `FormData.get()` returns the FIRST. Reading it the other way round would let
  // a repeated key split the hook's view from the grant's.
  //
  // MUTATION: change the FormData loop back to `body.get('client_id')` → the
  // hook reads 'innocent-client', returns early, and this throws nothing.
  it('REFUSES a repeated FormData client_id whose LAST value names Ask Moji', async () => {
    const form = new FormData();
    form.append('grant_type', 'refresh_token');
    form.append('refresh_token', 'askmoji_leaked_refresh');
    form.append('client_id', 'innocent-client');
    form.append('client_id', ASK_MOJI_CLIENT_ID);

    // In-process, so the refusal arrives as a thrown APIError rather than a
    // Response. Its payload is on `.body` (better-call puts the JSON body there;
    // `.message` is empty because this APIError carries no `message` key).
    const err = await auth.api
      .mcpOAuthToken({
        body: form as unknown as Record<string, unknown>,
        headers: new Headers(),
      })
      .then(
        () => null,
        (e: unknown) => e as { status?: string; body?: Record<string, string> }
      );

    expect(err).not.toBeNull();
    expect(err?.status).toBe('UNAUTHORIZED');
    expect(err?.body?.error).toBe('invalid_client');
    expect(err?.body?.error_description).toMatch(/does not use the token endpoint/i);
    expect(mocks.created).toHaveLength(0);
  });

  // NEGATIVE CONTROL: an array-valued client id for ANOTHER client must still be
  // left alone — the normalization must not turn the hook into a blanket refusal.
  it('leaves an array-valued client_id for another client working', async () => {
    mocks.rows.push({
      id: 'tok-other',
      accessToken: 'other_access',
      refreshToken: 'other_refresh',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 604_800_000),
      clientId: OTHER_CLIENT_ID,
      userId: 'user-2',
      scopes: 'read write',
    });

    const res = await auth.handler(
      new Request(`${BASE}/mcp/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: 'other_refresh',
          client_id: [OTHER_CLIENT_ID],
        }),
      })
    );

    expect(res.status).toBe(200);
    expect(mocks.created).toHaveLength(1);
  });

  // NEGATIVE CONTROL: the refusal is client-specific. Break this and we have
  // not hardened Ask Moji, we have broken every other MCP client.
  it('leaves another client’s refresh grant working', async () => {
    mocks.rows.push({
      id: 'tok-other',
      accessToken: 'other_access',
      refreshToken: 'other_refresh',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 604_800_000),
      clientId: OTHER_CLIENT_ID,
      userId: 'user-2',
      scopes: 'read write',
    });

    const res = await auth.handler(
      tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: 'other_refresh',
        client_id: OTHER_CLIENT_ID,
      })
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(mocks.created).toHaveLength(1);
  });
});

describe('the raw /mcp/get-session endpoint is not reachable over HTTP', () => {
  // MUTATION: remove '/mcp/get-session' from disabledPaths → this returns 200
  // with the whole token row, refresh token included.
  it('404s a GET with a valid bearer token', async () => {
    mocks.rows.push({
      id: 'tok-live',
      accessToken: 'askmoji_leaked',
      refreshToken: 'askmoji_leaked_refresh',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 604_800_000),
      clientId: ASK_MOJI_CLIENT_ID,
      userId: 'user-1',
      scopes: 'read',
    });

    const res = await auth.handler(
      new Request(`${BASE}/mcp/get-session`, {
        headers: { authorization: 'Bearer askmoji_leaked' },
      })
    );

    expect(res.status).toBe(404);
    expect(await res.text()).not.toMatch(/askmoji_leaked_refresh/);
  });

  // The MCP resource server calls getMcpSession IN-PROCESS
  // (apps/mcp/src/auth/resolveViewer.ts:42), which never touches the HTTP
  // router. Disabling the path must not touch that — otherwise every MCP
  // request 401s.
  it('leaves the in-process auth.api.getMcpSession working', async () => {
    mocks.rows.push({
      id: 'tok-live',
      accessToken: 'askmoji_ok',
      refreshToken: 'askmoji_ok_refresh',
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenExpiresAt: new Date(Date.now() - 1_000),
      clientId: ASK_MOJI_CLIENT_ID,
      userId: 'user-1',
      scopes: 'read',
    });

    const session = (await auth.api.getMcpSession({
      headers: new Headers({ authorization: 'Bearer askmoji_ok' }),
    })) as Record<string, unknown> | null;

    expect(session).not.toBeNull();
    expect(session?.userId).toBe('user-1');
    expect(session?.scopes).toBe('read');
  });
});

describe('the hook does not get in the way of anything else', () => {
  it('leaves OAuth discovery reachable', async () => {
    const res = await auth.handler(
      new Request(`${BASE}/.well-known/oauth-authorization-server`, { method: 'GET' })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.token_endpoint).toMatch(/\/mcp\/token$/);
  });
});
