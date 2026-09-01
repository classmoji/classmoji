import { describe, expect, it } from 'vitest';

import { csvCell, csvTextCell, toCsv } from '../csv.ts';

describe('csvTextCell', () => {
  it('marks text that a spreadsheet would otherwise read as a formula', () => {
    expect(csvTextCell('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(csvTextCell('+1 on this')).toBe("'+1 on this");
    expect(csvTextCell('-Anne')).toBe("'-Anne");
    expect(csvTextCell('@channel')).toBe("'@channel");
  });

  /**
   * PADDING IS NOT PROTECTION.
   *
   * Excel trims a cell before deciding what it is, so `" =1+1"` and `"=1+1"` are
   * the same formula to it. The check used to look at the LITERAL first
   * character, which meant one leading space walked straight past it — and a
   * space is the easiest thing in the world to type into a form field. Every
   * whitespace a spreadsheet skips has to be skipped here too, or the guard is
   * only stopping the attempts that were not really trying.
   */
  it('sees through leading whitespace, which is how the guard was bypassed', () => {
    for (const pad of [' ', '  ', '\t', '\r', '\n', '\r\n', '\u00a0', '\ufeff', ' \t\n ']) {
      const cell = `${pad}=cmd|'/c calc'!A1`;
      // The apostrophe goes on, and the cell keeps what the person actually
      // typed — padding included. Neutralizing it is the job; tidying is not.
      expect(csvTextCell(cell), JSON.stringify(pad)).toBe(`'${cell}`);
    }

    // Every formula starter, not only `=`.
    expect(csvTextCell(' +1 on this')).toBe("' +1 on this");
    expect(csvTextCell('\t-Anne')).toBe("'\t-Anne");
    expect(csvTextCell('\n@channel')).toBe("'\n@channel");
  });

  it('leaves ordinary text exactly as it was typed', () => {
    expect(csvTextCell('Maya Chen')).toBe('Maya Chen');
    expect(csvTextCell('emailed 8/25 — waiting')).toBe('emailed 8/25 — waiting');
    // Only the first SIGNIFICANT character decides. A formula character anywhere
    // else is ordinary punctuation and must not move the rest of the cell — and
    // indented prose is prose.
    expect(csvTextCell('a = b')).toBe('a = b');
    expect(csvTextCell('  indented note')).toBe('  indented note');
    expect(csvTextCell('')).toBe('');
    // All-whitespace has no significant character to judge, and must not be
    // mistaken for one.
    expect(csvTextCell('   ')).toBe('   ');
  });
});

describe('csvCell', () => {
  it('passes numbers through untouched', () => {
    // The case the string-only rule exists for: a negative number is a number,
    // not text that happens to start with a minus sign.
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(7.5)).toBe('7.5');
  });

  it('renders nothing for null and undefined', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('renders booleans as spreadsheet booleans', () => {
    expect(csvCell(true)).toBe('TRUE');
    expect(csvCell(false)).toBe('FALSE');
  });

  it('applies text-cell handling to strings', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('plain')).toBe('plain');
  });

  it('renders a non-finite number as empty rather than the literal NaN', () => {
    expect(csvCell(Number.NaN)).toBe('');
    expect(csvCell(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('toCsv', () => {
  it('quotes cells carrying a delimiter, a quote, or a newline', () => {
    expect(toCsv([['a,b', 'say "hi"', 'line\nbreak']])).toBe('"a,b","say ""hi""","line\nbreak"');
  });

  it('joins rows with CRLF and leaves simple cells unquoted', () => {
    expect(
      toCsv([
        ['Name', 'Score'],
        ['Maya', 9],
      ])
    ).toBe('Name,Score\r\nMaya,9');
  });

  it('marks a formula-shaped cell AND quotes it when both rules apply', () => {
    expect(toCsv([['=CONCAT(A1,"x")']])).toBe('"\'=CONCAT(A1,""x"")"');
  });

  it('renders a ragged row as its own cells, and an empty document as empty', () => {
    expect(toCsv([])).toBe('');
    expect(toCsv([[], ['a']])).toBe('\r\na');
  });
});
