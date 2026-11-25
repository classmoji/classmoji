/**
 * The reader island's client rules that need no browser: when highlighting
 * has settled (`readiness.ts`) and how a viewer opens every toggle
 * (`components/viewer/toggles.ts`). The whole island — mount, ready marker,
 * open toggles, no API calls, no storage writes, print CSS — is checked in a
 * real browser by the step's end-to-end run against the render route.
 */
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';
import { test, expect } from '@playwright/test';

import {
  DEFAULT_CODE_LANGUAGE,
  codeBlockLanguages,
  highlightSettled,
} from '../../app/reader-island/readiness.ts';
import { createToggleFrame } from '@blocknote/core';
import {
  openAllToggles,
  toggledStateFor,
  togglesOpenIn,
} from '../../app/components/viewer/toggles.ts';

const HIGHLIGHTER = Symbol.for('blocknote.shikiHighlighterPromise');
type Holder = { [HIGHLIGHTER]?: Promise<unknown> };

const code = (id: string, language: string | undefined, text: string) => ({
  id,
  type: 'codeBlock',
  props: language === undefined ? {} : { language },
  content: text ? [{ type: 'text', text }] : [],
  children: [],
});

const BLOCKS = [
  code('js', 'javascript', 'const a = 1;'),
  code('alias', 'js', 'let b = 2;'),
  code('plain', 'text', 'plain words'),
  code('unknown', 'cobol-not-bundled', 'DIVISION.'),
  code('nolang', undefined, 'let c = 3;'),
  code('empty', 'python', ''),
  {
    id: 'toggle',
    type: 'toggleListItem',
    props: {},
    content: [],
    children: [code('nested', 'python', 'x = 1')],
  },
];

/** The viewer's DOM for these blocks: each code block's content and its <pre>. */
function viewerDom() {
  const { document } = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>').window;
  const root = document.getElementById('root')!;
  const add = (id: string, text: string) => {
    const outer = document.createElement('div');
    outer.className = 'bn-block-outer';
    outer.setAttribute('data-id', id);
    outer.innerHTML = `<div class="bn-block"><div class="bn-block-content" data-content-type="codeBlock"><pre><code>${text}</code></pre></div></div>`;
    root.appendChild(outer);
    return outer.querySelector('code')!;
  };
  const codes = Object.fromEntries(
    [
      ['js', 'const a = 1;'],
      ['alias', 'let b = 2;'],
      ['plain', 'plain words'],
      ['unknown', 'DIVISION.'],
      ['nolang', 'let c = 3;'],
      ['empty', ''],
      ['nested', 'x = 1'],
    ].map(([id, text]) => [id, add(id, text)])
  );
  const paint = (id: string) => {
    const span = document.createElement('span');
    span.setAttribute('style', '--shiki-light:#000;--shiki-dark:#fff');
    span.textContent = codes[id].textContent;
    codes[id].replaceChildren(span);
  };
  return { root, paint };
}

test.describe('highlight readiness', () => {
  test.beforeAll(() => {
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (cb: () => void) =>
      setTimeout(cb, 5);
  });
  test.afterEach(() => {
    delete (globalThis as Holder)[HIGHLIGHTER];
  });

  test('each code block’s language as Shiki is asked for it: canonical, `text` where never asked', () => {
    expect(DEFAULT_CODE_LANGUAGE).toBe('javascript');
    expect([...codeBlockLanguages(BLOCKS)]).toEqual([
      ['js', 'javascript'],
      ['alias', 'javascript'],
      ['plain', 'text'],
      // Not in the bundle: plain text (page-schema's guard), never asked.
      ['unknown', 'text'],
      ['nolang', 'javascript'],
      ['empty', 'python'],
      ['nested', 'python'],
    ]);
  });

  test('settles once every block with code in a painted language is painted, an unknown one in the middle included', async () => {
    const { root, paint } = viewerDom();
    const asked: string[] = [];
    (globalThis as Holder)[HIGHLIGHTER] = Promise.resolve({
      loadLanguage(language: string) {
        asked.push(language);
        return Promise.resolve();
      },
    });
    // Three painted, the nested one not yet: still waiting.
    setTimeout(() => ['js', 'alias', 'nolang'].forEach(paint), 20);
    expect(await highlightSettled(root, BLOCKS, 300)).toBe('timeout');
    const settled = highlightSettled(root, BLOCKS, 3000);
    setTimeout(() => paint('nested'), 60);
    expect(await settled).toBe('settled');
    // Plain, unknown and empty blocks are never asked about or waited for.
    expect([...new Set(asked)].sort()).toEqual(['javascript', 'python']);
  });

  test('a language the highlighter refuses is not waited for', async () => {
    const { root, paint } = viewerDom();
    (globalThis as Holder)[HIGHLIGHTER] = Promise.resolve({
      loadLanguage(language: string) {
        // Shiki throws SYNCHRONOUSLY for a language its bundle lacks.
        if (language === 'python') throw new Error('not included in this bundle');
        return Promise.resolve();
      },
    });
    setTimeout(() => ['js', 'alias', 'nolang'].forEach(paint), 20);
    expect(await highlightSettled(root, BLOCKS, 3000)).toBe('settled');
  });

  test('no highlighter where BlockNote keeps it: a short grace, not the full wait', async () => {
    const { root } = viewerDom();
    const started = Date.now();
    expect(await highlightSettled(root, BLOCKS, 6000)).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('a highlighter that never paints ends in a bounded timeout, not a hang', async () => {
    const { root } = viewerDom();
    (globalThis as Holder)[HIGHLIGHTER] = Promise.resolve({
      loadLanguage: () => Promise.resolve(),
    });
    const started = Date.now();
    expect(await highlightSettled(root, BLOCKS, 200)).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('a highlighter that never loads ends in the same bounded timeout', async () => {
    const { root } = viewerDom();
    (globalThis as Holder)[HIGHLIGHTER] = new Promise(() => {});
    expect(await highlightSettled(root, BLOCKS, 150)).toBe('timeout');
  });

  test('a document with nothing to paint is settled at once', async () => {
    const { root } = viewerDom();
    expect(await highlightSettled(root, [code('plain', 'text', 'x')], 1000)).toBe('none');
  });
});

test.describe('open toggles (the render surface)', () => {
  test('a marked editor’s toggles read open and store nothing; any other keeps BlockNote’s store', () => {
    const marked = {};
    const other = {};
    openAllToggles(marked);
    expect(togglesOpenIn(marked)).toBe(true);
    expect(togglesOpenIn(other)).toBe(false);

    const store = toggledStateFor(marked);
    expect(store?.get({ id: 'any' })).toBe(true);
    // Closing it is not remembered: the next frame is open again.
    store?.set({ id: 'any' }, false);
    expect(store?.get({ id: 'any' })).toBe(true);

    // `undefined` is BlockNote's own store (the reader's browser).
    expect(toggledStateFor(other)).toBeUndefined();
  });

  test('BlockNote’s toggle frame with the marked store is drawn open', () => {
    const marked = {};
    openAllToggles(marked);
    const { window } = new JSDOM('<!DOCTYPE html><body></body>');
    const g = globalThis as { document?: unknown };
    const previous = g.document;
    g.document = window.document;
    try {
      const editor = {
        isEditable: false,
        dictionary: { toggle_blocks: { toggle_button: 'Toggle', add_block_button: 'Add block' } },
      };
      // Only the fields the frame reads.
      const frame = createToggleFrame(
        { id: 't', children: [] } as never,
        editor as never,
        toggledStateFor(marked)
      );
      expect(frame.dom.querySelector('.bn-toggle-button')?.getAttribute('aria-expanded')).toBe(
        'true'
      );
    } finally {
      g.document = previous;
    }
  });
});
