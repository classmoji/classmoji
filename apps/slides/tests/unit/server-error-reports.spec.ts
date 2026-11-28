/**
 * Server-side error reports in the slides app: what is reported, and that the
 * answers and logs around it stay as they were.
 *
 * - `handleError` (app/entry.server.tsx) logs what React Router's default
 *   did, then hands real failures (not aborts, not 4xx) to the reporter
 *   (`reportRouteError`); `@classmoji/utils/sentry-node` is stubbed so
 *   nothing starts Sentry in this shared worker;
 * - a deck intent's generic failure is reported once, tagged with the intent,
 *   and answers what it answered before (the route runs with every import
 *   stubbed, `reportError` included, so the call is recorded);
 * - server.ts starts Sentry before anything else it imports, reports the
 *   Socket.IO failures nothing else sees, and the image ships `server/`.
 */

import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import type { HandleErrorFunction } from 'react-router';
import { setErrorReporter, type ReportContext } from '@classmoji/utils/error-report';

import { importWithStubs, stubModule } from '../helpers/dataRequest.helpers.ts';
import { callsTo, importRouteWithStubs, resetRouteStubs } from '../helpers/routeStubs.helpers.ts';

const app = (path: string) => new URL(`../../app/${path}`, import.meta.url);
const appRoot = (path: string) => new URL(`../../${path}`, import.meta.url);

/** Run with console.error captured. */
const capturingConsole = (run: () => void): unknown[][] => {
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    run();
    return logged;
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

  test.afterEach(() => {
    setErrorReporter(null);
  });

  test.afterAll(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  });

  const args = (request = new Request('https://slides.test/deck')) => ({
    request,
    params: {},
    context: undefined as never,
  });

  test('an error: logged as the default does, reported once as react_router.handle_error', () => {
    const error = new Error('loader blew up');
    expect(capturingConsole(() => handleError(error, args()))).toEqual([[error]]);
    expect(captured()).toEqual([{ error, context: HANDLE_ERROR }]);
  });

  test('a thrown 4xx Response: logged as before, not reported', () => {
    const response = new Response('nope', { status: 403 });
    expect(capturingConsole(() => handleError(response, args()))).toEqual([[response]]);
    expect(captured()).toEqual([]);
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
    expect(capturingConsole(() => handleError(routeError, args()))).toEqual([[inner]]);
    expect(captured()).toHaveLength(1);
  });

  test('an aborted request: neither logged nor reported', () => {
    const controller = new AbortController();
    controller.abort();
    const request = new Request('https://slides.test/deck', { signal: controller.signal });
    expect(capturingConsole(() => handleError(new Error('gone'), args(request)))).toEqual([]);
    expect(captured()).toEqual([]);
  });

  test('test mode: not logged (as the default), still reported', () => {
    process.env.NODE_ENV = 'test';
    expect(capturingConsole(() => handleError(new Error('quiet'), args()))).toEqual([]);
    expect(captured()).toHaveLength(1);
  });

  test('the streaming render error is reported only after the shell, as react_router.render', () => {
    const source = readFileSync(app('entry.server.tsx'), 'utf8');
    const onError = source.slice(source.indexOf('onError(error: unknown)'));
    // reportRenderError (sentry-server): surface react_router.render, never
    // for a client that went away or the stream timeout's abort.
    expect(onError.indexOf('reportRenderError(error, request)')).toBeGreaterThan(
      onError.indexOf('if (shellRendered)')
    );
  });
});

// ─── A deck intent's generic failure ────────────────────────────────────────

test.describe('deck action failures', () => {
  type Action = (args: {
    request: Request;
    params: Record<string, string | undefined>;
  }) => Promise<unknown>;
  const DECK_ID = '11111111-1111-4111-8111-111111111111';
  let deck: Action;

  test.beforeAll(async () => {
    ({ action: deck } = await importRouteWithStubs<{ action: Action }>(
      app('routes/$slideId/route.tsx'),
      // As deck-action-writes.spec.ts keeps them: everything else is a stub.
      [
        'react-router',
        '~/utils/classroomWrites',
        '~/utils/deckFiles',
        '@classmoji/utils',
        '@classmoji/utils/upload-limit',
        '@classmoji/utils/repo-limits',
        '@classmoji/utils/return-path',
        '~/utils/slideDocumentAccess',
      ]
    ));
  });

  const slide = {
    id: DECK_ID,
    title: 'Deck',
    kind: 'DECK',
    classroom_id: 'class-1',
    content_path: 'slides/deck-x',
    classroom: {
      id: 'class-1',
      slug: 'class-x',
      status: 'ACTIVE',
      content_repo: 'content',
      git_organization: { login: 'org', provider: 'GITHUB' },
    },
  };

  const post = (fields: Record<string, string>) =>
    deck({
      request: new Request(`http://localhost/${DECK_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      }),
      params: { slideId: DECK_ID },
    });

  test('a failed snippet delete answers as before and is reported once, with its intent', async () => {
    const failure = new Error('GitHub 502');
    resetRouteStubs({
      'getPrisma().slide.findUnique': async () => slide,
      assertSlideAccess: async () => ({ slide, userId: 'user-1', membership: { role: 'TEACHER' } }),
      liveEditingEnv: () => null,
      'ContentService.delete': async () => {
        throw failure;
      },
    });
    const result = await quietly(() => post({ intent: 'delete-snippet', id: 'box.html' }));
    expect(result).toEqual({ error: 'GitHub 502' });
    expect(callsTo('reportError').map(call => call.args)).toEqual([
      [
        failure,
        { surface: 'slides.deck_action', tags: { intent: 'delete-snippet', slide_id: DECK_ID } },
      ],
    ]);
  });

  test('a failed shared-theme lookup on save is reported (the deck then saves as white)', () => {
    const source = readFileSync(app('routes/$slideId/route.tsx'), 'utf8');
    const fallback = source.indexOf("theme = 'white';");
    const report = source.lastIndexOf("reportActionFailure(err, 'save.shared_theme')", fallback);
    expect(report).toBeGreaterThan(source.lastIndexOf('getThemeUrls(', fallback));
    expect(report).toBeLessThan(fallback);
  });
});

// ─── server.ts and the image ────────────────────────────────────────────────

test.describe('server.ts', () => {
  const source = () => readFileSync(appRoot('server.ts'), 'utf8');

  test('starts Sentry before anything else it imports', () => {
    const firstImport = /^import\b[^;]*?from\s+'([^']+)'/m.exec(source())?.[1];
    expect(firstImport).toBe('./server/sentry.ts');
  });

  test("adds Sentry's Express handler only when Sentry is on, after the routes", () => {
    const text = source();
    expect(text).toContain('if (sentryEnabled) setupExpressErrorHandler(app);');
    expect(text.indexOf('setupExpressErrorHandler(app)')).toBeGreaterThan(
      text.lastIndexOf('createRequestHandler(')
    );
  });

  test('reports the Socket.IO failures nothing else sees', () => {
    const text = source();
    expect(text).toContain("surface: 'auth.session_read', tags: { via: 'socket' }");
    expect(text).toContain("surface: 'auth.session_read', tags: { via: 'multiplex' }");
    // The join payload is taken as a plain parameter (no destructuring in
    // the parameter list, which would reject outside the handler's guard).
    expect(text).toMatch(/socket\.on\(\s*'join',\s*createJoinHandler\(/);
  });

  test.describe('the multiplex join handler', () => {
    type Emit = [string, unknown?];
    const setup = (findSlide: (id: string) => Promise<unknown>) => {
      const emits: Emit[] = [];
      const queried: string[] = [];
      const reports: Array<{ error: unknown; context: ReportContext }> = [];
      setErrorReporter({
        capture: (error, context) => void reports.push({ error, context }),
        flush: async () => true,
      });
      return {
        emits,
        queried,
        reports,
        findSlide,
        socket: {
          emit: (event: string, payload?: unknown) => void emits.push([event, payload]),
          join: () => {},
        },
      };
    };
    const run = async (payload: unknown, findSlide: (id: string) => Promise<unknown>) => {
      const { createJoinHandler } = await import('../../server/multiplexJoin.ts');
      const t = setup(findSlide);
      const handler = createJoinHandler({
        socket: t.socket,
        data: { shareCode: 'share-1' },
        findSlide: async id => {
          t.queried.push(id);
          return (await t.findSlide(id)) as never;
        },
        currentState: () => undefined,
        roomSize: () => 1,
        broadcastViewerCount: () => {},
      });
      const logged: unknown[][] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => void logged.push(args);
      try {
        await handler(payload);
      } finally {
        console.error = original;
        setErrorReporter(null);
      }
      return { ...t, logged };
    };
    const neverCalled = async () => {
      throw new Error('queried');
    };

    for (const payload of [
      null,
      undefined,
      42,
      'slide-1',
      [],
      {},
      { slideId: 42 },
      { slideId: {} },
      // Strings no slide id can be: the database would refuse the query.
      { slideId: 'slide\u0000-1' },
      { slideId: 'slide-1\n' },
      { slideId: 'x'.repeat(257) },
    ]) {
      test(`a payload naming no slide id (${String(JSON.stringify(payload)).slice(0, 40)}) is not queried, answered or reported`, async () => {
        const { emits, queried, reports, logged } = await run(payload, neverCalled);
        expect(queried).toEqual([]);
        // What it answered before: nothing.
        expect(emits).toEqual([]);
        expect(reports).toEqual([]);
        expect(logged).toHaveLength(1);
      });
    }

    test('for a slide id, every failure is reported (a validation error included)', async () => {
      const validation = Object.assign(new Error('Invalid `findUnique()` invocation'), {
        name: 'PrismaClientValidationError',
      });
      const down = new Error('database down');
      for (const error of [validation, down]) {
        const { emits, reports } = await run({ slideId: 'slide-1' }, async () => {
          throw error;
        });
        expect(emits).toEqual([]);
        expect(reports).toEqual([{ error, context: { surface: 'slides.multiplex.join' } }]);
      }
    });

    test('a uuid or any other id shape up to the bound is still looked up', async () => {
      for (const slideId of ['6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b', 'slide-1', 'x'.repeat(256)]) {
        const { queried, emits } = await run({ slideId }, async () => null);
        expect(queried).toEqual([slideId]);
        expect(emits).toEqual([['join_error', { reason: 'slide_not_found' }]]);
      }
    });

    test('a valid join answers as before', async () => {
      const missing = await run({ slideId: 'slide-1' }, async () => null);
      expect(missing.emits).toEqual([['join_error', { reason: 'slide_not_found' }]]);
      const found = await run({ slideId: 'slide-1' }, async () => ({
        classroom_id: 'c1',
        multiplex_id: 'share-1',
      }));
      expect(found.emits).toEqual([['joined', { slideId: 'slide-1', canBroadcast: false }]]);
      expect(found.reports).toEqual([]);
    });
  });

  test('the production image copies server/, which server.ts imports first', () => {
    const dockerfile = readFileSync(appRoot('Dockerfile'), 'utf8');
    const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    expect(runtime).toContain('COPY --from=build /app/apps/slides/server ./apps/slides/server');
  });
});
