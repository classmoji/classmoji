import { describe, it, expect, vi } from 'vitest';
import { COLLAB_COMMIT_TRAILER } from '@classmoji/collab';

import {
  COLLAB_TRAILER,
  createCollabExternalTrigger,
  isCollabCommit,
  notifyCollabOfPush,
  type CollabExternalPayload,
  type CollabPrisma,
} from '../src/collabExternal.ts';

/** Unit tests for the pieces the route tests can't pin down directly. */

const HEAD = 'c'.repeat(40);
const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('the trailer', () => {
  it('matches @classmoji/collab (repeated in hook-station to keep yjs out)', () => {
    expect(COLLAB_TRAILER).toBe(COLLAB_COMMIT_TRAILER);
  });

  it('counts only for a Bot sender, in the final paragraph, with a run id', () => {
    const bot = { type: 'Bot' };
    expect(isCollabCommit({ message: 'Update A\n\nClassmoji-Collab: run_1' }, bot)).toBe(true);
    expect(
      isCollabCommit(
        { message: 'Update A\r\n\r\nClassmoji-Collab: run_1\r\nCo-authored-by: x' },
        bot
      )
    ).toBe(true);
    expect(
      isCollabCommit({ message: 'Update A\n\nClassmoji-Collab: run_1' }, { type: 'User' })
    ).toBe(false);
    expect(isCollabCommit({ message: 'Update A\n\nClassmoji-Collab: run_1' }, undefined)).toBe(
      false
    );
    expect(isCollabCommit({ message: 'Classmoji-Collab: run_1\n\nBody after' }, bot)).toBe(false);
    expect(isCollabCommit({ message: 'Update A\n\nClassmoji-Collab:' }, bot)).toBe(false);
    expect(isCollabCommit({ message: 'mentions Classmoji-Collab: x inline' }, bot)).toBe(false);
  });
});

describe('the every-row fallback', () => {
  it('keeps at most 4 triggers in flight', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({
      kind: i % 2 ? 'deck' : 'page',
      doc_id: `doc-${i}`,
      pushed_commit: null,
    }));
    const prisma = {
      page: { findMany: vi.fn(async () => []) },
      slide: { findMany: vi.fn(async () => []) },
      collabDoc: { findMany: vi.fn(async () => rows) },
    } as unknown as CollabPrisma;

    let inFlight = 0;
    let peak = 0;
    const seen: string[] = [];
    const trigger = vi.fn(async (p: CollabExternalPayload) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      seen.push(p.docId);
      inFlight--;
    });

    await notifyCollabOfPush(
      {
        classroomId: 'c1',
        collabEnabled: true,
        after: HEAD,
        before: 'a'.repeat(40),
        commits: [],
        complete: true,
        forced: true,
      },
      { prisma, trigger, log: quiet } // no compare → fallback
    );

    expect(seen).toHaveLength(11);
    expect(peak).toBe(4);
  });
});

describe('createCollabExternalTrigger', () => {
  it('triggers the task by id, loading the SDK once', async () => {
    const tasksTrigger = vi.fn(async () => ({}));
    const load = vi.fn(async () => tasksTrigger);
    const trigger = createCollabExternalTrigger(load);
    const payload: CollabExternalPayload = {
      classroomId: 'c1',
      kind: 'deck',
      docId: 'd1',
      sha: HEAD,
      before: null,
    };

    await trigger(payload);
    await trigger({ ...payload, docId: 'd2' });

    expect(load).toHaveBeenCalledTimes(1);
    expect(tasksTrigger).toHaveBeenNthCalledWith(1, 'collab-external', payload, {
      concurrencyKey: 'c1',
      idempotencyKey: `collab-external:deck:d1:..${HEAD}`,
      idempotencyKeyTTL: '1h',
    });
  });
});
