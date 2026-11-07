import { describe, expect, it } from 'vitest';
import { safeReturn } from '../url.ts';

/**
 * The Back link on a person's and a classroom's page reads `?from=`, which the
 * list pages set to their own path and query (`encodeURIComponent`, so the
 * value arrives decoded once and any non-ASCII search stays percent-encoded).
 */
describe('safeReturn', () => {
  it.each([
    ['/people'],
    ['/people?q=ada&page=2'],
    ['/people?q=Jos%C3%A9&page=2'],
    ['/people?q=ada lovelace'],
    ['/classrooms?status=ACTIVE&sort=name'],
    ['/classrooms/cs52-26f'],
  ])('keeps the list page path %s', from => {
    expect(safeReturn(from, '/people')).toBe(from);
  });

  it.each([
    [null],
    [''],
    ['people'],
    ['https://example.com/people'],
    ['//example.com/people'],
    ['/\\example.com'],
    ['/\t/example.com'],
    ['/\n/example.com'],
    ['/.//example.com'],
    ['/people?q=José'],
  ])('falls back for %j', from => {
    expect(safeReturn(from, '/people')).toBe('/people');
  });
});
