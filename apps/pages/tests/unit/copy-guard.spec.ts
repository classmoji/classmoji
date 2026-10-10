/**
 * Copying turned off on a code or terminal block (`data-copyable="false"`):
 * a reader's copy that reaches such a block must not carry its text.
 *
 * Two implementations of one algorithm, both run here against the same
 * pages: `app/utils/copyGuard.ts` (the read-only editor view) and the class
 * site's inline script (`app/site/copyScript.ts`, ES5, no bundle). The site
 * script also owns the Copy buttons' clicks.
 */

import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations; the cast below pins the shape used.
import { JSDOM as UntypedJSDOM } from 'jsdom';

import { copyableSelectionContent, fragmentText, installCopyGuard } from '~/utils/copyGuard.ts';
import { SITE_COPY_SCRIPT } from '~/site/copyScript.ts';

type Win = Window & typeof globalThis & { eval: (code: string) => unknown };
const JSDOM = UntypedJSDOM as new (
  html: string,
  options?: { runScripts?: 'outside-only' }
) => { window: Win };

/** A page as the site (or the read-only viewer, `editable` "false") draws it. */
function page(editable?: 'true' | 'false') {
  const attr = editable ? ` contenteditable="${editable}"` : '';
  return new JSDOM(
    `<body><div class="site-article"><div class="bn-editor"${attr}>` +
      '<div class="bn-block-content" data-content-type="paragraph"><p id="before">Before</p></div>' +
      '<div class="bn-block-content" data-content-type="codeBlock" data-copyable="false">' +
      '<div><span class="bn-code-language">Python</span></div>' +
      '<pre><code id="secret">secret()</code></pre></div>' +
      '<div class="bn-block-content" data-content-type="codeBlock">' +
      '<div><span class="bn-code-language">JavaScript</span>' +
      '<button type="button" class="bn-copy-button" aria-label="Copy"><svg></svg></button></div>' +
      '<pre><code id="open">open()\n  next()</code></pre></div>' +
      '<div class="bn-block-content" data-content-type="terminal" data-copyable="false">' +
      '<div class="terminal-block"><div class="terminal-header"><span class="terminal-title">Terminal</span></div>' +
      '<div class="terminal-content"><pre><code id="term">rm -rf</code></pre></div></div></div>' +
      '<div class="bn-block-content" data-content-type="paragraph"><p id="after">After</p></div>' +
      '</div></div></body>',
    { runScripts: 'outside-only' }
  ).window;
}

/** Select from the start of `fromId`'s text to the end of `toId`'s. */
function select(win: Win, fromId: string, toId: string) {
  const doc = win.document;
  const from = doc.getElementById(fromId)!.firstChild!;
  const to = doc.getElementById(toId)!.firstChild!;
  const range = doc.createRange();
  range.setStart(from, 0);
  range.setEnd(to, to.textContent!.length);
  const selection = win.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

function selectAll(win: Win) {
  const range = win.document.createRange();
  range.selectNodeContents(win.document.body);
  const selection = win.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

/** Fire a copy at `target`; what reached the clipboard, and whether it was taken over. */
function copy(win: Win, target: Element) {
  const data: Record<string, string> = {};
  const event = new win.Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { setData: (type: string, value: string) => (data[type] = value) },
  });
  let reachedTarget = false;
  target.addEventListener('copy', () => (reachedTarget = true));
  target.dispatchEvent(event);
  return { data, prevented: event.defaultPrevented, reachedTarget };
}

const SPANNING_TEXT = 'Before\nopen()\n  next()\nAfter';

test.describe('copyableSelectionContent (read-only view)', () => {
  test('a selection that touches no disabled block is left alone', () => {
    const win = page('false');
    expect(copyableSelectionContent(select(win, 'before', 'before'))).toBeNull();
    expect(copyableSelectionContent(select(win, 'open', 'open'))).toBeNull();
  });

  test('a selection across disabled blocks keeps everything but them', () => {
    const win = page('false');
    const content = copyableSelectionContent(select(win, 'before', 'after'))!;
    expect(content.text).toBe(SPANNING_TEXT);
    for (const leaked of ['secret()', 'rm -rf', 'data-copyable', 'Python', 'Terminal']) {
      expect(content.text).not.toContain(leaked);
      expect(content.html).not.toContain(leaked);
    }
    // Title-bar chrome is not text the reader picked.
    expect(content.text).not.toContain('JavaScript');
    expect(content.html).not.toContain('<button');
    expect(content.html).toContain('open()');
  });

  test('select all leaves the disabled blocks out', () => {
    const win = page('false');
    expect(copyableSelectionContent(selectAll(win))!.text).toBe(SPANNING_TEXT);
  });

  test('a selection that starts or ends inside a disabled block drops it', () => {
    const win = page('false');
    expect(copyableSelectionContent(select(win, 'secret', 'after'))!.text).toBe(
      'open()\n  next()\nAfter'
    );
    expect(copyableSelectionContent(select(win, 'before', 'term'))!.text).toBe(
      'Before\nopen()\n  next()'
    );
  });

  test('a selection wholly inside one is replaced with nothing, not let through', () => {
    const win = page('false');
    expect(copyableSelectionContent(select(win, 'secret', 'secret'))).toEqual({
      text: '',
      html: '',
    });
  });

  test('editors copy everything: a disabled block in an editable editor is not guarded', () => {
    const win = page('true');
    expect(copyableSelectionContent(select(win, 'before', 'after'))).toBeNull();
  });
});

test.describe('fragmentText', () => {
  test('breaks between blocks, keeps <br> and pre text, tabs between cells', () => {
    const win = page();
    const box = win.document.createElement('div');
    box.innerHTML =
      '<p>a<br>b</p><pre>x\n\ny</pre><table><tr><td>1</td><td>2</td></tr><tr><td>3</td></tr></table>';
    expect(fragmentText(box)).toBe('a\nb\nx\n\ny\n1\t2\n3');
  });
});

test.describe('installCopyGuard', () => {
  test('takes over a copy that spans a disabled block, before BlockNote sees it', () => {
    const win = page('false');
    const stop = installCopyGuard(win.document);
    select(win, 'before', 'after');
    const result = copy(win, win.document.querySelector('.bn-editor')!);
    expect(result.prevented).toBe(true);
    expect(result.reachedTarget).toBe(false);
    expect(result.data['text/plain']).toBe(SPANNING_TEXT);
    expect(result.data['text/html']).not.toContain('secret()');
    stop();
  });

  test('leaves every other copy to the browser and BlockNote', () => {
    const win = page('false');
    const stop = installCopyGuard(win.document);
    select(win, 'open', 'open');
    const result = copy(win, win.document.querySelector('.bn-editor')!);
    expect(result).toEqual({ data: {}, prevented: false, reachedTarget: true });
    stop();
  });

  test("Select All in the read-only view: BlockNote's selection, minus disabled blocks", () => {
    // ProseMirror holds an AllSelection the DOM never shows (the DOM selection
    // is collapsed), and BlockNote would copy every block from it.
    const win = page('false');
    const root = win.document.querySelector('.bn-editor')!;
    const view = {
      dom: root,
      state: { selection: { from: 0, to: 1, empty: false } },
      domAtPos: (pos: number) => ({ node: root, offset: pos === 0 ? 0 : root.childNodes.length }),
    };
    const stop = installCopyGuard(win.document, () => view);
    for (const type of ['copy', 'cut']) {
      win.getSelection()!.removeAllRanges();
      const data: Record<string, string> = {};
      const event = new win.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: { setData: (kind: string, value: string) => (data[kind] = value) },
      });
      let reachedBlockNote = false;
      root.addEventListener(type, () => (reachedBlockNote = true));
      win.document.getElementById('before')!.dispatchEvent(event);
      expect(event.defaultPrevented, type).toBe(true);
      expect(reachedBlockNote, type).toBe(false);
      expect(data['text/plain'], type).toBe(SPANNING_TEXT);
      expect(data['text/html'], type).not.toContain('secret()');
    }

    // A visible selection is what goes on the clipboard, whatever BlockNote holds.
    select(win, 'open', 'open');
    view.state.selection = { from: 0, to: 1, empty: false };
    expect(copy(win, win.document.body).data['text/plain']).toBe('open()\n  next()');

    // Neither selection touches a disabled block: BlockNote copies.
    view.state.selection = { from: 0, to: 0, empty: true };
    win.getSelection()!.removeAllRanges();
    expect(copy(win, win.document.getElementById('before')!).prevented).toBe(false);
    stop();
  });

  test('a cut is guarded like a copy', () => {
    const win = page('false');
    const stop = installCopyGuard(win.document);
    select(win, 'before', 'after');
    const data: Record<string, string> = {};
    const event = new win.Event('cut', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { setData: (type: string, value: string) => (data[type] = value) },
    });
    win.document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(data['text/plain']).toBe(SPANNING_TEXT);
    stop();
  });

  test('a view that is not mounted yet (it throws) does not break copying', () => {
    const win = page('false');
    const stop = installCopyGuard(win.document, () => {
      throw new Error('[tiptap error]: The editor view is not available.');
    });
    select(win, 'open', 'open');
    expect(copy(win, win.document.body).prevented).toBe(false);
    select(win, 'before', 'after');
    expect(copy(win, win.document.body).data['text/plain']).toBe(SPANNING_TEXT);
    stop();
  });

  test('refuses dragging out a selection that spans a disabled block', () => {
    const win = page('false');
    const stop = installCopyGuard(win.document);
    select(win, 'before', 'after');
    const drag = new win.Event('dragstart', { bubbles: true, cancelable: true });
    win.document.getElementById('before')!.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
    stop();
  });
});

test.describe('the class site script', () => {
  function sitePage() {
    const win = page();
    win.eval(SITE_COPY_SCRIPT);
    return win;
  }

  test('rebuilds a copy across disabled blocks exactly as the viewer does', () => {
    const win = sitePage();
    for (const [from, to] of [
      ['before', 'after'],
      ['secret', 'after'],
      ['before', 'term'],
    ]) {
      const expected = copyableSelectionContent(select(win, from, to))!;
      const result = copy(win, win.document.body);
      expect(result.prevented).toBe(true);
      expect(result.reachedTarget).toBe(false);
      expect(result.data).toEqual({ 'text/plain': expected.text, 'text/html': expected.html });
    }
    selectAll(win);
    expect(copy(win, win.document.body).data['text/plain']).toBe(SPANNING_TEXT);
  });

  test('a selection wholly inside a disabled block copies nothing', () => {
    const win = sitePage();
    select(win, 'secret', 'secret');
    const result = copy(win, win.document.body);
    expect(result.prevented).toBe(true);
    expect(result.data).toEqual({ 'text/plain': '', 'text/html': '' });
  });

  test('leaves an ordinary copy alone', () => {
    const win = sitePage();
    select(win, 'open', 'open');
    expect(copy(win, win.document.body)).toEqual({
      data: {},
      prevented: false,
      reachedTarget: true,
    });
  });

  test('the Copy button copies its block, then shows the check for a moment', async () => {
    const win = sitePage();
    const written: string[] = [];
    Object.defineProperty(win.navigator, 'clipboard', {
      value: { writeText: async (text: string) => void written.push(text) },
      configurable: true,
    });
    const button = win.document.querySelector('.bn-copy-button')!;
    // The click lands on the icon, inside the button.
    button.querySelector('svg')!.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    await expect.poll(() => button.hasAttribute('data-copied')).toBe(true);
    expect(written).toEqual(['open()\n  next()']);
    await expect.poll(() => button.hasAttribute('data-copied'), { timeout: 3000 }).toBe(false);
  });

  test('a refused Clipboard API falls back to execCommand (a framed site)', async () => {
    const win = sitePage();
    Object.defineProperty(win.navigator, 'clipboard', {
      value: { writeText: async () => Promise.reject(new Error('NotAllowedError')) },
      configurable: true,
    });
    let commanded = '';
    Object.defineProperty(win.document, 'execCommand', {
      value: (command: string) => {
        commanded = command;
        return true;
      },
      configurable: true,
    });
    const button = win.document.querySelector('.bn-copy-button')!;
    (button as HTMLElement).click();
    await expect.poll(() => button.hasAttribute('data-copied')).toBe(true);
    expect(commanded).toBe('copy');
    expect(win.document.querySelector('textarea')).toBeNull();
  });
});
