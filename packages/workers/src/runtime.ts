/**
 * The fetch handler a classmoji app exports from its `workers/app.ts`.
 *
 * Every request gets its own Prisma client on a Postgres connection opened
 * through the Worker's Hyperdrive binding (a connection belongs to the request
 * that opened it on workerd, so nothing is shared between requests), and the
 * app's React Router handler runs inside it with `{ env, ctx }` in its load
 * context (`context.get(cloudflareContext)`, ./context.ts).
 */
import { RouterContextProvider } from 'react-router';
import { runWithPrisma } from '@classmoji/database';
import { PrismaPg } from '@classmoji/database/pg-adapter';

import { cloudflareContext } from './context.ts';

/** The Hyperdrive binding's shape (`env.HYPERDRIVE`). */
export interface HyperdriveBinding {
  connectionString: string;
}

/** What every classmoji Worker is bound to; the rest of `env` is vars and secrets. */
export interface ClassmojiWorkerEnv {
  HYPERDRIVE?: HyperdriveBinding;
  /** The version metadata binding: which Worker version is answering. */
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
  [key: string]: unknown;
}

/** The part of the Workers `ExecutionContext` handlers use. */
export interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

/** React Router's request handler, as `createRequestHandler` returns it. */
export type WorkerRequestHandler = (
  request: Request,
  loadContext: RouterContextProvider
) => Promise<Response>;

export interface WorkerHandler<Env> {
  fetch(request: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response>;
}

export function createWorkerHandler<Env extends ClassmojiWorkerEnv>(
  requestHandler: WorkerRequestHandler
): WorkerHandler<Env> {
  return {
    async fetch(request, env, ctx) {
      const connectionString = env.HYPERDRIVE?.connectionString;
      if (!connectionString) {
        // A build without an environment (no `--env`/CLOUDFLARE_ENV) has no
        // bindings at all; say so instead of failing on the first query.
        console.error('[workers] the HYPERDRIVE binding is missing: no database for this request');
        return new Response('Service misconfigured', { status: 503 });
      }
      const adapter = new PrismaPg({ connectionString });
      // `waitUntil()` from @classmoji/database hands work to this request's
      // ctx.waitUntil, so un-awaited writes outlive the response.
      const loadContext = new RouterContextProvider();
      loadContext.set(cloudflareContext, { env, ctx });
      return runWithPrisma(adapter, () => requestHandler(request, loadContext), {
        waitUntil: promise => ctx.waitUntil(promise),
      });
    },
  };
}
