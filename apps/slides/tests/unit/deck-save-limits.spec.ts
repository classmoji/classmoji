/**
 * A deck save is counted before it is parsed: its ops (an ops save) or its
 * slides HTML (a whole-deck save), each at most `DOCUMENT_SAVE_MAX_BYTES`, in a
 * request body sized from that cap.
 *
 * The deck editor's action needs Postgres and a content repo, so its order and
 * answers are pinned from source; the limits are checked on decks built at and
 * well above the size of the largest real one.
 * Runs in the Playwright runner without a browser or the dev stack.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { deckOpsPayloadSchema } from '@classmoji/services/slides/ops';
import { DOCUMENT_SAVE_MAX_BYTES } from '@classmoji/utils/repo-limits';
import { UploadTooLargeError, parseJsonWithin, textOverBytes } from '@classmoji/utils/upload-limit';

const VIEWER_SOURCE = readFileSync(
  fileURLToPath(new URL('../../app/routes/$slideId/route.tsx', import.meta.url)),
  'utf8'
);
const ACTION = VIEWER_SOURCE.slice(VIEWER_SOURCE.indexOf('export const action'));

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** The largest deck measured in real course content (deck.json, 2026-11-11). */
const LARGEST_REAL_DECK_BYTES = 190_397;

/** Slide markup like the editor's: a text block with a heading and a list. */
function slideHtml(n: number): string {
  return (
    `<div class="sl-block" data-block-type="text" style="left:80px;top:60px;width:800px">` +
    `<div class="sl-block-content"><h2>Slide ${n}</h2><ul>` +
    Array.from(
      { length: 6 },
      (_, i) => `<li>Point ${i + 1} of slide ${n}, with some words</li>`
    ).join('') +
    `</ul></div></div>`
  );
}

/** A deck's slides HTML, as the editor posts it, of at least `min` bytes. */
function deckHtmlOfAtLeast(min: number): string {
  const open = '<div class="slides">';
  const close = '</div>';
  const sections: string[] = [];
  let size = bytes(open) + bytes(close);
  while (size < min) {
    const section = `<section data-cm-id="s${sections.length}">${slideHtml(sections.length)}</section>`;
    sections.push(section);
    size += bytes(section);
  }
  return `${open}${sections.join('')}${close}`;
}

test.describe('the deck action', () => {
  test('sizes the save body from the save cap; an image upload keeps the file cap', () => {
    const limit = VIEWER_SOURCE.slice(VIEWER_SOURCE.indexOf('function deckActionBodyLimit('));
    expect(limit.slice(0, limit.indexOf('\n}'))).toContain(
      '? uploadBodyLimit(REPO_REST_MAX_BYTES)\n    : 3 * DOCUMENT_SAVE_MAX_BYTES + MULTIPART_OVERHEAD_BYTES;'
    );
  });

  test('reads ops within the save cap, and answers any failure with the whole-deck fallback', () => {
    const parse = ACTION.indexOf(
      'ops = deckOpsPayloadSchema.parse(parseJsonWithin(rawOps, DOCUMENT_SAVE_MAX_BYTES));'
    );
    expect(parse).toBeGreaterThan(-1);
    const after = ACTION.slice(parse);
    expect(after.slice(0, after.indexOf('\n    }\n'))).toContain(
      "} catch {\n      return opsFallback('Malformed ops payload — use a full-document save.');"
    );
    expect(ACTION).not.toContain('JSON.parse(rawOps)');
    // The fallback's `code` is what makes the editor re-send the whole deck once.
    expect(ACTION).toContain(
      "data({ error: message, code: 'OPS_BASE_MISMATCH' }, { status: 409 });"
    );
    expect(VIEWER_SOURCE).toContain(
      '} else if (fetcher.data?.code && lastPostedContentRef.current) {'
    );
  });

  test('counts the deck HTML before it is parsed, and answers 413 without a retry flag', () => {
    const check = ACTION.indexOf(
      "if (typeof htmlContent === 'string' && textOverBytes(htmlContent, DOCUMENT_SAVE_MAX_BYTES)) {"
    );
    const parse = ACTION.indexOf('parseSlidesFragment(htmlContent)');
    expect(check).toBeGreaterThan(-1);
    expect(parse).toBeGreaterThan(check);
    expect(ACTION.slice(check, parse)).toContain(
      'return data({ error: DECK_SAVE_TOO_LARGE_MESSAGE }, { status: 413 });'
    );
  });
});

test.describe('the limits against real-size decks', () => {
  test('ops one byte over the cap are refused before they are parsed', () => {
    const shell = JSON.stringify([{ op: 'delete', id: '' }]);
    const over = JSON.stringify([
      { op: 'delete', id: 'x'.repeat(DOCUMENT_SAVE_MAX_BYTES + 1 - bytes(shell)) },
    ]);
    expect(() => parseJsonWithin(over, DOCUMENT_SAVE_MAX_BYTES)).toThrow(UploadTooLargeError);
  });

  test('changes to every slide of a deck the size of the largest real one save as ops', () => {
    const ops = [];
    let size = 0;
    for (let n = 0; size < LARGEST_REAL_DECK_BYTES; n += 1) {
      const html = slideHtml(n).repeat(4);
      ops.push({ op: 'update', id: `s${n}`, html, notes: `<p>Notes for slide ${n}</p>` });
      size += bytes(html);
    }
    expect(ops.length).toBeLessThanOrEqual(400);
    const text = JSON.stringify(ops);
    expect(deckOpsPayloadSchema.parse(parseJsonWithin(text, DOCUMENT_SAVE_MAX_BYTES))).toHaveLength(
      ops.length
    );
  });

  test('a deck sixteen times the largest real one is under the cap; one over it is not', () => {
    expect(
      textOverBytes(deckHtmlOfAtLeast(16 * LARGEST_REAL_DECK_BYTES), DOCUMENT_SAVE_MAX_BYTES)
    ).toBe(false);
    expect(
      textOverBytes(deckHtmlOfAtLeast(DOCUMENT_SAVE_MAX_BYTES + 1), DOCUMENT_SAVE_MAX_BYTES)
    ).toBe(true);
  });
});
