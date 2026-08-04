/**
 * Unit tests for the page editor's save/conflict decision helpers (saveState.ts).
 *
 * These run in the Playwright runner WITHOUT a browser or the dev stack — the
 * module under test is pure (no React, no network). It carries the load-bearing
 * logic of the review findings' client fixes so they're verifiable in isolation:
 *  - P1: the diff-at-save (ops) path is trustworthy ONLY when the baseline is
 *        bound to the sha the conflict token names (a cover-write desync must
 *        force the whole-document save).
 *  - P4: a conflict report/chooser is derived ONLY when the fetcher data is
 *        stamped for the current page (no ghosting across in-route navigation).
 *  - P9: a code-bearing refusal being auto-recovered by the fallback must not
 *        flash 'error'.
 */

import { test, expect } from '@playwright/test';
import {
  opsPathEligible,
  fetcherMatchesPage,
  deriveSaveMergeReport,
  deriveSaveConflict,
  isCodeFallbackRefusal,
  type SaveBaseline,
  type SaveFetcherData,
} from '../../app/routes/$classroomSlug.$pageId/saveState.ts';

const baseline = (sha: string | null, content = '[]'): SaveBaseline => ({ sha, content });

// ─── P1: ops-path pairing guard ──────────────────────────────────────────────

test.describe('opsPathEligible (P1 pairing guard)', () => {
  test('eligible when the baseline sha matches the conflict token', () => {
    expect(opsPathEligible(baseline('sha-A'), 'sha-A')).toBe(true);
  });

  test('NOT eligible when the token advanced past the baseline (cover-write desync)', () => {
    // Baseline is the loaded document (sha-A); a cover write advanced the token
    // to sha-B without re-basing this document — the ops must NOT replay onto
    // sha-B, so the whole-document save is taken instead.
    expect(opsPathEligible(baseline('sha-A'), 'sha-B')).toBe(false);
  });

  test('NOT eligible without a token (fresh / legacy page → whole-doc create)', () => {
    expect(opsPathEligible(baseline('sha-A'), null)).toBe(false);
    expect(opsPathEligible(baseline(null), null)).toBe(false);
  });

  test('NOT eligible before the editor onReady captures a baseline', () => {
    expect(opsPathEligible(null, 'sha-A')).toBe(false);
  });
});

// ─── P4: per-page stamping ────────────────────────────────────────────────────

test.describe('fetcher-to-page stamping (P4)', () => {
  test('matches only the page the exchange was stamped for', () => {
    expect(fetcherMatchesPage('page-A', 'page-A')).toBe(true);
    expect(fetcherMatchesPage('page-A', 'page-B')).toBe(false);
  });

  const conflictData: SaveFetcherData = {
    conflict: true,
    units: [{ id: 'a1', index: 0 }],
    autoMerged: 2,
    oursSha: 'sha-A-1',
  };

  test('a conflict report renders on the page it was stamped for', () => {
    const report = deriveSaveMergeReport(conflictData, /* matchesPage */ true);
    expect(report).toEqual({ units: [{ id: 'a1', index: 0 }], autoMerged: 2, oursSha: 'sha-A-1' });
  });

  test('the SAME report does NOT render after navigating to another page (no ghost)', () => {
    expect(deriveSaveMergeReport(conflictData, /* matchesPage */ false)).toBeNull();
  });

  test('the plain reload banner is also gated to the stamped page', () => {
    const legacyConflict: SaveFetcherData = { conflict: true };
    // On the stamped page: banner shows (no mergeable report).
    expect(deriveSaveConflict(legacyConflict, true, null)).toBe(true);
    // After navigation: neither chooser nor banner ghosts onto the next page.
    expect(deriveSaveConflict(legacyConflict, false, null)).toBe(false);
  });

  test('a mergeable report suppresses the plain reload banner', () => {
    const report = deriveSaveMergeReport(conflictData, true);
    expect(deriveSaveConflict(conflictData, true, report)).toBe(false);
  });
});

// ─── P9: code-bearing refusal during auto-fallback ────────────────────────────

test.describe('isCodeFallbackRefusal (P9)', () => {
  test('true for a code-bearing refusal that is NOT a conflict (fallback in flight)', () => {
    expect(isCodeFallbackRefusal({ error: 'x', code: 'OPS_BASE_MISMATCH' })).toBe(true);
    expect(isCodeFallbackRefusal({ error: 'x', code: 'OPS_MALFORMED' })).toBe(true);
  });

  test('false for a mergeable conflict (the chooser handles it, not the fallback)', () => {
    expect(isCodeFallbackRefusal({ conflict: true, code: 'OPS_BASE_MISMATCH' })).toBe(false);
  });

  test('false for a plain error and for success', () => {
    expect(isCodeFallbackRefusal({ error: 'boom' })).toBe(false);
    expect(isCodeFallbackRefusal({ success: true, sha: 'sha-1' })).toBe(false);
    expect(isCodeFallbackRefusal(undefined)).toBe(false);
  });
});
