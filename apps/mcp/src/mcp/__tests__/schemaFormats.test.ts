/**
 * Walks every tool's input schema, and the shared schemas behind them (team
 * sets, forms and their field types, deck and page ops, the quiz agent's
 * tools), for patterns whose meaning would change silently:
 *
 * - ids in uuid form use `uuidString()` and datetimes `isoDateTime()`
 *   (`@classmoji/utils/zod-formats`), never zod's own `.uuid()` or
 *   `.datetime()`, which accept less;
 * - no `.default()` directly under `.optional()` or `.nullable()` (the default
 *   is applied to an absent key);
 * - no object key that takes `undefined` without being optional (`z.unknown()`
 *   or `z.any()` as a key: an absent key is refused).
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

type Node = {
  _zod: {
    def: Record<string, any>;
    /** Absent on a check given as a plain function (`.check(fn)`). */
    traits?: Set<string>;
    optin?: string;
  };
  safeParse: (value: unknown) => { success: boolean };
};

const found = {
  uuidString: 0,
  isoDateTime: 0,
  strictUuid: [] as string[],
  zodDateTime: [] as string[],
  defaultUnderOptional: [] as string[],
  keyRefusedWhenAbsent: [] as string[],
};

function walk(node: Node | undefined, where: string, path: Set<Node>) {
  if (!node?._zod || path.has(node)) return;
  path = new Set(path).add(node);
  const def = node._zod.def;
  const kinds = [node, ...((def.checks ?? []) as Node[])];
  for (const kind of kinds) {
    const traits = kind._zod.traits ?? new Set<string>();
    if (traits.has('$ZodGUID')) found.uuidString++;
    if (traits.has('$ZodUUID')) found.strictUuid.push(where);
    if (traits.has('$ZodISODateTime')) found.zodDateTime.push(where);
    if (traits.has('$ZodCustomStringFormat') && kind._zod.def.format === 'datetime')
      found.isoDateTime++;
  }
  if (
    (def.type === 'optional' || def.type === 'nullable') &&
    def.innerType?._zod.def.type === 'default'
  ) {
    found.defaultUnderOptional.push(where);
  }
  if (def.type === 'object') {
    for (const [key, value] of Object.entries(def.shape as Record<string, Node>)) {
      if (value._zod.optin === undefined && value.safeParse(undefined).success) {
        found.keyRefusedWhenAbsent.push(`${where}.${key}`);
      }
      walk(value, `${where}.${key}`, path);
    }
    walk(def.catchall, `${where}.*`, path);
  }
  if (def.type === 'record') {
    walk(def.keyType, `${where}{key}`, path);
    walk(def.valueType, `${where}{}`, path);
  }
  if (def.type === 'pipe') {
    walk(def.in, where, path);
    walk(def.out, where, path);
  }
  if (def.type === 'array') walk(def.element, `${where}[]`, path);
  if (def.type === 'tuple')
    (def.items as Node[]).forEach((n, i) => walk(n, `${where}[${i}]`, path));
  if (def.type === 'union') (def.options as Node[]).forEach(n => walk(n, where, path));
  if (def.type === 'intersection') {
    walk(def.left, where, path);
    walk(def.right, where, path);
  }
  walk(def.innerType, where, path);
}

beforeAll(async () => {
  const { registerAllTools } = await import('../../tools/index.ts');
  const { listToolDefinitions } = await import('../registry.ts');
  registerAllTools();
  for (const tool of listToolDefinitions()) {
    walk(z.object(tool.inputSchema) as unknown as Node, tool.name, new Set());
  }
  const modules: Record<string, Record<string, unknown>> = {
    quizAgent: await import('@classmoji/utils/quiz-agent'),
    askMoji: await import('@classmoji/utils/ask-moji'),
    teamSet: await import('@classmoji/services/team-set-config'),
    deckOps: await import('@classmoji/services/slides/ops'),
    form: await import('@classmoji/services/form-contract'),
  };
  for (const [name, mod] of Object.entries(modules)) {
    for (const [key, value] of Object.entries(mod)) {
      if (value && typeof value === 'object' && '_zod' in value) {
        walk(value as Node, `${name}.${key}`, new Set());
      }
    }
  }
  const registry = (modules.form as { FIELD_TYPE_REGISTRY?: Record<string, { defSchema?: Node }> })
    .FIELD_TYPE_REGISTRY;
  for (const [type, entry] of Object.entries(registry ?? {})) {
    walk(entry.defSchema, `formField.${type}`, new Set());
  }
});

describe('shared schema formats', () => {
  it('reaches the uuid-form ids and datetimes', () => {
    expect(found.uuidString).toBeGreaterThan(100);
    expect(found.isoDateTime).toBeGreaterThan(20);
  });

  it('takes ids with uuidString() and datetimes with isoDateTime()', () => {
    expect(found.strictUuid).toEqual([]);
    expect(found.zodDateTime).toEqual([]);
  });

  it('has no default under optional or nullable, and no key refused when absent', () => {
    expect(found.defaultUnderOptional).toEqual([]);
    expect(found.keyRefusedWhenAbsent).toEqual([]);
  });
});
