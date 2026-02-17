/**
 * Creates a debounced function that delays invoking func until after delay milliseconds
 * have elapsed since the last time the debounced function was invoked.
 *
 * @param {Function} func - The function to debounce
 * @param {number} delay - The number of milliseconds to delay
 * @returns {Function} - The debounced function with a cancel method
 */
export function debounce(func, delay) {
  let timeoutId;

  const debounced = function (...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      func.apply(this, args);
    }, delay);
  };

  debounced.cancel = function () {
    clearTimeout(timeoutId);
  };

  return debounced;
}
