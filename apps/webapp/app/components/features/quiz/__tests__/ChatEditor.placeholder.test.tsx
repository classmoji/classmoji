// @vitest-environment jsdom
/**
 * ChatEditor shows its `placeholder` in the empty editor (the Placeholder
 * extension's `data-placeholder`, drawn by ChatEditor.css), and a new
 * placeholder replaces it without recreating the editor: the quiz chat
 * changes it as the answer counter moves ("Type your answer…", the last
 * answer's line, the default).
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/hooks', () => ({ useDarkMode: () => ({ isDarkMode: false }) }));
// Under Node, prosemirror-codemark resolves to its CommonJS build, which
// brings a second copy of prosemirror-view: its decorations next to the
// placeholder's then break the view. The app's bundler takes its ES build
// (one copy), so here it is left out: this test is about the placeholder.
vi.mock('prosemirror-codemark', () => ({ default: () => [] }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const { default: ChatEditor } = await import('~/routes/student.$class.quizzes/ChatEditor');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const shown = () =>
  container.querySelector('.ProseMirror p.is-editor-empty')?.getAttribute('data-placeholder');

describe('ChatEditor placeholder', () => {
  it('shows the placeholder, and the new one when it changes', async () => {
    await act(async () =>
      root.render(<ChatEditor onSubmit={() => {}} placeholder="Type your answer…" />)
    );
    expect(shown()).toBe('Type your answer…');
    const editor = container.querySelector('.ProseMirror');

    await act(async () =>
      root.render(
        <ChatEditor onSubmit={() => {}} placeholder="Your last answer for this question…" />
      )
    );
    expect(shown()).toBe('Your last answer for this question…');
    // The same editor, not a new one.
    expect(container.querySelector('.ProseMirror')).toBe(editor);
  });
});
