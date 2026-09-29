/**
 * A video uploaded through a generic file block becomes a video block.
 *
 * BlockNote makes a `file` block for a dropped file no block in the schema
 * claims — which, since the app's video block is a custom one, includes every
 * video. The page editor's `uploadFile` therefore answers a video landing in a
 * `file` block with `{ type: 'video', props: { url } }` instead of a bare URL,
 * and BlockNote's upload tab and drop handler both pass that object straight to
 * `updateBlock`. This pins the two BlockNote behaviours that relies on, against
 * the app's real schema: the type change keeps what the two blocks share (the
 * caption), and the follow-up update BlockNote's upload tab sends — which
 * still names the file block's `name` prop — is absorbed rather than thrown.
 */

import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';

const GLOBALS = [
  'window',
  'document',
  'navigator',
  'Node',
  'HTMLElement',
  'Element',
  'MutationObserver',
  'getComputedStyle',
  'DocumentFragment',
  'Text',
];

test.describe('a video uploaded into a file block', () => {
  const g = globalThis as Record<string, unknown>;
  const installed: string[] = [];

  test.beforeAll(() => {
    // BlockNote's editor needs a DOM to exist, even unmounted. Installed for
    // this file only and removed afterwards: the unit suite shares a worker,
    // and other specs decide client-vs-server on `typeof window`.
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    for (const key of GLOBALS) {
      if (key in g) continue;
      g[key] = key === 'window' ? dom.window : (dom.window as Record<string, unknown>)[key];
      installed.push(key);
    }
  });

  test.afterAll(() => {
    for (const key of installed) delete g[key];
  });

  test('becomes a video block holding the reference, caption kept', async () => {
    const { BlockNoteEditor } = await import('@blocknote/core');
    const { schema } = await import('~/components/editor/blocks/index.tsx');
    const editor = BlockNoteEditor.create({
      schema,
      initialContent: [
        { type: 'file', props: { name: 'lecture.mp4', caption: 'Week 1', url: '' } },
      ] as never,
    });
    const id = editor.document[0].id;

    // What `uploadFile` returns for a video in a file block.
    editor.updateBlock(id, { type: 'video', props: { url: 'media://abc' } } as never);
    expect(editor.document[0]).toMatchObject({
      id,
      type: 'video',
      props: { url: 'media://abc', caption: 'Week 1' },
    });

    // A later update naming a prop the video block does not have is absorbed.
    expect(() =>
      editor.updateBlock(id, { props: { name: 'lecture.mp4', url: 'media://abc' } } as never)
    ).not.toThrow();
    expect(editor.document[0].type).toBe('video');
  });
});
