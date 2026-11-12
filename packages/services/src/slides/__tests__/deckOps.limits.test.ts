/**
 * Size caps on deck ops (DECK_OPS_LIMITS): each is checked before what it
 * caps is parsed, so an oversized payload is refused with one issue, and a
 * save the size of the largest real deck still parses.
 */
import { describe, expect, it } from 'vitest';
import { DECK_OPS_LIMITS, deckOpSchema, deckOpsPayloadSchema } from '../deckOps.ts';

function refusedOnce(result: { success: boolean; error?: { issues: unknown[] } }) {
  expect(result.success).toBe(false);
  expect(result.error?.issues).toHaveLength(1);
}

const keys = (n: number, value: unknown = 'x') =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`data-k${i}`, value]));

describe('deck op size caps', () => {
  it('parses a save the size of the largest real deck', () => {
    // About 120 slides with a few section attributes each, and a reorder of 50.
    const updates = Array.from({ length: 120 }, (_, i) => ({
      op: 'update',
      id: `s${i}`,
      html: `<h2>Slide ${i}</h2>`,
      attrs: keys(4),
    }));
    const reorder = {
      op: 'reorder',
      order: Array.from({ length: 50 }, (_, i) => `s${i}`),
    };
    const stack = {
      op: 'insert',
      slides: [
        {
          children: Array.from({ length: DECK_OPS_LIMITS.MAX_NEW_CHILDREN }, (_, i) => ({
            html: `<p>${i}</p>`,
            attrs: keys(4),
          })),
        },
      ],
      position: { at: 'end' },
    };
    expect(deckOpsPayloadSchema.safeParse([...updates, reorder, stack]).success).toBe(true);
  });

  it('refuses more ops than one save carries, with one issue', () => {
    refusedOnce(deckOpsPayloadSchema.safeParse(Array.from({ length: 100_000 }, () => 1)));
    refusedOnce(
      deckOpsPayloadSchema.safeParse(
        Array.from({ length: DECK_OPS_LIMITS.MAX_OPS + 1 }, (_, i) => ({
          op: 'delete',
          id: `s${i}`,
        }))
      )
    );
  });

  it('refuses a reorder over its cap, in the op schema the MCP tool uses too', () => {
    const order = Array.from({ length: DECK_OPS_LIMITS.MAX_ORDER + 1 }, (_, i) => `s${i}`);
    refusedOnce(deckOpSchema.safeParse({ op: 'reorder', order }));
    refusedOnce(deckOpSchema.safeParse({ op: 'reorder', order: order.map(() => 1) }));
    expect(deckOpSchema.safeParse({ op: 'reorder', order: order.slice(1) }).success).toBe(true);
  });

  it('refuses a slide with more attributes than the cap, with one issue', () => {
    const attrs = keys(DECK_OPS_LIMITS.MAX_ATTRS + 1);
    const update = deckOpSchema.safeParse({ op: 'update', id: 's1', attrs });
    refusedOnce(update);
    if (!update.success) {
      expect(update.error.issues[0].message).toBe(
        `A slide has at most ${DECK_OPS_LIMITS.MAX_ATTRS} attributes`
      );
    }
    refusedOnce(
      deckOpSchema.safeParse({
        op: 'insert',
        slides: [{ html: '<p>x</p>', attrs: keys(1_000_000, 1) }],
        position: { at: 'end' },
      })
    );
  });

  it('refuses inserts over their slide and child caps with one issue', () => {
    refusedOnce(
      deckOpSchema.safeParse({
        op: 'insert',
        slides: Array.from({ length: 50_000 }, () => 1),
        position: { at: 'end' },
      })
    );
    refusedOnce(
      deckOpSchema.safeParse({
        op: 'insert',
        slides: [{ children: Array.from({ length: 50_000 }, () => 1) }],
        position: { at: 'end' },
      })
    );
  });

  it('refuses a payload over the element budget with one issue, however it is nested', () => {
    // Every op, slide list and child list is within its own cap; together they are not.
    const ops = Array.from({ length: DECK_OPS_LIMITS.MAX_OPS }, () => ({
      op: 'insert',
      slides: Array.from({ length: DECK_OPS_LIMITS.MAX_INSERT_SLIDES }, () => ({
        children: Array.from({ length: DECK_OPS_LIMITS.MAX_NEW_CHILDREN }, () => ({ html: 1 })),
      })),
      position: { at: 'end' },
    }));
    refusedOnce(deckOpsPayloadSchema.safeParse(ops));
  });
});
