import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce } from '../debounce.ts';

describe('debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('invokes once after the delay elapses', () => {
    const spy = vi.fn();
    const fn = debounce(spy, 100);
    fn();
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('coalesces rapid calls into a single invocation with the latest args', () => {
    const spy = vi.fn();
    const fn = debounce((...args: unknown[]) => spy(...args), 50);
    fn('a');
    vi.advanceTimersByTime(20);
    fn('b');
    vi.advanceTimersByTime(20);
    fn('c');
    vi.advanceTimersByTime(50);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('c');
  });

  it('cancel() prevents pending invocation', () => {
    const spy = vi.fn();
    const fn = debounce(spy, 100);
    fn();
    fn.cancel();
    vi.advanceTimersByTime(500);
    expect(spy).not.toHaveBeenCalled();
  });
});
