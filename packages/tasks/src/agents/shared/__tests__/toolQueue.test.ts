import { describe, expect, it } from 'vitest';
import { createToolQueue } from '../toolQueue.ts';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('createToolQueue', () => {
  it('runs bodies one at a time in call order', async () => {
    const queue = createToolQueue();
    const events: string[] = [];
    const slow = queue(async () => {
      events.push('a:start');
      await delay(20);
      events.push('a:end');
      return 'a';
    });
    const fast = queue(async () => {
      events.push('b:start');
      events.push('b:end');
      return 'b';
    });
    expect(await Promise.all([slow, fast])).toEqual(['a', 'b']);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('does not let a failure block the next body', async () => {
    const queue = createToolQueue();
    const failed = queue(async () => {
      throw new Error('first');
    });
    const next = queue(async () => 'second');
    await expect(failed).rejects.toThrow('first');
    await expect(next).resolves.toBe('second');
  });
});
