/**
 * Throttle helper for provider-API loops.
 *
 * Lives in its own module so tests can `vi.mock` it away — a local `const sleep`
 * inside a service cannot be intercepted, and the rename/add-member queues would
 * otherwise make every unit test wait on real timers.
 */
export const sleep = async (ms: number): Promise<void> => {
  return new Promise(resolve => setTimeout(resolve, ms));
};
