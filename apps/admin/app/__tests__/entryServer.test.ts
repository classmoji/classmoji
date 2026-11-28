/**
 * admin's `handleError` (app/entry.server.tsx), the same on Node and Workers:
 * it logs what React Router's default handler logged, and reports real
 * failures (once) to whatever reporter the runtime registered; nothing when
 * no reporter is registered (Sentry off).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setErrorReporter, type ReportContext } from '@classmoji/utils/error-report';
import { handleError } from '../entry.server.tsx';

// What React Router hands handleError for a thrown `data(..., { status })`
// (its ErrorResponseImpl): the shape `isRouteErrorResponse` checks.
const routeErrorResponse = (status: number, error?: Error) => ({
  status,
  statusText: status === 404 ? 'Not Found' : 'Internal Server Error',
  internal: true,
  data: 'x',
  ...(error ? { error } : {}),
});

const args = (aborted = false) => {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    request: new Request('https://admin.example.com/people', { signal: controller.signal }),
    params: {},
    context: undefined as never,
  };
};

let reported: Array<{ error: unknown; context: ReportContext }>;
let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  reported = [];
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
  // React Router's default skips logging in test mode; the entry passes the
  // build's mode (import.meta.env.MODE, 'test' under vitest), so the log
  // branch needs a build mode here.
  vi.stubEnv('MODE', 'production');
});
afterEach(() => {
  setErrorReporter(null);
  logged.mockRestore();
  vi.unstubAllEnvs();
});

const withReporter = () =>
  setErrorReporter({
    capture: (error, context) => reported.push({ error, context }),
    flush: async () => true,
  });

describe('handleError', () => {
  it('logs and reports an unexpected error once, as unhandled', () => {
    withReporter();
    const error = new Error('loader broke');
    handleError(error, args());
    handleError(error, args());
    expect(logged).toHaveBeenCalledWith(error);
    expect(reported).toEqual([
      { error, context: { surface: 'react_router.handle_error', handled: false } },
    ]);
  });

  it('logs the Error a 5xx route error response carries and reports the response', () => {
    withReporter();
    const inner = new Error('inner');
    const response = routeErrorResponse(500, inner);
    handleError(response, args());
    expect(logged).toHaveBeenCalledWith(inner);
    expect(reported.map(r => r.error)).toEqual([response]);
  });

  it('logs a 4xx route error response as before and does not report it', () => {
    withReporter();
    const response = routeErrorResponse(404);
    handleError(response, args());
    expect(logged).toHaveBeenCalledWith(response);
    expect(reported).toEqual([]);
  });

  it('neither logs nor reports when the request was aborted', () => {
    withReporter();
    handleError(new Error('client went away'), args(true));
    expect(logged).not.toHaveBeenCalled();
    expect(reported).toEqual([]);
  });

  it('reports a thrown 5xx Response as the Error naming its status, not a 4xx one', () => {
    withReporter();
    handleError(new Response(null, { status: 404 }), args());
    handleError(new Response(null, { status: 500 }), args());
    expect(reported).toHaveLength(1);
    expect((reported[0].error as Error).message).toMatch(/^Response 500/);
  });

  it('does not log in test mode, like the default', () => {
    vi.stubEnv('MODE', 'test');
    handleError(new Error('quiet'), args());
    expect(logged).not.toHaveBeenCalled();
  });

  it('without a reporter only logs, and does not throw', () => {
    const error = new Error('loader broke');
    expect(() => handleError(error, args())).not.toThrow();
    expect(logged).toHaveBeenCalledWith(error);
    expect(reported).toEqual([]);
  });
});
