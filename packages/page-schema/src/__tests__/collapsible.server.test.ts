/**
 * The `collapsible` prop on code blocks, on the server: a one-off HTML render
 * through the page schema's ServerBlockNoteEditor. A node-environment file
 * because the server editor swaps the process's `document` for its own JSDOM,
 * which a DOM test environment does not allow (see collapsible.test.ts for the
 * schema, the helpers and the node view in a mounted editor).
 */
import { describe, expect, it } from 'vitest';

import { getServerEditor } from '../server.ts';

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
const code = (id: string, text: string, props: Record<string, unknown> = {}) => ({
  id,
  type: 'codeBlock',
  props: { language: 'js', ...props },
  content: [{ type: 'text', text, styles: {} }],
  children: [],
});

describe('codeBlock.collapsible', () => {
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
