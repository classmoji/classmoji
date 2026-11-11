/**
 * Whose IP a request is, by platform. Fly must trust only Fly-Client-IP: a
 * client can send CF-Connecting-IP to a grey-cloud Fly host. Workers trusts
 * only CF-Connecting-IP. Covers ../clientIp.ts (Gitlab instance setup) and
 * server.ts's `ipAddressHeaders` (better-auth rate limits and sessions).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientIp } from '../clientIp.ts';

const BOTH = () =>
  new Headers({
    'fly-client-ip': ' 203.0.113.7 ',
    'cf-connecting-ip': '198.51.100.9',
    'x-forwarded-for': '192.0.2.1, 10.0.0.1',
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('clientIp on Node (Fly)', () => {
  it('reads Fly-Client-IP and ignores CF-Connecting-IP', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(clientIp(BOTH())).toBe('203.0.113.7');
  });

  it('never trusts a client-sent CF-Connecting-IP in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(clientIp(new Headers({ 'cf-connecting-ip': '198.51.100.9' }))).toBeNull();
  });

  it('falls back to X-Forwarded-For only outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(clientIp(new Headers({ 'x-forwarded-for': '192.0.2.1, 10.0.0.1' }))).toBe('192.0.2.1');
    vi.stubEnv('NODE_ENV', 'production');
    expect(clientIp(new Headers({ 'x-forwarded-for': '192.0.2.1' }))).toBeNull();
  });

  it('is null without headers', () => {
    expect(clientIp(undefined)).toBeNull();
  });
});

describe('clientIp on Workers', () => {
  it('reads CF-Connecting-IP and ignores Fly-Client-IP', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
    expect(clientIp(BOTH())).toBe('198.51.100.9');
    expect(clientIp(new Headers({ 'fly-client-ip': '203.0.113.7' }))).toBeNull();
  });
});
