/**
 * Unit tests for MCP_PUBLIC_URL boot-time validation.
 *
 * The resource identifier advertised in RFC 9728 metadata and WWW-Authenticate
 * challenges must be an absolute http(s) origin; a schemeless value would
 * silently produce broken metadata. config.ts validates at module eval, so
 * each case re-imports the module with a fresh env under vi.resetModules().
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL = process.env.MCP_PUBLIC_URL;

async function loadConfig() {
  vi.resetModules();
  return import('../config.ts');
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MCP_PUBLIC_URL;
  else process.env.MCP_PUBLIC_URL = ORIGINAL;
  vi.resetModules();
});

describe('MCP_PUBLIC_URL validation', () => {
  it('throws at boot on a schemeless value', async () => {
    process.env.MCP_PUBLIC_URL = 'mcp.example.com';
    await expect(loadConfig()).rejects.toThrow(/must be an absolute http/);
  });

  it('throws at boot on a non-http(s) scheme', async () => {
    process.env.MCP_PUBLIC_URL = 'ftp://mcp.example.com';
    await expect(loadConfig()).rejects.toThrow(/must use http/);
  });

  it('accepts a valid https URL and strips the trailing slash', async () => {
    process.env.MCP_PUBLIC_URL = 'https://mcp.example.com/';
    const cfg = await loadConfig();
    expect(cfg.MCP_PUBLIC_URL).toBe('https://mcp.example.com');
  });

  it('falls back to the localhost default when unset', async () => {
    delete process.env.MCP_PUBLIC_URL;
    const cfg = await loadConfig();
    expect(cfg.MCP_PUBLIC_URL).toMatch(/^http:\/\/localhost:\d+$/);
  });
});
