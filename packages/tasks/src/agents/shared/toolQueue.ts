/**
 * A FIFO queue for one attempt run's tool executes.
 *
 * The AI SDK starts every tool call of a step together once the model call
 * ends, in the order the model emitted them. Two calls in one step would then
 * race on the same attempt row (for example, recording question 2's result
 * and presenting question 3). Each execute hands its body to the queue as its
 * first statement, so bodies run one at a time, in emission order, and a
 * failure in one does not block the ones after it.
 */
export type ToolQueue = <T>(fn: () => Promise<T>) => Promise<T>;

export function createToolQueue(): ToolQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}
