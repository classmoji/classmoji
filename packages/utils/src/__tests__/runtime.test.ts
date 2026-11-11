import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientIpHeader, isWorkerd } from '../runtime.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isWorkerd', () => {
  it('is false on Node (navigator.userAgent is Node.js/<v>)', () => {
    expect(isWorkerd()).toBe(false);
  });

  it('is false with no navigator at all', () => {
    vi.stubGlobal('navigator', undefined);
    expect(isWorkerd()).toBe(false);
  });

  it('is true only for the exact workerd user agent', () => {
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
    expect(isWorkerd()).toBe(true);
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Cloudflare-Workers' });
    expect(isWorkerd()).toBe(false);
  });
});

describe('clientIpHeader', () => {
  it('trusts only Fly-Client-IP off Workers', () => {
    expect(clientIpHeader()).toBe('fly-client-ip');
  });

  it('trusts CF-Connecting-IP on Workers', () => {
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
    expect(clientIpHeader()).toBe('cf-connecting-ip');
  });
});
