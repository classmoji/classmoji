/**
 * Unit tests for the deck editor's file rules (app/utils/deckFiles.ts): which
 * repository paths `delete-images` may delete, and which theme and snippet
 * file names the theme and snippet intents may write or delete.
 *
 * Runs in the Playwright runner without a browser or the dev stack.
 */

import { test, expect } from '@playwright/test';

import {
  deckImageFolder,
  deckImagePathsOrNull,
  isDeckImagePath,
  isSnippetFileId,
  isThemeFileId,
  isThemeType,
} from '../../app/utils/deckFiles.ts';

const DECK = 'slides/week-1';

test.describe('deck image paths', () => {
  test("accepts any file name directly in the deck's image folder", () => {
    expect(deckImageFolder(DECK)).toBe('slides/week-1/images');
    for (const name of [
      '1700000000-diagram.png',
      'Imported Photo (1).JPG',
      'café ☕.png',
      '50% off.png',
      'a%20b.png',
      '.hidden',
      '..png',
      'a..b.png',
    ]) {
      expect(isDeckImagePath(`slides/week-1/images/${name}`, DECK), name).toBe(true);
    }
    expect(
      deckImagePathsOrNull(['slides/week-1/images/a.png', 'slides/week-1/images/b c.gif'], DECK)
    ).toEqual(['slides/week-1/images/a.png', 'slides/week-1/images/b c.gif']);
  });

  test('reads a stored content path with stray slashes as the same folder', () => {
    expect(isDeckImagePath('slides/week-1/images/a.png', '/slides/week-1/')).toBe(true);
    expect(isDeckImagePath('slides/week-1/images/a.png', 'slides//week-1')).toBe(true);
  });

  test("accepts only files in the deck's image folder", () => {
    for (const path of [
      'slides/week-1/images/../deck.json',
      'slides/week-1/images/../../other/deck.json',
      'slides/week-1/images/..',
      'slides/week-1/images/.',
      'slides/week-1/images/./a.png',
    ]) {
      expect(isDeckImagePath(path, DECK), path).toBe(false);
    }
  });

  test("refuses the deck's own files outside the image folder, and the folder itself", () => {
    for (const path of [
      'slides/week-1/deck.json',
      'slides/week-1/index.html',
      'slides/week-1/images',
      'slides/week-1/images/',
      'slides/week-1/images/sub/a.png',
    ]) {
      expect(isDeckImagePath(path, DECK), path).toBe(false);
    }
  });

  test("refuses a sibling deck's folder, including one whose slug extends this one", () => {
    for (const path of [
      'slides/week-10/images/a.png',
      'slides/week-1-old/images/a.png',
      'slides/other/images/a.png',
    ]) {
      expect(isDeckImagePath(path, DECK), path).toBe(false);
    }
  });

  test('refuses pages, the theme folder and the repository root', () => {
    for (const path of [
      'pages/lab-1/content.json',
      'pages/lab-1/assets/a.png',
      '.slidesthemes/shared-light.css',
      'README.md',
    ]) {
      expect(isDeckImagePath(path, DECK), path).toBe(false);
    }
  });

  test('refuses leading or doubled slashes, backslashes, control characters and escaped separators', () => {
    for (const path of [
      '/slides/week-1/images/a.png',
      'slides/week-1//images/a.png',
      'slides/week-1/images//a.png',
      'slides\\week-1\\images\\a.png',
      'slides/week-1/images/..\\deck.json',
      'slides/week-1/images/%2e%2e',
      'slides/week-1/images/%2E%2E%2Fdeck.json',
      'slides/week-1/images/a%2Fb.png',
      'slides/week-1/images/a%5cb.png',
      'slides%2Fweek-1%2Fimages%2Fa.png',
      'slides/week-1/images%2Fa.png',
      'slides/week-1/images/a\u0000.png',
      'slides/week-1/images/a%00.png',
      'slides/week-1/images/a\n.png',
    ]) {
      expect(isDeckImagePath(path, DECK), JSON.stringify(path)).toBe(false);
    }
  });

  test('refuses values that are not strings', () => {
    for (const value of [null, undefined, 42, { path: 'slides/week-1/images/a.png' }, ['x']]) {
      expect(isDeckImagePath(value, DECK)).toBe(false);
    }
  });

  test('refuses everything for a deck with no usable content path', () => {
    for (const contentPath of [null, undefined, '', '/', 'slides/../pages']) {
      expect(isDeckImagePath('slides/week-1/images/a.png', contentPath)).toBe(false);
    }
  });

  test('refuses the whole list when any one entry is not a file in the folder', () => {
    for (const list of [
      ['slides/week-1/images/a.png', 'pages/lab-1/content.json'],
      ['slides/week-1/images/a.png', ['slides/week-1/images/b.png']],
      ['slides/week-1/images/a.png', { path: 'slides/week-1/images/b.png' }],
      [],
    ]) {
      expect(deckImagePathsOrNull(list, DECK), JSON.stringify(list)).toBeNull();
    }
    expect(deckImagePathsOrNull('slides/week-1/images/a.png', DECK)).toBeNull();
  });
});

test.describe('theme and snippet file names', () => {
  test('accepts every name the theme and snippet lists can return', () => {
    for (const id of [
      'ocean-light.css',
      'my-theme-dark.css',
      '-light.css',
      'My Theme-light.css',
      'théme-dark.css',
      '50%-dark.css',
      '.old-light.css',
    ]) {
      expect(isThemeFileId(id), id).toBe(true);
    }
    for (const id of ['callout-box.html', 'My Snip.html', '.html', 'ünïcode.html']) {
      expect(isSnippetFileId(id), id).toBe(true);
    }
    expect(isThemeType('light')).toBe(true);
    expect(isThemeType('dark')).toBe(true);
  });

  test('accepts only one file name, not a path', () => {
    for (const id of [
      '../pages/lab-1/content.json',
      '../ocean-light.css',
      'snippets/../ocean-light.css',
      'nested/ocean-light.css',
      'ocean%2F..-light.css',
      'ocean\\x-light.css',
      '/ocean-light.css',
      'ocean\u0000-light.css',
      '',
    ]) {
      expect(isThemeFileId(id), id).toBe(false);
      expect(isSnippetFileId(id.replace(/-light\.css$/, '.html')), id).toBe(false);
    }
  });

  test('refuses a theme name that is not a light or dark css file, and other types', () => {
    expect(isThemeFileId('ocean.css')).toBe(false);
    expect(isThemeFileId('ocean-light.html')).toBe(false);
    expect(isSnippetFileId('callout.css')).toBe(false);
    expect(isThemeFileId(['ocean-light.css'])).toBe(false);
    expect(isThemeType('../x')).toBe(false);
    expect(isThemeType('sepia')).toBe(false);
    expect(isThemeType(undefined)).toBe(false);
  });
});
