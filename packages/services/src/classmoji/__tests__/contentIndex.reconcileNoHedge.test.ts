/**
 * The index reconcile reads every classroom's files in the background, four at
 * a time, and nobody is waiting on it. It must read without a hedge: a second
 * request there would only double the load on a Worker that is already slow.
 */

import { describe, it, expect, vi } from 'vitest';

const fetchContentText = vi.fn();

vi.mock('@classmoji/database', () => ({ default: () => ({}) }));
vi.mock('../contentDelivery.service.ts', () => ({
  fetchContentText: (...args: unknown[]) => fetchContentText(...args),
}));

const { deliveryFetchBody } = await import('../contentIndex.service.ts');

describe('the reconcile byte source', () => {
  it('reads through the delivery ladder with the hedge off', async () => {
    fetchContentText.mockResolvedValue({ text: 'bytes', sha: 'a'.repeat(40), source: 'worker' });
    const classroom = { id: 'c1' } as Parameters<typeof deliveryFetchBody>[0];

    const got = await deliveryFetchBody(classroom, 'pages/a/content.json');

    expect(got).toEqual({ text: 'bytes', sha: 'a'.repeat(40) });
    expect(fetchContentText).toHaveBeenCalledWith({ classroom }, 'pages/a/content.json', {
      label: 'index-reconcile',
      hedge: false,
    });
  });
});
