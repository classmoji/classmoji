/**
 * Text the live editor's chrome shows from data, under jsdom: the short
 * reason behind "Not saved to GitHub yet" (never the worker's raw text), and
 * slide titles for an ordering listed without previews.
 */
import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';

import {
  DEFAULT_CHECKPOINT_REASON,
  checkpointErrorReason,
} from '../../app/components/collab/checkpointReason.ts';
import { slideTitleFromDom } from '../../app/components/preview/conflictChooser.ts';

test.describe('checkpoint reasons', () => {
  const cases: Array<[string, string]> = [
    [
      'failed: push failed: remote: Permission to org/repo.git denied. fatal: 403',
      'No write access to the repository',
    ],
    [
      'failed: push failed: git@github.com: Permission denied (publickey).',
      'No write access to the repository',
    ],
    [
      'schema-mismatch: deck schema 3 is newer than the converter',
      "The deck couldn't be written as a file",
    ],
    ['outside-edit-pending: slides/x/deck.json changed on main', 'The file changed on GitHub'],
    ['path-conflict: slides/x exists', "The deck's file path isn't usable"],
    ['skipped: converter unavailable', 'Saving to GitHub is unavailable'],
    ['doc-missing: deck row not found in this classroom', 'The deck was not found'],
    ['failed: push failed: getaddrinfo ENOTFOUND github.com', DEFAULT_CHECKPOINT_REASON],
    ['something new', DEFAULT_CHECKPOINT_REASON],
  ];
  for (const [error, reason] of cases) {
    test(`${error} → ${reason}`, () => {
      expect(checkpointErrorReason(error)).toBe(reason);
    });
  }
});

test.describe('slide titles from the deck on screen', () => {
  const doc: Document = new JSDOM(
    '<!DOCTYPE html><div class="slides">' +
      '<section data-cm-id="a"><h2>  Intro\n to   trees </h2><p>x</p></section>' +
      '<section data-cm-id="b"><p>First words here</p><aside class="notes">notes</aside></section>' +
      '<section data-cm-id="c"><aside class="notes"><h1>Only notes</h1></aside></section>' +
      `<section data-cm-id="d"><h1>${'L'.repeat(100)}</h1></section>` +
      '</div>'
  ).window.document;

  test('first heading, else first text; notes never; long titles capped', () => {
    expect(slideTitleFromDom(doc, 'a')).toBe('Intro to trees');
    expect(slideTitleFromDom(doc, 'b')).toBe('First words here');
    expect(slideTitleFromDom(doc, 'c')).toBe('');
    expect(slideTitleFromDom(doc, 'd')).toHaveLength(80);
    expect(slideTitleFromDom(doc, 'missing')).toBe('');
  });
});
