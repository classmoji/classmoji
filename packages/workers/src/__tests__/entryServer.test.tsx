/**
 * The two server entries behind `@classmoji/workers/entry-server`:
 * - Node (`default`) is React Router's own default entry, byte for byte apart
 *   from the `// classmoji` lines (reporting), so Fly renders exactly as before;
 * - Workers (`workerd`) renders the same documents on web streams.
 * `ServerRouter` is replaced by a small document with a suspended part, so
 * both entries can be driven with the same inputs.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Suspense, use } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntryContext, RouterContextProvider } from 'react-router';
import { setErrorReporter, type ReportContext } from '@classmoji/utils/error-report';
import { isRenderAbort, REACT_RENDER_ABORTS } from '@classmoji/utils/sentry-server';

vi.mock('react-router', async () => ({
  ...(await vi.importActual<typeof import('react-router')>('react-router')),
  ServerRouter: ({ context, url }: { context: { late?: Promise<string> }; url: string }) => (
    <html lang="en">
      <body>
        <p>{url}</p>
        {context.late && (
          <Suspense fallback={<i>loading</i>}>
            <Late value={context.late} />
          </Suspense>
        )}
      </body>
    </html>
  ),
}));

function Late({ value }: { value: Promise<string> }) {
  return <b>{use(value)}</b>;
}

const node = await import('../entry-server.node.tsx');
const workerd = await import('../entry-server.workerd.tsx');

const ENTRIES = [
  ['node', node],
  ['workerd', workerd],
] as const;

const BOT = 'Googlebot/2.1 (+http://www.google.com/bot.html)';
const BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

function render(
  entry: (typeof ENTRIES)[number][1],
  {
    method = 'GET',
    userAgent = BROWSER,
    late,
    loadContext = {} as RouterContextProvider,
  }: {
    method?: string;
    userAgent?: string;
    late?: Promise<string>;
    loadContext?: RouterContextProvider;
  } = {}
) {
  return entry.default(
    new Request('https://admin.example.com/people', {
      method,
      headers: { 'user-agent': userAgent },
    }),
    200,
    new Headers({ 'x-app': 'kept' }),
    { isSpaMode: false, late } as unknown as EntryContext,
    loadContext
  ) as Promise<Response>;
}

describe('the Node entry', () => {
  it("is React Router's default entry.server.node.tsx, byte for byte, plus the marked lines", () => {
    const require = createRequire(import.meta.url);
    const defaults = require
      .resolve('@react-router/dev/package.json')
      .replace(/package\.json$/, 'dist/config/defaults/entry.server.node.tsx');
    const source = readFileSync(new URL('../entry-server.node.tsx', import.meta.url), 'utf8');
    const theirs = readFileSync(defaults, 'utf8');
    // Our additions are whole lines ending in `// classmoji`: exactly the
    // reportRenderError import and its one call.
    const marked = source.split('\n').filter(line => line.endsWith(' // classmoji'));
    expect(marked.map(line => line.trim())).toEqual([
      'import { reportRenderError } from "@classmoji/utils/sentry-server"; // classmoji',
      'reportRenderError(error, request); // classmoji',
    ]);
    const ours = source
      .split('\n')
      .filter(line => !line.endsWith(' // classmoji'))
      .join('\n');
    expect(ours.endsWith(theirs)).toBe(true);
    // Only the header comment and the eslint pragma precede it.
    expect(ours.slice(0, ours.length - theirs.length)).toMatch(
      /^\/\*\*[\s\S]*\*\/\n\/\* eslint-disable[^\n]*\*\/\n$/
    );
  });
});

describe.each(ENTRIES)('the %s entry', (_name, entry) => {
  it('exports the same streamTimeout', () => {
    expect(entry.streamTimeout).toBe(5_000);
  });

  it('renders the document as text/html, keeping the headers', async () => {
    const response = await render(entry);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(response.headers.get('x-app')).toBe('kept');
    expect(await response.text()).toContain('<p>https://admin.example.com/people</p>');
  });

  it('answers HEAD with no body', async () => {
    const response = await render(entry, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get('x-app')).toBe('kept');
  });

  it('streams the shell to browsers before suspended content resolves', async () => {
    let resolve!: (value: string) => void;
    const late = new Promise<string>(r => (resolve = r));
    const response = await render(entry, { late });
    // The response exists while the content is still pending.
    resolve('ready');
    const html = await response.text();
    expect(html).toContain('<i>loading</i>');
    expect(html).toContain('ready');
  });

  describe('an error after the shell', () => {
    let reported: Array<{ error: unknown; context: ReportContext }>;
    let logged: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      reported = [];
      logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      setErrorReporter(null);
      logged.mockRestore();
    });

    const renderFailingLate = async () => {
      let reject!: (error: Error) => void;
      const late = new Promise<string>((_resolve, r) => (reject = r));
      const response = await render(entry, { late });
      const error = new Error('late boom');
      reject(error);
      const html = await response.text();
      return { error, html, response };
    };

    it('is logged as before and reported once, as react_router.render', async () => {
      setErrorReporter({
        capture: (error, context) => reported.push({ error, context }),
        flush: async () => true,
      });
      const { error, html, response } = await renderFailingLate();
      expect(response.status).toBe(200);
      expect(html).toContain('<i>loading</i>');
      expect(logged).toHaveBeenCalledWith(error);
      expect(reported).toEqual([
        { error, context: { surface: 'react_router.render', handled: false } },
      ]);
    });

    it('is not reported when the client goes away mid-stream', async () => {
      setErrorReporter({
        capture: (error, context) => reported.push({ error, context }),
        flush: async () => true,
      });
      // Never resolves: the suspended part is still pending when the body is cancelled.
      const late = new Promise<string>(() => {});
      const response = await render(entry, { late });
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
      // React told onError why it stopped (so the path ran), and nothing was reported.
      const reasons: string[] = (logged.mock.calls as unknown[][]).map(call =>
        String((call[0] as Error | undefined)?.message)
      );
      expect(reasons.some(reason => REACT_RENDER_ABORTS.includes(reason))).toBe(true);
      expect(reported).toEqual([]);
    });

    it('without a reporter is only logged, and the response is unchanged', async () => {
      const { error, html, response } = await renderFailingLate();
      expect(response.status).toBe(200);
      expect(html).toContain('<i>loading</i>');
      expect(logged).toHaveBeenCalledWith(error);
      expect(reported).toEqual([]);
    });
  });

  it('waits for all content for bots', async () => {
    let resolve!: (value: string) => void;
    const late = new Promise<string>(r => (resolve = r));
    const pending = render(entry, { userAgent: BOT, late });
    setTimeout(() => resolve('ready'), 5);
    const html = await (await pending).text();
    expect(html).not.toContain('<i>loading</i>');
    expect(html).toContain('<b>ready</b>');
  });
});

/**
 * What React 19 hands `onError` when the entries' stream timeout stops a
 * render: on Node `abort()` with no reason, on workerd `AbortSignal.timeout`.
 * Both are recognised by `isRenderAbort`, so `reportRenderError` skips them.
 */
describe('the stream timeout abort, as React reports it', () => {
  it('on Node (abort() with no reason)', async () => {
    const { renderToPipeableStream } = await import('react-dom/server');
    const { PassThrough } = await import('node:stream');
    const errors: unknown[] = [];
    await new Promise<void>(resolve => {
      const { pipe, abort } = renderToPipeableStream(
        <Suspense fallback={<i>loading</i>}>
          <Late value={new Promise<string>(() => {})} />
        </Suspense>,
        {
          onShellReady() {
            const body = new PassThrough();
            body.resume();
            body.on('end', resolve);
            pipe(body);
            abort();
          },
          onError(error) {
            errors.push(error);
          },
        }
      );
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every(isRenderAbort)).toBe(true);
  });

  it("on workerd (AbortSignal.timeout): onError gets the signal's own reason", async () => {
    // The workerd entry skips exactly `error === timeout.reason`, so an
    // upstream TimeoutError (a different object) is still reported.
    const { renderToReadableStream } = await import('react-dom/server.edge');
    const errors: unknown[] = [];
    const signal = AbortSignal.timeout(5);
    const body = await renderToReadableStream(
      <Suspense fallback={<i>loading</i>}>
        <Late value={new Promise<string>(() => {})} />
      </Suspense>,
      { signal, onError: error => void errors.push(error) }
    );
    await new Response(body).text();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every(error => error === signal.reason)).toBe(true);
    expect(isRenderAbort(signal.reason)).toBe(false);
  });
});

/**
 * On workerd a render error after the shell is reported after the response
 * was returned, so after @sentry/cloudflare's own flush: the entry hands a
 * flush of it to the request's waitUntil, so the send is not cut off.
 */
describe('the workerd entry: a late report is flushed under waitUntil', () => {
  afterEach(() => setErrorReporter(null));

  it('hands a flush that waits for the slow ingest to ctx.waitUntil', async () => {
    const { RouterContextProvider } = await import('react-router');
    const { cloudflareContext } = await import('../context.ts');
    let release!: () => void;
    const ingest = new Promise<void>(r => (release = r));
    const flushed = vi.fn();
    setErrorReporter({
      capture: () => {},
      flush: async () => {
        await ingest;
        flushed();
        return true;
      },
    });
    const handed: Promise<unknown>[] = [];
    const loadContext = new RouterContextProvider();
    loadContext.set(cloudflareContext, {
      env: {} as never,
      ctx: { waitUntil: promise => void handed.push(promise), passThroughOnException() {} },
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let reject!: (error: Error) => void;
      const late = new Promise<string>((_resolve, r) => (reject = r));
      const response = await render(workerd, { late, loadContext });
      // Nothing is handed over before an error is reported.
      expect(handed).toHaveLength(0);
      reject(new Error('late boom'));
      await response.text();

      expect(handed).toHaveLength(1);
      let settled = false;
      void handed[0].then(() => (settled = true));
      await new Promise(resolve => setTimeout(resolve, 10));
      // Still waiting on the slow ingest: the runtime keeps the request alive.
      expect(settled).toBe(false);
      release();
      await handed[0];
      expect(flushed).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });

  it('hands nothing for an error it does not report (the client went away)', async () => {
    const { RouterContextProvider } = await import('react-router');
    const { cloudflareContext } = await import('../context.ts');
    setErrorReporter({ capture: () => {}, flush: async () => true });
    const handed: Promise<unknown>[] = [];
    const loadContext = new RouterContextProvider();
    loadContext.set(cloudflareContext, {
      env: {} as never,
      ctx: { waitUntil: promise => void handed.push(promise), passThroughOnException() {} },
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await render(workerd, { late: new Promise<string>(() => {}), loadContext });
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
      expect(handed).toHaveLength(0);
    } finally {
      logged.mockRestore();
    }
  });
});
