/**
 * normalizeCodeBlockContent: stored code blocks (inline content up to
 * BlockNote 0.46) become the plain text 0.55 loads, and nothing else moves.
 */
import { describe, expect, it } from 'vitest';

import { normalizeCodeBlockContent } from '../codeContent.ts';
import { parsePageContent, serializePageContent } from '../content.ts';
import { RICH_CODE_TEXT, codeBlocks, richCodeBlocks } from './fixtures/codeBlockLanguages.ts';
import { readFileSync } from 'node:fs';

type B = { id: string; type: string; content?: unknown; children?: B[] };

function codeOf(blocks: B[], id: string): unknown {
  for (const b of blocks) {
    if (b.id === id) return b.content;
    const inner = b.children ? codeOf(b.children, id) : undefined;
    if (inner !== undefined) return inner;
  }
  return undefined;
}

describe('normalizeCodeBlockContent', () => {
  it('flattens links and styled runs into one plain run, newlines kept', () => {
    const out = normalizeCodeBlockContent(richCodeBlocks()) as B[];
    for (const [id, text] of Object.entries(RICH_CODE_TEXT)) {
      expect(codeOf(out, id), id).toEqual([{ type: 'text', text, styles: {} }]);
    }
  });

  it('leaves everything that is not code content alone', () => {
    const input = richCodeBlocks();
    const out = normalizeCodeBlockContent(input) as B[];
    expect(out[2].content).toBe(input[2].content); // the paragraph's own content
    expect((out[0] as unknown as { props: unknown }).props).toBe(input[0].props);
    // The input is not mutated.
    expect(input[0].content).toHaveLength(3);
  });

  it('returns the same array, untouched, when every code block is already plain', () => {
    const plain = codeBlocks();
    expect(normalizeCodeBlockContent(plain)).toBe(plain);
    const kitchen = parsePageContent(
      readFileSync(new URL('./fixtures/kitchen-sink.content.json', import.meta.url), 'utf8')
    );
    expect(normalizeCodeBlockContent(kitchen.blocks)).toBe(kitchen.blocks);
  });

  it('empty and odd content', () => {
    const blocks = [
      { type: 'codeBlock', content: [{ type: 'link', href: 'x', content: [] }] },
      { type: 'codeBlock', content: 'already a string' },
      { type: 'codeBlock' },
      { type: 'codeBlock', content: [] },
      { type: 'codeBlock', content: [{ type: 'text', text: 'no styles key' }] },
    ];
    const out = normalizeCodeBlockContent(blocks) as Array<{ content?: unknown }>;
    expect(out[0].content).toEqual([]);
    expect(out.slice(1)).toEqual(blocks.slice(1));
    expect(normalizeCodeBlockContent(null)).toBe(null);
  });

  it('parsePageContent applies it; plain pages parse byte-identically', () => {
    const rich = parsePageContent(serializePageContent({ blocks: richCodeBlocks() }));
    expect(codeOf(rich.blocks as B[], 'rich-link')).toEqual([
      { type: 'text', text: RICH_CODE_TEXT['rich-link'], styles: {} },
    ]);
    const text = serializePageContent({ blocks: codeBlocks() });
    expect(serializePageContent(parsePageContent(text))).toBe(text);
  });
});
