import { describe, it, expect } from 'vitest';
import { slugify, slugifyInput } from '../utils.ts';

describe('slugify', () => {
  it('normalizes a name into a slug', () => {
    expect(slugify('Rendering Algorithms Fall 2024')).toBe('rendering-algorithms-fall-2024');
    expect(slugify('  CS87 -- Dartmouth!  ')).toBe('cs87-dartmouth');
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

  it('leaves a value that slugify then settles on blur', () => {
    expect(slugify(slugifyInput('cs-101-'))).toBe('cs-101');
    expect(slugify(slugifyInput('CS 101 -- Fall'))).toBe('cs-101-fall');
  });
});
