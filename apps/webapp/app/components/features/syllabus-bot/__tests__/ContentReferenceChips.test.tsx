/**
 * The citation chips, asserted against RENDERED MARKUP.
 *
 * These used to be regexes over `SyllabusBotChat.tsx` — a test that the source
 * contains `if (!url)` and a `<span>`, which is not a test that a null-URL
 * reference renders as one. A regex passes on a branch that is never reached,
 * on a component that throws before it draws, and on a `<span>` that somebody
 * later gave an `onClick`.
 *
 * `renderToStaticMarkup` needs no DOM and no new dependency — `react-dom` is
 * already one — so this runs in the ordinary node-environment unit suite.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ContentReferenceChips, { type ContentReference } from '../ContentReferenceChips';

const SLUG = 'cs52';
const SLIDES = 'https://slides.example';
const PAGES = 'https://pages.example';

const render = (references: ContentReference[]): string =>
  renderToStaticMarkup(
    <ContentReferenceChips
      references={references}
      classroomSlug={SLUG}
      slidesUrl={SLIDES}
      pagesUrl={PAGES}
    />
  );

/** A docs reference that builds a URL, and one that cannot. */
const LINKED: ContentReference = {
  referenceType: 'platform_docs',
  contentPath: 'docs/instructors/roster',
  displayText: 'Manage your roster',
};
const UNLINKABLE: ContentReference = {
  referenceType: 'platform_docs',
  // A bare name from the old `/docs/{name}` scheme: `buildContentReferenceUrl`
  // returns null for it rather than guessing a slug.
  contentPath: 'quizzes',
  displayText: 'Quizzes',
};

describe('a reference the widget cannot link to renders as TEXT, not a dead link', () => {
  it('gives the null-URL reference a span with no href and no tab stop', () => {
    const html = render([UNLINKABLE]);

    expect(html).toContain('<span class="askmoji-ref"');
    expect(html).toContain('Quizzes');
    // The three ways a dead chip used to pretend to be a link.
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href');
    expect(html).not.toContain('tabindex');
    expect(html).not.toContain('role=');
  });

  it('never emits href="#" — the fallback that navigated the page to itself', () => {
    expect(render([UNLINKABLE])).not.toContain('#');
  });

  it('gives the linked reference a real href, opened in a new tab safely', () => {
    const html = render([LINKED]);

    expect(html).toContain('href="https://classmoji.io/docs/instructors/roster"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Manage your roster');
  });

  it('draws both in ONE list, with the SAME chip class, so they look identical', () => {
    // The visual claim the span branch rests on: a reader must not be able to
    // tell a label from a link by its styling, only by whether it responds.
    // The chip's colours come from panel-level CSS variables, so one class is
    // correct in light and dark alike.
    const html = render([LINKED, UNLINKABLE]);

    expect(html.match(/class="askmoji-ref"/g) ?? []).toHaveLength(2);
    expect(html).toMatch(/<a [^>]*class="askmoji-ref"/);
    expect(html).toMatch(/<span class="askmoji-ref"/);
    expect(html.indexOf('Manage your roster')).toBeLessThan(html.indexOf('Quizzes'));
  });

  it('renders each reference type with its own icon, and an unknown one with the fallback', () => {
    // The icon is the only thing that distinguishes a page citation from a docs
    // one at a glance, and an unknown type must still draw something rather
    // than a hole.
    const svgs = (html: string) => (html.match(/<svg/g) ?? []).length;
    expect(svgs(render([{ ...LINKED, referenceType: 'page', contentPath: 'p1' }]))).toBe(1);
    expect(svgs(render([{ ...LINKED, referenceType: 'slides', contentPath: 'd1' }]))).toBe(1);
    expect(svgs(render([LINKED]))).toBe(1);
    expect(svgs(render([{ ...LINKED, referenceType: 'mystery' }]))).toBe(1);
  });

  it('draws nothing at all when there are no references', () => {
    // Not an empty `askmoji-refs` div: that reserves margin under an answer
    // that cited nothing.
    expect(render([])).toBe('');
  });
});
