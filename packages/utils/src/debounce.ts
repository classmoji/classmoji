interface DebouncedFunction<T extends (...args: unknown[]) => void> {
  (...args: Parameters<T>): void;
  cancel(): void;
}

/**
 * Creates a debounced function that delays invoking func until after delay milliseconds
 * have elapsed since the last time the debounced function was invoked.
 */
export function debounce<T extends (...args: unknown[]) => void>(
  func: T,
  delay: number
): DebouncedFunction<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const debounced = function (this: unknown, ...args: Parameters<T>) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      func.apply(this, args);
    }, delay);
  } as DebouncedFunction<T>;

  debounced.cancel = function () {
    clearTimeout(timeoutId);
  };

  return debounced;
}
