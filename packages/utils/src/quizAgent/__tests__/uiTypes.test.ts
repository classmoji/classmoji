import { describe, expect, it } from 'vitest';
import { BUTTON_TEXT, buttonActionFor } from '../uiTypes.ts';

describe('buttonActionFor', () => {
  it('names each button by its own text, trimmed and in any case', () => {
    expect(buttonActionFor(BUTTON_TEXT.try_again)).toBe('try_again');
    expect(buttonActionFor(`  ${BUTTON_TEXT.try_again.toUpperCase()} `)).toBe('try_again');
    expect(buttonActionFor(BUTTON_TEXT.next)).toBe('next');
    expect(buttonActionFor(' Next ')).toBe('next');
  });

  it('takes a message that is just "try again" as the Try again button', () => {
    for (const typed of [
      'try again',
      'Try again',
      '  TRY AGAIN  ',
      'try  again',
      'try again.',
      'Try again!',
      'try again?',
      'try again…',
      'try again!!',
    ]) {
      expect(buttonActionFor(typed)).toBe('try_again');
    }
  });

  it('names no button for any other message', () => {
    for (const typed of [
      '',
      'try',
      'again',
      'try again please',
      'can I try again?',
      "let's try again",
      'try again, I think it is 4',
      'try-again',
      'next question',
      'next.',
      'my answer is next',
    ]) {
      expect(buttonActionFor(typed)).toBeUndefined();
    }
  });
});
