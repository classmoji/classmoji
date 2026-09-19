/**
 * The barrel's lazy write half, and what it does with a load that failed.
 *
 * The facades exist so that naming `createUpload` does not drag the AWS SDK
 * into a render path (see `renderGraph.test.ts`). The cost of that is a dynamic
 * import on the first write, and a dynamic import is a thing that can fail for
 * reasons the module knows nothing about — a chunk that did not arrive, a disk
 * that blinked. Caching the rejected promise would turn one bad moment into a
 * process that refuses every upload until it is restarted, which is the failure
 * this file exists to keep out.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));

const classroom = { id: '11111111-2222-4333-8444-555555555555' };

describe('the lazy write half', () => {
  it('retries a failed load instead of answering with the same rejection forever', async () => {
    let loads = 0;
    vi.doMock('../media.service.ts', () => {
      loads += 1;
      if (loads === 1) throw new Error('chunk load failed');
      return { usage: async () => ({ usedBytes: 0, quotaBytes: 0, perFileBytes: 0, isPro: false }) };
    });

    const media = await import('../index.ts');

    await expect(media.usage(classroom)).rejects.toThrow();
    expect(loads).toBe(1);

    // The second call has to reach the module again. A cached rejected promise
    // would answer from the failure above without ever asking.
    await expect(media.usage(classroom)).resolves.toMatchObject({ usedBytes: 0 });
    expect(loads).toBe(2);

    vi.doUnmock('../media.service.ts');
  });
});
