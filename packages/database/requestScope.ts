import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A database client per request, for Cloudflare Workers.
 *
 * On workerd a database connection belongs to the request that opened it (an
 * I/O object can't be used from another request), so there is no
 * process-wide client. Each request runs inside `run(adapter, fn)`, which
 * builds a client on that request's adapter; `client` is a stand-in that
 * resolves the CURRENT request's client on every property access. That keeps
 * import-time captures working: better-auth's `prismaAdapter(getPrisma())`
 * and `export const prisma = getPrisma()` hold the stand-in, not a client.
 *
 * Kept free of Prisma so it can be tested on Node with any factory.
 */
export interface RequestScopeOptions {
  /** The request's `ctx.waitUntil`: keeps work alive after the response. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface RequestScope<Client extends object, Adapter> {
  /** Forwards every access to the running request's client; throws outside one. */
  readonly client: Client;
  /** Runs `fn` with a fresh client on `adapter` as the current one. */
  run<T>(adapter: Adapter, fn: () => Promise<T>, options?: RequestScopeOptions): Promise<T>;
  /**
   * Hands `promise` to the running request's `waitUntil`. Returns false (and
   * does nothing) outside a request or when the run was given none.
   */
  waitUntil(promise: Promise<unknown>): boolean;
}

interface Store<Client> {
  client: Client;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export function createRequestScope<Client extends object, Adapter>(
  createClient: (adapter: Adapter) => Client
): RequestScope<Client, Adapter> {
  const storage = new AsyncLocalStorage<Store<Client>>();

  const current = (prop: PropertyKey): Client => {
    const client = storage.getStore()?.client;
    if (!client) {
      throw new Error(
        `[database] Prisma used outside a request (property ${String(prop)}). On Workers every ` +
          'database call must run inside runWithPrisma().'
      );
    }
    return client;
  };

  const client = new Proxy({} as Client, {
    get(_target, prop) {
      // Promise-resolution probes (`await getPrisma()`, a client returned from
      // an async function) must not throw outside a request.
      if (prop === 'then') return undefined;
      const target = current(prop);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(_target, prop) {
      return Reflect.has(current(prop), prop);
    },
    set(_target, prop, value) {
      return Reflect.set(current(prop), prop, value);
    },
  });

  return {
    client,
    // No explicit disconnect: a streamed response can still be reading after
    // `fn` resolves, and the runtime closes the request's sockets when the
    // request ends.
    run: (adapter, fn, options = {}) =>
      storage.run({ client: createClient(adapter), waitUntil: options.waitUntil }, fn),
    waitUntil(promise) {
      const waitUntil = storage.getStore()?.waitUntil;
      if (!waitUntil) return false;
      waitUntil(promise);
      return true;
    },
  };
}
