import { describe, it, expect } from 'vitest';
import { toCsv } from '../csv.ts';

describe('toCsv', () => {
  it('quotes commas, quotes and newlines, and leaves empties empty', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['x, y', 'say "hi"'],
          [null, 'two\nlines'],
        ]
      )
    ).toBe('a,b\r\n"x, y","say ""hi"""\r\n,"two\nlines"\r\n');
  });
  it('defuses cells a spreadsheet would run as a formula', () => {
    expect(toCsv(['n'], [['=HYPERLINK("x")'], ['-1+1'], ['@sum']])).toBe(
      'n\r\n"\'=HYPERLINK(""x"")"\r\n\'-1+1\r\n\'@sum\r\n'
    );
  });
});
