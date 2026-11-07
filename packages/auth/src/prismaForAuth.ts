/**
 * The Prisma client better-auth's adapter is given (./server.ts): the app's
 * own client, where a list column written as `null` is written as an empty
 * list instead.
 *
 * Prisma models a Postgres array column as a list that is never null: its
 * client refuses `null` for one ("Argument `allowedScopes` must not be
 * null"), and reads a NULL column back as `[]`. better-auth 1.7's
 * oauth-provider writes `null` for a list it has no value for (the
 * `allowedScopes` of the resource row it seeds at boot, for one), so every
 * such write would fail. `[]` is what Prisma reads back for NULL anyway, so
 * the stored value means the same to every reader.
 *
 * Only `null` values of scalar list fields, on create, createMany, update,
 * updateMany and upsert; everything else passes through unchanged.
 */

import { Prisma, type PrismaClient } from '@prisma/client';

const lowerFirst = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

/** Scalar list fields per model, keyed by the model name as Prisma reports it. */
const LIST_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Prisma.dmmf.datamodel.models.map(model => [
    model.name,
    new Set(model.fields.filter(f => f.kind === 'scalar' && f.isList).map(f => f.name)),
  ])
);

/** `data` with every null list field set to `[]`. */
export function withEmptyLists(model: string, data: unknown): unknown {
  const lists = LIST_FIELDS.get(model) ?? LIST_FIELDS.get(lowerFirst(model));
  if (!lists?.size || !data || typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(row => withEmptyLists(model, row));
  let changed: Record<string, unknown> | null = null;
  for (const field of lists) {
    if ((data as Record<string, unknown>)[field] === null) {
      changed ??= { ...(data as Record<string, unknown>) };
      changed[field] = [];
    }
  }
  return changed ?? data;
}

/**
 * The client for better-auth: `client` with null list writes made empty
 * lists. A stand-in without `$extends` (the unit tests') is returned as is.
 */
export function prismaForAuth<T extends PrismaClient>(client: T): T {
  if (typeof (client as { $extends?: unknown }).$extends !== 'function') return client;
  const listSafe =
    (data: (model: string, args: Record<string, unknown>) => Record<string, unknown>) =>
    ({
      model,
      args,
      query,
    }: {
      model: string;
      args: unknown;
      query: (a: never) => Promise<unknown>;
    }): Promise<unknown> =>
      query(data(model, args as Record<string, unknown>) as never);
  const dataOnly = (model: string, args: Record<string, unknown>) => ({
    ...args,
    data: withEmptyLists(model, args.data),
  });
  return client.$extends({
    query: {
      $allModels: {
        create: listSafe(dataOnly),
        createMany: listSafe(dataOnly),
        update: listSafe(dataOnly),
        updateMany: listSafe(dataOnly),
        upsert: listSafe((model, args) => ({
          ...args,
          create: withEmptyLists(model, args.create),
          update: withEmptyLists(model, args.update),
        })),
      },
    },
  }) as unknown as T;
}
