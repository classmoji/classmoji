import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The webapp's server entry (app/entry.server.tsx): `handleError` logs what
 * React Router's default logged and reports real failures once; a streaming
 * render error after the shell is reported too. Sentry itself is mocked
 * (`./utils/sentry.server`): the assertions are on what the entry hands it.
 */

const mocks = vi.hoisted(() => ({
  enabled: { value: true },
  capture: vi.fn(),
  render: vi.fn(),
}));

vi.mock('../utils/sentry.server', () => ({
  get serverSentryEnabled() {
    return mocks.enabled.value;
  },
  captureServerException: (...a: unknown[]) => mocks.capture(...a),
}));

vi.mock('react-dom/server', () => ({
  renderToPipeableStream: (...a: unknown[]) => mocks.render(...a),
}));

const { UNSAFE_ErrorResponseImpl: ErrorResponseImpl } = await import('react-router');
const entry = await import('../entry.server');

const request = (aborted = false) => {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return new Request('https://app.example.test/admin/cs10/assignments', {
    signal: controller.signal,
  });
};

const handle = (error: unknown, req = request()) =>
  entry.handleError(error, { request: req, params: {}, context: undefined as never });

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mocks.enabled.value = true;
  mocks.capture.mockReset();
  mocks.render.mockReset();
  // React Router's default skips logging in test mode; the entry mirrors that
  // through NODE_ENV, so the log branch needs a non-test mode here.
  vi.stubEnv('NODE_ENV', 'production');
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('handleError', () => {
  it('logs and reports a thrown error, once', () => {
    const error = new Error('loader exploded');
    handle(error);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(error);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture).toHaveBeenCalledWith(error, { surface: 'react_router.handle_error' });
  });

  it('reports a thrown 5xx Response', () => {
    const response = new Response('down', { status: 503 });
    handle(response);
    expect(mocks.capture).toHaveBeenCalledWith(response, {
      surface: 'react_router.handle_error',
    });
  });

  it('logs a 404 route error response by its inner error and does not report it', () => {
    const inner = new Error('No route matches URL "/nowhere"');
    const notFound = new ErrorResponseImpl(404, 'Not Found', inner, true);
    handle(notFound);

    expect(errorSpy).toHaveBeenCalledWith(inner);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('does not report a thrown 4xx Response or redirect', () => {
    handle(new Response(null, { status: 403 }));
    handle(new Response(null, { status: 302, headers: { Location: '/' } }));
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('neither logs nor reports when the request was aborted', () => {
    handle(new Error('client went away'), request(true));
    expect(errorSpy).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('logs as before and reports nothing when Sentry is off', () => {
    mocks.enabled.value = false;
    const error = new Error('loader exploded');
    handle(error);
    expect(errorSpy).toHaveBeenCalledWith(error);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('logs nothing in test mode, like the default', () => {
    vi.stubEnv('NODE_ENV', 'test');
    handle(new Error('quiet'));
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('streaming render errors', () => {
  type Options = { onShellReady(): void; onError(error: unknown): void };
  const start = () => {
    let options: Options | undefined;
    mocks.render.mockImplementation((_element: unknown, opts: Options) => {
      options = opts;
      return { pipe: vi.fn(), abort: vi.fn() };
    });
    const pending = entry.default(
      request(),
      200,
      new Headers(),
      { isSpaMode: false } as never,
      undefined as never
    );
    return { options: options as Options, pending };
  };

  it('reports an error after the shell, with the render surface', async () => {
    const { options, pending } = start();
    options.onShellReady();
    await pending;
    const error = new Error('suspense boundary failed');
    options.onError(error);

    expect(errorSpy).toHaveBeenCalledWith(error);
    expect(mocks.capture).toHaveBeenCalledWith(error, { surface: 'react_router.render' });
  });

  it('leaves an error before the shell to handleError', () => {
    const { options } = start();
    options.onError(new Error('shell failed'));
    expect(errorSpy).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
