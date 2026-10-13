import { describe, it, expect, vi } from 'vitest';

// BlockNote's server editor swaps the process's window/document while it
// works, so conversions must not overlap. A stand-in converter that yields
// mid-conversion records whether two were ever in flight at once.
const events: string[] = [];
let inFlight = 0;
let maxInFlight = 0;

vi.mock('@classmoji/page-schema/server', () => ({
  htmlToPageBlocks: async (html: string) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    events.push(`start:${html}`);
    await new Promise(resolve => setTimeout(resolve, 5));
    events.push(`end:${html}`);
    inFlight--;
    if (html === 'boom') throw new Error('conversion failed');
    return [{ type: 'paragraph', content: html }];
  },
}));

const { convertPageHtml } = await import('../pageHtmlBlocks.ts');

describe('convertPageHtml queue', () => {
  it('runs one conversion at a time, in call order', async () => {
    const results = await Promise.all(['a', 'b', 'c'].map(html => convertPageHtml(html)));

    expect(maxInFlight).toBe(1);
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
    expect(results.map(blocks => (blocks[0] as { content: string }).content)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('a failed conversion does not fail the ones queued behind it', async () => {
    const failed = convertPageHtml('boom');
    const next = convertPageHtml('after');

    await expect(failed).rejects.toThrow('conversion failed');
    await expect(next).resolves.toEqual([{ type: 'paragraph', content: 'after' }]);
  });
});
