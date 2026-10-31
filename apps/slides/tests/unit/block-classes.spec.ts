/**
 * The properties panel's Classes field (#366): which classes it shows, what it
 * accepts, and that it can never strip the classes the editor selects a block by.
 *
 * Runs in the Playwright runner WITHOUT a browser — jsdom stands in for it.
 */

import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';
import { applyUserClasses, parseClassInput, userClassesOf } from '../../app/utils/blockClasses.ts';

const content = (className: string): Element =>
  new JSDOM(`<div class="${className}"></div>`).window.document.querySelector('div')!;

test.describe('userClassesOf', () => {
  test('lists the user classes and hides the structural ones', () => {
    expect(userClassesOf(content('sl-block-content plain tim'))).toEqual(['plain', 'tim']);
    expect(userClassesOf(content('sl-block sl-block-content'))).toEqual([]);
  });
});

test.describe('parseClassInput', () => {
  test('splits on spaces and commas and keeps each class once', () => {
    expect(parseClassInput('plain, tim  plain\tcard\n')).toEqual({
      classes: ['plain', 'tim', 'card'],
      invalid: [],
    });
  });

  test('returns nothing for an empty field', () => {
    expect(parseClassInput('  ')).toEqual({ classes: [], invalid: [] });
  });

  test('leaves out names no selector can match, and says which', () => {
    expect(parseClassInput('plain 9lives a.b <x> -ok _ok')).toEqual({
      classes: ['plain', '-ok', '_ok'],
      invalid: ['9lives', 'a.b', '<x>'],
    });
  });

  test('never lets the structural classes in', () => {
    expect(parseClassInput('sl-block sl-block-content plain')).toEqual({
      classes: ['plain'],
      invalid: [],
    });
  });
});

test.describe('applyUserClasses', () => {
  test('adds and removes user classes, keeping the structural ones', () => {
    const element = content('sl-block-content plain tim');

    expect(applyUserClasses(element, ['tim', 'card'])).toBe(true);

    expect(Array.from(element.classList).sort()).toEqual(['card', 'sl-block-content', 'tim']);
  });

  test('clearing the field removes every user class and nothing else', () => {
    const element = content('sl-block-content plain');

    applyUserClasses(element, []);

    expect(element.className).toBe('sl-block-content');
  });

  test('reports no change when the classes already match', () => {
    const element = content('sl-block-content plain tim');

    expect(applyUserClasses(element, ['tim', 'plain'])).toBe(false);
    expect(element.className).toBe('sl-block-content plain tim');
  });
});
