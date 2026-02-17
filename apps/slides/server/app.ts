import { createRequestHandler } from '@react-router/express';

export const app = createRequestHandler({
  // In dev, Vite handles the build via virtual module
  build: () => import('virtual:react-router/server-build'),
});
