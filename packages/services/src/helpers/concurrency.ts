/** Bounded concurrency for service reads and writes. */

/**
 * `Promise.all(items.map(fn))`, with at most `limit` calls of `fn` in flight.
 *
 * Results come back in INPUT order, whatever order the calls finish in. The
 * first rejection rejects the whole call, as `Promise.all` would, and stops
 * the workers taking new items: the calls already running finish, but nothing
 * further is started for a batch that has already failed.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;

  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker())
  );
  return results;
}
