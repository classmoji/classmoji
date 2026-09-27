/**
 * `serverErrorLine`: which part of a failed JSON reply the Ask Moji and prompt
 * assistant hooks may show.
 *
 * The classroom-status gate answers `{ error: 'CLASSROOM_LOCKED', message }`,
 * so reading `error` alone put a bare code in front of students. `message`
 * comes first; an `error` is used only when it reads as text; anything else
 * leaves the hook to its own fixed copy.
 */

import { describe, expect, it } from 'vitest';

import { serverErrorLine } from '../serverErrorLine';

describe('serverErrorLine', () => {
  it("shows the status gate's message, not its code", () => {
    expect(
      serverErrorLine({
        error: 'CLASSROOM_LOCKED',
        message: 'This class is in read-only mode. The owner has locked it.',
      })
    ).toBe('This class is in read-only mode. The owner has locked it.');
  });

  it("shows a route's own error line", () => {
    expect(serverErrorLine({ error: "Ask Moji isn't available in this class." })).toBe(
      "Ask Moji isn't available in this class."
    );
  });

  it.each(['CLASSROOM_LOCKED', 'CLASSROOM_UNPUBLISHED', 'QUIZZES_UNAVAILABLE', 'E500'])(
    'treats a bare code (%s) as no line',
    code => {
      expect(serverErrorLine({ error: code })).toBeNull();
    }
  );

  it.each([
    ['null', null],
    ['a string', 'Not Found'],
    ['an empty object', {}],
    ['empty strings', { error: '', message: '   ' }],
    ['non-string fields', { error: 403, message: { text: 'x' } }],
  ])('answers null for %s', (_label, body) => {
    expect(serverErrorLine(body)).toBeNull();
  });
});
