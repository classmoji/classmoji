/**
 * Page comments: when the list is fetched again (`refetchPolicy.ts`), and
 * where the page-discussion strip sits. The rule is pure and called directly;
 * its wiring (the controller, the hook, the route) is pinned from source, the
 * `page-comments.spec.ts` approach for code that needs a browser to run.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import { COMMENTS_FRESH_MS, shouldRefetch } from '~/components/comments/refetchPolicy.ts';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const NOW = 1_800_000_000_000;

test.describe('shouldRefetch', () => {
  test('the freshness window is 30 s', () => {
    expect(COMMENTS_FRESH_MS).toBe(30_000);
  });

  for (const reason of ['panel', 'focus'] as const) {
    test(`${reason}: fetches when nothing was fetched on this page`, () => {
      expect(shouldRefetch({ reason, hasList: true, lastFetchAt: null, now: NOW })).toBe(true);
    });

    test(`${reason}: skipped while the list is younger than 30 s`, () => {
      for (const age of [0, 1_500, 29_999]) {
        expect(shouldRefetch({ reason, hasList: true, lastFetchAt: NOW - age, now: NOW })).toBe(
          false
        );
      }
    });

    test(`${reason}: fetches once the list is 30 s old or more`, () => {
      for (const age of [30_000, 30_001, 600_000]) {
        expect(shouldRefetch({ reason, hasList: true, lastFetchAt: NOW - age, now: NOW })).toBe(
          true
        );
      }
    });

    test(`${reason}: a clock that went backwards counts as fresh`, () => {
      expect(shouldRefetch({ reason, hasList: true, lastFetchAt: NOW + 5_000, now: NOW })).toBe(
        false
      );
    });

    test(`${reason}: fetches whenever no list is held, however fresh the stamp`, () => {
      // Never loaded here, or the last load failed: freshness does not apply.
      for (const age of [0, 1_500, 29_999]) {
        expect(shouldRefetch({ reason, hasList: false, lastFetchAt: NOW - age, now: NOW })).toBe(
          true
        );
      }
    });
  }

  for (const reason of ['mount', 'action'] as const) {
    test(`${reason}: always fetches, however fresh the list`, () => {
      expect(shouldRefetch({ reason, hasList: true, lastFetchAt: NOW, now: NOW })).toBe(true);
      expect(shouldRefetch({ reason, hasList: true, lastFetchAt: NOW - 1_000, now: NOW })).toBe(
        true
      );
      expect(shouldRefetch({ reason, hasList: false, lastFetchAt: null, now: NOW })).toBe(true);
    });
  }
});

test.describe('wiring', () => {
  const controller = source('../../app/components/comments/usePageCommentsController.ts');
  const hook = source('../../app/hooks/usePageComments.ts');
  const panel = source('../../app/components/comments/CommentsPanel.tsx');
  const route = source('../../app/routes/$classroomSlug.$pageId/route.tsx');

  test('panel opens and focus go through the freshness rule; nothing else loads directly', () => {
    // The only direct `load(` calls: the arrival load and the guarded refresh.
    const direct = controller.match(/void load\(/g) ?? [];
    expect(direct).toHaveLength(2);
    expect(controller).toMatch(/if \(enabled && openOnLoad > 0\) void load\(\{ quiet: true \}\)/);
    expect(controller).toMatch(
      /shouldRefetch\(\{\s*reason,\s*hasList: hasListRef\.current,\s*lastFetchAt: lastFetchAt\(\),\s*now: Date\.now\(\),?\s*\}\)/
    );
    expect(controller).toContain('hasListRef.current = threads !== null');
    expect(controller).toContain("refresh('focus'");
    expect(controller.match(/refresh\('panel'/g)?.length).toBeGreaterThanOrEqual(4);
    expect(controller).not.toContain('FOCUS_REFETCH_MS');
  });

  test('the hook stamps every successful list, whatever asked for it', () => {
    expect(hook).toContain('lastFetch.current = { pageId: page, at: requestedAt }');
    // Still refreshes after an own action, unguarded.
    expect(hook).toMatch(/Others may have written meanwhile[\s\S]*?void load\(\{ quiet: true \}\)/);
  });

  test('a page change clears the stamp (A → B → back to A starts A over)', () => {
    expect(hook).toMatch(
      /if \(seenPage !== pageId\) \{\s*setSeenPage\(pageId\);\s*lastFetch\.current = null;/
    );
  });

  test('a pending flash is dropped on close and tried once after the list loads', () => {
    expect(controller).toMatch(/const closePanel = useCallback\(\(\) => \{[^}]*setFlash\(null\);/);
    expect(panel).toMatch(
      /threads === null\)\s*return;\s*flashed\.current = flash\.nonce;\s*const card =/
    );
  });

  test('the strip mounts once, after the title and Draft chip, before every host', () => {
    const mounts = route.match(/<PageDiscussion /g) ?? [];
    expect(mounts).toHaveLength(1);
    const strip = route.indexOf('<PageDiscussion ');
    const draft = route.indexOf('Draft\n');
    const title = route.indexOf("{pageTitle || 'Untitled'}");
    // Every JSX host (git editor, live editor, live pre-sync viewer, viewer).
    const hosts = [...route.matchAll(/<(PageEditor|BlockNoteViewer)\n/g)].map(m => m.index ?? -1);
    expect(hosts.length).toBe(4);
    const firstHost = Math.min(...hosts);
    expect(title).toBeGreaterThan(0);
    expect(draft).toBeGreaterThan(title);
    expect(strip).toBeGreaterThan(draft);
    expect(strip).toBeLessThan(firstHost);
    // Only with a controller (null for anonymous, non-members, previews).
    expect(route).toMatch(/\{comments && \(\s*<PageDiscussion controller=\{comments\}/);
  });

  test('the strip reads the controller, never the API', () => {
    const strip = source('../../app/components/comments/PageDiscussion.tsx');
    expect(strip).not.toMatch(/fetch\(|load\(|api\/page-comments|dangerouslySetInnerHTML/);
  });
});
