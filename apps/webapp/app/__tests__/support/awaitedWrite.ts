import { expect, vi, type Mock } from 'vitest';

/**
 * Whether `run` waits for the write `mock` stands for: the mock's promise is
 * held open, and `run` must not finish until it is released. A loader or
 * action that fires the write without awaiting it finishes first and fails
 * here. Only the next call is held. Returns what `run` resolved with.
 */
export async function expectAwaitsWrite<T>(mock: Mock, run: () => Promise<T>): Promise<T> {
  let release!: () => void;
  let released = false;
  mock.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        release = () => {
          released = true;
          resolve();
        };
      })
  );
  let finished = false;
  const pending = run().then(value => {
    finished = true;
    return value;
  });
  await vi.waitFor(() => expect(mock).toHaveBeenCalled());
  // Every chance to finish without the write: several turns of the event loop.
  for (let turn = 0; turn < 10; turn++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(finished).toBe(false);
  release();
  const value = await pending;
  expect(released).toBe(true);
  return value;
}
