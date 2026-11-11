/**
 * POST /mcp with the REAL resolveViewer: both kinds of token go through the
 * route's `onRequest` hook, before the body is read, and the Ask Moji headers
 * follow the kind the token really is.
 *
 *   - A JWT access token is verified (signature, claims) and its client, user
 *     and consent read in `onRequest`: a refused one is answered from the
 *     headers alone, even while the body has not arrived (P17).
 *   - The role ceiling and View as headers are read only for an internal
 *     token of the Ask Moji client. A JWT, even one whose claims name the Ask
 *     Moji client, never gets them: it is refused outright (P19).
 *
 * Stood in: the key read (`auth.api.getJwks`, with the real verifier), Prisma
 * (the DMMF-validating stub), and the tool/resource registries.
 */

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { connect, type AddressInfo, type Socket } from 'node:net';
import Fastify from 'fastify';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_BODY_LIMIT_BYTES } from '../../bodyLimit.ts';

const mocks = vi.hoisted(() => ({
  getJwks: vi.fn(),
  viewers: [] as Array<Record<string, unknown>>,
}));

vi.mock('@classmoji/auth/server', async () => ({
  auth: { api: { getJwks: (...args: unknown[]) => mocks.getJwks(...args) } },
  verifyJwsAccessToken: (await import('better-auth/oauth2')).verifyJwsAccessToken,
}));
vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);
vi.mock('../../mcp/registry.ts', () => ({
  buildMcpServer: vi.fn((viewer: Record<string, unknown>) => {
    mocks.viewers.push({ ...viewer });
    return new McpServer({ name: 'test', version: '0' });
  }),
}));
vi.mock('../../resources/index.ts', () => ({ registerAllResources: vi.fn() }));

const {
  default: mcpRoutes,
  IMPERSONATED_BY_HEADER,
  ROLE_CEILING_HEADER,
} = await import('../mcp.ts');
const { prismaCalls, resetPrismaStub, setPrismaRows } =
  await import('../../__tests__/prismaSchemaStub.ts');
const { AUTH_ISSUER, MCP_RESOURCE } = await import('@classmoji/auth/mcp-resource');
const { ASK_MOJI_CLIENT_ID } = await import('@classmoji/auth/mcp-token');

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const SERVER_KEY = (() => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { kid: 'k1', privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid: 'k1' } };
})();
const STRANGER_KEY = generateKeyPairSync('ed25519').privateKey;

function jwt(claims: Record<string, unknown> = {}, privateKey = SERVER_KEY.privateKey) {
  const iat = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'EdDSA', typ: 'at+jwt', kid: 'k1' })}.${b64({
    sub: 'user-1',
    azp: 'client-1',
    aud: MCP_RESOURCE,
    iss: AUTH_ISSUER,
    scope: 'read write',
    iat,
    exp: iat + 3600,
    ...claims,
  })}`;
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
}

const INTERNAL = 'askmoji_route-test-token';
const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest('base64url');

function rows({ consent = true } = {}) {
  setPrismaRows({
    oauthClient: { findUnique: { disabled: false } },
    user: { findUnique: { banned: false, ban_expires_at: null } },
    oauthConsent: { findFirst: consent ? { createdAt: new Date(Date.now() - 60_000) } : null },
    mcpInternalToken: {
      findUnique: (a: { where: { token_hash: string } }) =>
        a.where.token_hash === sha256(INTERNAL)
          ? {
              client_id: ASK_MOJI_CLIENT_ID,
              user_id: 'user-1',
              scopes: ['read'],
              expires_at: new Date(Date.now() + 600_000),
              impersonation_session_id: 'sess-1',
              impersonated_by: 'admin-1',
              user: { banned: false, ban_expires_at: null },
            }
          : null,
    },
    session: {
      findUnique: {
        user_id: 'user-1',
        impersonatedBy: 'admin-1',
        expires_at: new Date(Date.now() + 600_000),
      },
    },
  });
}

async function app() {
  const fastify = Fastify({ bodyLimit: MCP_BODY_LIMIT_BYTES });
  const preParsing = vi.fn(async () => {});
  fastify.addHook('preParsing', preParsing);
  await fastify.register(mcpRoutes);
  return { fastify, preParsing };
}

const post = (
  fastify: Awaited<ReturnType<typeof app>>['fastify'],
  token: string,
  extra: Record<string, string> = {},
  payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
) =>
  fastify.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      ...extra,
    },
    payload,
  });

beforeEach(() => {
  resetPrismaStub();
  rows();
  mocks.viewers.length = 0;
  mocks.getJwks.mockReset();
  mocks.getJwks.mockResolvedValue({ keys: [SERVER_KEY.jwk] });
});

describe('a JWT access token at POST /mcp', () => {
  it('is served once verified and live, as a jwt viewer', async () => {
    const { fastify, preParsing } = await app();
    const res = await post(fastify, jwt());
    expect(res.statusCode).toBe(200);
    expect(preParsing).toHaveBeenCalledTimes(1);
    expect(mocks.viewers.at(-1)).toMatchObject({
      tokenKind: 'jwt',
      userId: 'user-1',
      clientId: 'client-1',
    });
    await fastify.close();
  });

  it('a forged one is refused with the challenge, its body never parsed, nothing read', async () => {
    const { fastify, preParsing } = await app();
    const res = await post(
      fastify,
      jwt({}, STRANGER_KEY),
      {},
      '['.repeat(MCP_BODY_LIMIT_BYTES + 1)
    );
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/scope="read write"$/);
    expect(preParsing).not.toHaveBeenCalled();
    expect(prismaCalls).toHaveLength(0);
    await fastify.close();
  });

  it('one for a disconnected app is refused before its body is parsed', async () => {
    rows({ consent: false });
    const { fastify, preParsing } = await app();
    const res = await post(fastify, jwt());
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Unauthorized: The app is no longer connected');
    expect(preParsing).not.toHaveBeenCalled();
    await fastify.close();
  });

  it('never gets the role ceiling or a View as admin from headers', async () => {
    const { fastify } = await app();
    const res = await post(fastify, jwt(), {
      [ROLE_CEILING_HEADER]: 'STUDENT',
      [IMPERSONATED_BY_HEADER]: 'admin-1',
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.viewers.at(-1)).toMatchObject({ roleCeiling: null, impersonatedBy: null });
    await fastify.close();
  });

  it('naming the Ask Moji client is refused outright', async () => {
    const { fastify } = await app();
    const res = await post(fastify, jwt({ azp: ASK_MOJI_CLIENT_ID }), {
      [ROLE_CEILING_HEADER]: 'STUDENT',
    });
    expect(res.statusCode).toBe(401);
    expect(mocks.viewers).toHaveLength(0);
    await fastify.close();
  });

  describe('over a real socket', () => {
    let socket: Socket | undefined;
    let close: (() => Promise<void>) | undefined;
    afterEach(async () => {
      socket?.destroy();
      await close?.();
      socket = undefined;
      close = undefined;
    });

    it('a forged one is answered 401 before the client has sent the body', async () => {
      const { fastify, preParsing } = await app();
      await fastify.listen({ port: 0, host: '127.0.0.1' });
      close = () => fastify.close();
      const { port } = fastify.server.address() as AddressInfo;
      const token = jwt({}, STRANGER_KEY);

      const response = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no response before the body')), 5_000);
        let received = '';
        const client = connect(port, '127.0.0.1', () => {
          client.write(
            'POST /mcp HTTP/1.1\r\n' +
              `Host: 127.0.0.1:${port}\r\n` +
              `Authorization: Bearer ${token}\r\n` +
              'Content-Type: application/json\r\n' +
              `Content-Length: ${MCP_BODY_LIMIT_BYTES}\r\n` +
              '\r\n' +
              '['.repeat(1024)
          );
        });
        socket = client;
        client.on('data', chunk => {
          received += chunk.toString('utf8');
          if (received.includes('\r\n\r\n')) {
            clearTimeout(timer);
            resolve(received);
          }
        });
        client.on('error', reject);
      });

      expect(response.startsWith('HTTP/1.1 401')).toBe(true);
      expect(preParsing).not.toHaveBeenCalled();
    });
  });
});

describe('an internal Ask Moji token at POST /mcp', () => {
  it('gets its ceiling, and the View as admin its row names', async () => {
    const { fastify } = await app();
    const res = await post(fastify, INTERNAL, {
      [ROLE_CEILING_HEADER]: 'STUDENT',
      [IMPERSONATED_BY_HEADER]: 'admin-1',
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.viewers.at(-1)).toMatchObject({
      tokenKind: 'internal',
      clientId: ASK_MOJI_CLIENT_ID,
      roleCeiling: 'STUDENT',
      impersonatedBy: 'admin-1',
    });
    await fastify.close();
  });

  it('is refused when the header names another admin than its row', async () => {
    const { fastify } = await app();
    const res = await post(fastify, INTERNAL, { [IMPERSONATED_BY_HEADER]: 'admin-2' });
    expect(res.statusCode).toBe(400);
    expect(mocks.viewers).toHaveLength(0);
    await fastify.close();
  });

  it('that is not in the table is refused with the challenge (401, not 503)', async () => {
    const { fastify, preParsing } = await app();
    const res = await post(fastify, 'askmoji_not-a-token-we-minted');
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBeDefined();
    expect(res.headers['retry-after']).toBeUndefined();
    expect(preParsing).not.toHaveBeenCalled();
    await fastify.close();
  });
});
