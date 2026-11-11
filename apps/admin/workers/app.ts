/* eslint-disable import/no-unresolved -- virtual module resolved by Vite */
/**
 * apps/admin as a Cloudflare Worker (BUILD_TARGET=cloudflare builds only; on
 * Fly, server.ts serves the same React Router build with Express).
 *
 * Every request gets its own Prisma client over the HYPERDRIVE binding
 * (@classmoji/workers/runtime). Static assets are served by Workers Assets
 * before the Worker runs.
 */
import { createRequestHandler } from 'react-router';
import {
  createWorkerHandler,
  type ClassmojiWorkerEnv,
  type WorkerExecutionContext,
} from '@classmoji/workers/runtime';

declare module 'react-router' {
  interface AppLoadContext {
    cloudflare: { env: ClassmojiWorkerEnv; ctx: WorkerExecutionContext };
  }
}

const requestHandler = createRequestHandler(
  () => import('virtual:react-router/server-build'),
  import.meta.env.MODE
);

export default createWorkerHandler<ClassmojiWorkerEnv>(requestHandler);
