import { describe, expect, it } from 'vitest';
import {
  blobKey,
  contentHeaders,
  errorResponse,
  finalizeHeaders,
  treeKey,
  variantKey,
} from '../src/cache.ts';

describe('R2 key derivation', () => {
  it('keys originals by sha alone, so classrooms share bytes they both reference', () => {
    expect(blobKey('deadbeef')).toBe('blobs/deadbeef');
  });

  it('keys variants by width and concrete format', () => {
    expect(variantKey('deadbeef', 1600, 'avif')).toBe('blobs/deadbeef/w1600.avif');
    expect(variantKey('deadbeef', 800, 'webp')).toBe('blobs/deadbeef/w800.webp');
  });

  it('keys tree listings by tree sha', () => {
    expect(treeKey('t0p')).toBe('trees/t0p.json');
  });
});

describe('response headers', () => {
  it('puts CORS, nosniff and the sandboxing CSP on everything', () => {
    const headers = finalizeHeaders(new Headers());
    expect(headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS');
    expect(headers.get('Access-Control-Expose-Headers')).toBe('Content-Type, Content-Length, ETag');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    // content.classmoji.io sits under the app's .classmoji.io cookie domain:
    // an SVG with inline script, opened top-level, must not run there.
    expect(headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
  });

  it('never lets a cookie out', () => {
    const headers = new Headers({ 'Set-Cookie': 'session=leaked' });
    expect(finalizeHeaders(headers).get('Set-Cookie')).toBeNull();
  });

  it('carries the caller-chosen content type and cache policy', () => {
    const headers = contentHeaders('image/png', 'public, max-age=60, immutable');
    expect(headers.get('Content-Type')).toBe('image/png');
    expect(headers.get('Cache-Control')).toBe('public, max-age=60, immutable');
  });

  it('varies on Accept, because fmt=auto negotiates the stored format', () => {
    expect(contentHeaders('image/avif', 'public, max-age=60, immutable').get('Vary')).toBe(
      'Accept'
    );
  });

  it('never caches an error', async () => {
    const response = errorResponse(403, 'bad-signature');
    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'bad-signature' });
  });
});
