/**
 * The headers the legacy `/content/{org}/{repo}/…` proxy sends.
 *
 * Runs in the Playwright runner without a browser or the dev stack: the rule
 * is a pure function of the MIME type, and the route's use of it is checked
 * from its source, the way slide-gates.spec checks the routes.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import {
  contentProxySafetyHeaders,
  isDocumentMimeType,
  withNosniff,
} from '../../app/utils/contentProxyHeaders.ts';
import { DOWNLOAD_HARDENING_HEADERS, slideFileResponse } from '../../app/utils/slideKind.ts';

const PROXY_SOURCE = readFileSync(
  fileURLToPath(new URL('../../app/routes/content.$org.$repo.$/route.tsx', import.meta.url)),
  'utf8'
);

test.describe('which types are served as a download', () => {
  for (const mime of [
    'text/html; charset=utf-8',
    'TEXT/HTML',
    'application/xhtml+xml',
    'image/svg+xml',
    'application/xml',
    'text/xml',
    'application/atom+xml',
  ]) {
    test(`${mime} is a document type`, () => {
      expect(isDocumentMimeType(mime)).toBe(true);
    });
  }

  for (const mime of [
    'text/css; charset=utf-8',
    'application/javascript; charset=utf-8',
    'application/json; charset=utf-8',
    'image/png',
    'font/woff2',
    'video/mp4',
    'application/pdf',
    'application/octet-stream',
  ]) {
    test(`${mime} is not`, () => {
      expect(isDocumentMimeType(mime)).toBe(false);
    });
  }
});

test.describe('the headers per type', () => {
  test('an asset gets nosniff and nothing else', () => {
    expect(contentProxySafetyHeaders('text/css; charset=utf-8')).toEqual({
      'X-Content-Type-Options': 'nosniff',
    });
    expect(contentProxySafetyHeaders('image/png')).toEqual({
      'X-Content-Type-Options': 'nosniff',
    });
  });

  test('HTML renders as a page, so a deck can embed it in an iframe', () => {
    for (const mime of ['text/html; charset=utf-8', 'application/xhtml+xml']) {
      expect(contentProxySafetyHeaders(mime)).toEqual({ 'X-Content-Type-Options': 'nosniff' });
    }
  });

  test('SVG and XML get the download hardening the file-slide download uses', () => {
    for (const mime of ['image/svg+xml', 'application/xml']) {
      const headers = contentProxySafetyHeaders(mime);
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['Content-Security-Policy']).toBe(
        DOWNLOAD_HARDENING_HEADERS['Content-Security-Policy']
      );
      expect(headers['Content-Disposition']).toBe('attachment');
    }
  });

  test('the pair is the one the file-slide download sends, not a second copy', () => {
    const streamed = slideFileResponse({
      mode: 'stream',
      body: new Uint8Array([1, 2, 3]),
      filename: 'notes.pdf',
      contentType: 'application/pdf',
      disposition: 'attachment; filename="notes.pdf"',
    });
    for (const [name, value] of Object.entries(DOWNLOAD_HARDENING_HEADERS)) {
      expect(streamed.headers.get(name)).toBe(value);
    }
  });
});

test.describe('withNosniff', () => {
  test('adds nosniff to a plain refusal', () => {
    const response = withNosniff(new Response('Forbidden', { status: 403 }));
    expect(response.status).toBe(403);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  test('rebuilds a response whose headers are immutable', async () => {
    const response = withNosniff(Response.redirect('https://example.com/abc', 302));
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://example.com/abc');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});

test.describe('the proxy route', () => {
  test('puts the per-type headers on what it serves', () => {
    expect(PROXY_SOURCE).toContain('...contentProxySafetyHeaders(mimeType),');
  });

  test('stamps nosniff on every other answer, returned or thrown', () => {
    expect(PROXY_SOURCE).toContain('return withNosniff(response);');
    expect(PROXY_SOURCE).toContain('if (error instanceof Response) throw withNosniff(error);');
  });
});
