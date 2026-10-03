// @vitest-environment jsdom
/**
 * Writing the live editor's files back into a Sandpack block.
 *
 * Sandpack reports its whole file map — the template's files with the block's
 * files on top, plus a generated /package.json — on mount and after every
 * edit. Written back verbatim, that injected the template's /styles.css and
 * /package.json into every block the moment the editor opened (and the block
 * then opened on the CSS tab). Only the block's own files are written, only
 * when one actually changed, and onto what the element stores now.
 */

import { describe, expect, it } from 'vitest';
import { mergeEditedFiles, syncEditedFiles } from '../utils.ts';

/** What Sandpack's react template adds under a block's files. */
const REACT_TEMPLATE_EXTRAS = {
  '/index.js': 'import React from "react";',
  '/styles.css': 'body { font-family: sans-serif; }',
  '/public/index.html': '<div id="root"></div>',
};

const STORED = {
  '/App.js': 'export default function App() { return <h1>Hi</h1>; }',
  '/package.json': '{"dependencies":{"lodash":"4.17.21"},"main":"/index.js"}',
};

/** Sandpack's live map for STORED: template extras + the block's files, package.json re-serialized. */
function liveFiles(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...REACT_TEMPLATE_EXTRAS,
    ...STORED,
    '/package.json': JSON.stringify(
      { dependencies: { lodash: '4.17.21' }, main: '/index.js', devDependencies: {} },
      null,
      2
    ),
    ...overrides,
  };
}

function embedWith(payload: string, attrs = 'data-template="react"'): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = `<div class="sandpack-embed" ${attrs}><script type="application/json" data-sandpack-files>${payload}</script></div>`;
  return host.firstElementChild as HTMLElement;
}

const payloadOf = (el: HTMLElement) =>
  el.querySelector('script[data-sandpack-files]')?.textContent ?? '';

describe('mergeEditedFiles', () => {
  it('nothing edited: no write, even with template files and a re-serialized package.json', () => {
    expect(mergeEditedFiles(STORED, liveFiles())).toBeNull();
  });

  it('one file edited: only that file changes, template files stay out', () => {
    const merged = mergeEditedFiles(STORED, liveFiles({ '/App.js': 'edited' }));
    expect(merged).toEqual({ '/App.js': 'edited', '/package.json': STORED['/package.json'] });
    expect(Object.keys(merged ?? {})).toEqual(['/App.js', '/package.json']);
  });

  it('a real package.json edit is written', () => {
    const edited = '{\n  "dependencies": {\n    "lodash": "4.17.20"\n  }\n}';
    expect(mergeEditedFiles(STORED, liveFiles({ '/package.json': edited }))).toEqual({
      ...STORED,
      '/package.json': edited,
    });
  });

  it('stored keys without a leading slash are matched and kept as stored', () => {
    expect(mergeEditedFiles({ 'App.js': 'a' }, { '/App.js': 'b', '/styles.css': 'x' })).toEqual({
      'App.js': 'b',
    });
  });

  it('object-form entries keep their other keys', () => {
    const stored = { '/App.js': { code: 'a', active: true, hidden: false } };
    expect(mergeEditedFiles(stored, { '/App.js': 'b' })).toEqual({
      '/App.js': { code: 'b', active: true, hidden: false },
    });
  });
});

describe('syncEditedFiles', () => {
  it('mount-time report of an untouched block leaves the payload byte-identical', () => {
    const payload = JSON.stringify(STORED).replace(/<\/script>/gi, '<\\/script>');
    const el = embedWith(payload, `data-template="react" data-visible-files='["/App.js"]'`);
    expect(syncEditedFiles(el, liveFiles())).toBe(false);
    expect(payloadOf(el)).toBe(payload);
  });

  it('an edit writes the block files only; the embed attributes are untouched', () => {
    const el = embedWith(
      JSON.stringify(STORED),
      `data-template="react" data-visible-files='["/App.js"]' data-show-line-numbers="false"`
    );
    expect(syncEditedFiles(el, liveFiles({ '/App.js': 'edited' }))).toBe(true);
    expect(JSON.parse(payloadOf(el))).toEqual({ ...STORED, '/App.js': 'edited' });
    expect(el.getAttribute('data-visible-files')).toBe('["/App.js"]');
    expect(el.getAttribute('data-show-line-numbers')).toBe('false');
  });

  it('compares against what the element stores now, so an edit can be reverted', () => {
    const el = embedWith(JSON.stringify(STORED));
    syncEditedFiles(el, liveFiles({ '/App.js': 'edited' }));
    expect(syncEditedFiles(el, liveFiles())).toBe(true);
    expect(JSON.parse(payloadOf(el))).toEqual(STORED);
  });

  it('a `</script>` in a file round-trips through the JSON', () => {
    const files = { '/index.html': '<body><script src="index.js"></script></body>' };
    const el = embedWith(JSON.stringify(files).replace(/<\/script>/gi, '<\\/script>'));
    const edited = '<body><script src="main.js"></script></body>';
    expect(syncEditedFiles(el, { '/index.html': edited, '/styles.css': 'x' })).toBe(true);
    expect(JSON.parse(payloadOf(el))).toEqual({ '/index.html': edited });
  });

  it('an empty block edits the starter files it renders', () => {
    const el = embedWith('{}', 'data-template="vanilla"');
    const result = syncEditedFiles(el, { '/index.js': 'edited', '/package.json': '{}' });
    expect(result).toBe(true);
    const written = JSON.parse(payloadOf(el));
    expect(written['/index.js']).toBe('edited');
    expect(Object.keys(written).sort()).toEqual(['/index.html', '/index.js', '/styles.css']);
  });
});
