import { describe, expect, it } from 'vitest';
import { checkOrigin, expectedOrigins } from '../originCheck.server';

const req = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { method: 'POST', headers });

describe('checkOrigin (webapp)', () => {
  it('accepts the production shape: http request.url behind the proxy, https Origin = WEBAPP_URL', () => {
    const env = { WEBAPP_URL: 'https://classmoji.io' };
    const r = req('http://classmoji.io/api/ask-moji/cs1/start', { origin: 'https://classmoji.io' });
    expect(checkOrigin(r, env)).toEqual({ ok: true });
  });

  it('accepts development: Origin equals the request origin, WEBAPP_URL unset', () => {
    const r = req('http://localhost:3000/api/ask-moji/cs1/start', {
      origin: 'http://localhost:3000',
    });
    expect(checkOrigin(r, {}).ok).toBe(true);
  });

  it('refuses another origin, a sibling subdomain and Origin: null', () => {
    const env = { WEBAPP_URL: 'https://classmoji.io' };
    for (const origin of ['https://evil.example', 'https://pages.classmoji.io', 'null']) {
      const result = checkOrigin(req('http://classmoji.io/x', { origin }), env);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('origin-mismatch');
    }
  });

  it('never reads X-Forwarded-Host', () => {
    const r = req('http://classmoji.io/x', {
      origin: 'https://evil.example',
      'x-forwarded-host': 'evil.example',
    });
    expect(checkOrigin(r, { WEBAPP_URL: 'https://classmoji.io' }).ok).toBe(false);
    expect([...expectedOrigins(r, { WEBAPP_URL: 'https://classmoji.io' })]).toEqual([
      'https://classmoji.io',
      'http://classmoji.io',
    ]);
  });

  it('without Origin, refuses a cross-site fetch and allows same-site, same-origin, none', () => {
    expect(checkOrigin(req('http://a.test/x', { 'sec-fetch-site': 'cross-site' }), {}).ok).toBe(
      false
    );
    for (const site of ['same-origin', 'same-site', 'none']) {
      expect(checkOrigin(req('http://a.test/x', { 'sec-fetch-site': site }), {}).ok).toBe(true);
    }
  });

  it('allows a non-browser client (no Origin, no Sec-Fetch-Site)', () => {
    expect(checkOrigin(req('http://a.test/x'), {}).ok).toBe(true);
  });
});
