/**
 * A Prisma client stand-in for unit tests that validates every query against
 * the REAL generated schema and never touches a database.
 *
 * WHY THIS EXISTS
 * ---------------
 * `apps/mcp` unit tests mock `@classmoji/database` (and `@classmoji/services`)
 * with plain `vi.fn()` stubs, so a query naming a field or model that does not
 * exist behaves exactly like a correct one: the stub answers, the assertion
 * passes, and the bug only surfaces against a live database. Two such bugs
 * shipped to production from the ai-agent surface — a `select` of
 * `Module.weight` (no such field) and a read of `prisma.repositoryAssignment`
 * (no such model; it is `GitRepoAssignment`) — and every call of those tools
 * threw for weeks with a green unit suite.
 *
 * The harness that caught them lived in the private submodule at
 * `apps/ai-agent/tests/databaseTools.unit.test.js`, attached to a file that
 * Phase 3 deletes. This is that harness, ported, generalised, and made
 * importable from any `apps/mcp` unit test (plan §5.8, P2-8).
 *
 * WHAT IT CHECKS
 * --------------
 * Every `select`, `include`, `where`, `orderBy` and `data` key of every query
 * is resolved against `Prisma.dmmf.datamodel.models` — the generated client's
 * own description of the schema, so it moves with each migration for free:
 *   - unknown field   -> `Unknown field \`x\` for where statement on model \`Page\`.`
 *   - unknown model   -> `Unknown model \`prisma.repositoryAssignment\`.`
 *   - nested `select` on a scalar -> `\`Page.title\` is scalar and cannot take a nested select.`
 *   - relation filters (`some` / `every` / `none` / `is` / `isNot`) recurse into
 *     the related model, as do nested selects, includes, ordering and the
 *     nested writes inside `data` (`connect` / `create` / `upsert` / ...).
 *
 * WHAT IT DOES NOT CHECK
 * ----------------------
 * Scalar filter operators (`{ contains }`, `{ gte }`, `{ in }`, ...) and scalar
 * update operators (`{ increment }`, ...) are passed over rather than
 * validated, because rejecting an unrecognised one would fail valid queries as
 * Prisma grows. Types are not checked either — this catches schema drift, not
 * type errors; `tsc` covers those. `$queryRaw` is recorded and answered from
 * canned rows without parsing (the search SQL in plan §5.6 is exercised by the
 * integration suite, against a real database).
 *
 * USAGE (the whole adoption cost, from a tools test):
 *
 *   vi.mock('@classmoji/database', async () =>
 *     (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock());
 *
 *   import { prismaCalls, setPrismaRows } from '../../__tests__/prismaSchemaStub.ts';
 *   setPrismaRows({ page: { findMany: [{ id: 'p1', title: 'Syllabus' }] } });
 *
 * The mock factory is `async` on purpose: vitest hoists `vi.mock` above the
 * imports, so the stub has to be pulled in from inside the factory, which runs
 * lazily at first import of the mocked module.
 */

import { Prisma } from '@prisma/client';

type DmmfModel = Prisma.DMMF.Model;
type DmmfField = Prisma.DMMF.Field;

/** Model name as it appears on the client: `GitRepoAssignment` -> `gitRepoAssignment`. */
const clientKey = (name: string): string => name[0].toLowerCase() + name.slice(1);

const MODELS_BY_NAME = new Map<string, DmmfModel>(
  Prisma.dmmf.datamodel.models.map(m => [m.name, m])
);
const MODELS_BY_CLIENT_KEY = new Map<string, DmmfModel>(
  Prisma.dmmf.datamodel.models.map(m => [clientKey(m.name), m])
);

/**
 * Result fields added by the `$extends` in `packages/database/index.ts`. They
 * are real on the client but absent from the DMMF, so they must be allowed in
 * `select` — and only there: a client-side computed field cannot be filtered,
 * ordered or written, so naming one in `where` / `orderBy` / `data` is a bug
 * and is reported as one. Keep this table in step with that file.
 */
const COMPUTED_SELECT_FIELDS: Record<string, readonly string[]> = {
  User: ['avatar_url'],
  Team: ['avatar_url'],
  GitOrganization: ['avatar_url'],
  Classroom: ['num_students', 'num_staff'],
  GitRepoAssignment: ['extension_hours', 'num_late_hours', 'is_late', 'should_be_zero'],
};

const LOGICAL_OPS = new Set(['AND', 'OR', 'NOT']);
const RELATION_FILTER_OPS = new Set(['some', 'every', 'none', 'is', 'isNot']);

/** `_count` is a client aggregate, not a schema field, and is legal in several clauses. */
const COUNT_KEY = '_count';

type Clause = unknown;
type QueryArgs = Record<string, unknown> | undefined;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

const isComputed = (model: DmmfModel, key: string): boolean =>
  (COMPUTED_SELECT_FIELDS[model.name] ?? []).includes(key);

const fieldOf = (model: DmmfModel, key: string): DmmfField | undefined =>
  model.fields.find(f => f.name === key);

const relatedModelOf = (field: DmmfField): DmmfModel | undefined =>
  field.kind === 'object' ? MODELS_BY_NAME.get(field.type) : undefined;

const unknownField = (model: DmmfModel, key: string, kind: string): Error =>
  new Error(`Unknown field \`${key}\` for ${kind} statement on model \`${model.name}\`.`);

const computedFieldMisuse = (model: DmmfModel, key: string, kind: string): Error =>
  new Error(
    `\`${model.name}.${key}\` is a client-extension computed field ` +
      `(packages/database/index.ts) and cannot be used in a ${kind} statement.`
  );

// ---------------------------------------------------------------------------
// Clause validators
// ---------------------------------------------------------------------------

function assertWhere(model: DmmfModel, clause: Clause): void {
  if (Array.isArray(clause)) {
    for (const entry of clause) assertWhere(model, entry);
    return;
  }
  if (!isPlainObject(clause)) return;

  for (const [key, value] of Object.entries(clause)) {
    if (LOGICAL_OPS.has(key)) {
      assertWhere(model, value);
      continue;
    }
    const field = fieldOf(model, key);
    if (!field) {
      if (isComputed(model, key)) throw computedFieldMisuse(model, key, 'where');
      throw unknownField(model, key, 'where');
    }
    const related = relatedModelOf(field);
    if (related) assertRelationFilter(related, value);
    // Scalars stop here: `{ contains }`, `{ gte }`, `{ in }` are operators, not fields.
  }
}

function assertRelationFilter(related: DmmfModel, value: Clause): void {
  if (!isPlainObject(value)) return; // `{ relation: null }` and friends
  const keys = Object.keys(value);
  if (keys.length > 0 && keys.every(k => RELATION_FILTER_OPS.has(k))) {
    for (const k of keys) assertWhere(related, value[k]);
    return;
  }
  // To-one shorthand: `where: { classroom: { slug: 'cs52' } }`.
  assertWhere(related, value);
}

function assertSelect(model: DmmfModel, clause: Clause, kind: 'select' | 'include'): void {
  if (!isPlainObject(clause)) return;

  for (const [key, value] of Object.entries(clause)) {
    if (key === COUNT_KEY) {
      if (isPlainObject(value)) assertSelect(model, value.select, 'select');
      continue;
    }

    const field = fieldOf(model, key);
    if (!field) {
      if (kind === 'select' && isComputed(model, key)) continue;
      if (isComputed(model, key)) throw computedFieldMisuse(model, key, kind);
      throw unknownField(model, key, kind);
    }

    const related = relatedModelOf(field);

    if (kind === 'include' && !related) {
      throw new Error(`\`${model.name}.${key}\` is scalar and cannot be included.`);
    }

    if (isPlainObject(value)) {
      if (!related) {
        throw new Error(`\`${model.name}.${key}\` is scalar and cannot take a nested select.`);
      }
      assertSelect(related, value.select, 'select');
      assertSelect(related, value.include, 'include');
      assertWhere(related, value.where);
      assertOrderBy(related, value.orderBy);
    }
  }
}

function assertOrderBy(model: DmmfModel, clause: Clause): void {
  if (Array.isArray(clause)) {
    for (const entry of clause) assertOrderBy(model, entry);
    return;
  }
  if (!isPlainObject(clause)) return;

  for (const [key, value] of Object.entries(clause)) {
    if (key === COUNT_KEY) continue; // `orderBy: { relation: { _count: 'desc' } }`
    const field = fieldOf(model, key);
    if (!field) {
      if (isComputed(model, key)) throw computedFieldMisuse(model, key, 'orderBy');
      throw unknownField(model, key, 'orderBy');
    }
    const related = relatedModelOf(field);
    if (related && isPlainObject(value)) assertOrderBy(related, value);
    // Scalars stop here: `{ sort: 'asc', nulls: 'last' }` are operators.
  }
}

function assertData(model: DmmfModel, clause: Clause): void {
  if (Array.isArray(clause)) {
    for (const entry of clause) assertData(model, entry);
    return;
  }
  if (!isPlainObject(clause)) return;

  for (const [key, value] of Object.entries(clause)) {
    const field = fieldOf(model, key);
    if (!field) {
      if (isComputed(model, key)) throw computedFieldMisuse(model, key, 'data');
      throw unknownField(model, key, 'data');
    }
    const related = relatedModelOf(field);
    if (related) assertNestedWrite(related, value);
    // Scalars stop here: `{ set }`, `{ increment }`, and Json columns take anything.
  }
}

/** `data: { relation: { connect | create | upsert | ... } }`. */
function assertNestedWrite(related: DmmfModel, value: Clause): void {
  if (!isPlainObject(value)) return;

  for (const [op, operand] of Object.entries(value)) {
    switch (op) {
      case 'create':
      case 'update': // to-one shorthand, or `{ where, data }` — both handled below
      case 'upsert':
      case 'connectOrCreate':
      case 'updateMany':
      case 'delete':
      case 'deleteMany':
      case 'disconnect':
      case 'connect':
      case 'set':
      case 'createMany':
        assertNestedWriteOperand(related, op, operand);
        break;
      default:
        // Unrecognised nested-write keys are left alone rather than rejected;
        // this harness is about schema drift, not API-surface completeness.
        break;
    }
  }
}

function assertNestedWriteOperand(related: DmmfModel, op: string, operand: Clause): void {
  if (Array.isArray(operand)) {
    for (const entry of operand) assertNestedWriteOperand(related, op, entry);
    return;
  }
  if (!isPlainObject(operand)) return; // `disconnect: true`, `delete: true`

  switch (op) {
    case 'connect':
    case 'disconnect':
    case 'set':
    case 'delete':
    case 'deleteMany':
      assertWhere(related, operand);
      return;
    case 'createMany':
      assertData(related, operand.data);
      return;
    case 'create':
      assertData(related, operand);
      return;
    case 'connectOrCreate':
      assertWhere(related, operand.where);
      assertData(related, operand.create);
      return;
    case 'update':
    case 'updateMany':
      if ('data' in operand || 'where' in operand) {
        assertWhere(related, operand.where);
        assertData(related, operand.data);
      } else {
        assertData(related, operand); // to-one shorthand
      }
      return;
    case 'upsert':
      assertWhere(related, operand.where);
      assertData(related, operand.create);
      assertData(related, operand.update);
      return;
    default:
      return;
  }
}

/** The clauses shared by every read: `select` / `include` / `where` / `orderBy`. */
function assertReadArgs(model: DmmfModel, args: QueryArgs): void {
  assertSelect(model, args?.select, 'select');
  assertSelect(model, args?.include, 'include');
  assertWhere(model, args?.where);
  assertOrderBy(model, args?.orderBy);
  assertWhere(model, args?.cursor);
  assertDistinct(model, args?.by);
  assertDistinct(model, args?.distinct);
}

/** `distinct` / `groupBy.by` are field names, flat. */
function assertDistinct(model: DmmfModel, clause: Clause): void {
  const names = Array.isArray(clause) ? clause : clause === undefined ? [] : [clause];
  for (const name of names) {
    if (typeof name !== 'string') continue;
    if (!fieldOf(model, name)) throw unknownField(model, name, 'distinct');
  }
}

// ---------------------------------------------------------------------------
// The stub itself
// ---------------------------------------------------------------------------

export interface RecordedCall {
  /** Schema model name, e.g. `GitRepoAssignment`. */
  model: string;
  /** Client key, e.g. `gitRepoAssignment`; `null` for `$`-level calls. */
  clientKey: string | null;
  method: string;
  args: unknown;
}

/** A canned answer: a value, or a function of the query args. */
type Canned = unknown | ((args: QueryArgs) => unknown);

/** Canned rows keyed by client model key, then by method. */
export type PrismaRows = Record<string, Record<string, Canned>>;

export interface PrismaStubDelegate {
  [method: string]: (args?: QueryArgs) => Promise<unknown>;
}

export interface PrismaStub {
  [model: string]: PrismaStubDelegate;
}

export interface ValidatingPrisma {
  /** Pass this wherever a `PrismaClient` is expected. */
  prisma: PrismaStub;
  /** Every query the code under test issued, in order. */
  calls: RecordedCall[];
  /** Supply canned answers; merges over anything already set. */
  setRows: (rows: PrismaRows) => void;
  /** Canned answer for `$queryRaw` / `$queryRawUnsafe`. */
  setRaw: (raw: Canned) => void;
  /** Clear calls, rows and raw answers. */
  reset: () => void;
  /** Calls narrowed to one model (and optionally one method). */
  callsFor: (clientModelKey: string, method?: string) => RecordedCall[];
}

const READ_METHODS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

const WRITE_METHODS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

const RAW_METHODS = new Set(['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe']);

export function createValidatingPrisma(initialRows: PrismaRows = {}): ValidatingPrisma {
  const calls: RecordedCall[] = [];
  let rows: PrismaRows = structuredCloneRows(initialRows);
  let raw: Canned;

  const answer = (key: string, method: string, args: QueryArgs, fallback: unknown): unknown => {
    const canned = rows[key]?.[method];
    if (canned === undefined) return fallback;
    return typeof canned === 'function' ? (canned as (a: QueryArgs) => unknown)(args) : canned;
  };

  function validateAndAnswer(model: DmmfModel, method: string, args: QueryArgs): unknown {
    const key = clientKey(model.name);
    calls.push({ model: model.name, clientKey: key, method, args });

    if (READ_METHODS.has(method)) {
      assertReadArgs(model, args);
    } else if (WRITE_METHODS.has(method)) {
      assertReadArgs(model, args);
      if (method === 'upsert') {
        assertData(model, args?.create);
        assertData(model, args?.update);
      } else {
        assertData(model, args?.data);
      }
    } else {
      throw new Error(
        `Unsupported method \`prisma.${key}.${method}()\` in the schema stub. ` +
          `Add it to prismaSchemaStub.ts if a tool needs it.`
      );
    }

    switch (method) {
      case 'findMany':
      case 'createManyAndReturn':
      case 'groupBy':
        return answer(key, method, args, []);
      case 'count':
        return answer(key, method, args, 0);
      case 'aggregate':
        return answer(key, method, args, {});
      case 'createMany':
      case 'updateMany':
      case 'deleteMany':
        return answer(key, method, args, {
          count: Array.isArray(args?.data) ? args.data.length : 0,
        });
      case 'create':
      case 'update':
        return answer(key, method, args, isPlainObject(args?.data) ? { ...args.data } : {});
      case 'upsert':
        return answer(key, method, args, isPlainObject(args?.create) ? { ...args.create } : {});
      case 'delete':
        return answer(key, method, args, {});
      case 'findFirstOrThrow':
      case 'findUniqueOrThrow': {
        const found = answer(key, method, args, null);
        if (found === null || found === undefined) {
          throw new Error(`No \`${model.name}\` record found for \`${method}\`.`);
        }
        return found;
      }
      default:
        // findFirst / findUnique
        return answer(key, method, args, null);
    }
  }

  const rawHandler =
    (method: string) =>
    async (...parts: unknown[]): Promise<unknown> => {
      calls.push({ model: '$raw', clientKey: null, method, args: parts });
      const fallback = method.startsWith('$execute') ? 0 : [];
      if (raw === undefined) return fallback;
      return typeof raw === 'function' ? (raw as (a: unknown) => unknown)(parts) : raw;
    };

  const topLevel: Record<string, unknown> = {
    $connect: async () => undefined,
    $disconnect: async () => undefined,
    $on: () => undefined,
    $use: () => undefined,
    $transaction: async (arg: unknown) => {
      calls.push({ model: '$transaction', clientKey: null, method: '$transaction', args: null });
      if (typeof arg === 'function') return (arg as (p: PrismaStub) => unknown)(prisma);
      if (Array.isArray(arg)) return Promise.all(arg);
      return undefined;
    },
  };
  for (const method of RAW_METHODS) topLevel[method] = rawHandler(method);

  const prisma = new Proxy({} as PrismaStub, {
    get: (_target, prop) => {
      if (typeof prop === 'symbol') return undefined;
      // Let `await prisma` and structural probes fall through instead of
      // being mistaken for a model named `then`.
      if (prop === 'then' || prop === 'toJSON' || prop === 'constructor') return undefined;

      if (prop === '$extends') return () => prisma;
      if (prop in topLevel) return topLevel[prop];
      if (prop.startsWith('$')) {
        throw new Error(`Unsupported client method \`prisma.${prop}()\` in the schema stub.`);
      }

      const model = MODELS_BY_CLIENT_KEY.get(prop);
      if (!model) throw new Error(`Unknown model \`prisma.${prop}\`.`);

      return new Proxy({} as PrismaStubDelegate, {
        get: (_d, method) => async (args?: QueryArgs) =>
          validateAndAnswer(model, String(method), args),
      });
    },
  });

  return {
    prisma,
    calls,
    setRows: next => {
      for (const [model, methods] of Object.entries(next)) {
        rows[model] = { ...(rows[model] ?? {}), ...methods };
      }
    },
    setRaw: next => {
      raw = next;
    },
    reset: () => {
      calls.length = 0;
      rows = structuredCloneRows(initialRows);
      raw = undefined;
    },
    callsFor: (key, method) =>
      calls.filter(c => c.clientKey === key && (method === undefined || c.method === method)),
  };
}

/** Shallow-per-model copy so `reset()` restores the constructor's rows. */
function structuredCloneRows(rows: PrismaRows): PrismaRows {
  return Object.fromEntries(
    Object.entries(rows).map(([model, methods]) => [model, { ...methods }])
  );
}

// ---------------------------------------------------------------------------
// Shared instance — the one-line adoption path
// ---------------------------------------------------------------------------

const shared = createValidatingPrisma();

export const validatingPrisma = shared.prisma;
export const prismaCalls = shared.calls;
export const setPrismaRows = shared.setRows;
export const setPrismaRaw = shared.setRaw;
export const resetPrismaStub = shared.reset;
export const prismaCallsFor = shared.callsFor;

/**
 * Module shape for `vi.mock('@classmoji/database', ...)` — both the default
 * export (`getPrisma`) and the named one, as `packages/database/index.ts`
 * exposes them.
 */
export function databaseModuleMock() {
  return {
    default: () => validatingPrisma,
    getPrisma: () => validatingPrisma,
  };
}
