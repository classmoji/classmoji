import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runBackgroundTask } from '../backgroundTask.server';

// A rejected fire-and-forget task must never surface as an unhandledRejection,
// which the global handler turns into a process exit.
describe('runBackgroundTask', () => {
  // Tag-scoped listener: only count rejections this test deliberately produces,
  // so a foreign rejection leaking from another test can never flake us.
  const TAG = '__backgroundTask_test__';
  let unhandled: unknown[];
  const record = (reason: unknown) => {
    if (reason instanceof Error && reason.message.includes(TAG)) {
      unhandled.push(reason);
    }
  };

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', record);
  });

  afterEach(() => {
    process.off('unhandledRejection', record);
    vi.restoreAllMocks();
  });

  // Deterministic settle: wait until the suppression console.error has fired (or
  // the success spy has run), then flush the microtask queue once more so any
  // would-be unhandledRejection has had its chance to be emitted.
  const microtaskFlush = () => new Promise<void>(resolve => queueMicrotask(() => resolve()));

  it('does not emit an unhandledRejection when the task rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const boom = new Error(`${TAG} background DB write failed`);
    runBackgroundTask('test', async () => {
      throw boom;
    });

    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    await microtaskFlush();

    // The suppression log must be label-tagged and carry the original error so
    // swallowed failures remain diagnosable in production logs.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[backgroundTask:test\] background work failed/),
      boom
    );
    expect(unhandled).toHaveLength(0);
  });

  it('does not emit an unhandledRejection when a synchronous throw occurs', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    runBackgroundTask('test', () => {
      throw new Error(`${TAG} synchronous boom`);
    });

    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled());
    await microtaskFlush();

    expect(unhandled).toHaveLength(0);
  });

  it('runs the task and lets successful work complete', async () => {
    const work = vi.fn(async () => {});

    runBackgroundTask('test', work);

    await vi.waitFor(() => expect(work).toHaveBeenCalledOnce());
    await microtaskFlush();

    expect(unhandled).toHaveLength(0);
  });
});
