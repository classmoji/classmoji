/**
 * Every array and record that client input reaches is capped before its
 * elements are parsed, so an oversized one is refused with one issue rather
 * than one per element:
 *
 * - an array carries `.max()` (or `.length()`) among its LEADING size checks,
 *   the ones zod 4 checks before parsing the elements (`util.sizeCaps`); a
 *   `.refine()` placed before the `.max()` would make zod parse every element
 *   first;
 * - a record sits inside `capKeys` (@classmoji/utils/input-caps): zod has no
 *   size check for records.
 *
 * Walked: every MCP tool's input, the page and deck ops payloads the editors
 * save, every form field's answer, a quiz's code submission, and the team-set
 * config and patch (form_teams_run's `patch` and the teams page parse them).
 * The few exceptions are listed in ALLOWED.
 */

import { capArray, capElements, capKeys, inputCapOf } from '@classmoji/utils/input-caps';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

type Def = Record<string, any>;
type Node = { _zod: { def: Def } };

/** The exceptions, by where the walk finds them. */
const ALLOWED = new Set([
  'tool calendar_event_create.recurrence_rule (record)',
  'tool form_response_create.responses[].answers (record)',
  'tool form_teams_run.patch (record)',
  'team-set patch.options (record)',
  'team-set config.options (record)',
]);

const findings: string[] = [];
const seen = { arrays: 0, records: 0, capped: 0 };

/** zod 4's rule (`util.sizeCaps`): the leading length/size checks that set a maximum. */
function leadingMax(def: Def): boolean {
  for (const check of (def.checks ?? []) as Node[]) {
    const d = check._zod.def;
    if (!/_(length|size)$|_equals$/.test(String(d.check))) return false;
    if ((d.maximum ?? d.length ?? d.size) >= 0) return true;
  }
  return false;
}

function walk(node: Node | undefined, where: string, path: Set<Node>, keysCapped = false) {
  if (!node?._zod || path.has(node)) return;
  path = new Set(path).add(node);
  const def = node._zod.def;
  switch (def.type) {
    case 'array':
      seen.arrays++;
      if (leadingMax(def)) seen.capped++;
      else findings.push(`${where} (array)`);
      walk(def.element, `${where}[]`, path);
      return;
    case 'record':
      seen.records++;
      if (keysCapped) seen.capped++;
      else findings.push(`${where} (record)`);
      walk(def.keyType, `${where}{key}`, path);
      walk(def.valueType, `${where}{}`, path);
      return;
    case 'object':
      for (const [key, value] of Object.entries(def.shape as Record<string, Node>)) {
        walk(value, `${where}.${key}`, path);
      }
      walk(def.catchall, `${where}.*`, path);
      return;
    case 'pipe': {
      const cap = inputCapOf(node);
      walk(def.in, where, path);
      walk(def.out, where, path, cap?.kind === 'keys');
      return;
    }
    case 'union':
      (def.options as Node[]).forEach((option, i) => walk(option, `${where}|${i}`, path));
      return;
    case 'intersection':
      walk(def.left, where, path);
      walk(def.right, where, path);
      return;
    case 'tuple':
      (def.items as Node[]).forEach((item, i) => walk(item, `${where}[${i}]`, path));
      if (def.rest) findings.push(`${where} (tuple rest)`);
      return;
    case 'set':
    case 'map':
      findings.push(`${where} (${def.type})`);
      return;
    case 'lazy':
      walk(def.getter(), where, path);
      return;
    default:
      // optional, nullable, default, prefault, catch, readonly, nonoptional,
      // promise: the schema they wrap. Primitives have none.
      walk(def.innerType, where, path, keysCapped);
  }
}

/** One field of every answering type, as small as its definition allows. */
function fieldOfEachType(): Array<Record<string, unknown>> {
  const options = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ];
  const base = (type: string, extra: Record<string, unknown> = {}) => ({
    id: `f_${type}`,
    type,
    label: type,
    required: false,
    ...extra,
  });
  return [
    base('short_text'),
    base('long_text'),
    base('email'),
    base('number'),
    base('dropdown', { options }),
    base('multiselect', { options }),
    base('switch'),
    base('opinion_scale', { scale: { min: 1, max: 5 } }),
    base('roster_select', { options, multiple: true }),
    base('ranked_choice', { options, ranks: 2 }),
    base('matrix', { matrix: { rows: options, columns: options, required_rows: 'none' } }),
    base('repeat_group', {
      fields: [base('short_text', { id: 'inner' })],
      repeat: { require_all_targets: false },
    }),
  ];
}

beforeAll(async () => {
  const { registerAllTools } = await import('../../tools/index.ts');
  const { listToolDefinitions } = await import('../registry.ts');
  registerAllTools();
  for (const tool of listToolDefinitions()) {
    walk(z.object(tool.inputSchema) as unknown as Node, `tool ${tool.name}`, new Set());
  }

  const { ClassmojiService } = await import('@classmoji/services');
  walk(
    ClassmojiService.pageContent.pageBlockOpsPayloadSchema as unknown as Node,
    'page ops',
    new Set()
  );
  const { deckOpsPayloadSchema } = await import('@classmoji/services/slides/ops');
  walk(deckOpsPayloadSchema as unknown as Node, 'deck ops', new Set());

  const { buildResponseSchema, FIELD_TYPE_REGISTRY } =
    await import('@classmoji/services/form-contract');
  const fields = fieldOfEachType();
  const answering = Object.entries(FIELD_TYPE_REGISTRY).filter(
    ([, spec]) => (spec as { kind: string }).kind === 'input'
  );
  expect(fields.map(f => f.type).sort()).toEqual(answering.map(([type]) => type).sort());
  const answers = buildResponseSchema(fields as never, {
    resolved: { f_repeat_group: [{ user_id: 'u1' }] } as never,
  });
  walk(answers as unknown as Node, 'form answers', new Set());

  const { CodeSubmissionInputSchema } = await import('@classmoji/utils/quiz-agent');
  walk(CodeSubmissionInputSchema as unknown as Node, 'quiz code submission', new Set());

  const { TeamSetConfigPatchSchema, TeamSetConfigSchema } =
    await import('@classmoji/services/team-set-config');
  walk(TeamSetConfigPatchSchema as unknown as Node, 'team-set patch', new Set());
  walk(TeamSetConfigSchema as unknown as Node, 'team-set config', new Set());
}, 60_000);

describe('arrays and records in client input', () => {
  it('walks them all', () => {
    expect(seen.arrays).toBeGreaterThan(40);
    expect(seen.records).toBeGreaterThan(10);
    expect(seen.capped).toBeGreaterThan(40);
  });

  it('caps every one before its elements are parsed, or lists it', () => {
    expect(findings.filter(where => !ALLOWED.has(where))).toEqual([]);
  });

  it('lists no exception the walk no longer meets', () => {
    expect([...ALLOWED].filter(where => !findings.includes(where))).toEqual([]);
  });
});

describe('the walk itself', () => {
  /** What the walk flags in `schema`, left out of the real findings above. */
  function flagged(schema: z.ZodType): string[] {
    const start = findings.length;
    walk(schema as unknown as Node, 'probe', new Set());
    return findings.splice(start);
  }

  it('flags an array with no maximum, or one checked only after a refinement', () => {
    expect(flagged(z.object({ a: z.array(z.string()) }))).toEqual(['probe.a (array)']);
    expect(flagged(z.array(z.string()).min(1))).toEqual(['probe (array)']);
    expect(
      flagged(
        z
          .array(z.string())
          .refine(() => true)
          .max(3)
      )
    ).toEqual(['probe (array)']);
  });

  it('passes an array with a leading maximum, however it is wrapped', () => {
    expect(
      flagged(
        z
          .array(z.string())
          .max(3)
          .refine(() => true)
      )
    ).toEqual([]);
    expect(flagged(z.array(z.string()).min(1).max(3).optional())).toEqual([]);
    expect(flagged(capArray(z.array(z.string()).max(3), 3).nullish())).toEqual([]);
  });

  it('flags a record unless capKeys checks it first', () => {
    const record = () => z.record(z.string(), z.number());
    expect(flagged(z.object({ r: record() }))).toEqual(['probe.r (record)']);
    expect(flagged(z.object({ r: capKeys(record(), 5).optional() }))).toEqual([]);
    expect(
      flagged(
        capKeys(
          record().refine(() => true),
          5
        )
      )
    ).toEqual([]);
    expect(flagged(capElements(record(), 50))).toEqual(['probe (record)']);
  });
});
