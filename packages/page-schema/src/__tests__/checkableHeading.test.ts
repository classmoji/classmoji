/**
 * The page heading: BlockNote's heading plus `checkable` (no default), and the
 * `lockedSection` block, through every conversion the server does.
 */
import { createHeadingBlockSpec } from '@blocknote/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { lockedSectionConfig } from '../configs.ts';
import { serializePageContent } from '../content.ts';
import { createPageSchema } from '../schema.ts';
import { getServerEditor, pageContentToYDoc, yDocToPageContent } from '../server.ts';

const text = (value: string) => [{ type: 'text', text: value, styles: {} }];

function yjsTrip(blocks: unknown[]) {
  const loaded = new Y.Doc();
  Y.applyUpdate(loaded, Y.encodeStateAsUpdate(pageContentToYDoc({ blocks })));
  return yDocToPageContent(loaded).blocks as Array<{
    id: string;
    props: Record<string, unknown>;
    children: unknown[];
  }>;
}

describe('heading.checkable', () => {
  it('is BlockNote’s heading config plus an optional boolean with no default', () => {
    const schema = createPageSchema();
    const heading = (schema.blockSchema as unknown as Record<string, { propSchema: object }>)
      .heading;
    const base = createHeadingBlockSpec().config.propSchema;
    expect(heading.propSchema).toEqual({
      ...base,
      checkable: { default: undefined, type: 'boolean' },
    });
  });

  it('true survives the Yjs round trip as a boolean; absent stays absent', () => {
    const [on, off, absent] = yjsTrip([
      { id: 'on', type: 'heading', props: { level: 2, checkable: true }, content: text('a') },
      { id: 'off', type: 'heading', props: { level: 2, checkable: false }, content: text('b') },
      { id: 'absent', type: 'heading', props: { level: 2 }, content: text('c') },
    ]);
    expect(on.props.checkable).toBe(true);
    expect(off.props.checkable).toBe(false);
    expect('checkable' in absent.props).toBe(false);
    expect(serializePageContent({ blocks: [absent] })).not.toContain('checkable');
  });

  it('keeps level, toggle headings and their children', () => {
    const [toggle] = yjsTrip([
      {
        id: 't',
        type: 'heading',
        props: { level: 3, isToggleable: true, checkable: true },
        content: text('toggle'),
        children: [{ id: 'c', type: 'paragraph', content: text('child') }],
      },
    ]);
    expect(toggle.props).toMatchObject({ level: 3, isToggleable: true, checkable: true });
    expect(toggle.children).toHaveLength(1);
  });

  it('renders data-checkable only when set, and the same heading markup as before', async () => {
    const editor = getServerEditor();
    const html = await editor.blocksToFullHTML([
      { id: 'a', type: 'heading', props: { level: 2, checkable: true }, content: text('A') },
      { id: 'b', type: 'heading', props: { level: 3 }, content: text('B') },
    ] as never);
    expect(html.match(/data-checkable="true"/g)).toHaveLength(1);
    expect(html).toContain('<h2');
    expect(html).toContain('<h3');
    expect(html).not.toContain('data-checkable="false"');

    const external = await editor.blocksToHTMLLossy([
      {
        id: 'c',
        type: 'heading',
        props: { level: 2, isToggleable: true, checkable: true },
        content: text('C'),
        children: [{ id: 'd', type: 'paragraph', content: text('D') }],
      },
    ] as never);
    expect(external).toContain('<details');
    expect(external).toContain('<h2');
  });
});

describe('lockedSection', () => {
  it('is in the server schema with the shared config: a title prop, no inline content', () => {
    const schema = createPageSchema();
    const block = (
      schema.blockSchema as unknown as Record<string, { content: string; propSchema: object }>
    ).lockedSection;
    expect(block.content).toBe('none');
    expect(block.propSchema).toEqual({ title: { default: '' } });
    expect(lockedSectionConfig).toEqual({
      type: 'lockedSection',
      propSchema: { title: { default: '' } },
      content: 'none',
    });
  });

  it('keeps its title and nested children through the Yjs round trip', () => {
    const blocks = [
      {
        id: 'L',
        type: 'lockedSection',
        props: { title: 'Solution' },
        children: [
          { id: 'L-p', type: 'paragraph', content: text('body') },
          {
            id: 'L-inner',
            type: 'lockedSection',
            props: { title: 'Inner' },
            children: [{ id: 'L-inner-p', type: 'paragraph', content: text('inner body') }],
          },
        ],
      },
    ];
    const [trip] = yjsTrip(blocks);
    expect(trip.props).toEqual({ title: 'Solution' });
    expect((trip as { content?: unknown }).content).toBeUndefined();
    const json = JSON.stringify(trip);
    expect(json).toContain('inner body');
    expect(trip.children).toHaveLength(2);
    expect((trip.children[1] as { props: unknown }).props).toEqual({ title: 'Inner' });
  });

  it('writes the title, never the body, onto the block element', async () => {
    const html = await getServerEditor().blocksToFullHTML([
      {
        id: 'L',
        type: 'lockedSection',
        props: { title: 'Solution' },
        children: [{ id: 'L-p', type: 'paragraph', content: text('body') }],
      },
    ] as never);
    const blockContent = html.match(/<div[^>]*data-content-type="lockedSection"[^>]*>/)?.[0];
    expect(blockContent).toContain('data-title="Solution"');
    expect(blockContent).not.toContain('body');
  });
});
