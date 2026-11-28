import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  flushErrorReports,
  hasErrorReporter,
  markReported,
  reportError,
  setErrorReporter,
  wasReported,
  type ErrorReporter,
} from '../errorReport.ts';

const makeReporter = (flush: ErrorReporter['flush'] = async () => true) => {
  const capture = vi.fn<ErrorReporter['capture']>();
  const reporter: ErrorReporter = { capture, flush };
  return { reporter, capture };
};

afterEach(() => {
  setErrorReporter(null);
  vi.useRealTimers();
});

describe('reportError', () => {
  it('does nothing without a reporter', () => {
    expect(hasErrorReporter()).toBe(false);
    const error = new Error('x');
    expect(() => reportError(error, { surface: 'test' })).not.toThrow();
    // Not marked either: a reporter registered later still gets it.
    expect(wasReported(error)).toBe(false);
  });

  it('hands the error and context to the reporter', () => {
    const { reporter, capture } = makeReporter();
    setErrorReporter(reporter);
    const error = new Error('boom');
    const context = {
      surface: 'audit.write',
      tags: { classroom_id: 'c1' },
      level: 'warning' as const,
    };
    reportError(error, context);
    expect(capture).toHaveBeenCalledExactlyOnceWith(error, context);
  });

  it('reports one error object once', () => {
    const { reporter, capture } = makeReporter();
    setErrorReporter(reporter);
    const error = new Error('boom');
    reportError(error, { surface: 'a' });
    reportError(error, { surface: 'b' });
    expect(capture).toHaveBeenCalledOnce();
    expect(wasReported(error)).toBe(true);
  });

  it('shares the once-only set with markReported', () => {
    const { reporter, capture } = makeReporter();
    setErrorReporter(reporter);
    const error = new Error('seen by handleError first');
    markReported(error);
    reportError(error, { surface: 'a' });
    expect(capture).not.toHaveBeenCalled();
  });

  it('always passes primitives on (they cannot be tracked)', () => {
    const { reporter, capture } = makeReporter();
    setErrorReporter(reporter);
    reportError('a string', { surface: 'a' });
    reportError('a string', { surface: 'a' });
    expect(capture).toHaveBeenCalledTimes(2);
    expect(wasReported('a string')).toBe(false);
  });

  it('skips thrown Responses and aborts', () => {
    const { reporter, capture } = makeReporter();
    setErrorReporter(reporter);
    reportError(new Response(null, { status: 302 }), { surface: 'a' });
    reportError(new Response(null, { status: 500 }), { surface: 'a' });
    reportError(new DOMException('gone', 'AbortError'), { surface: 'a' });
    reportError(Object.assign(new Error('x'), { name: 'AbortError' }), { surface: 'a' });
    reportError(Object.assign(new Error('x'), { code: 'ABORT_ERR' }), { surface: 'a' });
    expect(capture).not.toHaveBeenCalled();
  });

  it('swallows a reporter that throws, and does not retry the error', () => {
    const capture = vi.fn(() => {
      throw new Error('reporter broke');
    });
    setErrorReporter({ capture, flush: async () => true });
    const error = new Error('boom');
    expect(() => reportError(error, { surface: 'a' })).not.toThrow();
    expect(() => reportError(error, { surface: 'a' })).not.toThrow();
    expect(capture).toHaveBeenCalledOnce();
  });

  it('survives hostile error objects', () => {
    const { reporter } = makeReporter();
    setErrorReporter(reporter);
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('getter trap');
        },
      }
    );
    expect(() => reportError(hostile, { surface: 'a' })).not.toThrow();
  });

  it('keeps its registry on globalThis, shared by every copy of the module', async () => {
    const { reporter, capture } = makeReporter();
    setErrorReporter(reporter);
    // A fresh evaluation of the module, as a second bundled copy would be.
    vi.resetModules();
    const copy = await import('../errorReport.ts');
    const error = new Error('from the other copy');
    copy.reportError(error, { surface: 'a' });
    expect(capture).toHaveBeenCalledOnce();
    // And the once-only set is the same one.
    reportError(error, { surface: 'a' });
    expect(capture).toHaveBeenCalledOnce();
  });
});

describe('flushErrorReports', () => {
  it('resolves at once without a reporter', async () => {
    await expect(flushErrorReports(10)).resolves.toBeUndefined();
  });

  it('waits for the reporter and passes the timeout on', async () => {
    const flush = vi.fn(async () => true);
    setErrorReporter({ capture: () => {}, flush });
    await flushErrorReports(1234);
    expect(flush).toHaveBeenCalledExactlyOnceWith(1234);
  });

  it('never rejects', async () => {
    setErrorReporter({ capture: () => {}, flush: () => Promise.reject(new Error('no network')) });
    await expect(flushErrorReports(50)).resolves.toBeUndefined();
    setErrorReporter({
      capture: () => {},
      flush: () => {
        throw new Error('sync throw');
      },
    });
    await expect(flushErrorReports(50)).resolves.toBeUndefined();
  });

  it('is bounded by its own timeout when the reporter hangs', async () => {
    vi.useFakeTimers();
    setErrorReporter({ capture: () => {}, flush: () => new Promise(() => {}) });
    let done = false;
    const flushing = flushErrorReports(2000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flushing;
    expect(done).toBe(true);
  });
});
