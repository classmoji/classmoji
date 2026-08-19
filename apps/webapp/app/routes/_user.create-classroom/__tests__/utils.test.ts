import { describe, it, expect } from 'vitest';
import { slugify, slugifyInput } from '../utils.ts';

describe('slugify', () => {
  it('normalizes a name into a slug', () => {
    expect(slugify('Rendering Algorithms Fall 2024')).toBe('rendering-algorithms-fall-2024');
    expect(slugify('  CS87 -- Dartmouth!  ')).toBe('cs87-dartmouth');
  });

  // The slug is the sole key in every app URL and is globally unique, so the
  // character set is deliberately narrower than the one GitHub accepts for repo
  // names: dash is the only separator. `sanitizeRepoName` in @classmoji/utils
  // intentionally allows [a-z0-9._-] because that is what GitHub allows for
  // `content_repo` — the two are separate namespaces with separate rules, and
  // this test exists so the slug side is not widened to match by mistake.
  it('permits only [a-z0-9-], collapsing dots and underscores to dashes', () => {
    expect(slugify('cs.101')).toBe('cs-101');
    expect(slugify('cs_101')).toBe('cs-101');
    expect(slugify('CS.101_Fall/2026')).toBe('cs-101-fall-2026');

    for (const input of ['a.b', 'a_b', 'a b', 'a/b', 'a+b', 'aB', 'å∫ç', 'a..b', 'a__b']) {
      expect(slugify(input)).toMatch(/^[a-z0-9-]*$/);
    }
  });
});

describe('slugifyInput', () => {
  // The reason this function exists: `slugify` trims edge dashes, so running it
  // on every keystroke deletes the dash as soon as it is typed and a hyphenated
  // slug can never be entered by hand.
  it('keeps a trailing dash so the next character can be typed', () => {
    expect(slugifyInput('cs-')).toBe('cs-');
    expect(slugifyInput('cs-1')).toBe('cs-1');
  });

  it('survives typing a hyphenated slug one character at a time', () => {
    const typed = 'cs-101-fall';
    const progressive = typed.split('').map((_, i) => slugifyInput(typed.slice(0, i + 1)));
    expect(progressive[progressive.length - 1]).toBe(typed);
    // every prefix is preserved verbatim, which is what makes typing possible
    expect(progressive).toEqual(typed.split('').map((_, i) => typed.slice(0, i + 1)));
  });

  it('still lowercases and converts characters a slug cannot hold', () => {
    expect(slugifyInput('CS 101')).toBe('cs-101');
    expect(slugifyInput('Dartmouth!!')).toBe('dartmouth-');
  });

  // Dash is the only separator a slug may hold, so typing '.' or '_' produces a
  // dash rather than being silently dropped — the character the user typed still
  // separates the words either way.
  it('converts a typed dot or underscore to a dash rather than swallowing it', () => {
    expect(slugifyInput('cs.')).toBe('cs-');
    expect(slugifyInput('cs_')).toBe('cs-');
    expect(slugifyInput('cs.101')).toBe('cs-101');
    expect(slugifyInput('cs_101')).toBe('cs-101');
  });

  it('leaves a value that slugify then settles on blur', () => {
    expect(slugify(slugifyInput('cs-101-'))).toBe('cs-101');
    expect(slugify(slugifyInput('CS 101 -- Fall'))).toBe('cs-101-fall');
  });
});
