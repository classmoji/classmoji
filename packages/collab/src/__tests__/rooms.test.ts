import { describe, expect, it } from 'vitest';
import { parseRoom, roomName } from '../rooms.ts';

describe('room names', () => {
  it('round-trips', () => {
    const id = '6f1c2d3e-0000-4000-8000-123456789abc';
    expect(roomName('page', id, 1)).toBe(`page:${id}:1`);
    expect(parseRoom(roomName('deck', id, 7))).toEqual({ kind: 'deck', id, epoch: 7 });
  });

  it('refuses what is not ours', () => {
    for (const name of [
      '',
      'page',
      'page:x',
      'quiz:x:1',
      'page::1',
      'page:x:0',
      'page:x:01',
      'page:x:1.5',
      'page:x:y:1',
    ]) {
      expect(parseRoom(name), name).toBeNull();
    }
  });

  it('will not build an ambiguous name', () => {
    expect(() => roomName('page', 'a:b', 1)).toThrow();
    expect(() => roomName('page', '', 1)).toThrow();
    expect(() => roomName('page', 'a', 0)).toThrow();
    expect(() => roomName('slides' as never, 'a', 1)).toThrow();
  });
});
