/**
 * Save before presenting asks collab for a FLUSH-ONLY checkpoint (the
 * presenter is not credited as a co-author); Save version is not flush-only.
 * The collab call is stubbed at `fetch`; an `alreadySaved` reply answers
 * without touching the database.
 */
import { test, expect } from '@playwright/test';

import {
  checkpointBeforePresenting,
  deckCheckpointBody,
} from '../../app/utils/collab/collab.server.ts';

const actor = { userId: 'u1', name: 'Ada Lovelace' };

test.describe('deck checkpoint requests', () => {
  test('the body: flushOnly only when asked', () => {
    expect(deckCheckpointBody(actor)).toEqual({ actor });
    expect(deckCheckpointBody(actor, { message: 'v2', requestId: 'sv-12345678' })).toEqual({
      actor,
      message: 'v2',
      requestId: 'sv-12345678',
    });
    expect(deckCheckpointBody(actor, { flushOnly: true })).toEqual({ actor, flushOnly: true });
  });

  test('save before presenting sends flushOnly', async () => {
    const saved = {
      COLLAB_URL: process.env.COLLAB_URL,
      COLLAB_INTERNAL_SECRET: process.env.COLLAB_INTERNAL_SECRET,
    };
    const realFetch = globalThis.fetch;
    const bodies: unknown[] = [];
    process.env.COLLAB_URL = 'http://collab.test';
    process.env.COLLAB_INTERNAL_SECRET = 'secret';
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? 'null'));
      return new Response(JSON.stringify({ version: 3, requestId: 'x', alreadySaved: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const outcome = await checkpointBeforePresenting(
        { id: 'deck-1', classroom: { collab_enabled: true } },
        actor
      );
      expect(outcome).toBe('saved');
      expect(bodies).toEqual([{ actor, flushOnly: true }]);
    } finally {
      globalThis.fetch = realFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
