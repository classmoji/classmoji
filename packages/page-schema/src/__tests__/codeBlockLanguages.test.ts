/**
 * @vitest-environment jsdom
 *
 * Code blocks render whatever language a page was saved with.
 *
 * BlockNote 0.55's code block throws `Language <x> is not supported.` from its
 * render when `block.props.language` is not a key of `supportedLanguages`, and
 * the throw takes the whole editor (and viewer) down. Saved pages hold
 * aliases (`bash`, `js`, `py`, `yml`), languages BlockNote never listed, and
 * `''`. The page code block shows those as their canonical entry (or Plain
 * Text) in the select, and never changes the stored value.
 */
import { BlockNoteEditor, createCodeBlockSpec, BlockNoteSchema } from '@blocknote/core';
import { codeBlockOptions } from '@blocknote/code-block';
import { afterEach, describe, expect, it } from 'vitest';

import { codeBlockDisplayLanguage, createPageSchema } from '../schema.ts';
import { CODE_LANGUAGES as LANGUAGES, codeBlocks } from './fixtures/codeBlockLanguages.ts';

let editor: BlockNoteEditor<any, any, any> | undefined;
afterEach(() => {
  editor?._tiptapEditor.destroy();
  editor = undefined;
});

function mountEditor(schema: BlockNoteSchema<any, any, any>, blocks: unknown[]) {
  const created = BlockNoteEditor.create({ schema, initialContent: blocks as never });
  editor = created;
  const div = document.createElement('div');
  document.body.appendChild(div);
  created.mount(div);
  return { editor: created, root: div };
}

describe('codeBlockDisplayLanguage', () => {
  it.each(LANGUAGES)('%j shows as %j', (stored, shown) => {
    expect(codeBlockDisplayLanguage(stored)).toBe(shown);
  });

  it('non-strings show as text', () => {
    expect(codeBlockDisplayLanguage(undefined)).toBe('text');
    expect(codeBlockDisplayLanguage(null)).toBe('text');
    expect(codeBlockDisplayLanguage(42)).toBe('text');
  });
});

describe('the page code block in the editor', () => {
  it("BlockNote's stock code block throws on an alias (why the page block exists)", () => {
    const stock = BlockNoteSchema.create().extend({
      blockSpecs: { codeBlock: createCodeBlockSpec(codeBlockOptions) },
    });
    expect(() =>
      mountEditor(stock, [{ type: 'codeBlock', props: { language: 'bash' }, content: 'ls' }])
    ).toThrow(/Language bash is not supported/);
  });

  it('renders every stored language, editable and read-only, without throwing', () => {
    for (const editable of [true, false]) {
      const { editor: e, root } = mountEditor(createPageSchema(), codeBlocks());
      e.isEditable = editable;
      const selects = [...root.querySelectorAll('select')];
      expect(selects.map(s => s.value)).toEqual(LANGUAGES.map(([, shown]) => shown));
      e._tiptapEditor.destroy();
      editor = undefined;
    }
  });

  it('keeps the stored language strings untouched', () => {
    const { editor: e } = mountEditor(createPageSchema(), codeBlocks());
    expect(e.document.map(b => (b.props as { language: string }).language)).toEqual(
      LANGUAGES.map(([stored]) => stored)
    );
  });

  it("keeps the stored language in the block's data-language and external HTML", () => {
    const { editor: e, root } = mountEditor(createPageSchema(), codeBlocks());
    const attrs = [...root.querySelectorAll('[data-content-type="codeBlock"]')].map(el =>
      el.getAttribute('data-language')
    );
    // `javascript` is the prop default, which BlockNote leaves off the element.
    expect(attrs).toEqual(LANGUAGES.map(([stored]) => (stored === 'javascript' ? null : stored)));
    const html = e.blocksToHTMLLossy(e.document);
    expect(html).toContain('data-language="bash"');
    expect(html).toContain('language-brainfuck" data-language="brainfuck"');
  });

  it('choosing a language in the select writes its canonical id', () => {
    const { editor: e, root } = mountEditor(createPageSchema(), codeBlocks());
    const select = root.querySelector('select') as HTMLSelectElement;
    select.value = 'python';
    select.dispatchEvent(new Event('change'));
    expect((e.getBlock('code-0')!.props as { language: string }).language).toBe('python');
    // The other blocks keep what they had.
    expect((e.getBlock('code-1')!.props as { language: string }).language).toBe('sh');
  });

  it('the ``` input rule still resolves aliases to the canonical id', () => {
    const { editor: e } = mountEditor(createPageSchema(), [
      { id: 'p', type: 'paragraph', content: '' },
    ]);
    e.setTextCursorPosition('p', 'start');
    const view = e.prosemirrorView!;
    for (const char of '```bash ') {
      const { from, to } = view.state.selection;
      const deflt = () => view.state.tr.insertText(char, from, to);
      const handled = view.someProp('handleTextInput', f => f(view, from, to, char, deflt));
      if (!handled) view.dispatch(deflt());
    }
    const block = e.document[0];
    expect(block.type).toBe('codeBlock');
    expect((block.props as { language: string }).language).toBe('shellscript');
  });
});
