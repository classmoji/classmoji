// Test preload (`node --import`): every fetch fails, so a script's first
// network call errors without leaving the machine.
globalThis.fetch = async () => {
  throw new Error('offline (test preload)');
};
