import { describe, expect, it } from 'vitest';
import { BUTTON_TEXT, buttonActionFor, replyShowsHint } from '../uiTypes.ts';

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

describe('replyShowsHint', () => {
  const text = (t: string, state?: string) => ({
    type: 'text',
    text: t,
    ...(state ? { state } : {}),
  });
  const notice = (code: string) => ({ type: 'data-notice', data: { code } });
  const refused = {
    type: 'tool-offer_next_step',
    toolCallId: 'toolu_1',
    state: 'output-error',
    errorText: 'An error occurred.',
  };

  it('holds for a reply with text and no notice, finished or stopped part way', () => {
    expect(replyShowsHint([{ type: 'step-start' }, text("Here's a hint.")])).toBe(true);
    expect(replyShowsHint([refused, text("Here's a", 'streaming')])).toBe(true);
  });

  it('does not hold for a reply with a notice, text or not', () => {
    expect(replyShowsHint([notice('source_material_unavailable')])).toBe(false);
    expect(replyShowsHint([text("Here's a"), notice('reply_failed')])).toBe(false);
    expect(replyShowsHint([text("Here's a"), notice('turn_stopped')])).toBe(false);
  });

  it('does not hold for a reply that shows no text', () => {
    expect(replyShowsHint([])).toBe(false);
    expect(replyShowsHint([{ type: 'step-start' }, text('  \n ')])).toBe(false);
    expect(replyShowsHint([{ type: 'step-start' }, refused])).toBe(false);
    expect(replyShowsHint([{ type: 'reasoning', text: 'thinking' }])).toBe(false);
    expect(replyShowsHint([null, 'text', { type: 'text', text: 3 }])).toBe(false);
  });
});
