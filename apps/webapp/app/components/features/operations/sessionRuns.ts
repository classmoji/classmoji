/**
 * Watches every run carrying a session tag and reports the whole list as it
 * changes. Plain functions, no React, so the parts that went wrong before can
 * be tested directly.
 *
 * Why not `useRealtimeRunsWithTag`: it merges each update into a copy of the
 * list that only refreshes after React renders, so two updates arriving
 * together drop the first, and a dropped final status is never resent.
 *
 * What this does instead:
 * - Every update lands in one map kept for the whole watch, so a reconnect
 *   overwrites runs it has seen rather than rebuilding the list from nothing.
 * - The list is reported in batches: a (re)connect replays its snapshot one run
 *   at a time within a few milliseconds, and a partial list must never be
 *   mistaken for the whole operation.
 * - A connection that goes quiet is reopened, which replays a fresh snapshot.
 * - A connection we closed ourselves is never an error. Aborting a fetch in
 *   flight surfaces as all sorts of errors, not only `AbortError`, so the
 *   signal decides, not the error's name.
 * - A connection that fails is reopened a few times before giving up.
 */

export interface RunSource {
  subscribeToRunsWithTag(
    tag: string,
    filters: Record<string, never>,
    options: { signal?: AbortSignal; onFetchError?: (error: Error) => void }
  ): AsyncIterable<unknown>;
}

export interface WatchOptions<T> {
  onRuns: (runs: T[]) => void;
  /** Only after the connection has failed `maxReconnects` times in a row. */
  onError: (error: Error) => void;
  applyEveryMs?: number;
  quietMs?: number;
  maxReconnects?: number;
}

export const watchSessionRuns = <T extends { id: string }>(
  client: RunSource,
  tag: string,
  { onRuns, onError, applyEveryMs = 250, quietMs = 15_000, maxReconnects = 3 }: WatchOptions<T>
) => {
  const byId = new Map<string, T>();
  let dirty = false;
  let stopped = false;
  let failures = 0;
  let lastUpdate = Date.now();
  let controller: AbortController | null = null;

  const connect = () => {
    if (stopped) return;
    const current = new AbortController();
    controller = current;
    lastUpdate = Date.now();

    const fail = (error: Error) => {
      // Closed by us (quiet reconnect, stop): whatever it threw is expected.
      if (stopped || current.signal.aborted) return;
      current.abort();
      failures += 1;
      if (failures > maxReconnects) {
        stop();
        onError(error);
        return;
      }
      connect();
    };

    (async () => {
      const subscription = client.subscribeToRunsWithTag(
        tag,
        {},
        { signal: current.signal, onFetchError: fail }
      );
      for await (const run of subscription) {
        if (current.signal.aborted) return;
        byId.set((run as T).id, run as T);
        dirty = true;
        lastUpdate = Date.now();
        failures = 0;
      }
    })().catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
  };

  const apply = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    onRuns(Array.from(byId.values()));
  }, applyEveryMs);

  const quiet = setInterval(
    () => {
      if (Date.now() - lastUpdate <= quietMs) return;
      controller?.abort();
      connect();
    },
    Math.max(quietMs / 3, applyEveryMs)
  );

  const stop = () => {
    stopped = true;
    controller?.abort();
    clearInterval(apply);
    clearInterval(quiet);
  };

  connect();
  return stop;
};
