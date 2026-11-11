/**
 * The Cloudflare Workers request scope, shared by index.ts (getPrisma,
 * runWithPrisma) and `@classmoji/database/wait-until`. Its own module so code
 * can keep work alive past the response without importing the Prisma client
 * (and so a test that mocks `@classmoji/database` still gets the real thing).
 */
import { isWorkerd } from '@classmoji/utils';
import { createRequestScope, type RequestScope } from './requestScope.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let scope: RequestScope<any, any> | null = null;

/** The scope, built on first use (Workers only: nothing exists before that). */
export function workerScope<Client extends object, Adapter>(
  createClient: (adapter: Adapter) => Client
): RequestScope<Client, Adapter> {
  return (scope ??= createRequestScope(createClient)) as RequestScope<Client, Adapter>;
}

/**
 * Work that must finish even though nobody awaits it (a last-seen write, an
 * audit row): on Workers it is handed to the request's `ctx.waitUntil`, since
 * the runtime may cancel whatever is still pending once the response is sent.
 * Off Workers this does nothing: the promise runs to completion on its own,
 * as before. Either way the caller handles the promise's rejection.
 */
export function waitUntil(promise: Promise<unknown>): void {
  if (!isWorkerd()) return;
  scope?.waitUntil(promise);
}
