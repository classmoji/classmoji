/**
 * One scrubber for browser and server events: what the browser clients
 * (webapp, pages, slides, admin) hand Sentry's `beforeSend`,
 * `beforeBreadcrumb` and `beforeSendSpan`, on realistic inputs. A search
 * term, a join code or a person's name in a page URL, a fetch URL, a
 * navigation, a click target or a sampled span never leaves the browser.
 */
import { describe, expect, it } from 'vitest';
import type { Breadcrumb } from '@sentry/core';
import {
  scrubBrowserBreadcrumb,
  scrubBrowserEvent,
  scrubSpan,
  stripElementAttributes,
} from '../sentryScrub.ts';

describe('scrubBrowserEvent (beforeSend)', () => {
  it('cuts the query and sensitive segments, keeps the user id and the browser description', () => {
    const event = scrubBrowserEvent({
      request: {
        url: 'https://classmoji.io/api/search?q=jane@school.edu',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh)',
          Referer: 'https://classmoji.io/join/CODE123?invite=abc',
          Cookie: 'better-auth.session_token=x',
        },
      },
      user: { id: 'u1', email: 'jane@school.edu', ip_address: '1.2.3.4' } as { id: string },
      exception: { values: [{ type: 'TypeError', value: 'failed at /admin/cs52/students/jane' }] },
    });
    expect(event.request).toEqual({
      url: 'https://classmoji.io/api/search',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh)',
        Referer: 'https://classmoji.io/join/[code]',
      },
    });
    expect(event.user).toEqual({ id: 'u1' });
    expect(event.exception?.values?.[0].value).toBe('failed at /admin/cs52/students/[login]');
    expect(JSON.stringify(event)).not.toMatch(/jane|CODE123|session_token/);
  });
});

describe('scrubBrowserBreadcrumb (beforeBreadcrumb)', () => {
  it('drops the values of attributes in a click target', () => {
    const click: Breadcrumb = {
      category: 'ui.click',
      message:
        'div.roster > button.btn[type="button"][title="Remove Jane Doe"][aria-label="Remove Jane Doe"]',
    };
    expect(scrubBrowserBreadcrumb(click)).toEqual({
      category: 'ui.click',
      message: 'div.roster > button.btn[type][title][aria-label]',
    });
  });

  it('does the same for input targets, also when a value holds quotes or brackets', () => {
    expect(
      scrubBrowserBreadcrumb({
        category: 'ui.input',
        message: 'form > input[name="search"][title="say "hi" [x]"]',
      })?.message
    ).toBe('form > input[name][title]');
    expect(stripElementAttributes('a.link > img[alt="Jane"]')).toBe('a.link > img[alt]');
  });

  it('scrubs fetch and navigation breadcrumbs', () => {
    expect(
      scrubBrowserBreadcrumb({
        category: 'fetch',
        data: { url: '/api/search?q=jane%40school.edu', method: 'GET', status_code: 200 },
      })
    ).toEqual({ category: 'fetch', data: { url: '/api/search', method: 'GET', status_code: 200 } });
    expect(
      scrubBrowserBreadcrumb({
        category: 'navigation',
        data: { from: '/join/CODE', to: '/teacher/cs52/students/jane-doe?tab=notes' },
      })
    ).toEqual({
      category: 'navigation',
      data: { from: '/join/[code]', to: '/teacher/cs52/students/[login]' },
    });
  });

  it('still drops console breadcrumbs', () => {
    expect(scrubBrowserBreadcrumb({ category: 'console', message: 'jane' })).toBeNull();
  });
});

describe('scrubSpan (beforeSendSpan, streamed spans)', () => {
  it('scrubs the name and the URL attributes of a sampled fetch span', () => {
    const span = scrubSpan({
      name: 'GET https://classmoji.io/api/search?q=jane@school.edu',
      attributes: {
        'url.full': 'https://classmoji.io/api/search?q=jane@school.edu',
        'http.url': 'https://classmoji.io/join/CODE?x=1',
        'url.query': 'q=jane@school.edu',
        'http.query': '?q=jane',
        'user.id': 'u1',
        'user.email': 'jane@school.edu',
        'sentry.segment.name': '/admin/cs52/students/jane-doe',
        'http.response.status_code': 200,
        'sentry.op': 'http.client',
      },
    });
    expect(span).toEqual({
      name: 'GET https://classmoji.io/api/search',
      attributes: {
        'url.full': 'https://classmoji.io/api/search',
        'http.url': 'https://classmoji.io/join/[code]',
        'user.id': 'u1',
        'sentry.segment.name': '/admin/cs52/students/[login]',
        'http.response.status_code': 200,
        'sentry.op': 'http.client',
      },
    });
  });

  it('scrubs a navigation span named by its URL, and typed attribute values', () => {
    const span = scrubSpan({
      name: '/join/CODE123',
      attributes: { 'url.full': { value: 'https://x.test/join/CODE123?a=1', type: 'string' } },
    });
    expect(span.name).toBe('/join/[code]');
    expect(span.attributes['url.full']).toEqual({
      value: 'https://x.test/join/[code]',
      type: 'string',
    });
  });
});

describe('the four browser clients', () => {
  it.each(['webapp', 'pages', 'slides', 'admin'])(
    '%s uses the shared scrubbers and sends no query string',
    async app => {
      const { readFileSync } = await import('node:fs');
      const source = readFileSync(
        new URL(`../../../../apps/${app}/app/utils/sentry.client.ts`, import.meta.url),
        'utf8'
      );
      expect(source).toContain('urlQueryParams: false,');
      expect(source).toContain('beforeSend: event => scrubBrowserEvent(event),');
      expect(source).toContain(
        'beforeBreadcrumb: breadcrumb => scrubBrowserBreadcrumb(breadcrumb),'
      );
      expect(source).toContain('beforeSendSpan: span => scrubSpan(span),');
      // The browser module, never the server one.
      expect(source).not.toMatch(/@classmoji\/utils\/sentry-(server|node)/);
    }
  );
});
