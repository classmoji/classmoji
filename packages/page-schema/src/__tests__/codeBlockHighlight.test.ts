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

import { createPageSchema } from '../schema.ts';

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
});
