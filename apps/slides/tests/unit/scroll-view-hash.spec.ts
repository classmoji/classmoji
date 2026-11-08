/**
 * A deck link with a slide hash on a phone (#763): reveal's scroll view puts
 * each slide in a `.scroll-page`, and the viewer scrolls the page of the slide
 * the hash names to the top itself.
 *
 * Runs in the Playwright runner WITHOUT a browser — jsdom stands in for it.
 */

import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';
import { hashForSlide, scrollToSlidePage, slideForHash } from '../../app/utils/scrollViewHash.ts';

// Scroll-view markup as reveal builds it: one page per slide, the stack's
// children carrying both indices.
const deck = () =>
  new JSDOM(`<div class="slides">
    <div class="scroll-page"><section data-index-h="0" id="intro">Intro</section></div>
    <div class="scroll-page"><section data-index-h="1" data-index-v="0">Stack top</section></div>
    <div class="scroll-page"><section data-index-h="1" data-index-v="1" id="deep:dive">Stack 2</section></div>
    <div class="scroll-page"><section data-index-h="34">Your turn</section></div>
  </div>`).window.document.querySelector('.slides')!;

test.describe('slideForHash', () => {
  test('reads h and v indices', () => {
    const root = deck();
    expect(slideForHash('#/34/0', root)?.textContent).toBe('Your turn');
    expect(slideForHash('#/34', root)?.textContent).toBe('Your turn');
    expect(slideForHash('#/1/1', root)?.textContent).toBe('Stack 2');
    expect(slideForHash('#/1', root)?.textContent).toBe('Stack top');
  });

  test('ignores a fragment index after h/v', () => {
    expect(slideForHash('#/1/1/2', deck())?.textContent).toBe('Stack 2');
  });

  test('reads a slide id, any characters', () => {
    const root = deck();
    expect(slideForHash('#/intro', root)?.textContent).toBe('Intro');
    expect(slideForHash('#/deep%3Adive', root)?.textContent).toBe('Stack 2');
  });

  test('finds nothing for an empty hash, a missing slide or a bad escape', () => {
    const root = deck();
    expect(slideForHash('', root)).toBeNull();
    expect(slideForHash('#/', root)).toBeNull();
    expect(slideForHash('#/99', root)).toBeNull();
    expect(slideForHash('#/nope', root)).toBeNull();
    expect(slideForHash('#/%E0%A4%A', root)).toBeNull();
  });
});

test.describe('scrollToSlidePage', () => {
  const rect = (top: number) => ({ top }) as DOMRect;

  test("puts the slide's page at the top of the viewport, below the navbar", () => {
    const root = deck();
    const slide = slideForHash('#/34', root)!;
    const page = slide.closest('.scroll-page')!;
    const viewport = root.ownerDocument.body;
    viewport.scrollTop = 100;
    // The page sits 2,000px below the viewport's top as currently scrolled.
    page.getBoundingClientRect = () => rect(2000);
    viewport.getBoundingClientRect = () => rect(0);

    expect(scrollToSlidePage(viewport, slide, 56)).toBe(true);
    expect(viewport.scrollTop).toBe(100 + 2000 - 56);
  });

  test('never scrolls above the top', () => {
    const root = deck();
    const slide = slideForHash('#/0', root)!;
    const viewport = root.ownerDocument.body;
    slide.closest('.scroll-page')!.getBoundingClientRect = () => rect(0);
    viewport.getBoundingClientRect = () => rect(0);

    scrollToSlidePage(viewport, slide, 56);
    expect(viewport.scrollTop).toBe(0);
  });
});

test.describe('hashForSlide', () => {
  test('writes h, h/v, or the slide id, and reads back to the same slide', () => {
    const root = deck();
    expect(hashForSlide(slideForHash('#/34', root), 34, 0)).toBe('#/34');
    expect(hashForSlide(root.querySelector('[data-index-v="0"]'), 1, 0)).toBe('#/1');
    const withId = slideForHash('#/1/1', root);
    expect(hashForSlide(withId, 1, 1)).toBe('#/deep%3Adive');
    expect(slideForHash(hashForSlide(withId, 1, 1), root)).toBe(withId);
    expect(hashForSlide(null, 2, 3)).toBe('#/2/3');
  });
});
