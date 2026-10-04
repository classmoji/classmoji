/**
 * Deck folder paths for agent uploads: what a folder may be, how the row's
 * filename carries it, and that nothing outside the deck folder is reachable.
 */

import { describe, expect, it } from 'vitest';
import {
  STAGE_FOLDER_MAX_DEPTH,
  normalizeStageFolder,
  splitStagePath,
  stageFilename,
} from '../stageFolder.ts';

describe('normalizeStageFolder', () => {
  it('keeps a relative folder as given, minus a trailing slash', () => {
    expect(normalizeStageFolder('games/minions')).toBe('games/minions');
    expect(normalizeStageFolder(' games/Minions_2/v1.0/ ')).toBe('games/Minions_2/v1.0');
  });

  it.each([
    ['', /empty/],
    ['/', /empty/],
    ['/games', /leading/],
    ['../games', /"\.\."/],
    ['games/../../x', /"\.\."/],
    ['games/./x', /"\.\."/],
    ['games//x', /empty segments/],
    ['games\\x', /never/],
    ['.github/workflows', /cannot start with/],
    ['games/min ions', /only letters/],
    ['games/ü', /only letters/],
    ['a/b/c/d/e', /at most 4/],
  ])('refuses %j', (folder, message) => {
    expect(() => normalizeStageFolder(folder)).toThrow(message);
    try {
      normalizeStageFolder(folder);
    } catch (error) {
      expect(error).toMatchObject({ code: 'STORAGE_REFUSED' });
    }
  });

  it('allows exactly the depth cap', () => {
    const deepest = Array.from({ length: STAGE_FOLDER_MAX_DEPTH }, (_, i) => `d${i}`).join('/');
    expect(normalizeStageFolder(deepest)).toBe(deepest);
  });
});

describe('stageFilename', () => {
  it('a flat name stays flat (pages and decks)', () => {
    expect(stageFilename('Diagram 1.png', undefined, 'page')).toBe('Diagram 1.png');
    expect(stageFilename('diagram.png', null, 'slide')).toBe('diagram.png');
  });

  it('a deck folder name is folder/name, kept exactly', () => {
    expect(stageFilename('jquery.min.js', 'games/minions', 'slide')).toBe(
      'games/minions/jquery.min.js'
    );
  });

  it('refuses paths in the name, folders for pages, odd names and long paths', () => {
    expect(() => stageFilename('a/b.png', undefined, 'slide')).toThrow(/not a path/);
    expect(() => stageFilename('a\\b.png', undefined, 'page')).toThrow(/not a path/);
    expect(() => stageFilename('a.png', 'x', 'page')).toThrow(/slide decks/);
    expect(() => stageFilename('my game.js', 'x', 'slide')).toThrow(/keeps its name exactly/);
    expect(() => stageFilename('.env', 'x', 'slide')).toThrow(/keeps its name exactly/);
    expect(() => stageFilename('Makefile', 'x', 'slide')).toThrow(/extension/);
    expect(() => stageFilename(`${'a'.repeat(150)}.js`, 'games/x', 'slide')).toThrow(/160/);
  });
});

describe('splitStagePath', () => {
  it('splits at the last slash', () => {
    expect(splitStagePath('games/minions/a.png')).toEqual({
      folder: 'games/minions',
      name: 'a.png',
    });
    expect(splitStagePath('a.png')).toEqual({ folder: null, name: 'a.png' });
  });
});
