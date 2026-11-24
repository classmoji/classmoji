/**
 * @vitest-environment jsdom
 *
 * Syntax highlighting with the page code block and BlockNote 0.55's
 * `syntaxHighlighter` extension (what the pages editor and viewer pass in
 * `extensions`; up to 0.46 it came with the code block's options).
 *
 * Pins that the page code block keeps BlockNote's `meta.highlight` (so the
 * extension finds it), that a stored alias highlights (Shiki's bundle takes
 * `bash`/`js`), that an unknown language stays plain without an error, and
 * that tokens carry both theme colours as `--shiki-light`/`--shiki-dark`,
 * which BlockNote's stylesheet resolves (`.shiki { color: var(--shiki-dark) }`,
 * the code block being dark in both colour schemes).
 */
import { BlockNoteEditor } from '@blocknote/core';
import { syntaxHighlighter } from '@blocknote/code-block';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BLOCKNOTE_SHIKI_HIGHLIGHTER,
  codeBlockHighlightLanguage,
  createPageSchema,
} from '../schema.ts';

let editor: BlockNoteEditor<any, any, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
afterEach(() => {
  editor?._tiptapEditor.destroy();
  editor = undefined;
});

const code = (id: string, language: string, text: string) => ({
  id,
  type: 'codeBlock',
  props: { language },
  content: [{ type: 'text', text, styles: {} }],
  children: [],
});

async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 25));
  }
}

describe('code block syntax highlighting', () => {
  it('highlights canonical and alias languages, leaves unknown ones plain', async () => {
    editor = BlockNoteEditor.create({
      schema: createPageSchema(),
      extensions: [syntaxHighlighter],
      initialContent: [
        code('a', 'bash', 'echo "hi" | grep h'),
        code('b', 'javascript', 'const a = 1;'),
        code('c', 'brainfuck', '++[>+<-]'),
      ] as never,
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    editor.mount(root);

    const block = (id: string) => root.querySelector(`[data-id="${id}"] code`) as HTMLElement;
    await until(
      () =>
        block('a').querySelectorAll('.shiki').length > 0 &&
        block('b').querySelectorAll('.shiki').length > 0
    );

    const span = block('b').querySelector('.shiki') as HTMLElement;
    const style = span.getAttribute('style') ?? '';
    expect(style).toMatch(/--shiki-light:/);
    expect(style).toMatch(/--shiki-dark:/);
    expect(block('c').querySelectorAll('.shiki')).toHaveLength(0);
    expect(block('c').textContent).toBe('++[>+<-]');
  });

  it('an unknown language (and `plain`) stays plain WITHOUT stopping the blocks after it', async () => {
    // Before the guard, Shiki threw for `brainfuck` inside BlockNote's
    // highlight pass and no code block after it was ever painted.
    editor = BlockNoteEditor.create({
      schema: createPageSchema(),
      extensions: [syntaxHighlighter],
      initialContent: [
        code('u', 'brainfuck', '++[>+<-]'),
        code('p', 'plain', 'plain words'),
        code('after-js', 'js', 'const after = 1;'),
        code('after-py', 'python', 'after = True'),
      ] as never,
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    editor.mount(root);

    const block = (id: string) => root.querySelector(`[data-id="${id}"] code`) as HTMLElement;
    await until(
      () =>
        block('after-js').querySelectorAll('.shiki').length > 0 &&
        block('after-py').querySelectorAll('.shiki').length > 0
    );
    expect(block('u').querySelectorAll('.shiki')).toHaveLength(0);
    expect(block('u').textContent).toBe('++[>+<-]');
    expect(block('p').querySelectorAll('.shiki')).toHaveLength(0);
    // The stored language is untouched; only what Shiki is asked changes.
    expect(editor.getBlock('u')?.props).toMatchObject({ language: 'brainfuck' });
  });

  it('asks Shiki only for canonical ids it bundles; plain text and unknown names are `text`', async () => {
    expect(
      ['js', 'bash', 'py', 'javascript', 'plain', 'txt', 'text', '', 'brainfuck', undefined].map(
        codeBlockHighlightLanguage
      )
    ).toEqual([
      'javascript',
      'shellscript',
      'python',
      'javascript',
      'text',
      'text',
      'text',
      'text',
      'text',
      'text',
    ]);
  });

  it('BlockNote keeps its highlighter where the reader island waits for it', async () => {
    // Pinned against the INSTALLED @blocknote/core: if an upgrade moves the
    // highlighter, this fails instead of every page render waiting out its
    // readiness timeout (apps/pages/app/reader-island/readiness.ts).
    editor = BlockNoteEditor.create({
      schema: createPageSchema(),
      extensions: [syntaxHighlighter],
      initialContent: [code('a', 'python', 'x = 1')] as never,
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    editor.mount(root);
    const holder = globalThis as { [BLOCKNOTE_SHIKI_HIGHLIGHTER]?: Promise<unknown> };
    await until(() => holder[BLOCKNOTE_SHIKI_HIGHLIGHTER] !== undefined);
    const highlighter = (await holder[BLOCKNOTE_SHIKI_HIGHLIGHTER]) as {
      loadLanguage: (language: string) => Promise<void>;
      getLoadedLanguages: () => string[];
    };
    await expect(highlighter.loadLanguage('python')).resolves.toBeUndefined();
    // Every language the select offers is one the bundle loads, so the
    // canonical ids above never throw inside the pass.
    const { codeBlockOptions } = await import('@blocknote/code-block');
    for (const id of Object.keys(codeBlockOptions.supportedLanguages)) {
      if (id === 'text') continue;
      await expect(highlighter.loadLanguage(id), id).resolves.toBeUndefined();
    }
    // An unbundled name throws SYNCHRONOUSLY (why the guard exists).
    expect(() => highlighter.loadLanguage('brainfuck')).toThrow();
  });
});
