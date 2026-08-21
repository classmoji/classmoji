/**
 * Unit tests for the navGrid ("Page directory") entry parser
 * (`app/components/editor/blocks/navGridShared.ts`).
 *
 * These run in the Playwright runner WITHOUT a browser or the dev stack — the
 * module is pure. It is shared by three consumers (the editor block, the HTML
 * export, and the class-site server renderer), so it carries two guarantees:
 *
 *  - it NEVER throws. The `entries` prop is a JSON string living in
 *    user-authored page content; malformed JSON must degrade to an empty
 *    directory (which the editor renders as its "Add your first link" state),
 *    not blow up a page render.
 *  - it sanitizes external URLs. Entries are authored by instructors but
 *    rendered to every visitor, including anonymous ones, so `javascript:`
 *    and friends must not survive parsing.
 */

import { test, expect } from '@playwright/test';
import {
  moveNavGridEntry,
  navGridEntryLabel,
  normalizeNavGridColumns,
  parseNavGridEntries,
  sanitizeNavGridEmoji,
  sanitizeNavGridUrl,
  serializeNavGridEntries,
  type NavGridEntry,
} from '../../app/components/editor/blocks/navGridShared.ts';

test.describe('parseNavGridEntries — never throws', () => {
  const junk: unknown[] = [
    '{not json',
    '',
    '   ',
    null,
    undefined,
    42,
    '{"a":1}',
    '"a string"',
    '[null, 3, "x"]',
    [{ kind: 'page' }],
  ];

  for (const value of junk) {
    test(`degrades to [] for ${JSON.stringify(value) ?? 'undefined'}`, () => {
      expect(parseNavGridEntries(value)).toEqual([]);
    });
  }
});

test.describe('parseNavGridEntries — entry shapes', () => {
  test('keeps a well-formed page entry', () => {
    expect(
      parseNavGridEntries('[{"kind":"page","pageId":"p1","title":"Syllabus","emoji":"📌"}]')
    ).toEqual([{ kind: 'page', pageId: 'p1', title: 'Syllabus', emoji: '📌' }]);
  });

  test('accepts snake_case page_id on the way in, always emits pageId', () => {
    expect(parseNavGridEntries('[{"kind":"page","page_id":"p1","title":"T"}]')).toEqual([
      { kind: 'page', pageId: 'p1', title: 'T' },
    ]);
  });

  test('drops a page entry with no id', () => {
    expect(parseNavGridEntries('[{"kind":"page","title":"orphan"}]')).toEqual([]);
  });

  test('drops an unknown kind', () => {
    expect(parseNavGridEntries('[{"kind":"widget","url":"https://x.com"}]')).toEqual([]);
  });

  test('accepts a parsed array as well as a JSON string', () => {
    const entries: NavGridEntry[] = [{ kind: 'page', pageId: 'p1', title: 'T' }];
    expect(parseNavGridEntries(entries)).toEqual(entries);
  });

  test('keeps good entries and drops bad ones in the same list', () => {
    const raw =
      '[{"kind":"page","pageId":"p1","title":"Good"},{"kind":"page"},{"kind":"external","url":"javascript:alert(1)","label":"Bad"},{"kind":"external","url":"https://ok.dev","label":"Fine"}]';
    expect(parseNavGridEntries(raw)).toEqual([
      { kind: 'page', pageId: 'p1', title: 'Good' },
      { kind: 'external', url: 'https://ok.dev/', label: 'Fine' },
    ]);
  });
});

test.describe('sanitizeNavGridUrl — external links reach anonymous visitors', () => {
  test('rejects javascript: and data: schemes', () => {
    expect(sanitizeNavGridUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeNavGridUrl('JaVaScRiPt:alert(1)')).toBeNull();
    expect(sanitizeNavGridUrl('data:text/html,<script>x</script>')).toBeNull();
    expect(sanitizeNavGridUrl('file:///etc/passwd')).toBeNull();
  });

  test('allows http, https and mailto', () => {
    expect(sanitizeNavGridUrl('http://x.dev/a')).toBe('http://x.dev/a');
    expect(sanitizeNavGridUrl('https://x.dev/a')).toBe('https://x.dev/a');
    expect(sanitizeNavGridUrl('mailto:prof@dartmouth.edu')).toBe('mailto:prof@dartmouth.edu');
  });

  test('adds https:// to a bare host so authors need not type it', () => {
    expect(sanitizeNavGridUrl('piazza.com/cs52')).toBe('https://piazza.com/cs52');
  });

  test('rejects empty / non-string input', () => {
    expect(sanitizeNavGridUrl('')).toBeNull();
    expect(sanitizeNavGridUrl('   ')).toBeNull();
    expect(sanitizeNavGridUrl(null)).toBeNull();
  });
});

test.describe('serialize / round-trip', () => {
  test('round-trips a mixed directory unchanged', () => {
    const json =
      '[{"kind":"page","pageId":"p1","title":"Syllabus","emoji":"📌"},' +
      '{"kind":"external","url":"https://piazza.com/","label":"Piazza"}]';
    expect(serializeNavGridEntries(parseNavGridEntries(json))).toBe(json);
  });

  test('serializing sanitizes too (bad entries never reach the prop)', () => {
    const dirty = [
      { kind: 'external', url: 'javascript:alert(1)', label: 'x' },
      { kind: 'page', pageId: 'p1', title: 'T' },
    ] as unknown as NavGridEntry[];
    expect(serializeNavGridEntries(dirty)).toBe('[{"kind":"page","pageId":"p1","title":"T"}]');
  });

  test('empty list serializes to the prop default', () => {
    expect(serializeNavGridEntries([])).toBe('[]');
  });
});

test.describe('helpers', () => {
  test('normalizeNavGridColumns coerces to 1 or 2', () => {
    expect(normalizeNavGridColumns(1)).toBe(1);
    expect(normalizeNavGridColumns('1')).toBe(1);
    expect(normalizeNavGridColumns(2)).toBe(2);
    expect(normalizeNavGridColumns(7)).toBe(2);
    expect(normalizeNavGridColumns(undefined)).toBe(2);
    expect(normalizeNavGridColumns('nonsense')).toBe(2);
  });

  test('sanitizeNavGridEmoji trims to a few code points, drops empties', () => {
    expect(sanitizeNavGridEmoji('📌')).toBe('📌');
    expect(sanitizeNavGridEmoji('   ')).toBeUndefined();
    expect(sanitizeNavGridEmoji(undefined)).toBeUndefined();
    expect(sanitizeNavGridEmoji('abcdefgh')).toBe('abcd');
  });

  test('navGridEntryLabel falls back sensibly', () => {
    expect(navGridEntryLabel({ kind: 'page', pageId: 'p', title: '' })).toBe('Untitled');
    expect(
      navGridEntryLabel({ kind: 'external', url: 'https://www.piazza.com/x', label: '' })
    ).toBe('piazza.com');
    expect(navGridEntryLabel({ kind: 'external', url: 'https://x.dev', label: 'Named' })).toBe(
      'Named'
    );
  });

  test('moveNavGridEntry reorders without mutating, ignores out-of-range', () => {
    const entries: NavGridEntry[] = [
      { kind: 'page', pageId: 'a', title: 'A' },
      { kind: 'page', pageId: 'b', title: 'B' },
    ];
    const moved = moveNavGridEntry(entries, 0, 1);
    expect(moved.map(e => (e as { pageId: string }).pageId)).toEqual(['b', 'a']);
    expect(entries.map(e => (e as { pageId: string }).pageId)).toEqual(['a', 'b']);
    expect(moveNavGridEntry(entries, 0, 5)).toBe(entries);
    expect(moveNavGridEntry(entries, -1, 0)).toBe(entries);
  });
});
