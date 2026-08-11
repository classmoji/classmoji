/**
 * Unit tests for `filmstripEntries` — the single resolver both the top-level
 * order card and the per-stack child-order card use to turn an ordering (a list
 * of slide ids) into filmstrip thumbnails against the accept report's
 * `unit_previews` map.
 *
 * Regression guard for the child-order blank-thumbnail bug: a genuine
 * `__order__:<stackId>` conflict rides in the 409 `units[]` array (NOT the
 * separate `orderConflict` payload the top-level order uses), and its thumbnails
 * came back blank. These specs pin that BOTH id sources resolve html for every
 * referenced id through the SAME helper, so the two card types can never drift.
 *
 * The payloads below are copied verbatim from the SERVER's real accept report
 * for a stack whose three children are reordered on both sides — the exact shape
 * `deckPreview.service`'s `buildDeckUnitPreviews` + `splitDeckConflicts` emit
 * (units carry the `__order__:<stackId>` sentinel with child-id arrays;
 * `unit_previews` is keyed by those same child ids, each with `{index,title,
 * html}`). Runs in the Playwright runner WITHOUT a browser — the module is pure.
 */

import { test, expect } from '@playwright/test';
import {
  filmstripEntries,
  isChildOrderId,
  orderDiffIds,
  ORDER_CONFLICT_ID,
  type ConflictUnit,
  type UnitPreviews,
} from '../../app/components/preview/conflictChooser.ts';

// ── The real server accept-report body for a child-order conflict ────────────
// (stack `s14` at deck position 2; children c1,c2,c3 reordered on both sides.)
// Shape verified against deckPreview.service's report construction.
const CHILD_ORDER_UNIT: ConflictUnit = {
  id: `${ORDER_CONFLICT_ID}:s14`,
  index: '2',
  reason: 'child_order',
  base: ['c1', 'c2', 'c3'],
  ours: ['c2', 'c1', 'c3'],
  theirs: ['c1', 'c3', 'c2'],
};

const UNIT_PREVIEWS: UnitPreviews = {
  c2: { index: '2.1', title: 'Child Two', html: '<h3>Child Two</h3><p>beta</p>' },
  c1: { index: '2.2', title: 'Child One', html: '<h3>Child One</h3><p>alpha</p>' },
  c3: { index: '2.3', title: 'Child Three', html: '<h3>Child Three</h3><p>gamma</p>' },
};

test.describe('filmstripEntries — child-order card resolves child thumbnails', () => {
  test('the conflict unit IS a child-order sentinel carrying child-id arrays', () => {
    // Guards the assumptions the card reads: child order rides in units[] under
    // the __order__:<stackId> sentinel, with ours/theirs as child-id arrays.
    expect(isChildOrderId(CHILD_ORDER_UNIT.id)).toBe(true);
    expect(Array.isArray(CHILD_ORDER_UNIT.ours)).toBe(true);
    expect(Array.isArray(CHILD_ORDER_UNIT.theirs)).toBe(true);
  });

  test('EVERY child id in BOTH orderings resolves to its preview html', () => {
    const oursIds = CHILD_ORDER_UNIT.ours as string[];
    const theirsIds = CHILD_ORDER_UNIT.theirs as string[];
    const moved = orderDiffIds(oursIds, theirsIds);

    for (const [ids, label] of [
      [oursIds, 'ours'],
      [theirsIds, 'theirs'],
    ] as const) {
      const entries = filmstripEntries(ids, UNIT_PREVIEWS, moved);
      expect(entries, label).toHaveLength(ids.length);
      for (const entry of entries) {
        // The core assertion: the filmstrip receives HTML for every child id —
        // not just a title. A blank thumbnail = html dropped here.
        expect(entry.html, `${label} ${entry.id} html`).toBe(UNIT_PREVIEWS[entry.id].html);
        expect(entry.html, `${label} ${entry.id} html non-empty`).toBeTruthy();
        expect(entry.title, `${label} ${entry.id} title`).toBe(UNIT_PREVIEWS[entry.id].title);
      }
    }
  });

  test('positions are 1-based in each ordering and moved children are flagged', () => {
    const oursIds = CHILD_ORDER_UNIT.ours as string[];
    const theirsIds = CHILD_ORDER_UNIT.theirs as string[];
    const moved = orderDiffIds(oursIds, theirsIds);
    const entries = filmstripEntries(oursIds, UNIT_PREVIEWS, moved);

    expect(entries.map(e => [e.id, e.position])).toEqual([
      ['c2', 1],
      ['c1', 2],
      ['c3', 3],
    ]);
    // ours [c2,c1,c3] vs theirs [c1,c3,c2]: every child lands at a different
    // position across the two orderings, so all three get the moved (amber) ring.
    expect(entries.every(e => e.moved)).toBe(true);
  });

  test('the SAME helper resolves the top-level order card identically', () => {
    // Top-level order ids arrive via the orderConflict payload, not units[].
    // Resolving them through the same helper must yield html the same way —
    // proving the two card types share one resolution path.
    const ours = ['c1', 'c2', 'c3'];
    const theirs = ['c3', 'c2', 'c1'];
    const entries = filmstripEntries(ours, UNIT_PREVIEWS, orderDiffIds(ours, theirs));
    for (const entry of entries) {
      expect(entry.html).toBe(UNIT_PREVIEWS[entry.id].html);
    }
  });

  test('an id with no preview yields a title/html-less entry (thumbnail falls back to id)', () => {
    const entries = filmstripEntries(['c1', 'missing'], UNIT_PREVIEWS, new Set());
    expect(entries[0].html).toBe(UNIT_PREVIEWS.c1.html);
    expect(entries[1].html).toBeUndefined();
    expect(entries[1].title).toBe('');
    expect(entries[1].id).toBe('missing');
  });
});
