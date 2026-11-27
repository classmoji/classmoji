/**
 * The New Slide picker at the Free plan's slide limit, which counts decks only.
 *
 * The rule itself (decks counted, files and links never) is pinned in the
 * services' `planLimits.test.ts`. What is pinned here is the route structure
 * around it, which needs a database to render: at the limit only the "Start
 * blank" choice is replaced by the limit notice, and the upload and link forms
 * are untouched by it, in any form (negated, ternary, a renamed copy).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const NEW_SOURCE = readFileSync(
  fileURLToPath(new URL('../../app/routes/$classroomSlug.new/route.tsx', import.meta.url)),
  'utf8'
);

/** The text from `start` up to (not including) `end`; both must be there. */
const between = (text: string, start: string, end: string): string => {
  const from = text.indexOf(start);
  expect(from, `missing: ${start}`).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from + start.length);
  expect(to, `missing: ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
};

const count = (text: string, needle: string): number => text.split(needle).length - 1;

const PAGE = between(NEW_SOURCE, 'export default function NewSlidePage', '\n}\n');
const FORM = between(NEW_SOURCE, 'function NewSlideForm()', '\n}\n');
const FILE_BRANCH = between(FORM, "{source === 'file' && (", "{source === 'link' && (");
const LINK_BRANCH = FORM.slice(FORM.indexOf("{source === 'link' && ("));

test.describe('New Slide at the deck limit', () => {
  test('the page is the picker, never a whole-page refusal', () => {
    expect(PAGE).toContain('<NewSlideForm />');
    expect(PAGE).not.toContain('deckLimit');
    expect(PAGE).not.toContain('deckNotice');
  });

  test('the limit reaches the form through one value, tied to the blank choice', () => {
    // Read once from the loader, and used once: to derive the blank-only notice.
    expect(count(FORM, 'deckLimitMessage')).toBe(2);
    expect(FORM).toContain("const deckNotice = source === 'blank' ? deckLimitMessage : null;");
    // Its definition, the alert's dedupe, the notice, and the blank form's guard.
    expect(count(FORM, 'deckNotice')).toBe(5);
    expect(FORM).toContain('{deckNotice && (');
    expect(FORM).toContain("{source === 'blank' && !deckNotice && (");
  });

  test('the file and link forms are not gated by the deck limit in any form', () => {
    for (const branch of [FILE_BRANCH, LINK_BRANCH]) {
      expect(branch).not.toMatch(/deckLimit|deckNotice|DeckLimitReached|PLAN_CONTENT/);
    }
  });

  test('the notice says the sentence once and links to the choices that still work', () => {
    expect(FORM).toContain('serverError !== deckNotice');
    const notice = between(NEW_SOURCE, 'function DeckLimitReached', '\n}\n');
    expect(notice).toMatch(/to="\?source=file"[^>]*>\s*Upload a file\s*</);
    expect(notice).toMatch(/to="\?source=link"[^>]*>\s*Link a URL\s*</);
  });

  test('the notice is the slide limit sentence, from the slide allowance', () => {
    const loader = between(NEW_SOURCE, 'export const loader', 'export const action');
    expect(loader).toMatch(/contentAllowance\(\s*classroom\.id,\s*'slides'\s*\)/);
    expect(loader).toContain("contentLimitMessage('slides', limit)");
  });
});
