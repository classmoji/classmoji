import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  SUBDOMAIN_REGEX,
  RESERVED_PAGE_SLUGS,
  RESERVED_SUBDOMAINS,
  isReservedPageSlug,
  isReservedSubdomain,
  isValidSubdomain,
  normalizeSubdomain,
} from '../subdomains.ts';

describe('normalizeSubdomain', () => {
  it('trims and lowercases, and nothing else', () => {
    expect(normalizeSubdomain('  CS52  ')).toBe('cs52');
    expect(normalizeSubdomain('CS 52')).toBe('cs 52'); // still invalid — not repaired
    expect(normalizeSubdomain(null)).toBe('');
    expect(normalizeSubdomain(undefined)).toBe('');
  });
});

describe('isValidSubdomain', () => {
  it.each(['a', 'cs52', 'cs-52', 'a1b2c3', 'x'.repeat(63)])('accepts %s', label => {
    expect(isValidSubdomain(label)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['-cs52', 'leading hyphen'],
    ['cs52-', 'trailing hyphen'],
    ['CS52', 'uppercase — the unique index is byte-comparing'],
    ['cs_52', 'underscore'],
    ['cs 52', 'space'],
    ['cs.52', 'dot — this is ONE label, not a hostname'],
    ['x'.repeat(64), '64 characters'],
  ])('rejects %s (%s)', label => {
    expect(isValidSubdomain(label)).toBe(false);
  });

  it('does not normalize for you', () => {
    expect(isValidSubdomain('  cs52  ')).toBe(false);
  });
});

describe('reserved registries', () => {
  it('refuses the platform hosts', () => {
    expect(isReservedSubdomain('app')).toBe(true);
    expect(isReservedSubdomain('classmoji')).toBe(true);
    expect(isReservedSubdomain('cs52')).toBe(false);
  });

  it('refuses the platform-owned first path segments', () => {
    expect(isReservedPageSlug('schedule')).toBe(true);
    expect(isReservedPageSlug('sign-in')).toBe(true);
    expect(isReservedPageSlug('week-1')).toBe(false);
  });

  it('keeps the two registries distinct — a site label is not a page path', () => {
    // `www` may not be claimed as a subdomain but is a perfectly good page slug;
    // conflating the sets would silently rename authored pages.
    expect(RESERVED_SUBDOMAINS.has('www')).toBe(true);
    expect(RESERVED_PAGE_SLUGS.has('www')).toBe(false);
  });

  it('lists only labels that are themselves valid subdomains', () => {
    // A reserved entry that could never be typed is dead weight and hides typos.
    for (const label of RESERVED_SUBDOMAINS) {
      expect(SUBDOMAIN_REGEX.test(label), `${label} is not a valid DNS label`).toBe(true);
    }
  });
});

// The two copies of these lists that cannot import each other. A drift here is
// silent in production: a page keeps a slug the router will never reach.
describe('cross-file registry agreement', () => {
  const repoFile = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8');

  const reservedArrayIn = (migration: string): Set<string> => {
    const sql = repoFile(`../../../database/migrations/${migration}/migration.sql`);
    const declaration = sql.match(/reserved CONSTANT TEXT\[\] := ARRAY\[([^\]]+)\]/);
    if (!declaration) throw new Error(`reserved array not found in ${migration}`);

    return new Set(
      declaration[1]
        .split(',')
        .map(entry => entry.trim().replace(/^'|'$/g, ''))
        .filter(Boolean)
    );
  };

  /**
   * The LATEST eviction migration is the one that has to match exactly: it ran
   * against every row in the table, so anything reserved but absent from its
   * array is a slug some page still holds and the router will never reach.
   * Adding an entry to the registry means adding a migration here too.
   */
  it('RESERVED_PAGE_SLUGS matches the migration that evicted pages holding them', () => {
    expect(reservedArrayIn('20260902180000_reserve_forms_page_slug')).toEqual(
      new Set(RESERVED_PAGE_SLUGS)
    );
  });

  /**
   * Earlier migrations are HISTORY — they name the registry as it stood when
   * they ran — so they are only required to be a subset. An entry that vanished
   * from the registry but still appears in one of them would mean a page was
   * evicted from a path that is free again, which nothing else would catch.
   */
  it('the first eviction migration lists only slugs still reserved today', () => {
    for (const slug of reservedArrayIn('20260821003300_page_slug_backfill_and_unique')) {
      expect(RESERVED_PAGE_SLUGS.has(slug), `${slug} was evicted but is no longer reserved`).toBe(
        true
      );
    }
  });

  it('SUBDOMAIN_REGEX matches the CHECK constraint that enforces it', () => {
    const sql = repoFile(
      '../../../database/migrations/20260821003200_add_classroom_sites/migration.sql'
    );
    const check = sql.match(/CHECK \("subdomain" ~ '([^']+)'\)/);
    if (!check) throw new Error('subdomain CHECK not found in the migration');
    expect(check[1]).toBe(SUBDOMAIN_REGEX.source);
  });
});
