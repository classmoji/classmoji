/**
 * Unit tests for `assetResolveContext` (`app/utils/assetRefs.server.ts`).
 *
 * This is the pages app's half of the per-classroom gate. The service refuses
 * to sign for a classroom whose flag is false, but only if the flag reaches it
 * — and it reaches it through here. A context built without the column reads as
 * `undefined` downstream, so the builder pins it to a real boolean, and pins it
 * CLOSED: "the row was loaded without asking for the column" and "the classroom
 * is switched off" have to be the same answer, or the safe direction is the one
 * you get by accident.
 */

import { test, expect } from '@playwright/test';
import { assetResolveContext } from '../../app/utils/assetRefs.server.ts';

const classroom = {
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  content_key_version: 7,
  content_repo: 'content-dartmouth-cs52-cs52-25s',
  content_delivery_enabled: true,
  git_organization: { login: 'dartmouth-cs52' },
};

test.describe('assetResolveContext', () => {
  test('carries the classroom flag through to the resolver', () => {
    expect(assetResolveContext(classroom, 'enrolled')?.classroom.content_delivery_enabled).toBe(
      true
    );
  });

  test('a flag that is false, null or absent all read as off', () => {
    for (const value of [false, null, undefined]) {
      const ctx = assetResolveContext(
        { ...classroom, content_delivery_enabled: value as boolean | null },
        'enrolled'
      );
      // Never `undefined` — a real `false`, because the resolver compares
      // strictly and "I did not ask" must not be able to mean yes.
      expect(ctx?.classroom.content_delivery_enabled).toBe(false);
    }
  });

  test('is null for a classroom the delivery layer cannot serve at all', () => {
    // No content repo and no git org are normal states, not failures — every
    // caller degrades to the stored references, which is what the page did
    // before any of this existed.
    expect(assetResolveContext({ ...classroom, content_repo: '' }, 'enrolled')).toBeNull();
    expect(assetResolveContext({ ...classroom, git_organization: null }, 'enrolled')).toBeNull();
    expect(assetResolveContext(null, 'enrolled')).toBeNull();
  });

  test('passes the tier through untouched', () => {
    for (const tier of ['public', 'enrolled', 'draft'] as const) {
      expect(assetResolveContext(classroom, tier)?.tier).toBe(tier);
    }
  });
});
