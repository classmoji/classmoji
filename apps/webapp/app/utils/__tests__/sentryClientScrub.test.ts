// @vitest-environment jsdom
/**
 * The browser client (utils/sentry.client.ts) through the real
 * `@sentry/react-router` SDK: one scrubber for browser and server events. A
 * captured error, a click breadcrumb on a button whose title names a person,
 * and a sampled span whose name and `url.full` carry a search term are sent
 * as the envelopes show, with the query, the login and the title gone. The
 * SDK's fetch transport is caught at `globalThis.fetch`; nothing reaches the
 * network. The 5% trace sampling is forced to "sampled" with Math.random.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

// The browser build of the SDK, as the client bundle gets it (vitest resolves
// the package's `node` condition otherwise).
vi.mock('@sentry/react-router', async () => {
  const { createRequire } = await import('node:module');
  const { dirname, join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const pkg = createRequire(import.meta.url).resolve('@sentry/react-router/package.json');
  return import(pathToFileURL(join(dirname(pkg), 'build/esm/index.client.js')).href);
});

const sent: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('ingest.sentry.io')) {
      const body = init?.body;
      sent.push(typeof body === 'string' ? body : new TextDecoder().decode(body as Uint8Array));
      return new Response('{}');
    }
    return new Response('{}');
  }) as typeof fetch;
  const config = document.createElement('script');
  config.id = 'sentry-config';
  config.type = 'application/json';
  config.textContent = JSON.stringify({
    dsn: 'https://public@o0.ingest.sentry.io/0',
    environment: 'staging',
  });
  document.body.appendChild(config);
  window.history.replaceState(null, '', '/teacher/cs52/students/jane-doe?q=jane@school.edu');
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

it('scrubs the error, its breadcrumbs and the sampled span before they leave', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const client = await import('../sentry.client');
  const Sentry = (await import('@sentry/react-router')) as typeof import('@sentry/react-router') & {
    startSpan: (options: object, callback: () => void) => void;
    flush: (timeout: number) => Promise<boolean>;
  };
  expect(client.initSentry('webapp')).not.toBeNull();

  // A click on a button whose title names someone.
  const button = document.createElement('button');
  button.className = 'remove';
  button.title = 'Remove Jane Doe';
  button.setAttribute('aria-label', 'Remove Jane Doe');
  document.body.appendChild(button);
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  // A sampled span, as a fetch of the search would make.
  Sentry.startSpan(
    {
      name: 'GET https://classmoji.io/api/search?q=jane@school.edu',
      forceTransaction: true,
      attributes: { 'url.full': 'https://classmoji.io/api/search?q=jane@school.edu' },
    },
    () => {}
  );

  Sentry.captureException(new Error('boom at /join/CODE123'));
  await Sentry.flush(2000);

  const all = sent.join('\n');
  expect(all.length).toBeGreaterThan(0);
  expect(all).not.toMatch(/jane|Jane|CODE123/);

  const items = sent.flatMap(envelope => {
    const lines = envelope.split('\n').filter(Boolean);
    const out: Array<{ type: string; payload: unknown }> = [];
    for (let i = 1; i + 1 < lines.length; i += 2) {
      out.push({
        type: (JSON.parse(lines[i]) as { type: string }).type,
        payload: JSON.parse(lines[i + 1]),
      });
    }
    return out;
  });
  const event = items.find(item => item.type === 'event')?.payload as {
    tags?: Record<string, unknown>;
    request?: { url?: string };
    exception?: { values?: Array<{ value?: string }> };
    breadcrumbs?: Array<{ category?: string; message?: string }>;
  };
  // Every event names its app and runtime, as the servers' do.
  expect(event.tags).toMatchObject({ app: 'webapp', runtime: 'browser' });
  expect(event.request?.url).toBe('http://localhost:3000/teacher/cs52/students/[login]');
  expect(event.exception?.values?.[0].value).toBe('boom at /join/[code]');
  const click = event.breadcrumbs?.find(crumb => crumb.category === 'ui.click');
  expect(click?.message).toBe('body > button.remove[aria-label][title]');

  // The span went through beforeSendSpan: streamed spans, or a transaction.
  const spanText = JSON.stringify(items.filter(item => item.type !== 'event'));
  expect(spanText).toContain('/api/search');
  expect(spanText).not.toContain('?q=');
  // Spans carry the same two as attributes.
  expect(spanText).toMatch(/"runtime":\{[^}]*"value":"browser"/);
  expect(spanText).toMatch(/"app":\{[^}]*"value":"webapp"/);
});
