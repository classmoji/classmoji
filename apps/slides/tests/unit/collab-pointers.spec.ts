/**
 * Live pointers in the deck editor: screen ↔ slide coordinates under Reveal's
 * scale and offset, the 20-a-second send throttle, when an arrow rests, and
 * that pointer moves do not re-render the route (the session's peer list
 * stays the same object).
 */
import { test, expect } from '@playwright/test';
import { Awareness } from 'y-protocols/awareness';
import { pointersFromStates, type CollabLoaderData } from '@classmoji/collab';

import {
  POINTER_REST_MS,
  POINTER_SEND_INTERVAL_MS,
  PointerMotion,
  PointerSender,
  frameWithin,
  screenToSlide,
  slideToScreen,
  type SentPointer,
} from '../../app/utils/collab/pointer.ts';
import { DeckCollabSession } from '../../app/utils/collab/session.ts';

test.describe('screen ↔ slide coordinates', () => {
  // Reveal draws the 960×700 slide scaled: here at 1.25, offset by (100, 40).
  const big = { left: 100, top: 40, width: 1200, height: 875 };
  // The same deck in a smaller window: scale 0.5, offset (20, 10).
  const small = { left: 20, top: 10, width: 480, height: 350 };

  test('the same slide spot from two window sizes', () => {
    expect(screenToSlide({ x: 100 + 300 * 1.25, y: 40 + 200 * 1.25 }, big)).toEqual({
      x: 300,
      y: 200,
    });
    expect(screenToSlide({ x: 20 + 300 * 0.5, y: 10 + 200 * 0.5 }, small)).toEqual({
      x: 300,
      y: 200,
    });
    // Corners are on the slide.
    expect(screenToSlide({ x: 100, y: 40 }, big)).toEqual({ x: 0, y: 0 });
    expect(screenToSlide({ x: 1300, y: 915 }, big)).toEqual({ x: 960, y: 700 });
  });

  test('round trip, and drawn where the other window points', () => {
    for (const frame of [big, small]) {
      const at = slideToScreen({ x: 480, y: 350 }, frame);
      expect(screenToSlide(at, frame)).toEqual({ x: 480, y: 350 });
    }
    // Pointed at in the big window, drawn in the small one.
    const slide = screenToSlide({ x: 700, y: 500 }, big)!;
    const drawn = slideToScreen(slide, small);
    expect(drawn.x).toBeCloseTo(20 + ((700 - 100) / 1200) * 480, 0);
    expect(drawn.y).toBeCloseTo(10 + ((500 - 40) / 875) * 350, 0);
  });

  test('outside the slide (or before layout) is no pointer', () => {
    expect(screenToSlide({ x: 99, y: 100 }, big)).toBeNull();
    expect(screenToSlide({ x: 500, y: 916 }, big)).toBeNull();
    expect(screenToSlide({ x: 1301, y: 100 }, big)).toBeNull();
    expect(screenToSlide({ x: 0, y: 0 }, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
  });

  test('the overlay draws relative to its own box', () => {
    expect(frameWithin(big, { left: 60, top: 30 })).toEqual({
      left: 40,
      top: 10,
      width: 1200,
      height: 875,
    });
  });
});

/** A sender on a fake clock, frames and timers run by hand. */
function fakeSender() {
  let now = 1_000;
  const sent: Array<SentPointer | null> = [];
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { at: number; run: () => void }>();
  let ids = 0;
  const sender = new PointerSender({
    send: pointer => sent.push(pointer),
    now: () => now,
    requestFrame: callback => {
      frames.set(++ids, callback);
      return ids;
    },
    cancelFrame: id => frames.delete(id),
    setTimer: (run, ms) => {
      timers.set(++ids, { at: now + ms, run });
      return ids;
    },
    clearTimer: id => timers.delete(id as number),
  });
  const frame = () => {
    const due = [...frames.values()];
    frames.clear();
    for (const run of due) run();
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.run();
      }
    }
  };
  return { sender, sent, frame, advance, pendingFrames: () => frames.size };
}

const at = (x: number, y: number, slide = 's1') => ({ slide, x, y });

test.describe('sending the local pointer', () => {
  test('moves within a frame collapse into the latest one', () => {
    const t = fakeSender();
    t.sender.move(at(1, 1));
    t.sender.move(at(2, 2));
    t.sender.move(at(3.4, 3.6));
    expect(t.sent).toEqual([]);
    t.frame();
    expect(t.sent).toEqual([at(3, 4)]);
  });

  test('at most one send per interval (20 a second)', () => {
    const t = fakeSender();
    t.sender.move(at(1, 1));
    t.frame();
    // 60 moves over one second, one every ~16 ms.
    for (let i = 0; i < 60; i++) {
      t.advance(1000 / 60);
      t.sender.move(at(10 + i, 10));
      t.frame();
    }
    t.advance(POINTER_SEND_INTERVAL_MS);
    t.frame();
    expect(t.sent.length).toBeGreaterThanOrEqual(15);
    expect(t.sent.length).toBeLessThanOrEqual(1 + 1000 / POINTER_SEND_INTERVAL_MS + 1);
    // The last position always arrives.
    expect(t.sent.at(-1)).toEqual(at(69, 10));
  });

  test('an unchanged pointer is not sent again', () => {
    const t = fakeSender();
    t.sender.move(at(5, 5));
    t.frame();
    t.advance(100);
    t.sender.move(at(5.2, 4.9));
    t.frame();
    expect(t.sent).toEqual([at(5, 5)]);
    expect(t.pendingFrames()).toBe(0);
  });

  test('clear sends no-pointer at once and drops a waiting move', () => {
    const t = fakeSender();
    t.sender.move(at(5, 5));
    t.frame();
    t.sender.move(at(6, 6)); // waits out the interval
    t.sender.clear();
    t.advance(POINTER_SEND_INTERVAL_MS * 2);
    t.frame();
    expect(t.sent).toEqual([at(5, 5), null]);
    // Clearing again sends nothing new.
    t.sender.clear();
    expect(t.sent).toEqual([at(5, 5), null]);
  });

  test('a new slide is a new pointer, even at the same spot', () => {
    const t = fakeSender();
    t.sender.move(at(5, 5, 's1'));
    t.frame();
    t.advance(POINTER_SEND_INTERVAL_MS);
    t.sender.move(at(5, 5, 's2'));
    t.frame();
    expect(t.sent).toEqual([at(5, 5, 's1'), at(5, 5, 's2')]);
  });

  test('after stop nothing is sent', () => {
    const t = fakeSender();
    t.sender.move(at(5, 5));
    t.frame();
    t.sender.stop();
    t.sender.move(at(9, 9));
    t.advance(1000);
    t.frame();
    expect(t.sent).toEqual([at(5, 5), null]);
  });
});

test.describe('resting arrows', () => {
  test('a person rests after a while without moving; a renewal is not a move; agents never rest', () => {
    let now = 0;
    const motion = new PointerMotion(() => now);
    motion.update([
      { clientId: 2, x: 10, y: 10 },
      { clientId: 3, x: 50, y: 50 },
    ]);
    expect(motion.resting(2, false)).toBe(false);
    expect(motion.nextRestIn(new Set([3]))).toBe(POINTER_REST_MS);
    now = POINTER_REST_MS - 1;
    motion.update([
      { clientId: 2, x: 10, y: 10 }, // same spot again
      { clientId: 3, x: 50, y: 50 },
    ]);
    now = POINTER_REST_MS;
    expect(motion.resting(2, false)).toBe(true);
    expect(motion.resting(3, true)).toBe(false);
    // It moves: awake again.
    motion.update([{ clientId: 2, x: 11, y: 10 }]);
    expect(motion.resting(2, false)).toBe(false);
    // Client 3 has gone: forgotten.
    expect(motion.movedAt().has(3)).toBe(false);
  });
});

test.describe('the overlay shows the right peers', () => {
  test('other people and agents on my slide, not me in another tab', () => {
    const states: Array<[number, unknown]> = [
      [1, { user: { id: 'u1', name: 'Me', color: '#000000' }, pointer: at(1, 1) }],
      [2, { user: { id: 'u1', name: 'Me', color: '#000000' }, pointer: at(2, 2) }],
      [3, { user: { id: 'u2', name: 'Bo', color: '#0090ff' }, pointer: at(3, 3) }],
      [4, { user: { id: 'u3', name: 'Cy', color: '#0090ff' }, pointer: at(4, 4, 's2') }],
      [5, { user: { name: 'Bo (agent)', color: '#e54666', agent: true }, pointer: at(480, 350) }],
    ];
    const shown = pointersFromStates(states, {
      localClientId: 1,
      localUserId: 'u1',
      slideId: 's1',
    });
    expect(shown.map(p => [p.name, p.agent, p.x, p.y])).toEqual([
      ['Bo', false, 3, 3],
      ['Bo (agent)', true, 480, 350],
    ]);
  });
});

test.describe('the session and pointer moves', () => {
  const COLLAB: CollabLoaderData = {
    wsUrl: 'ws://localhost:7710',
    room: 'deck:slide-1:1',
    epoch: 1,
    schemaVersion: 1,
    user: { id: 'u1', name: 'Ada', color: '#000000' },
  };

  test('setPointer shares it; moves keep the peer list (no route re-render)', () => {
    let awareness: Awareness | null = null;
    const session = new DeckCollabSession(COLLAB, a => {
      awareness = new Awareness(a.document);
      return { awareness, hasUnsyncedChanges: false, destroy: () => awareness?.destroy() };
    });
    const aw = awareness as unknown as Awareness;
    let renders = 0;
    session.subscribe(() => renders++);

    session.setPointer(at(10, 20));
    expect(aw.getLocalState()?.pointer).toEqual(at(10, 20));
    session.setPointer(null);
    expect(aw.getLocalState()?.pointer).toBeNull();
    expect(renders).toBe(0);

    const remote = (state: Record<string, unknown>) => {
      (aw.getStates() as Map<number, Record<string, unknown>>).set(77, state);
      aw.emit('change', [{ added: [], updated: [77], removed: [] }, 'remote']);
    };
    remote({ user: { id: 'u2', name: 'Bo', color: '#0090ff' }, slide: 's1' });
    expect(renders).toBe(1);
    const peers = session.getState().peers;
    for (let i = 0; i < 20; i++) {
      remote({ user: { id: 'u2', name: 'Bo', color: '#0090ff' }, slide: 's1', pointer: at(i, i) });
    }
    expect(renders).toBe(1);
    expect(session.getState().peers).toBe(peers);
    // Moving to another slide is a real change.
    remote({ user: { id: 'u2', name: 'Bo', color: '#0090ff' }, slide: 's2' });
    expect(renders).toBe(2);
    session.destroy();
  });
});
