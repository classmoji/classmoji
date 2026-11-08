/* eslint-disable @typescript-eslint/no-explicit-any -- stands in for whatever
   argument shape better-auth's Prisma adapter passes. */
/**
 * Shared pieces for the suites that run the REAL `auth` (../../server.ts)
 * over a stand-in Prisma client.
 *
 * better-auth 1.7's Prisma adapter writes equality conditions as
 * `{ field: { equals: value } }` (several of them under `AND`) for reads, and
 * `{ field: value }` for updates and deletes
 * (@better-auth/prisma-adapter dist/index.mjs, `convertWhereClause`). The
 * stand-ins read `where.field` directly, so the client handed to
 * better-auth flattens every `where` first (standInClient).
 *
 * oauth-provider and the jwt plugin read and write their own models at boot
 * and on use (resource rows, signing keys); a model a suite doesn't care
 * about is added as a no-op.
 */

import { vi } from 'vitest';

/** `{ a: { equals: 1 }, AND: [{ b: { equals: 2 } }] }` → `{ a: 1, b: 2 }`. */
export function flatWhere(where: any): any {
  if (!where || typeof where !== 'object' || Array.isArray(where)) return where;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND' && Array.isArray(value)) {
      Object.assign(out, ...value.map(flatWhere));
    } else if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date) &&
      'equals' in value &&
      // `{ equals, mode: 'insensitive' }`: the stand-ins store one spelling.
      Object.keys(value).every(k => k === 'equals' || k === 'mode')
    ) {
      out[key] = (value as { equals: unknown }).equals;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** A model that stores nothing: reads find nothing, writes echo their data. */
export function standInModel(): Record<string, any> {
  return {
    findFirst: vi.fn(() => Promise.resolve(null)),
    findUnique: vi.fn(() => Promise.resolve(null)),
    findMany: vi.fn(() => Promise.resolve([])),
    create: vi.fn(({ data }: any) => Promise.resolve(data)),
    createMany: vi.fn(() => Promise.resolve({ count: 0 })),
    update: vi.fn(({ data }: any) => Promise.resolve(data)),
    updateMany: vi.fn(() => Promise.resolve({ count: 0 })),
    upsert: vi.fn(({ create }: any) => Promise.resolve(create)),
    delete: vi.fn(() => Promise.resolve({})),
    deleteMany: vi.fn(() => Promise.resolve({ count: 0 })),
    count: vi.fn(() => Promise.resolve(0)),
  };
}

/**
 * A model that keeps its rows in memory and matches a (flattened) `where` by
 * equality on every key. For the provider's own bookkeeping the suites don't
 * look at: the resource row it seeds at boot and reads on every authorization,
 * and the jwt plugin's signing keys.
 */
export function storedModel(): Record<string, any> {
  const rows: Record<string, any>[] = [];
  const matches = (where: any) => (row: Record<string, any>) =>
    Object.entries(where ?? {}).every(([k, v]) => row[k] === v);
  return {
    rows,
    findFirst: vi.fn(({ where }: any = {}) => Promise.resolve(rows.find(matches(where)) ?? null)),
    findUnique: vi.fn(({ where }: any = {}) => Promise.resolve(rows.find(matches(where)) ?? null)),
    findMany: vi.fn(({ where }: any = {}) => Promise.resolve(rows.filter(matches(where)))),
    create: vi.fn(({ data }: any) => {
      const row = { id: `${rows.length + 1}`, ...data };
      rows.push(row);
      return Promise.resolve(row);
    }),
    update: vi.fn(({ where, data }: any) => {
      const row = rows.find(matches(where));
      if (row) Object.assign(row, data);
      return Promise.resolve(row ?? data);
    }),
    delete: vi.fn(({ where }: any) => {
      const i = rows.findIndex(matches(where));
      return Promise.resolve(i >= 0 ? rows.splice(i, 1)[0] : {});
    }),
    deleteMany: vi.fn(({ where }: any = {}) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (matches(where)(rows[i]!)) rows.splice(i, 1);
      return Promise.resolve({ count: before - rows.length });
    }),
    count: vi.fn(({ where }: any = {}) => Promise.resolve(rows.filter(matches(where)).length)),
  };
}

/** Models that are kept in memory unless a suite stands in for them itself. */
const STORED_MODELS = new Set(['oauthResource', 'jwks']);

/** Every model the auth instance (or its hooks) may touch. */
export const AUTH_MODELS = [
  'user',
  'session',
  'account',
  'verification',
  'platformAuditLog',
  'oauthClient',
  'oauthResource',
  'oauthClientResource',
  'oauthRefreshToken',
  'oauthAccessToken',
  'oauthConsent',
  'oauthClientAssertion',
  'jwks',
  'legacyOauthApplication',
  'legacyOauthAccessToken',
  'legacyOauthConsent',
] as const;

/**
 * The client @classmoji/database's default export returns in these suites:
 * `client` with a model for each AUTH_MODELS entry it lacks (added to
 * `client` itself, so a suite can inspect them: in memory for STORED_MODELS,
 * a no-op otherwise), every `where` flattened
 * (flatWhere) before it reaches the stand-in, and a `$transaction` that runs
 * its callback on the same client when the suite has none.
 */
export function standInClient<T extends Record<string, any>>(client: T): T {
  for (const model of AUTH_MODELS) {
    if (!(client as any)[model]) {
      (client as any)[model] = STORED_MODELS.has(model) ? storedModel() : standInModel();
    }
  }
  const proxy: any = new Proxy(client, {
    get(target, prop) {
      if (prop === '$transaction' && !(prop in target)) {
        return async (arg: unknown) =>
          typeof arg === 'function'
            ? (arg as (tx: unknown) => unknown)(proxy)
            : Promise.all(arg as unknown[]);
      }
      const model = (target as any)[prop];
      if (!model || typeof model !== 'object') return model;
      return new Proxy(model, {
        get(m, method) {
          const fn = m[method];
          if (typeof fn !== 'function') return fn;
          return (args: any, ...rest: unknown[]) =>
            fn(
              args && typeof args === 'object' && 'where' in args
                ? { ...args, where: flatWhere(args.where) }
                : args,
              ...rest
            );
        },
      });
    },
  });
  return proxy;
}
