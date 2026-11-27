/**
 * Server-side error reports in the pages app: what reaches the reporter, and
 * that the answers and logs around it stay as they were.
 *
 * - `handleError` (app/entry.server.tsx) logs what React Router's default
 *   did, then hands real failures (not aborts, not 4xx) to the reporter
 *   (`reportRouteError`); `@classmoji/utils/sentry-node` is stubbed so
 *   nothing starts Sentry in this shared worker;
 * - `sessionReadFailed` turns a failed session read into null, reported;
 * - the reader APIs' `guarded()` 500 is reported, once;
 * - server.ts starts Sentry before anything else it imports.
 *
 * Reports go to a fake reporter (`setErrorReporter`); with none registered
 * every call does nothing, which the last tests pin.
 */

import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { setErrorReporter, type ReportContext } from '@classmoji/utils/error-report';
import type { HandleErrorFunction } from 'react-router';

import { sessionReadFailed } from '~/utils/sessionRead.server.ts';
import { handleSectionsGet, type PageSectionsDeps } from '~/utils/pageSections.server.ts';
import { handleCommentsGet, type PageCommentsDeps } from '~/utils/pageComments.server.ts';
import { importWithStubs, stubModule } from '../helpers/dataRequest.helpers.ts';

const app = (path: string) => new URL(`../../app/${path}`, import.meta.url);

type Report = { error: unknown; context: ReportContext };
let reports: Report[] = [];

const useFakeReporter = () =>
  setErrorReporter({
    capture: (error, context) => {
      reports.push({ error, context });
    },
    flush: async () => true,
  });

test.beforeEach(() => {
  reports = [];
});

test.afterEach(() => {
  setErrorReporter(null);
});

/** Run with console.error captured, the way the default handler would print. */
const capturingConsole = (run: () => void): { logged: unknown[][] } => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    run();
    return { logged };
  } finally {
    console.error = original;
  }
};

/** Await `run` with console.error silenced (the handlers' own log lines). */
const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
};

// ─── handleError ────────────────────────────────────────────────────────────

test.describe('entry.server handleError', () => {
  // handleError reports through @classmoji/utils/error-report
  // (`reportRouteError`); the stub of sentry-node only keeps Sentry from
  // starting in this shared worker.
  type HandleErrorReport = { error: unknown; context: ReportContext };
  let handled: HandleErrorReport[] = [];
  const captured = () => handled;
  const HANDLE_ERROR = { surface: 'react_router.handle_error', handled: false };
  let handleError: HandleErrorFunction;
  const savedNodeEnv = process.env.NODE_ENV;

  test.beforeAll(async () => {
    ({ handleError } = await importWithStubs<{ handleError: HandleErrorFunction }>(
      app('entry.server.tsx'),
      {
        '@classmoji/utils/sentry-node': stubModule(
          'export const captureServerException = () => {};'
        ),
      }
    ));
  });

  test.beforeEach(() => {
    handled = [];
    setErrorReporter({
      capture: (error, context) => {
        handled.push({ error, context });
      },
      flush: async () => true,
    });
    process.env.NODE_ENV = 'production';
  });

  test.afterAll(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  });

  const args = (request = new Request('https://pages.test/c/p')) => ({
    request,
    params: {},
    context: undefined as never,
  });

  test('an error: logged as the default does, reported once as react_router.handle_error', () => {
    const error = new Error('loader blew up');
    const { logged } = capturingConsole(() => handleError(error, args()));
    expect(logged).toEqual([[error]]);
    expect(captured()).toEqual([{ error, context: HANDLE_ERROR }]);
  });

  test('a thrown 4xx Response: logged as before, not reported', () => {
    const response = new Response('nope', { status: 404 });
    const { logged } = capturingConsole(() => handleError(response, args()));
    expect(logged).toEqual([[response]]);
    expect(captured()).toEqual([]);
  });

  test('a thrown 5xx Response is reported, as the Error naming its status', () => {
    const response = new Response('down', { status: 503 });
    capturingConsole(() => handleError(response, args()));
    expect(captured()).toHaveLength(1);
    expect((captured()[0].error as Error).message).toMatch(/^Response 503/);
  });

  test('a route error response logs its inner error, as the default does', () => {
    const inner = new Error('inner');
    const routeError = {
      status: 500,
      statusText: 'Internal',
      internal: true,
      data: '',
      error: inner,
    };
    const { logged } = capturingConsole(() => handleError(routeError, args()));
    expect(logged).toEqual([[inner]]);
    expect(captured()).toHaveLength(1);
  });

  test('an aborted request: neither logged nor reported', () => {
    const controller = new AbortController();
    controller.abort();
    const request = new Request('https://pages.test/c/p', { signal: controller.signal });
    const { logged } = capturingConsole(() => handleError(new Error('gone'), args(request)));
    expect(logged).toEqual([]);
    expect(captured()).toEqual([]);
  });

  test('test mode: not logged (as the default), still reported', () => {
    process.env.NODE_ENV = 'test';
    const { logged } = capturingConsole(() => handleError(new Error('quiet'), args()));
    expect(logged).toEqual([]);
    expect(captured()).toHaveLength(1);
  });

  test('the streaming render error is reported only after the shell, as react_router.render', () => {
    const source = readFileSync(app('entry.server.tsx'), 'utf8');
    const onError = source.slice(source.indexOf('onError(error: unknown)'));
    expect(onError.indexOf("surface: 'react_router.render'")).toBeGreaterThan(
      onError.indexOf('if (shellRendered)')
    );
  });
});

// ─── Session reads ──────────────────────────────────────────────────────────

test.describe('sessionReadFailed', () => {
  test('a failed read becomes null and is reported once as auth.session_read', async () => {
    useFakeReporter();
    const failure = new Error('session store down');
    const read = () => Promise.reject(failure);
    await expect(read().catch(sessionReadFailed)).resolves.toBeNull();
    // A second layer seeing the same object does not send it again.
    await expect(read().catch(sessionReadFailed)).resolves.toBeNull();
    expect(reports).toEqual([{ error: failure, context: { surface: 'auth.session_read' } }]);
  });

  test('no session is not a failure: nothing reported', async () => {
    useFakeReporter();
    const read = () => Promise.resolve(null);
    await expect(read().catch(sessionReadFailed)).resolves.toBeNull();
    expect(reports).toEqual([]);
  });

  test('without a reporter it is the old `.catch(() => null)`', async () => {
    await expect(Promise.reject(new Error('x')).catch(sessionReadFailed)).resolves.toBeNull();
    expect(reports).toEqual([]);
  });
});

// ─── Reader APIs ────────────────────────────────────────────────────────────

test.describe('the reader APIs report the 500 they answer', () => {
  const failingSession = (failure: Error) => ({
    async getSession() {
      throw failure;
    },
  });

  test('page sections: a 500, reported once with its op', async () => {
    useFakeReporter();
    const failure = new Error('db down');
    const deps = failingSession(failure) as unknown as PageSectionsDeps<never>;
    const request = new Request('https://pages.test/api/page-sections?pageId=p&blockId=b');
    const response = await quietly(() => handleSectionsGet(request, deps));
    expect(response.status).toBe(500);
    expect(reports).toEqual([
      { error: failure, context: { surface: 'pages.page_sections', tags: { op: 'GET' } } },
    ]);
  });

  test('page comments: a 500, reported once with its op', async () => {
    useFakeReporter();
    const failure = new Error('db down');
    const deps = failingSession(failure) as unknown as PageCommentsDeps<never>;
    const request = new Request('https://pages.test/api/page-comments?pageId=p');
    const response = await quietly(() => handleCommentsGet(request, deps));
    expect(response.status).toBe(500);
    expect(reports).toEqual([
      { error: failure, context: { surface: 'pages.page_comments', tags: { op: 'GET' } } },
    ]);
  });

  test('without a reporter the answer is the same 500', async () => {
    const deps = failingSession(new Error('db down')) as unknown as PageSectionsDeps<never>;
    const request = new Request('https://pages.test/api/page-sections?pageId=p&blockId=b');
    const response = await quietly(() => handleSectionsGet(request, deps));
    expect(response.status).toBe(500);
    expect(reports).toEqual([]);
  });
});

// ─── Boot order ─────────────────────────────────────────────────────────────

test('server.ts starts Sentry before anything else it imports', () => {
  const source = readFileSync(new URL('../../server.ts', import.meta.url), 'utf8');
  const firstImport = /^import\b[^;]*?from\s+'([^']+)'/m.exec(source)?.[1];
  expect(firstImport).toBe('./server/sentry.ts');
  // Sentry's Express handler only when Sentry is on, after the routes.
  expect(source).toContain('if (sentryEnabled) setupExpressErrorHandler(app);');
  expect(source.indexOf('setupExpressErrorHandler(app)')).toBeGreaterThan(
    source.lastIndexOf('createRequestHandler(')
  );
});
