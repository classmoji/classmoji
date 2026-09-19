/**
 * The documentation URL builder.
 *
 * One definition serves the MCP's hit `url` and the Ask Moji widget's chip, so
 * what is pinned here is that the two cannot produce different strings — and
 * that a malformed slug produces NO link rather than a link to nowhere.
 */

import { describe, expect, it } from 'vitest';
import { DOCS_SITE_BASE_URL, docsUrl, isDocsSlug } from '../docs.ts';

describe('docsUrl', () => {
  it.each([
    ['docs', 'https://classmoji.io/docs'],
    ['docs/instructors', 'https://classmoji.io/docs/instructors'],
    ['docs/instructors/roster', 'https://classmoji.io/docs/instructors/roster'],
    [
      'docs/open-source/local-development',
      'https://classmoji.io/docs/open-source/local-development',
    ],
    ['docs/video-tutorials', 'https://classmoji.io/docs/video-tutorials'],
  ])('%s → %s', (slug, url) => {
    expect(docsUrl(slug)).toBe(url);
  });

  it('builds on the one canonical origin, with no double slash', () => {
    expect(docsUrl('docs/instructors/roster')).toBe(
      `${DOCS_SITE_BASE_URL}/docs/instructors/roster`
    );
    expect(docsUrl('docs')).not.toContain('//docs');
  });

  it.each([
    ['quizzes', 'a bare doc name from the old /docs/{name} scheme'],
    ['assignments', 'another one'],
    ['docs/../admin', 'traversal'],
    ['../../etc/passwd', 'traversal from the root'],
    ['/docs/instructors/roster', 'an absolute path — the slug carries no leading slash'],
    ['docs/instructors/roster/', 'a trailing slash'],
    ['docs/Instructors/Roster', 'uppercase — slugs are lowercase'],
    ['docs/instructors/roster.mdx', 'the file extension, which the slug never carries'],
    ['https://evil.example/docs', 'an absolute URL'],
    ['docs//instructors', 'an empty segment'],
    ['docs/-leading-dash', 'a segment starting with a dash'],
    ['', 'empty'],
  ])('refuses %s (%s)', slug => {
    expect(docsUrl(slug)).toBeNull();
    expect(isDocsSlug(slug)).toBe(false);
  });

  it('refuses anything that is not a string', () => {
    for (const value of [null, undefined, 42, {}, ['docs']]) {
      expect(docsUrl(value)).toBeNull();
      expect(isDocsSlug(value)).toBe(false);
    }
  });

  it('is a SHAPE guard, not an existence check — and says so', () => {
    // Documented explicitly so nobody reads a passing slug as a live page.
    expect(docsUrl('docs/instructors/made-up-feature')).toBe(
      'https://classmoji.io/docs/instructors/made-up-feature'
    );
  });
});
