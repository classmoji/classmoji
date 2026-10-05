/**
 * A file block whose upload is refused goes back to its empty state.
 *
 * BlockNote's DOM-rendered `file` and `audio` blocks (@blocknote/core,
 * `createFileBlockWrapper`) swap the "Add file" button for "Loading..." when an
 * upload starts and never listen for its end: only a successful upload, which
 * changes the block and so rebuilds it, gets rid of the loader. A refused one
 * left the block stuck. The page editor therefore runs with `editingSchema`,
 * whose `file` and `audio` blocks are BlockNote's React ones, which follow the
 * upload's start AND end.
 *
 * Pinned here:
 *   - the cause, in BlockNote's own render — when an upgrade fixes it, the
 *     first test fails and says the override can go;
 *   - the editor's schema replaces exactly those two renders and keeps
 *     BlockNote's configs and `fileBlockAccept`;
 *   - the reset that clears a dropped file's name off a block whose upload
 *     did not finish.
 */

import { test, expect } from '@playwright/test';
// @ts-expect-error -- jsdom ships no type declarations; only the constructor is used.
import { JSDOM } from 'jsdom';

import { unfinishedUploadReset } from '~/components/editor/media/uploadRouting.ts';

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

type Listener = (blockId?: string) => void;

test.describe('file block upload state', () => {
  const g = globalThis as Record<string, unknown>;
  const installed: string[] = [];

  test.beforeAll(() => {
    // Installed for this file only and removed afterwards: the unit suite
    // shares a worker, and other specs decide client-vs-server on `window`.
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    for (const key of GLOBALS) {
      // `!== undefined`, not `in`: ServerBlockNoteEditor restores the globals
      // it swaps by assignment, leaving `document: undefined` behind once any
      // spec earlier in the worker has called `blocksToFullHTML`.
      if (g[key] !== undefined) continue;
      g[key] = key === 'window' ? dom.window : (dom.window as Record<string, unknown>)[key];
      installed.push(key);
    }
  });

  test.afterAll(() => {
    for (const key of installed) delete g[key];
  });

  /** Just what BlockNote's file renders read off the editor. */
  function fakeEditor(elementRenderer?: () => void) {
    const starts: Listener[] = [];
    const ends: Listener[] = [];
    const editor = {
      dictionary: { file_blocks: { add_button_text: { file: 'Add file' } } },
      isEditable: true,
      elementRenderer,
      onUploadStart: (cb: Listener) => {
        starts.push(cb);
        return () => starts.splice(starts.indexOf(cb), 1);
      },
      onUploadEnd: (cb: Listener) => {
        ends.push(cb);
        return () => ends.splice(ends.indexOf(cb), 1);
      },
    };
    return { editor, starts, ends };
  }

  type Spec = {
    config: {
      type: string;
      propSchema: Record<string, { default?: unknown }>;
      content: string;
    };
    implementation: {
      render: (block: never, editor: never) => unknown;
      meta?: { fileBlockAccept?: string[] };
    };
  };

  /** A block of the spec's type with every prop at its default: no file yet. */
  const emptyBlock = (spec: Spec) => ({
    id: 'b1',
    type: spec.config.type,
    props: Object.fromEntries(
      Object.entries(spec.config.propSchema).map(([key, prop]) => [key, prop.default])
    ),
    content: undefined,
    children: [],
  });

  /**
   * Whether a spec renders through React. A React spec hands its element to
   * the editor's `elementRenderer`; a DOM spec builds the DOM itself.
   */
  function rendersThroughReact(spec: Spec): boolean {
    let viaReact = false;
    const { editor } = fakeEditor(() => {
      viaReact = true;
    });
    const warn = console.warn;
    console.warn = () => {}; // BlockNote warns when the fake renderer draws nothing.
    try {
      spec.implementation.render(emptyBlock(spec) as never, editor as never);
    } finally {
      console.warn = warn;
    }
    return viaReact;
  }

  test("BlockNote's DOM file block never leaves its loader after an upload ends", async () => {
    const { defaultBlockSpecs } = await import('@blocknote/core');
    const { editor, starts, ends } = fakeEditor();
    const spec = defaultBlockSpecs.file as unknown as Spec;

    const rendered = spec.implementation.render(emptyBlock(spec) as never, editor as never) as {
      dom: HTMLElement;
    };
    const dom = rendered.dom;
    expect(dom.querySelector('.bn-add-file-button')).not.toBeNull();

    // The upload starts: the button is swapped for the loader.
    for (const cb of [...starts]) cb('b1');
    expect(dom.querySelector('.bn-file-loading-preview')?.textContent).toBe('Loading...');
    expect(dom.querySelector('.bn-add-file-button')).toBeNull();

    // The upload fails. Nothing listens for its end, so nothing undoes that.
    expect(ends).toHaveLength(0);
    expect(dom.querySelector('.bn-file-loading-preview')).not.toBeNull();
    expect(dom.querySelector('.bn-add-file-button')).toBeNull();
  });

  test("the editor's file and audio blocks are BlockNote's React ones, same config", async () => {
    const { defaultBlockSpecs } = await import('@blocknote/core');
    const { schema } = await import('~/components/editor/blocks/index.tsx');
    const { editingSchema } = await import('~/components/editor/blocks/editingSchema.ts');

    const shared = schema.blockSpecs as unknown as Record<string, Spec>;
    const editing = editingSchema.blockSpecs as unknown as Record<string, Spec>;
    const core = defaultBlockSpecs as unknown as Record<string, Spec>;

    for (const type of ['file', 'audio']) {
      // The shared schema keeps BlockNote's DOM render (the class site's
      // server render is built from it); the editor's is the React one.
      expect(rendersThroughReact(shared[type])).toBe(false);
      expect(rendersThroughReact(editing[type])).toBe(true);

      // Same block to every document: type, props and content model.
      expect(editing[type].config.type).toBe(type);
      expect(editing[type].config.content).toBe(core[type].config.content);
      expect(Object.keys(editing[type].config.propSchema).sort()).toEqual(
        Object.keys(core[type].config.propSchema).sort()
      );
      // What marks it as a file block, sets the upload tab's `accept` and
      // picks the block a dropped file becomes.
      expect(editing[type].implementation.meta?.fileBlockAccept).toEqual(
        core[type].implementation.meta?.fileBlockAccept
      );
    }

    // Every other block type is still there, with the shared schema's config.
    expect(Object.keys(editing).sort()).toEqual(Object.keys(shared).sort());
    for (const type of Object.keys(shared)) {
      if (type === 'file' || type === 'audio') continue;
      expect(editing[type].config, type).toBe(shared[type].config);
    }
  });

  test('a block left by a refused drop loses the name of the file it never held', () => {
    expect(unfinishedUploadReset({ props: { name: 'lecture.mp4', url: '', caption: '' } })).toEqual(
      { props: { name: '' } }
    );
  });

  test('a block that holds a file, or has no name to clear, is left alone', () => {
    // An earlier upload, or a file picked from media.
    expect(unfinishedUploadReset({ props: { name: 'notes.pdf', url: 'assets/notes.pdf' } })).toBe(
      null
    );
    // Inserted from the slash menu: nothing was set.
    expect(unfinishedUploadReset({ props: { name: '', url: '' } })).toBe(null);
    // The video block has no `name`.
    expect(unfinishedUploadReset({ props: { url: '', caption: '' } })).toBe(null);
    // Deleted while the upload ran.
    expect(unfinishedUploadReset(undefined)).toBe(null);
    expect(unfinishedUploadReset(null)).toBe(null);
  });
});
