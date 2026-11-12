/**
 * Size caps on page block ops (PAGE_OPS_LIMITS): each is checked before what
 * it caps is parsed, so an oversized payload is refused with one issue, and
 * the largest real page still fits in one save.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../content/ContentService.ts', () => ({ ContentService: {} }));

const { PAGE_OPS_LIMITS, pageBlockOpSchema, pageBlockOpsPayloadSchema } =
  await import('../pageContent.service.ts');
const { countJsonElements } = await import('@classmoji/utils/input-caps');

const KITCHEN_SINK = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../page-schema/src/__tests__/fixtures/kitchen-sink.content.json',
        import.meta.url
      )
    ),
    'utf8'
  )
) as { blocks: Array<Record<string, unknown>> };

/**
 * The kitchen-sink fixture repeated to the shape of the largest real page
 * measured: about 620 top-level blocks and 13,700 elements.
 */
function largestRealPage(): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  for (let i = 0; blocks.length < 620; i++) {
    const source = KITCHEN_SINK.blocks[i % KITCHEN_SINK.blocks.length];
    blocks.push({ ...structuredClone(source), id: `b${i}` });
  }
  return blocks;
}

function refusedOnce(result: { success: boolean; error?: { issues: unknown[] } }) {
  expect(result.success).toBe(false);
  expect(result.error?.issues).toHaveLength(1);
}

describe('page block op size caps', () => {
  it('saves the largest real page, as one replace_all and as inserts', () => {
    const blocks = largestRealPage();
    expect(countJsonElements(blocks)).toBeGreaterThan(13_000);

    const replace = [{ op: 'replace_all', blocks }];
    expect(pageBlockOpsPayloadSchema.safeParse(replace).success).toBe(true);

    const inserts = [
      { op: 'insert', blocks: blocks.slice(0, 400), position: { at: 'start' } },
      { op: 'insert', blocks: blocks.slice(400), position: { at: 'end' } },
    ];
    expect(pageBlockOpsPayloadSchema.safeParse(inserts).success).toBe(true);
  });

  it('refuses more ops than one save carries, with one issue', () => {
    const ops = Array.from({ length: 100_000 }, () => ({ op: 'delete' }));
    refusedOnce(pageBlockOpsPayloadSchema.safeParse(ops));
    const justOver = Array.from({ length: PAGE_OPS_LIMITS.MAX_OPS + 1 }, (_, i) => ({
      op: 'delete',
      id: `b${i}`,
    }));
    const result = pageBlockOpsPayloadSchema.safeParse(justOver);
    refusedOnce(result);
    if (!result.success) {
      expect(result.error.issues[0]).toMatchObject({
        code: 'too_big',
        origin: 'array',
        maximum: PAGE_OPS_LIMITS.MAX_OPS,
      });
    }
  });

  it('refuses a replace_all over its block cap, in the op schema the MCP tool uses too', () => {
    const blocks = Array.from({ length: PAGE_OPS_LIMITS.MAX_REPLACE_ALL_BLOCKS + 1 }, (_, i) => ({
      id: `b${i}`,
    }));
    refusedOnce(pageBlockOpSchema.safeParse({ op: 'replace_all', blocks }));
    refusedOnce(pageBlockOpSchema.safeParse({ op: 'replace_all', blocks: blocks.map(() => 1) }));
    expect(
      pageBlockOpSchema.safeParse({ op: 'replace_all', blocks: blocks.slice(1) }).success
    ).toBe(true);
  });

  it('refuses an insert over its block cap with one issue', () => {
    const blocks = Array.from({ length: 50_000 }, () => 1);
    refusedOnce(pageBlockOpSchema.safeParse({ op: 'insert', blocks, position: { at: 'end' } }));
  });

  it('refuses a block with more keys than a block has, with one issue', () => {
    const block = Object.fromEntries(
      Array.from({ length: PAGE_OPS_LIMITS.MAX_BLOCK_KEYS + 1 }, (_, i) => [`k${i}`, i])
    );
    const result = pageBlockOpSchema.safeParse({ op: 'update', id: 'b1', block });
    refusedOnce(result);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        `A block has at most ${PAGE_OPS_LIMITS.MAX_BLOCK_KEYS} keys`
      );
    }
  });

  it('refuses a payload over the element budget with one issue, however it is nested', () => {
    // Every op and every block list is within its own cap; together they are not.
    const ops = Array.from({ length: PAGE_OPS_LIMITS.MAX_OPS }, () => ({
      op: 'insert',
      blocks: Array.from({ length: PAGE_OPS_LIMITS.MAX_INSERT_BLOCKS }, () => 1),
      position: { at: 'end' },
    }));
    refusedOnce(pageBlockOpsPayloadSchema.safeParse(ops));
    refusedOnce(
      pageBlockOpsPayloadSchema.safeParse([
        { op: 'replace_all', blocks: Array.from({ length: 1_000_000 }, () => 1) },
      ])
    );
  });
});
