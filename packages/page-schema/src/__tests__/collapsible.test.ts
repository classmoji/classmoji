/**
 * @vitest-environment jsdom
 *
 * The `collapsible` prop on code blocks (schema 5): no default, so a stored
 * document never gains it; off, the block renders exactly as before; on, a
 * block of more than 15 lines is drawn clipped with a bar along its bottom.
 * Drives a real editor (the page schema) for the node view: the bar, the
 * editor's toggle, live line counts and the caret opening the block.
 */
import { BlockNoteEditor, createCodeBlockSpec } from '@blocknote/core';
import { codeBlockOptions } from '@blocknote/code-block';
import { TextSelection } from 'prosemirror-state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import {
  COLLAPSE_OFF_TITLE,
  COLLAPSE_ON_TITLE,
  COLLAPSE_TOGGLE_CLASS,
  codeBlockText,
  codeLineCount,
  collapsesAt,
  createCollapseToggle,
  isCollapsible,
} from '../codeCollapse.ts';
import { serializePageContent } from '../content.ts';
import { createPageSchema } from '../schema.ts';
import { getServerEditor, pageContentToYDoc, yDocToPageContent } from '../server.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
const code = (id: string, text: string, props: Record<string, unknown> = {}) => ({
  id,
  type: 'codeBlock',
  props: { language: 'js', ...props },
  content: [{ type: 'text', text, styles: {} }],
  children: [],
});

function yjsTrip(blocks: unknown[]) {
  const loaded = new Y.Doc();
  Y.applyUpdate(loaded, Y.encodeStateAsUpdate(pageContentToYDoc({ blocks })));
  return yDocToPageContent(loaded).blocks as Array<{ props: Record<string, unknown> }>;
}

let editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors) editor._tiptapEditor.destroy();
  editors = [];
  document.body.innerHTML = '';
});

function mount(initialContent: unknown[], editable = true): Editor {
  const editor = BlockNoteEditor.create({
    schema: createPageSchema(),
    initialContent: initialContent as never,
  }) as Editor;
  // Before mounting: node views read it when they are built.
  editor.isEditable = editable;
  const root = document.createElement('div');
  document.body.appendChild(root);
  editor.mount(root);
  editors.push(editor);
  return editor;
}

/** The rendered block element for `id`. */
function blockEl(id: string): HTMLElement {
  return document.querySelector(`[data-id="${id}"] .bn-block-content`) as HTMLElement;
}

function cursorIn(editor: Editor, id: string, offset: number) {
  let pos = -1;
  editor._tiptapEditor.state.doc.descendants((node, at) => {
    if (pos >= 0) return false;
    if (node.attrs.id === id) {
      pos = at + 2; // blockContainer → blockContent → text
      return false;
    }
    return true;
  });
  const view = editor.prosemirrorView!;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + offset)));
}

describe('codeBlock.collapsible', () => {
  it('is BlockNote’s code block config plus copyable and an optional boolean', () => {
    const block = (
      createPageSchema().blockSchema as unknown as Record<string, { propSchema: object }>
    ).codeBlock;
    expect(block.propSchema).toEqual({
      ...createCodeBlockSpec(codeBlockOptions).config.propSchema,
      copyable: { default: true },
      collapsible: { default: undefined, type: 'boolean' },
    });
  });

  it('true survives the Yjs round trip; absent stays absent', () => {
    const [on, absent] = yjsTrip([code('on', 'a', { collapsible: true }), code('absent', 'b')]);
    expect(on.props.collapsible).toBe(true);
    expect('collapsible' in absent.props).toBe(false);
    expect(serializePageContent({ blocks: [absent] })).not.toContain('collapsible');
  });

  it('a one-off HTML render draws no bar: no surface shows it, its label must not travel', async () => {
    const editor = getServerEditor();
    const render = (block: unknown) => editor.blocksToFullHTML([block] as never);
    const plain = await render(code('a', lines(40)));
    expect(plain).not.toContain('bn-code-expand');
    expect(plain).not.toContain('data-collapse');
    expect(await render(code('a', lines(40), { collapsible: undefined }))).toBe(plain);

    const long = await render(code('a', lines(40), { collapsible: true }));
    expect(long).toContain('data-collapsible="true"');
    expect(long).not.toContain('bn-code-expand');
    expect(long).not.toContain('Show all');
    expect(long).not.toContain('data-collapse=');
  });
});

describe('helpers', () => {
  it('reads the prop the way every render must', () => {
    expect(isCollapsible({ collapsible: true })).toBe(true);
    expect(isCollapsible({ collapsible: 'true' })).toBe(true);
    for (const odd of [undefined, false, 'false', 1, 'yes', null])
      expect(isCollapsible({ collapsible: odd })).toBe(false);
  });

  it('counts source lines and collapses above 15', () => {
    expect(codeLineCount('')).toBe(1);
    expect(codeLineCount('a\nb')).toBe(2);
    expect(codeLineCount('a\nb\n')).toBe(3);
    expect(collapsesAt(15)).toBe(false);
    expect(collapsesAt(16)).toBe(true);
    expect(codeBlockText([{ text: 'a\n' }, { text: 'b' }, { nope: 1 }])).toBe('a\nb');
    expect(codeBlockText('x')).toBe('x');
  });

  it('the toggle shows the state in aria-pressed and the title, and calls back', () => {
    const onToggle = vi.fn();
    const on = createCollapseToggle(true, onToggle);
    expect(on.className).toBe(COLLAPSE_TOGGLE_CLASS);
    expect(on.getAttribute('aria-label')).toBe('Collapse long code');
    expect(on.getAttribute('aria-pressed')).toBe('true');
    expect(on.title).toBe(COLLAPSE_ON_TITLE);
    on.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
    const off = createCollapseToggle(false, onToggle);
    expect(off.getAttribute('aria-pressed')).toBe('false');
    expect(off.title).toBe(COLLAPSE_OFF_TITLE);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    off.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });
});

describe('the node view', () => {
  it('more than 15 lines: a collapsed <pre> and the bar naming it; 15 lines: nothing', () => {
    mount(
      [
        code('long', lines(16), { collapsible: true }),
        code('short', lines(15), { collapsible: true }),
      ],
      false
    );
    const pre = blockEl('long').querySelector('pre')!;
    const bar = blockEl('long').querySelector('button.bn-code-expand')!;
    expect(pre.getAttribute('data-collapse')).toBe('collapsed');
    expect(pre.id).toBe('bn-code-long');
    expect(bar.getAttribute('aria-controls')).toBe(pre.id);
    expect(bar.getAttribute('aria-expanded')).toBe('false');
    expect(bar.querySelector('.bn-code-expand-more')!.textContent).toBe('Show all 16 lines');
    expect(bar.querySelector('.bn-code-expand-less')!.textContent).toBe('Show less');
    // The bar is outside the code: none of it is block text.
    expect(pre.textContent).toBe(lines(16));
    expect(blockEl('long').querySelector('.bn-code-fade')!.getAttribute('aria-hidden')).toBe(
      'true'
    );

    const short = blockEl('short');
    expect((short.querySelector('button.bn-code-expand') as HTMLButtonElement).hidden).toBe(true);
    expect(short.querySelector('pre')!.hasAttribute('data-collapse')).toBe(false);
  });

  it('draws collapsed; the bar opens and closes it', () => {
    mount([code('c', lines(30), { collapsible: true })]);
    const pre = blockEl('c').querySelector('pre')!;
    const bar = blockEl('c').querySelector('button.bn-code-expand') as HTMLButtonElement;
    expect(pre.getAttribute('data-collapse')).toBe('collapsed');
    expect(bar.getAttribute('aria-expanded')).toBe('false');
    expect(bar.hidden).toBe(false);
    bar.click();
    expect(pre.getAttribute('data-collapse')).toBe('expanded');
    expect(bar.getAttribute('aria-expanded')).toBe('true');
    bar.click();
    expect(pre.getAttribute('data-collapse')).toBe('collapsed');
  });

  it('a collapsed <pre> that scrolls (find-in-page) opens', () => {
    mount([code('c', lines(30), { collapsible: true })], false);
    const pre = blockEl('c').querySelector('pre')!;
    pre.scrollTop = 120;
    pre.dispatchEvent(new Event('scroll'));
    expect(pre.getAttribute('data-collapse')).toBe('expanded');
    expect(pre.scrollTop).toBe(0);
  });

  it('the editor toggle sets the prop to true and back to absent, never false', () => {
    const editor = mount([code('c', lines(30))]);
    const toggle = () =>
      blockEl('c').querySelector(`button.${COLLAPSE_TOGGLE_CLASS}`) as HTMLButtonElement;
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(blockEl('c').querySelector('.bn-code-expand')).toBeNull();
    toggle().click();
    expect(editor.getBlock('c')!.props.collapsible).toBe(true);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(blockEl('c').querySelector('pre')!.getAttribute('data-collapse')).toBe('collapsed');
    toggle().click();
    expect(editor.getBlock('c')!.props.collapsible).toBeUndefined();
    expect(serializePageContent({ blocks: editor.document as never })).not.toContain('collapsible');
  });

  it('readers get no toggle', () => {
    mount([code('c', lines(30), { collapsible: true })], false);
    expect(blockEl('c').querySelector(`.${COLLAPSE_TOGGLE_CLASS}`)).toBeNull();
    expect(blockEl('c').querySelector('.bn-code-expand')).not.toBeNull();
  });

  it('follows edits: the count, and the bar coming and going at the threshold', () => {
    const editor = mount([
      { id: 'p', type: 'paragraph', content: [], children: [] },
      code('c', lines(16), { collapsible: true }),
    ]);
    cursorIn(editor, 'p', 0);
    const bar = () => blockEl('c').querySelector('button.bn-code-expand') as HTMLButtonElement;
    const pre = () => blockEl('c').querySelector('pre')!;
    expect(bar().textContent).toContain('Show all 16 lines');

    // Shrink to 15 lines: no bar, nothing clipped. The node view is kept.
    const sameBar = bar();
    editor.updateBlock('c', { content: lines(15) } as never);
    expect(bar()).toBe(sameBar);
    expect(bar().hidden).toBe(true);
    expect(pre().hasAttribute('data-collapse')).toBe(false);

    // A change from away (no caret in it) grows it back collapsed.
    editor.updateBlock('c', { content: lines(20) } as never);
    expect(bar().hidden).toBe(false);
    expect(bar().textContent).toContain('Show all 20 lines');
    expect(pre().getAttribute('data-collapse')).toBe('collapsed');
  });

  it('the caret entering the code opens it, in the editor only', () => {
    const editor = mount([
      { id: 'p', type: 'paragraph', content: [], children: [] },
      code('c', lines(30), { collapsible: true }),
    ]);
    cursorIn(editor, 'p', 0);
    expect(blockEl('c').querySelector('pre')!.getAttribute('data-collapse')).toBe('collapsed');
    cursorIn(editor, 'c', 3);
    expect(blockEl('c').querySelector('pre')!.getAttribute('data-collapse')).toBe('expanded');
  });

  it('stays open across a rebuild (a prop change), but is never saved', () => {
    const editor = mount([code('c', lines(30), { collapsible: true })]);
    (blockEl('c').querySelector('button.bn-code-expand') as HTMLButtonElement).click();
    editor.updateBlock('c', { props: { language: 'python' } });
    expect(blockEl('c').querySelector('pre')!.getAttribute('data-collapse')).toBe('expanded');
    expect(JSON.stringify(editor.document)).not.toContain('expanded');
  });
});
