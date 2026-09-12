import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildContentReferenceUrl, normalizeAssistantText } from '../contentReferenceUrl';

describe('buildContentReferenceUrl', () => {
  const page = { referenceType: 'page', contentPath: 'abc-123', displayText: 'Course Schedule' };

  it('builds a page link from the pagesUrl the server handed the widget', () => {
    expect(buildContentReferenceUrl(page, 'cs52', null, 'https://pages.example')).toBe(
      'https://pages.example/cs52/abc-123'
    );
  });

  it('renders no link, and does not guess one, when pagesUrl is absent', () => {
    expect(buildContentReferenceUrl(page, 'cs52', 'https://slides.example')).toBeNull();
  });

  it('still builds slide links from slidesUrl', () => {
    expect(
      buildContentReferenceUrl(
        { referenceType: 'slides', contentPath: 'd1' },
        'cs52',
        'https://slides.example'
      )
    ).toBe('https://slides.example/d1');
  });

  it('never reads process.env — this module runs in the browser', () => {
    const source = readFileSync(new URL('../contentReferenceUrl.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/process\.env\./);
  });
});

describe('platform_docs references', () => {
  const docsRef = (contentPath: string) => ({
    referenceType: 'platform_docs',
    contentPath,
    displayText: 'Manage your roster',
  });

  it('builds the canonical absolute URL from a doc slug', () => {
    // NOT `/docs/${contentPath}`, which is what this used to do: the origin is
    // the marketing site rather than the app, and a full slug produced
    // `/docs/docs/instructors/roster`.
    expect(buildContentReferenceUrl(docsRef('docs/instructors/roster'), 'cs52')).toBe(
      'https://classmoji.io/docs/instructors/roster'
    );
  });

  it.each([
    ['docs', 'https://classmoji.io/docs'],
    ['docs/instructors', 'https://classmoji.io/docs/instructors'],
    [
      'docs/open-source/local-development',
      'https://classmoji.io/docs/open-source/local-development',
    ],
  ])('%s → %s', (slug, url) => {
    expect(buildContentReferenceUrl(docsRef(slug), 'cs52')).toBe(url);
  });

  it('never guesses the origin from the page it is rendered on', () => {
    // The widget runs inside the app, so a relative `/docs/...` would resolve
    // against app.classmoji.io, where the documentation is not served.
    const url = buildContentReferenceUrl(docsRef('docs/instructors/roster'), 'cs52');
    expect(url?.startsWith('https://classmoji.io/')).toBe(true);
  });

  it.each([
    ['quizzes', 'a bare doc name from the old /docs/{name} scheme'],
    ['assignments', 'another bare name'],
    ['docs/../admin', 'traversal'],
    ['/docs/instructors/roster', 'an absolute path — a slug carries no leading slash'],
    ['https://evil.example/docs', 'an absolute URL'],
    ['', 'empty'],
  ])('renders NO link for %s (%s)', slug => {
    expect(buildContentReferenceUrl(docsRef(slug), 'cs52')).toBeNull();
  });

  it('needs no env var and no init payload, unlike page and slide links', () => {
    // The docs origin is one public host for the whole fleet, so it is a
    // constant rather than something plumbed through the widget's init payload
    // — which is why this works with both URL arguments absent.
    expect(buildContentReferenceUrl(docsRef('docs/instructors/roster'), 'cs52', null, null)).toBe(
      'https://classmoji.io/docs/instructors/roster'
    );
  });
});

describe('the chip the widget draws for a reference', () => {
  /**
   * WHAT THIS BLOCK NO LONGER DOES.
   *
   * It used to grep `SyllabusBotChat.tsx` for `if (!url)` and a `<span>`, which
   * is a test that the source contains a branch — not a test that a null-URL
   * reference renders as a label. That markup now lives in
   * `ContentReferenceChips`, and
   * `components/features/syllabus-bot/__tests__/ContentReferenceChips.test.tsx`
   * asserts it against the HTML React actually produces.
   *
   * What is left here is the one claim the render test cannot make: the chip's
   * single class has to be correct in BOTH themes, which is a CSS fact.
   */
  it('the chip class is themed by variables the panel redefines in dark mode', () => {
    const css = readFileSync(
      new URL('../../components/features/syllabus-bot/styles.css', import.meta.url),
      'utf8'
    );
    expect(css).toMatch(/\.askmoji-ref \{[\s\S]*?var\(--am-ref-bg\)/);
    expect(css).toMatch(/\.dark \.askmoji-panel/);
  });
});

describe('normalizeAssistantText', () => {
  it('collapses an invented <referenced_content> tag to its title', () => {
    expect(
      normalizeAssistantText(
        'The <referenced_content id="f4" type="page" title="Term Demos">Term Demos</referenced_content> page covers it.'
      )
    ).toBe('The Term Demos page covers it.');
  });

  it('collapses [page:Title] to the title', () => {
    expect(
      normalizeAssistantText('According to the [page:Course Schedule], Exam 2 is on Oct 22.')
    ).toBe('According to the Course Schedule, Exam 2 is on Oct 22.');
  });

  it('leaves ordinary markdown alone', () => {
    const md = '**Bold** and `code` and a [link](https://example.com) and [not a tag].';
    expect(normalizeAssistantText(md)).toBe(md);
  });
});
