/**
 * `onAuthApiError`, better-auth's `onAPIError.onError`: it logs each error as
 * better-auth 1.7.18's router does without a `logger` option (setting the hook
 * replaces that logging), and reports only the faults (`auth.api`): not an
 * APIError, or an APIError INTERNAL_SERVER_ERROR. Every other APIError (bad
 * credentials, a state mismatch, a refusal) is logged as before and never
 * reported. Without a reporter it only logs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { APIError, createAuthEndpoint, createAuthMiddleware } from 'better-auth/api';
import { betterAuth } from 'better-auth';
import {
  setErrorReporter,
  type ErrorReporter,
  type ReportContext,
} from '@classmoji/utils/error-report';
import { onAuthApiError } from '../apiErrorHook.ts';

let captured: Array<{ error: unknown; context: ReportContext }>;
const reporter: ErrorReporter = {
  capture: (error, context) => captured.push({ error, context }),
  flush: async () => true,
};
const logger = { error: vi.fn() };

beforeEach(() => {
  captured = [];
  logger.error.mockReset();
  setErrorReporter(reporter);
});

afterEach(() => {
  setErrorReporter(null);
});

describe('logging, as better-auth logs it by default', () => {
  it('an unknown error: its name, then the error', () => {
    const error = new TypeError('Cannot read properties of undefined');
    onAuthApiError(error, { logger });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith('TypeError', error);
  });

  it('a message about the schema: the message alone', () => {
    const error = new Error('The table `public.session` does not exist in the current database.');
    onAuthApiError(error, { logger });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(error.message);
  });

  it('an APIError INTERNAL_SERVER_ERROR: its status, then the error', () => {
    const error = new APIError('INTERNAL_SERVER_ERROR', { message: 'Failed to create session' });
    onAuthApiError(error, { logger });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith('INTERNAL_SERVER_ERROR', error);
  });

  it('any other APIError: nothing', () => {
    onAuthApiError(new APIError('UNAUTHORIZED', { message: 'Invalid email or password' }), {
      logger,
    });
    onAuthApiError(new APIError('BAD_REQUEST', { message: 'State mismatch' }), { logger });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a thrown string: an empty name, then the value', () => {
    onAuthApiError('boom', { logger });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith('', 'boom');
  });
});

describe('reporting', () => {
  it('reports an unknown error once as auth.api', () => {
    const error = new Error('connection terminated unexpectedly');
    onAuthApiError(error, { logger });
    onAuthApiError(error, { logger });
    expect(captured).toEqual([{ error, context: { surface: 'auth.api' } }]);
  });

  it('reports an APIError INTERNAL_SERVER_ERROR', () => {
    const error = new APIError('INTERNAL_SERVER_ERROR');
    onAuthApiError(error, { logger });
    expect(captured.map(c => c.error)).toEqual([error]);
  });

  it('never reports a 4xx/503 APIError (expected refusals; the 503 cause is reported at its site)', () => {
    for (const status of [
      'UNAUTHORIZED',
      'BAD_REQUEST',
      'FORBIDDEN',
      'NOT_FOUND',
      'TOO_MANY_REQUESTS',
      'SERVICE_UNAVAILABLE',
    ] as const) {
      onAuthApiError(new APIError(status, { message: 'User does not exist' }), { logger });
    }
    expect(captured).toHaveLength(0);
  });

  it('without a reporter, only logs', () => {
    setErrorReporter(null);
    const error = new Error('x');
    onAuthApiError(error, { logger });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(0);
  });
});

describe('wired into better-auth', () => {
  it('the router hands it an endpoint fault and still answers 500', async () => {
    const onError = vi.fn(onAuthApiError);
    const fault = new Error('database unreachable');
    const auth = betterAuth({
      secret: 'test-secret-test-secret-test-secret-32',
      baseURL: 'http://localhost:3999',
      onAPIError: { onError },
      logger: { disabled: true },
      hooks: {
        before: createAuthMiddleware(async () => {
          throw fault;
        }),
      },
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await auth.handler(new Request('http://localhost:3999/api/auth/ok'));
    errors.mockRestore();

    expect(response.status).toBe(500);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(fault);
    expect(captured).toEqual([{ error: fault, context: { surface: 'auth.api' } }]);
  });

  it('a fault inside an endpoint handler reaches it too', async () => {
    const fault = new Error('adapter failed mid request');
    const auth = betterAuth({
      secret: 'test-secret-test-secret-test-secret-32',
      baseURL: 'http://localhost:3999',
      onAPIError: { onError: onAuthApiError },
      logger: { disabled: true },
      plugins: [
        {
          id: 'test-fault',
          endpoints: {
            fault: createAuthEndpoint('/test-fault', { method: 'GET' }, async () => {
              throw fault;
            }),
          },
        },
      ],
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await auth.handler(new Request('http://localhost:3999/api/auth/test-fault'));
    errors.mockRestore();

    expect(response.status).toBe(500);
    expect(captured).toEqual([{ error: fault, context: { surface: 'auth.api' } }]);
  });
});

describe('log parity with better-auth’s default', () => {
  /** What each instance's logger printed for one fault thrown by an endpoint hook. */
  const logsFor = async (fault: unknown, withHook: boolean) => {
    const lines: unknown[][] = [];
    const auth = betterAuth({
      secret: 'test-secret-test-secret-test-secret-32',
      baseURL: 'http://localhost:3999',
      ...(withHook ? { onAPIError: { onError: onAuthApiError } } : {}),
      logger: { log: (level, message, ...args) => lines.push([level, message, ...args]) },
      hooks: {
        before: createAuthMiddleware(async () => {
          throw fault;
        }),
      },
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await auth.handler(new Request('http://localhost:3999/api/auth/ok'));
    errors.mockRestore();
    return { status: response.status, lines };
  };

  it.each([
    ['an unknown error', () => new TypeError('x is undefined'), 1],
    ['a schema message', () => new Error('relation "session" does not exist'), 1],
    ['an APIError 500', () => new APIError('INTERNAL_SERVER_ERROR', { message: 'failed' }), 1],
    ['an APIError 401', () => new APIError('UNAUTHORIZED', { message: 'Invalid password' }), 0],
  ] as const)('%s: the same status and the same log lines', async (_label, make, logged) => {
    const fault = make();
    const before = await logsFor(fault, false);
    const after = await logsFor(fault, true);
    expect(before.lines).toHaveLength(logged);
    expect(after).toEqual(before);
  });
});
