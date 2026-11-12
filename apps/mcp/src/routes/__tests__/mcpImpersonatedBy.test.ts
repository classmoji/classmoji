/**
 * The View as admin on an Ask Moji request (`impersonatedBy`, written as
 * `impersonated_by` into every audit row, see readAudit.test.ts).
 *
 * It comes from the TOKEN: the internal token's row names the View as session
 * and its admin (auth/internalToken.ts checks the session still lives). The
 * Ask Moji task also sends `X-Classmoji-Impersonated-By`; from Ask Moji (an
 * internal token of the Ask Moji client), a header that is not a plain id, or
 * that names someone other than the token's admin (or anyone, for a token
 * minted outside View as), is refused with a 400 before any server is built.
 * Every other request's header is ignored, whatever its value, and it gets no
 * admin.
 */

import Fastify from 'fastify';
import { McpServer } from '@modelcontextprotocol/server';
import { ASK_MOJI_CLIENT_ID, DEV_MINT_CLIENT_ID } from '@classmoji/auth/mcp-token';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Viewer } from '../../auth/resolveViewer.ts';

type TokenOf = Pick<Viewer, 'tokenKind' | 'clientId' | 'impersonatedBy'>;

const mocks = vi.hoisted(() => ({
  token: {} as {
    tokenKind?: 'internal' | 'jwt';
    clientId: string | null;
    impersonatedBy?: string | null;
  },
  viewers: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../auth/resolveViewer.ts', () => ({
  resolveViewer: vi.fn(async () => ({
    userId: 'u1',
    ...mocks.token,
    scopes: new Set(['read']),
  })),
}));
vi.mock('../../mcp/registry.ts', () => ({
  buildMcpServer: vi.fn((viewer: Record<string, unknown>) => {
    mocks.viewers.push(viewer);
    return new McpServer({ name: 'test', version: '0' });
  }),
}));
vi.mock('../../resources/index.ts', () => ({ registerAllResources: vi.fn() }));

const {
  default: mcpRoutes,
  impersonatedByFrom,
  IMPERSONATED_BY_HEADER,
} = await import('../mcp.ts');

/** Ask Moji's own turn, and one minted under admin-1's View as session. */
const ASK_MOJI: TokenOf = {
  tokenKind: 'internal',
  clientId: ASK_MOJI_CLIENT_ID,
  impersonatedBy: null,
};
const ASK_MOJI_VIEW_AS: TokenOf = { ...ASK_MOJI, impersonatedBy: 'admin-1' };
/** Requests that are not Ask Moji's, some of them claiming an admin. */
const OTHERS: Array<[string, TokenOf]> = [
  ['an OAuth client', { tokenKind: 'jwt', clientId: 'claude-ai-connector', impersonatedBy: null }],
  ['a JWT naming the Ask Moji client', { tokenKind: 'jwt', clientId: ASK_MOJI_CLIENT_ID }],
  ['the dev mint', { tokenKind: 'internal', clientId: DEV_MINT_CLIENT_ID, impersonatedBy: 'x' }],
  ['no token kind', { clientId: ASK_MOJI_CLIENT_ID, impersonatedBy: 'admin-1' }],
];
const BAD_VALUES = ['', 'admin 1', 'a/b', 'a.b', 'a:b', '<script>', 'x'.repeat(65), '%41'];

const headersWith = (value?: string) =>
  new Headers(value === undefined ? {} : { [IMPERSONATED_BY_HEADER]: value });

describe('impersonatedByFrom', () => {
  it('takes the admin from the token, with or without the header', () => {
    expect(impersonatedByFrom(headersWith('admin-1'), ASK_MOJI_VIEW_AS)).toEqual({
      ok: true,
      impersonatedBy: 'admin-1',
    });
    expect(impersonatedByFrom(headersWith(), ASK_MOJI_VIEW_AS)).toEqual({
      ok: true,
      impersonatedBy: 'admin-1',
    });
  });

  it('no header and no admin on the token means no View as', () => {
    expect(impersonatedByFrom(headersWith(), ASK_MOJI)).toEqual({ ok: true, impersonatedBy: null });
  });

  it('refuses a header that names another admin than the token’s', () => {
    const result = impersonatedByFrom(headersWith('admin-2'), ASK_MOJI_VIEW_AS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('does not match the token');
  });

  it('refuses a header naming an admin for a token minted outside View as', () => {
    for (const id of ['admin-1', 'cuid_abc123', 'A', 'x'.repeat(64)]) {
      const result = impersonatedByFrom(headersWith(id), ASK_MOJI);
      expect(result.ok, id).toBe(false);
    }
  });

  it('refuses a value from Ask Moji that is not an id', () => {
    for (const bad of BAD_VALUES) {
      for (const token of [ASK_MOJI, ASK_MOJI_VIEW_AS]) {
        const result = impersonatedByFrom(headersWith(bad), token);
        expect(result.ok, JSON.stringify(bad)).toBe(false);
        if (!result.ok) expect(result.message).toContain('X-Classmoji-Impersonated-By');
      }
    }
  });

  it.each(OTHERS)('ignores the header from %s and gives no admin', (_label, token) => {
    for (const value of ['admin-1', 'a/b', '']) {
      expect(impersonatedByFrom(headersWith(value), token)).toEqual({
        ok: true,
        impersonatedBy: null,
      });
    }
    expect(impersonatedByFrom(headersWith(), token)).toEqual({ ok: true, impersonatedBy: null });
  });
});

describe('POST /mcp with a View as admin', () => {
  async function app() {
    const fastify = Fastify();
    await fastify.register(mcpRoutes);
    return fastify;
  }

  const post = (fastify: Awaited<ReturnType<typeof app>>, actor?: string | string[]) =>
    fastify.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer t',
        ...(actor === undefined ? {} : { [IMPERSONATED_BY_HEADER]: actor }),
      },
      payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });

  beforeEach(() => {
    mocks.viewers.length = 0;
    mocks.token = { ...ASK_MOJI_VIEW_AS };
  });

  it('carries the token’s admin on the viewer', async () => {
    const fastify = await app();
    for (const header of ['admin-1', undefined]) {
      const res = await post(fastify, header);
      expect(res.statusCode).toBe(200);
      expect(mocks.viewers.at(-1)).toMatchObject({ userId: 'u1', impersonatedBy: 'admin-1' });
    }
    await fastify.close();
  });

  it('sets no admin for Ask Moji’s own turn', async () => {
    mocks.token = { ...ASK_MOJI };
    const fastify = await app();
    const res = await post(fastify);
    expect(res.statusCode).toBe(200);
    expect(mocks.viewers.at(-1)?.impersonatedBy).toBeNull();
    await fastify.close();
  });

  it('refuses a header that is not an id, or not the token’s admin, before building a server', async () => {
    const fastify = await app();
    for (const bad of ['a/b', 'admin 1', 'x'.repeat(65), ['admin-1', 'admin-2'], 'admin-2']) {
      const res = await post(fastify, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe(-32600);
      expect(body.error.message).toContain('X-Classmoji-Impersonated-By');
    }
    mocks.token = { ...ASK_MOJI };
    expect((await post(fastify, 'admin-1')).statusCode).toBe(400);
    expect(mocks.viewers).toHaveLength(0);
    await fastify.close();
  });

  it.each(OTHERS)('ignores the header from %s', async (_label, token) => {
    mocks.token = { ...token };
    const fastify = await app();
    for (const value of ['admin-1', 'a/b', undefined]) {
      const res = await post(fastify, value);
      expect(res.statusCode).toBe(200);
      expect(mocks.viewers.at(-1)?.impersonatedBy).toBeNull();
    }
    await fastify.close();
  });
});
