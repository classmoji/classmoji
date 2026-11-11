/**
 * The fetch handler a classmoji app exports from its `workers/app.ts`.
 *
 * Every request gets its own Prisma client on a Postgres connection opened
 * through the Worker's Hyperdrive binding (a connection belongs to the request
 * that opened it on workerd, so nothing is shared between requests), and the
 * app's React Router handler runs inside it with `{ cloudflare: { env, ctx } }`
 * as load context.
 */
import { runWithPrisma } from '@classmoji/database';
// eslint's resolver misses this subpath export; TypeScript resolves it.
// eslint-disable-next-line import/no-unresolved
import { PrismaPg } from '@classmoji/database/pg-adapter';

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

/** React Router's load context on Workers (`context.cloudflare` in loaders). */
export type WorkerLoadContext<Env = ClassmojiWorkerEnv> = {
  cloudflare: { env: Env; ctx: WorkerExecutionContext };
};

export type WorkerRequestHandler<Env> = (
  request: Request,
  loadContext: WorkerLoadContext<Env>
) => Promise<Response>;

export interface WorkerHandler<Env> {
  fetch(request: Request, env: Env, ctx: WorkerExecutionContext): Promise<Response>;
}

export function createWorkerHandler<Env extends ClassmojiWorkerEnv>(
  requestHandler: WorkerRequestHandler<Env>
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
      return runWithPrisma(adapter, () => requestHandler(request, { cloudflare: { env, ctx } }), {
        waitUntil: promise => ctx.waitUntil(promise),
      });
    },
  };
}
