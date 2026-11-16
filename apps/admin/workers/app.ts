/**
 * apps/admin as a Cloudflare Worker (BUILD_TARGET=cloudflare builds only; on
 * Fly, server.ts serves the same React Router build with Express).
 *
 * Every request gets its own Prisma client over the HYPERDRIVE binding
 * (@classmoji/workers/runtime). Static assets are served by Workers Assets
 * before the Worker runs. Loaders read the bindings with
 * `context.get(cloudflareContext)` (@classmoji/workers/context).
 */
import { createRequestHandler } from 'react-router';
import { createWorkerHandler, type ClassmojiWorkerEnv } from '@classmoji/workers/runtime';

const requestHandler = createRequestHandler(
  () => import('virtual:react-router/server-build'),
  import.meta.env.MODE
);

export default createWorkerHandler<ClassmojiWorkerEnv>(requestHandler);
