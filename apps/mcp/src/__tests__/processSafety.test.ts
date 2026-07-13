/**
 * Unit tests for the process-level safety nets (finding F2, S5).
 *
 * The handlers are registered on an INJECTED EventEmitter (never the real
 * process), so behavior is verified without risking the test runner: an
 * unhandledRejection is logged and the server keeps serving (no exit); an
 * uncaughtException is logged and hands off to onFatal(1).
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  logUncaughtException,
  logUnhandledRejection,
  registerProcessSafetyNets,
} from '../processSafety.ts';

function makeLogger() {
  return { error: vi.fn(), fatal: vi.fn() };
}

describe('registerProcessSafetyNets (F2)', () => {
  let logger: ReturnType<typeof makeLogger>;
  let onFatal: ReturnType<typeof vi.fn<(code: number) => void>>;
  let target: EventEmitter;

  beforeEach(() => {
    logger = makeLogger();
    onFatal = vi.fn<(code: number) => void>();
    target = new EventEmitter();
    registerProcessSafetyNets(logger, { onFatal, target });
  });

  it('registers a listener for both crash events', () => {
    expect(target.listenerCount('unhandledRejection')).toBeGreaterThan(0);
    expect(target.listenerCount('uncaughtException')).toBeGreaterThan(0);
  });

  it('unhandledRejection is logged and keeps serving (does NOT exit)', () => {
    target.emit('unhandledRejection', new Error('detached boom'));
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('uncaughtException is logged and exits once with code 1', () => {
    target.emit('uncaughtException', new Error('fatal boom'));
    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe('safety-net log helpers (F2)', () => {
  it('logUnhandledRejection tags the entry and wraps a non-Error reason', () => {
    const logger = makeLogger();
    logUnhandledRejection(logger, 'a bare string reason');
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [obj] = logger.error.mock.calls[0] as [{ err: Error; tag: string }];
    expect(obj.tag).toBe('unhandledRejection');
    expect(obj.err).toBeInstanceOf(Error);
    expect(obj.err.message).toContain('a bare string reason');
  });

  it('logUncaughtException tags the entry with the original error', () => {
    const logger = makeLogger();
    const err = new Error('boom');
    logUncaughtException(logger, err);
    expect(logger.fatal).toHaveBeenCalledTimes(1);
    const [obj] = logger.fatal.mock.calls[0] as [{ err: Error; tag: string }];
    expect(obj.tag).toBe('uncaughtException');
    expect(obj.err).toBe(err);
  });
});
