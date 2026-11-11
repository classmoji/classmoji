/**
 * The ops the editor's diff emits (blockOpsDiff.ts) parse with the schema the
 * server reads an ops save with (pageBlockOpsPayloadSchema), whose op
 * envelopes refuse keys they do not declare.
 *
 * Real pages (the page-schema and content fixtures) get seeded random edits:
 * a block's props and text changed, blocks deleted, inserted and moved. Each
 * op list goes through JSON as the route posts it. Runs in the Playwright
 * runner without a browser or the dev stack.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { ClassmojiService } from '@classmoji/services';
import { diffBlockOps } from '../../app/components/editor/blockOpsDiff.ts';

type Block = Record<string, unknown>;

const schema = ClassmojiService.pageContent.pageBlockOpsPayloadSchema;

function fixture(relative: string): Block[] {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const blocks = (Array.isArray(doc) ? doc : doc.blocks) as Block[];
  return blocks.map((block, i) => ({ ...block, id: (block.id as string) || `fixture-${i}` }));
}

const PAGES: Record<string, Block[]> = {
  'kitchen-sink': fixture(
    '../../../../packages/page-schema/src/__tests__/fixtures/kitchen-sink.content.json'
  ),
  'sample-home': fixture(
    '../../../../packages/services/src/content/extract/__tests__/fixtures/sample-page-home.content.json'
  ),
  'sample-prelab': fixture(
    '../../../../packages/services/src/content/extract/__tests__/fixtures/sample-page-prelab.content.json'
  ),
};

/** A small seeded generator (mulberry32), so a failure replays. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const viaJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function edited(base: Block[], seed: number): Block[] {
  const r = random(seed);
  const page = structuredClone(base);
  for (let step = 1 + Math.floor(r() * 4); step > 0; step--) {
    const pick = r();
    const at = Math.floor(r() * page.length);
    if (pick < 0.35 && page.length > 0) {
      const block = page[at];
      block.props = { ...((block.props as object) ?? {}), textColor: 'red' };
      block.content = [{ type: 'text', text: `edited ${seed}`, styles: { bold: true } }];
    } else if (pick < 0.55 && page.length > 1) {
      page.splice(at, 1);
    } else if (pick < 0.8) {
      const fresh = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, k) => ({
        id: `new-${seed}-${step}-${k}`,
        type: 'paragraph',
        props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' },
        content: [{ type: 'text', text: 'new', styles: {} }],
        children: [],
      }));
      page.splice(at, 0, ...fresh);
    } else if (page.length > 2) {
      const [moved] = page.splice(at, 1);
      page.splice(Math.floor(r() * page.length), 0, moved);
    }
  }
  return page;
}

test.describe('editor ops and the server payload schema', () => {
  test('every op list the diff emits on real pages parses', () => {
    const kinds = new Set<string>();
    let lists = 0;
    for (const [name, base] of Object.entries(PAGES)) {
      for (let seed = 1; seed <= 150; seed++) {
        const ops = diffBlockOps(viaJson(base) as never, viaJson(edited(base, seed)) as never);
        if (!ops || ops.length === 0) continue;
        lists++;
        for (const op of ops) kinds.add(op.op);
        const parsed = schema.safeParse(viaJson(ops));
        expect(parsed.success, `${name} #${seed}: ${JSON.stringify(parsed.error?.issues[0])}`).toBe(
          true
        );
      }
    }
    expect(lists).toBeGreaterThan(300);
    expect([...kinds].sort()).toEqual(['delete', 'insert', 'move', 'update']);
  });

  test('a key an op does not declare is refused and named; a block takes any key', () => {
    const open = schema.safeParse([
      { op: 'update', id: 'a', block: { id: 'a', type: 'x', legacyKey: 1, props: { old: 1 } } },
    ]);
    expect(open.success).toBe(true);
    const refused = schema.safeParse([{ op: 'update', id: 'a', block: { id: 'a' }, clientRev: 3 }]);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['clientRev'],
      path: [0],
    });
  });
});
