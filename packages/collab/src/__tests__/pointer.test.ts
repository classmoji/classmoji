import { describe, expect, it } from 'vitest';

import {
  DECK_SLIDE_SIZE,
  SLIDE_POINTERS_MAX,
  agentRestPoint,
  normalizeSlidePointer,
  pointersFromStates,
} from '../pointer.ts';

const person = (id: string, name: string, pointer?: unknown, color = '#0090ff') => ({
  user: { id, name, color },
  ...(pointer !== undefined ? { pointer } : {}),
});
const agent = (name: string, pointer?: unknown, color = '#e54666') => ({
  user: { name, color, agent: true },
  ...(pointer !== undefined ? { pointer } : {}),
});

const LOCAL = { localClientId: 1, localUserId: 'me', slideId: 's1' };

describe('normalizeSlidePointer', () => {
  it('keeps a pointer on the slide and clamps one off it', () => {
    expect(normalizeSlidePointer({ slide: 's1', x: 10, y: 20 })).toEqual({
      slide: 's1',
      x: 10,
      y: 20,
    });
    expect(normalizeSlidePointer({ slide: 's1', x: -5, y: 9999 })).toEqual({
      slide: 's1',
      x: 0,
      y: DECK_SLIDE_SIZE.height,
    });
    expect(
      normalizeSlidePointer({ slide: 's1', x: 2000, y: 5 }, { width: 100, height: 50 })
    ).toEqual({ slide: 's1', x: 100, y: 5 });
  });

  it('refuses anything malformed', () => {
    for (const bad of [
      null,
      'x',
      { x: 1, y: 1 },
      { slide: '', x: 1, y: 1 },
      { slide: 'a'.repeat(201), x: 1, y: 1 },
      { slide: 's', x: '1', y: 1 },
      { slide: 's', x: 1, y: Number.NaN },
      { slide: 's', x: Number.POSITIVE_INFINITY, y: 1 },
    ]) {
      expect(normalizeSlidePointer(bad)).toBeNull();
    }
  });
});

describe('agentRestPoint', () => {
  it('is the centre of the slide', () => {
    expect(agentRestPoint()).toEqual({ x: 480, y: 350 });
    expect(agentRestPoint({ width: 101, height: 51 })).toEqual({ x: 51, y: 26 });
  });
});

describe('pointersFromStates', () => {
  it('shows other people and agents on the viewer’s slide only', () => {
    const states: Array<[number, unknown]> = [
      [1, person('me', 'Me', { slide: 's1', x: 1, y: 1 })],
      [2, person('me', 'Me in another tab', { slide: 's1', x: 2, y: 2 })],
      [3, person('ada', 'Ada', { slide: 's1', x: 100, y: 200 })],
      [4, person('bob', 'Bob', { slide: 's2', x: 5, y: 5 })],
      [5, person('cy', 'Cy')],
      [6, person('di', 'Di', null)],
      [7, agent('Ada (agent)', { slide: 's1', x: 480, y: 350 })],
      [8, { pointer: { slide: 's1', x: 1, y: 1 } }],
      [9, person('eve', '', { slide: 's1', x: 1, y: 1 })],
      [10, person('fay', 'Fay', { slide: 's1', x: 'a', y: 1 })],
    ];
    expect(pointersFromStates(states, LOCAL)).toEqual([
      { clientId: 3, name: 'Ada', color: '#0090ff', agent: false, x: 100, y: 200 },
      { clientId: 7, name: 'Ada (agent)', color: '#e54666', agent: true, x: 480, y: 350 },
    ]);
  });

  it('shows nothing when the viewer is on no slide', () => {
    const states: Array<[number, unknown]> = [
      [3, person('ada', 'Ada', { slide: 's1', x: 1, y: 1 })],
    ];
    expect(pointersFromStates(states, { ...LOCAL, slideId: null })).toEqual([]);
  });

  it('greys a malformed colour and clamps onto the slide', () => {
    const states: Array<[number, unknown]> = [
      [3, person('ada', 'Ada', { slide: 's1', x: 5000, y: -3 }, 'red')],
    ];
    expect(pointersFromStates(states, LOCAL)).toEqual([
      { clientId: 3, name: 'Ada', color: '#6b7280', agent: false, x: 960, y: 0 },
    ]);
  });

  it('keeps the most recently moved when there are too many', () => {
    const states: Array<[number, unknown]> = [];
    const movedAt = new Map<number, number>();
    for (let i = 0; i < SLIDE_POINTERS_MAX + 3; i++) {
      const clientId = 100 + i;
      states.push([clientId, person(`u${i}`, `U${i}`, { slide: 's1', x: i, y: i })]);
      // The first three moved last.
      movedAt.set(clientId, i < 3 ? 1000 + i : i);
    }
    const shown = pointersFromStates(states, { ...LOCAL, movedAt });
    expect(shown).toHaveLength(SLIDE_POINTERS_MAX);
    const ids = shown.map(p => p.clientId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids).toEqual(expect.arrayContaining([100, 101, 102]));
    // The three least recently moved are left out.
    expect(ids).not.toContain(103);
    expect(ids).not.toContain(104);
    expect(ids).not.toContain(105);
    expect(pointersFromStates(states, { ...LOCAL, movedAt, max: 2 }).map(p => p.clientId)).toEqual([
      101, 102,
    ]);
  });
});
