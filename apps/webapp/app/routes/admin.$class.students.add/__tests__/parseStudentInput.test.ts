/**
 * The Add Students parser marks rows it will not submit. It shares the
 * registration address check: the regex it used before passed
 * `krishna@gmail.co.`, which Resend refuses, and that one row failed the
 * whole batch of invitation emails.
 */

import { describe, expect, it } from 'vitest';
import { parseStudentInput } from '../utils';

describe('parseStudentInput', () => {
  it('marks an address with a trailing dot invalid', () => {
    const [row] = parseStudentInput('Krishna, krishna@gmail.co.');
    expect(row.error).toBe('Invalid email');
  });

  it('accepts comma and tab separated rows, lower-casing the address', () => {
    const rows = parseStudentInput('Jane, Jane@School.edu\nSam\tsam@school.edu');
    expect(rows.map(r => [r.email, r.error])).toEqual([
      ['jane@school.edu', undefined],
      ['sam@school.edu', undefined],
    ]);
  });

  it('marks a row with no address as missing fields', () => {
    expect(parseStudentInput('Jane')[0].error).toBe('Missing fields');
  });
});
