import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runBackgroundTask } from '../backgroundTask.server';

// A rejected fire-and-forget task must never surface as an unhandledRejection,
// which the global handler turns into a process exit.
describe('runBackgroundTask', () => {
  let unhandled: unknown[];
  const record = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', record);
  });

  afterEach(() => {
    process.off('unhandledRejection', record);
    vi.restoreAllMocks();
  });

  const flush = () => new Promise(resolve => setTimeout(resolve, 10));

  it('does not emit an unhandledRejection when the task rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    runBackgroundTask('test', async () => {
      throw new Error('background DB write failed');
    });

    await flush();

    expect(unhandled).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('does not emit an unhandledRejection when a synchronous throw occurs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    runBackgroundTask('test', () => {
      throw new Error('synchronous boom');
    });

    await flush();

    expect(unhandled).toHaveLength(0);
  });

  it('runs the task and lets successful work complete', async () => {
    const work = vi.fn(async () => {});

    runBackgroundTask('test', work);
    await flush();

    expect(work).toHaveBeenCalledOnce();
    expect(unhandled).toHaveLength(0);
  });
});
