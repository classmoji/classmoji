/**
 * The 503 path on REAL code: the real better-auth instance
 * (@classmoji/auth/server) and Prisma client, pointed at a database that
 * cannot be reached. A JWT's key read (`auth.api.getJwks()` → the jwt plugin
 * → @better-auth/prisma-adapter → Prisma) and an internal token's lookup both
 * fail with the client's connection error, which tokenStoreErrors.ts must
 * recognise: POST /mcp answers 503 with Retry-After and no sign-in challenge.
 * (Better-auth 1.7.18 surfaces the PrismaClientInitializationError
 * unwrapped; a wrapper that hid it would turn these into 401s and fail here.)
 *
 * Only the MCP server's own tool and resource registries stand in; they are
 * not reached.
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import Fastify from 'fastify';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';

// Before anything builds the Prisma client or the auth instance.
process.env.DATABASE_URL = 'postgresql://nobody:nothing@127.0.0.1:1/unreachable';
process.env.BETTER_AUTH_SECRET = 'jwks-store-test-secret-at-least-32-chars';

vi.mock('../../mcp/registry.ts', () => ({
  buildMcpServer: vi.fn(() => new McpServer({ name: 'test', version: '0' })),
}));
vi.mock('../../resources/index.ts', () => ({ registerAllResources: vi.fn() }));

const { resolveViewer } = await import('../resolveViewer.ts');
const { default: mcpRoutes } = await import('../../routes/mcp.ts');
const { TokenStoreUnavailableError } = await import('../../mcp/errors.ts');
const { AUTH_ISSUER, MCP_RESOURCE } = await import('@classmoji/auth/mcp-resource');

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A well-formed access token for this server's audience, from a key the server has never seen. */
function aJwt(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  const iat = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'EdDSA', typ: 'at+jwt', kid: 'some-key' })}.${b64({
    sub: 'user-1',
    azp: 'client-1',
    aud: MCP_RESOURCE,
    iss: AUTH_ISSUER,
    iat,
    exp: iat + 3600,
  })}`;
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
}

const AN_INTERNAL_TOKEN = 'askmoji_this-token-cannot-be-looked-up';

describe('the token store is unreachable', () => {
  it.each([
    ['a JWT (the key read)', aJwt],
    ['an internal token (its lookup)', () => AN_INTERNAL_TOKEN],
  ])(
    'resolveViewer: %s is a TokenStoreUnavailableError',
    async (_label, token) => {
      const failure = await resolveViewer(
        new Headers({ authorization: `Bearer ${token()}` })
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TokenStoreUnavailableError);
      expect(((failure as Error).cause as Error).name).toBe('PrismaClientInitializationError');
    },
    30_000
  );

  it.each([
    ['a JWT', aJwt],
    ['an internal token', () => AN_INTERNAL_TOKEN],
  ])(
    'POST /mcp with %s: 503, Retry-After, no challenge',
    async (_label, token) => {
      const fastify = Fastify();
      await fastify.register(mcpRoutes);
      const res = await fastify.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token()}`,
        },
        payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('30');
      expect(res.headers['www-authenticate']).toBeUndefined();
      await fastify.close();
    },
    30_000
  );
});
