/**
 * The `copyable` prop on code and terminal blocks (schema 2): on by default,
 * so a document saved before it existed reads as copyable and gains only the
 * prop; a disabled block carries `data-copyable="false"`, which is what the
 * reader's CSS and copy guard key on.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { parsePageContent, serializePageContent, type PageContent } from '../content.ts';
import { FRAGMENT } from '../constants.ts';
import { createPageSchema } from '../schema.ts';
import { getServerEditor, pageContentToYDoc, yDocToPageContent } from '../server.ts';

type AnyBlock = { type?: string; props?: Record<string, unknown>; children?: AnyBlock[] };

function walk(blocks: unknown[], visit: (block: AnyBlock) => void) {
  for (const block of blocks as AnyBlock[]) {
    visit(block);
    if (block.children) walk(block.children, visit);
  }
}

const KITCHEN_SINK = parsePageContent(
  readFileSync(new URL('./fixtures/kitchen-sink.content.json', import.meta.url), 'utf8')
);

describe('copyable', () => {
  it('is a prop of codeBlock and terminal, on by default', () => {
    const schema = createPageSchema();
    const blocks = schema.blockSchema as unknown as Record<
      string,
      { propSchema: Record<string, { default?: unknown }> }
    >;
    expect(blocks.codeBlock.propSchema.copyable).toEqual({ default: true });
    expect(blocks.terminal.propSchema.copyable).toEqual({ default: true });
  });

  it('a page saved before the prop existed reads as copyable, nothing else changes', () => {
    const before = structuredClone(KITCHEN_SINK) as PageContent;
    const expected = structuredClone(KITCHEN_SINK) as PageContent;
    let touched = 0;
    walk(before.blocks, block => {
      if (block.props && 'copyable' in block.props) {
        delete block.props.copyable;
        touched++;
      }
    });
    walk(expected.blocks, block => {
      if (block.props && 'copyable' in block.props) block.props.copyable = true;
    });
    expect(touched).toBe(4);

    const loaded = new Y.Doc();
    Y.applyUpdate(loaded, Y.encodeStateAsUpdate(pageContentToYDoc(before)));
    expect(serializePageContent(yDocToPageContent(loaded))).toBe(serializePageContent(expected));
  });

  it('a live document stored under schema 1 (no copyable attribute) loses no block', () => {
    // A schema-2 seed writes every attribute, defaults included; a row stored
    // under schema 1 has no `copyable` on its elements at all.
    const doc = pageContentToYDoc(KITCHEN_SINK);
    let stripped = 0;
    const strip = (node: Y.XmlElement | Y.XmlFragment) => {
      for (const child of node.toArray()) {
        if (!(child instanceof Y.XmlElement)) continue;
        if (child.getAttribute('copyable') !== undefined) {
          child.removeAttribute('copyable');
          stripped++;
        }
        strip(child);
      }
    };
    strip(doc.getXmlFragment(FRAGMENT));
    expect(stripped).toBe(4);

    const blocks: AnyBlock[] = [];
    walk(yDocToPageContent(doc).blocks, block => blocks.push(block));
    const expected: AnyBlock[] = [];
    walk(KITCHEN_SINK.blocks, block => expected.push(block));
    expect(blocks.map(b => b.type)).toEqual(expected.map(b => b.type));
    const copyables = blocks.filter(b => b.type === 'codeBlock' || b.type === 'terminal');
    expect(copyables).toHaveLength(4);
    for (const block of copyables) expect(block.props?.copyable).toBe(true);
  });

  it('a disabled block carries data-copyable="false"; an enabled one no attribute', async () => {
    const html = await getServerEditor().blocksToFullHTML([
      {
        id: 'on',
        type: 'codeBlock',
        props: { language: 'js' },
        content: [{ type: 'text', text: 'a', styles: {} }],
      },
      {
        id: 'off',
        type: 'codeBlock',
        props: { language: 'js', copyable: false },
        content: [{ type: 'text', text: 'b', styles: {} }],
      },
      { id: 't-off', type: 'terminal', props: { code: 'ls', copyable: false } },
    ] as never);
    expect(html.match(/data-copyable="false"/g)).toHaveLength(2);
    expect(html).not.toContain('data-copyable="true"');
  });
});
