import { describe, expect, it } from 'vitest';
import type { SlideLock } from '../../api.ts';
import * as Y from 'yjs';

import { cloneYDoc, deckLocks, deckToYDoc } from '../convert.ts';
import {
  LOCK_DISCONNECT_GRACE_MS,
  LOCK_TAKEOVER_IDLE_MS,
  expireGoneLocks,
  goneLockExpired,
  markDisconnected,
  markReconnected,
  LockActivity,
  acquireLock,
  expireLocks,
  getLock,
  installLockArbiter,
  isConfirmedFor,
  lockArbitration,
  lockState,
  releaseLock,
  releaseLocksOf,
  touchLock,
} from '../locks.ts';

const DECK = {
  version: 1 as const,
  theme: 'white',
  codeTheme: 'github',
  slides: [
    { id: 's1', html: '<p>1</p>' },
    { id: 's2', html: '<p>2</p>' },
  ],
};

function peer(clientID: number, from?: Y.Doc): Y.Doc {
  const doc = from ? cloneYDoc(from) : deckToYDoc(DECK);
  doc.clientID = clientID;
  return doc;
}

const holder = (doc: Y.Doc, name: string) => ({
  userId: `u-${name}`,
  name,
  color: '#000',
  clientId: doc.clientID,
});

const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
};

describe('acquire / refresh / release', () => {
  it('free → mine; others refused until stale, then takeover', () => {
    const server = peer(1);
    const a = peer(10, server);
    const b = peer(20, server);
    expect(acquireLock(a, 's1', holder(a, 'A'), { now: 1000 }).ok).toBe(true);
    sync(a, b);
    const refused = acquireLock(b, 's1', holder(b, 'B'), { now: 2000, takeover: true });
    expect(refused).toMatchObject({ ok: false, holder: { name: 'A' } });

    // Idle measured locally: 60 s since the entry last changed.
    const stale = { now: 2000, idleMs: LOCK_TAKEOVER_IDLE_MS, takeover: true };
    expect(lockState(getLock(b, 's1'), b.clientID, stale)).toBe('stale');
    expect(acquireLock(b, 's1', holder(b, 'B'), { ...stale, takeover: false }).ok).toBe(false);
    const took = acquireLock(b, 's1', holder(b, 'B'), stale);
    expect(took).toMatchObject({ ok: true, tookOver: true });
  });

  it('a disconnected holder keeps the slide for the grace period', () => {
    const a = peer(10);
    acquireLock(a, 's1', holder(a, 'A'), { now: 0 });
    // Gone, not marked (a server restart): held until this observer has seen
    // the holder absent for the grace period, then free to take over.
    const gone = { now: 1, connected: new Set([99]) };
    expect(lockState(getLock(a, 's1'), 99, { ...gone, goneMs: 29_000 })).toBe('held');
    expect(lockState(getLock(a, 's1'), 99, { ...gone, goneMs: LOCK_DISCONNECT_GRACE_MS })).toBe(
      'stale'
    );
    markDisconnected(a, [10], 1_000);
    expect(lockState(getLock(a, 's1'), 99, { now: 2_000, idleMs: 1_000 })).toBe('held');
    expect(lockState(getLock(a, 's1'), 99, { now: 40_000, idleMs: LOCK_DISCONNECT_GRACE_MS })).toBe(
      'stale'
    );
    // Back within the grace: the mark goes, the lock (and its stamp) stay.
    markReconnected(a, [10]);
    expect(getLock(a, 's1')).not.toHaveProperty('disconnectedAt');
    expect(lockState(getLock(a, 's1'), 99, { now: 40_000, idleMs: 0 })).toBe('held');
  });

  it('touch keeps `since`, only the holder can touch or release', () => {
    const a = peer(10);
    acquireLock(a, 's1', holder(a, 'A'), { now: 100 });
    expect(touchLock(a, 's1', 10, 500)).toBe(true);
    expect(getLock(a, 's1')).toMatchObject({ since: 100, lastActive: 500 });
    expect(touchLock(a, 's1', 11, 600)).toBe(false);
    expect(releaseLock(a, 's1', 11)).toBe(false);
    expect(releaseLock(a, 's1', 10)).toBe(true);
    expect(getLock(a, 's1')).toBeNull();
  });
});

describe('server cleanup', () => {
  it('releases the locks of disconnected clients', () => {
    const doc = peer(1);
    acquireLock(doc, 's1', { ...holder(doc, 'A'), clientId: 10 }, { now: 0 });
    acquireLock(doc, 's2', { ...holder(doc, 'B'), clientId: 20 }, { now: 0 });
    expect(releaseLocksOf(doc, [10])).toEqual(['s1']);
    expect(getLock(doc, 's2')?.clientId).toBe(20);
  });

  it('expires idle locks by local observation', () => {
    let now = 0;
    const doc = peer(1);
    const activity = new LockActivity(doc, () => now);
    acquireLock(doc, 's1', { ...holder(doc, 'A'), clientId: 10 }, { now: 999_999 });
    now = 50_000;
    expect(expireLocks(doc, { now, activity, maxIdleMs: 120_000 })).toEqual([]);
    now = 130_000;
    expect(expireLocks(doc, { now, activity, maxIdleMs: 120_000 })).toEqual(['s1']);
    activity.destroy();
  });
});

describe('expireGoneLocks (server, on load and before agent ops)', () => {
  it('judges by stored times, not by when the doc was loaded', () => {
    const doc = peer(1);
    acquireLock(doc, 'old', { ...holder(doc, 'Gone'), clientId: 10 }, { now: 0 });
    acquireLock(doc, 'recent', { ...holder(doc, 'Blip'), clientId: 11 }, { now: 0 });
    markDisconnected(doc, [11], 90_000);
    acquireLock(doc, 'here', { ...holder(doc, 'Here'), clientId: 12 }, { now: 0 });
    const result = expireGoneLocks(doc, { now: 100_000, connected: new Set([12]) });
    expect(result.expired).toEqual(['old']);
    // Blip dropped 10 s ago: 20 s of grace left.
    expect(result.nextInMs).toBe(20_000);
    expect(getLock(doc, 'recent')).not.toBeNull();
    expect(getLock(doc, 'here')).not.toBeNull();
  });

  it('after a server start, every gone holder gets the full grace to reconnect', () => {
    const doc = peer(1);
    acquireLock(doc, 's1', { ...holder(doc, 'A'), clientId: 10 }, { now: 0 }); // stored long ago
    const started = 500_000;
    // Right after the start nobody is connected yet: nothing is cleared.
    let result = expireGoneLocks(doc, {
      now: started + 1_000,
      connected: new Set(),
      notBefore: started,
    });
    expect(result).toEqual({ expired: [], nextInMs: 29_000 });
    expect(
      goneLockExpired(getLock(doc, 's1') as SlideLock, {
        now: started + 29_999,
        notBefore: started,
      })
    ).toBe(false);
    // The holder never came back: cleared when the grace from the start ends.
    result = expireGoneLocks(doc, {
      now: started + 30_000,
      connected: new Set(),
      notBefore: started,
    });
    expect(result.expired).toEqual(['s1']);
  });
});

describe('arbiter', () => {
  for (const order of ['low first', 'high first'] as const) {
    it(`claims arriving one after the other: the first stands (${order})`, () => {
      const server = peer(1);
      installLockArbiter(server);
      const low = peer(10, server);
      const high = peer(20, server);
      acquireLock(low, 's1', holder(low, 'Low'), { now: 5 });
      acquireLock(high, 's1', holder(high, 'High'), { now: 5 });
      const updates = [Y.encodeStateAsUpdate(low), Y.encodeStateAsUpdate(high)];
      if (order === 'high first') updates.reverse();
      for (const update of updates) Y.applyUpdate(server, update);
      const first = order === 'low first' ? 'Low' : 'High';
      expect(getLock(server, 's1')?.name).toBe(first);
      sync(server, low);
      sync(server, high);
      expect(getLock(low, 's1')?.name).toBe(first);
      expect(getLock(high, 's1')?.name).toBe(first);
      // Only the winner sees its claim confirmed.
      const winner = order === 'low first' ? low : high;
      const loser = order === 'low first' ? high : low;
      expect(isConfirmedFor(getLock(winner, 's1'), winner.clientID)).toBe(true);
      expect(isConfirmedFor(getLock(loser, 's1'), loser.clientID)).toBe(false);
    });
  }

  it('claims arriving in one transaction: the lowest clientID wins', () => {
    const server = peer(1);
    installLockArbiter(server);
    const low = peer(10, server);
    const high = peer(20, server);
    acquireLock(low, 's1', holder(low, 'Low'), { now: 5 });
    acquireLock(high, 's1', holder(high, 'High'), { now: 5 });
    Y.applyUpdate(
      server,
      Y.mergeUpdates([Y.encodeStateAsUpdate(high), Y.encodeStateAsUpdate(low)])
    );
    expect(getLock(server, 's1')?.name).toBe('Low');
    expect(isConfirmedFor(getLock(server, 's1'), 10)).toBe(true);
  });

  it('never undoes a takeover (a claim made on top of the previous lock)', () => {
    const server = peer(1);
    installLockArbiter(server);
    const low = peer(10, server);
    acquireLock(low, 's1', holder(low, 'Low'), { now: 0 });
    Y.applyUpdate(server, Y.encodeStateAsUpdate(low));
    const high = peer(20, server);
    acquireLock(high, 's1', holder(high, 'High'), {
      now: 100_000,
      idleMs: LOCK_TAKEOVER_IDLE_MS,
      takeover: true,
    });
    Y.applyUpdate(server, Y.encodeStateAsUpdate(high));
    expect(getLock(server, 's1')?.name).toBe('High');
    expect(isConfirmedFor(getLock(server, 's1'), 20)).toBe(true);
  });

  it('a heartbeat keeps the stamp; a single claim is stamped once', () => {
    const server = peer(1);
    let fixes: unknown[] = [];
    server.on('afterTransaction', tr => {
      fixes = lockArbitration(server, tr, () => 7);
    });
    const a = peer(10, server);
    acquireLock(a, 's1', holder(a, 'A'), { now: 0 });
    Y.applyUpdate(server, Y.encodeStateAsUpdate(a));
    expect(fixes).toEqual([
      { slideId: 's1', lock: expect.objectContaining({ clientId: 10, confirmed: 7 }) },
    ]);
    expect(deckLocks(server).size).toBe(1);
  });
});
