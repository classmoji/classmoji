import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runBackgroundTask } from '../backgroundTask.server';

/**
 * Regression coverage for the intermittent production crash where a
 * fire-and-forget `setTimeout(async () => { ... })` (see api.quiz/route.ts)
 * whose body — INCLUDING its own catch block — rejects, escaped as an
 * `unhandledRejection`. The global handler in @classmoji/database turns any
 * unhandledRejection into `process.exit(1)`, so a single failed background DB
 * write took down the entire SSR process for every user.
 *
 * runBackgroundTask must guarantee a rejected task can never become an
 * unhandled rejection.
 */
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
