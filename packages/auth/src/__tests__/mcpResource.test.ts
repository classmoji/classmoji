/**
 * The MCP resource identifier and the issuer (../mcpResource.ts): how the
 * environment is read, what fails at boot, and which spellings of the
 * resource a request may send.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalMcpResourceParam,
  namesMcpResource,
  requireOrigin,
  resolveAuthIssuer,
  resolveMcpPublicOrigin,
} from '../mcpResource.ts';

const RESOURCE = 'https://mcp.example.org/mcp';

describe('resolveMcpPublicOrigin', () => {
  it('reads the origin, with or without a trailing slash', () => {
    for (const value of [
      'https://mcp.example.org',
      'https://mcp.example.org/',
      'https://mcp.example.org//',
      'HTTPS://MCP.Example.org:443/',
    ]) {
      expect(resolveMcpPublicOrigin(value, { production: true })).toBe('https://mcp.example.org');
    }
    expect(resolveMcpPublicOrigin('http://localhost:8110/', { production: false })).toBe(
      'http://localhost:8110'
    );
  });

  it('defaults to the local MCP port outside production', () => {
    expect(resolveMcpPublicOrigin(undefined, { production: false })).toBe('http://localhost:8100');
    expect(resolveMcpPublicOrigin('', { production: false, port: '8130' })).toBe(
      'http://localhost:8130'
    );
  });

  it('is required in production', () => {
    expect(() => resolveMcpPublicOrigin(undefined, { production: true })).toThrow(
      /MCP_PUBLIC_URL is required in production/
    );
  });

  it.each([
    ['no scheme', 'mcp.example.org'],
    ['a port without a scheme', 'localhost:8100'],
    ['another scheme', 'ftp://mcp.example.org'],
    ['a path', 'https://mcp.example.org/mcp'],
    ['a query', 'https://mcp.example.org/?a=1'],
    ['an empty query', 'https://mcp.example.org?'],
    ['a fragment', 'https://mcp.example.org/#x'],
    ['credentials', 'https://user:pass@mcp.example.org'],
    ['garbage', 'not a url'],
  ])('refuses a value with %s', (_label, value) => {
    expect(() => resolveMcpPublicOrigin(value, { production: false })).toThrow(/MCP_PUBLIC_URL/);
  });
});

describe('resolveAuthIssuer', () => {
  it('is the origin of WEBAPP_URL', () => {
    expect(resolveAuthIssuer('https://classmoji.io', { production: true })).toBe(
      'https://classmoji.io'
    );
    expect(resolveAuthIssuer('https://classmoji.io/', { production: true })).toBe(
      'https://classmoji.io'
    );
    expect(resolveAuthIssuer('http://localhost:3010', { production: false })).toBe(
      'http://localhost:3010'
    );
  });

  it('defaults to the local webapp outside production and is required in production', () => {
    expect(resolveAuthIssuer(undefined, { production: false })).toBe('http://localhost:3000');
    expect(() => resolveAuthIssuer(undefined, { production: true })).toThrow(
      /WEBAPP_URL is required in production/
    );
  });

  it('refuses a malformed value', () => {
    expect(() => resolveAuthIssuer('classmoji.io', { production: true })).toThrow(/WEBAPP_URL/);
    expect(() => resolveAuthIssuer('ftp://classmoji.io', { production: true })).toThrow(
      /WEBAPP_URL/
    );
  });
});

describe('requireOrigin', () => {
  it('drops a default port and lowercases the host', () => {
    expect(requireOrigin('https://Example.ORG:443', 'X')).toBe('https://example.org');
    expect(requireOrigin('http://example.org:80/', 'X')).toBe('http://example.org');
  });
});

describe('namesMcpResource', () => {
  it.each([
    'https://mcp.example.org/mcp',
    'https://mcp.example.org/mcp/',
    'https://mcp.example.org',
    'https://mcp.example.org/',
    'HTTPS://MCP.EXAMPLE.ORG/mcp',
    'https://mcp.example.org:443/mcp',
  ])('accepts %s', value => {
    expect(namesMcpResource(value, RESOURCE)).toBe(true);
  });

  it.each([
    'https://mcp.example.org/other',
    'https://mcp.example.org/MCP',
    'https://mcp.example.org/mcp/x',
    'http://mcp.example.org/mcp',
    'https://mcp.example.org:8443/mcp',
    'https://evil.example.org/mcp',
    'https://mcp.example.org.evil.example/mcp',
    'https://mcp.example.org/mcp?x=1',
    'https://mcp.example.org/mcp#x',
    'https://user@mcp.example.org/mcp',
    'mcp.example.org/mcp',
    '',
  ])('refuses %s', value => {
    expect(namesMcpResource(value, RESOURCE)).toBe(false);
  });
});

describe('canonicalMcpResourceParam', () => {
  it('fills in the resource when none is sent', () => {
    for (const value of [undefined, null, '', [], ['']]) {
      expect(canonicalMcpResourceParam(value, RESOURCE)).toBe(RESOURCE);
    }
  });

  it('maps the origin, the origin with a slash and the resource with a slash to the resource', () => {
    for (const value of [
      'https://mcp.example.org',
      'https://mcp.example.org/',
      'https://mcp.example.org/mcp',
      'https://mcp.example.org/mcp/',
    ]) {
      expect(canonicalMcpResourceParam(value, RESOURCE)).toBe(RESOURCE);
    }
  });

  it('leaves any other value as sent, for the authorization server to refuse', () => {
    expect(canonicalMcpResourceParam('https://evil.example.org/mcp', RESOURCE)).toBe(
      'https://evil.example.org/mcp'
    );
    expect(canonicalMcpResourceParam('not a url', RESOURCE)).toBe('not a url');
    expect(canonicalMcpResourceParam(42, RESOURCE)).toBe(42);
  });

  it('maps a list value by value and collapses duplicates', () => {
    expect(
      canonicalMcpResourceParam(
        ['https://mcp.example.org/', 'https://mcp.example.org/mcp'],
        RESOURCE
      )
    ).toBe(RESOURCE);
    expect(
      canonicalMcpResourceParam(['https://mcp.example.org', 'https://other.example.org'], RESOURCE)
    ).toEqual([RESOURCE, 'https://other.example.org']);
  });
});

describe('the module values', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.resetModules();
  });

  it('are built from MCP_PUBLIC_URL and WEBAPP_URL', async () => {
    process.env.MCP_PUBLIC_URL = 'https://mcp.example.org/';
    process.env.WEBAPP_URL = 'https://app.example.org/';
    vi.resetModules();
    const mod = await import('../mcpResource.ts');
    expect(mod.MCP_PUBLIC_ORIGIN).toBe('https://mcp.example.org');
    expect(mod.MCP_RESOURCE).toBe('https://mcp.example.org/mcp');
    expect(mod.AUTH_ISSUER).toBe('https://app.example.org');
  });

  it('fail at import on a malformed MCP_PUBLIC_URL', async () => {
    process.env.MCP_PUBLIC_URL = 'mcp.example.org';
    vi.resetModules();
    await expect(import('../mcpResource.ts')).rejects.toThrow(/MCP_PUBLIC_URL/);
  });

  it('fail at import in production without MCP_PUBLIC_URL', async () => {
    delete process.env.MCP_PUBLIC_URL;
    process.env.WEBAPP_URL = 'https://app.example.org';
    process.env.NODE_ENV = 'production';
    vi.resetModules();
    await expect(import('../mcpResource.ts')).rejects.toThrow(/MCP_PUBLIC_URL is required/);
  });
});
