/**
 * The page check list item on the server: what the page schema's
 * ServerBlockNoteEditor renders for `personal`. A node-environment file because
 * the server editor swaps the process's `document` for its own JSDOM, which a
 * DOM test environment does not allow (see checkListItem.test.ts for the
 * schema, the round trips and Enter in a mounted editor).
 */
import { BlockNoteSchema, defaultBlockSpecs } from '@blocknote/core';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { describe, expect, it } from 'vitest';

import { getServerEditor } from '../html.ts';

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];
const item = (id: string, value: string, props: Record<string, unknown> = {}) => ({
  id,
  type: 'checkListItem',
  props: { checked: false, ...props },
  content: value ? text(value) : [],
  children: [],
});

describe('checkListItem.personal', () => {
  it('renders data-personal only when set, and BlockNote’s markup otherwise', async () => {
    const page = getServerEditor();
    const html = await page.blocksToFullHTML([
      item('a', 'A', { personal: true }),
      item('b', 'B', { checked: true }),
    ] as never);
    expect(html.match(/data-personal="true"/g)).toHaveLength(1);
    expect(html).not.toContain('data-personal="false"');

    // A document without the prop renders exactly as BlockNote's own block.
    const plain = ServerBlockNoteEditor.create({
      schema: BlockNoteSchema.create({ blockSpecs: defaultBlockSpecs }),
    });
    const doc = [item('b', 'B', { checked: true }), item('c', 'C')];
    expect(await page.blocksToFullHTML(doc as never)).toBe(
      await plain.blocksToFullHTML(doc as never)
    );
    expect(await page.blocksToHTMLLossy(doc as never)).toBe(
      await plain.blocksToHTMLLossy(doc as never)
    );
  });
});
