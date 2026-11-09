/**
 * better-auth's `advanced.ipAddress.ipAddressHeaders` (server.ts), read once
 * when the module loads: in production on Node (Fly) it is exactly
 * ['fly-client-ip'], as before Workers support; on Workers ['cf-connecting-ip'];
 * outside production it is unset (better-auth's defaults).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@classmoji/database', async () => {
  const { standInClient } = await import('./support/prismaStandIn.ts');
  const client = standInClient({});
  return { default: () => client };
});
vi.mock('@classmoji/services', () => ({ ClassmojiService: {} }));

process.env.WEBAPP_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-chars!!';

async function loadHeaders() {
  // Required at load in production (mcpResource.ts).
  vi.stubEnv('MCP_PUBLIC_URL', 'https://mcp.example.com');
  vi.resetModules();
  const { auth } = await import('../server.ts');
  return (auth.options.advanced as { ipAddress?: { ipAddressHeaders?: string[] } }).ipAddress
    ?.ipAddressHeaders;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('ipAddressHeaders', () => {
  it("is ['fly-client-ip'] in production on Node", async () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(await loadHeaders()).toEqual(['fly-client-ip']);
  });

  it("is ['cf-connecting-ip'] in production on Workers", async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
    expect(await loadHeaders()).toEqual(['cf-connecting-ip']);
  });

  it('is unset outside production', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(await loadHeaders()).toBeUndefined();
  });
});
