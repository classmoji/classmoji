/**
 * The rendered preview marks the blocks a pending preview adds or edits
 * against the live page (previewHighlight.ts). Never a diff: removed blocks
 * are only counted.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import {
  cssAttrValue,
  hasPreviewChanges,
  previewBlockChanges,
  previewChangesSummary,
  previewHighlightCss,
} from '../../app/components/preview/previewHighlight.ts';

const p = (id: string, text: string, children: unknown[] = []) => ({
  id,
  type: 'paragraph',
  props: { textColor: 'default' },
  content: [{ type: 'text', text, styles: {} }],
  children,
});

test.describe('previewBlockChanges', () => {
  test('edited, added and removed blocks', () => {
    const live = [p('a', 'one'), p('b', 'two'), p('c', 'three')];
    const preview = [p('a', 'one'), p('b', 'TWO'), p('d', 'new')];
    expect(previewBlockChanges(live, preview)).toEqual({
      changed: ['b'],
      added: ['d'],
      removed: 1,
    });
  });

  test('key order and a reorder are not changes', () => {
    const live = [p('a', 'one'), p('b', 'two')];
    const reordered = [
      { children: [], content: live[1].content, props: live[1].props, type: 'paragraph', id: 'b' },
      p('a', 'one'),
    ];
    expect(previewBlockChanges(live, reordered)).toEqual({ changed: [], added: [], removed: 0 });
  });

  test('a nested edit marks the nested block only, not its parent', () => {
    const live = [p('parent', 'list', [p('child', 'old')])];
    const preview = [p('parent', 'list', [p('child', 'new'), p('child2', 'added')])];
    expect(previewBlockChanges(live, preview)).toEqual({
      changed: ['child'],
      added: ['child2'],
      removed: 0,
    });
  });

  test('non-arrays read as empty documents', () => {
    expect(previewBlockChanges(null, [p('a', 'x')])).toEqual({
      changed: [],
      added: ['a'],
      removed: 0,
    });
    expect(previewBlockChanges([p('a', 'x')], undefined).removed).toBe(1);
  });

  test('hasPreviewChanges', () => {
    expect(hasPreviewChanges({ changed: [], added: [], removed: 0 })).toBe(false);
    expect(hasPreviewChanges({ changed: [], added: [], removed: 2 })).toBe(true);
    expect(hasPreviewChanges(null)).toBe(false);
  });
});

test.describe('the highlight stylesheet', () => {
  test('marks each block’s own content row, scoped, light and dark', () => {
    const css = previewHighlightCss({ changed: ['b'], added: ['d'], removed: 0 }, 'scope');
    expect(css).toContain('.scope .bn-block[data-id="b"] > .bn-block-content');
    expect(css).toContain('.scope .bn-block[data-id="d"] > .bn-block-content');
    expect(css).toContain('.dark .scope .bn-block[data-id="b"]');
    expect(css).toContain('.dark .scope .bn-block[data-id="d"]');
  });

  test('nothing to mark is an empty stylesheet', () => {
    expect(previewHighlightCss({ changed: [], added: [], removed: 3 }, 'scope')).toBe('');
  });

  test('an id cannot break out of its selector', () => {
    expect(cssAttrValue('a"] body { x')).toBe('"a\\"] body { x"');
    expect(cssAttrValue('a\\b')).toBe('"a\\\\b"');
    const css = previewHighlightCss(
      { changed: ['x"]}*{display:none}'], added: [], removed: 0 },
      's'
    );
    expect(css).toContain('[data-id="x\\"]}*{display:none}"]');
  });
});

test.describe('the preview bar summary', () => {
  test('counts from the data', () => {
    expect(previewChangesSummary({ changed: ['a', 'b'], added: ['c'], removed: 1 })).toBe(
      '2 blocks edited · 1 block added · 1 block removed'
    );
    expect(previewChangesSummary({ changed: [], added: [], removed: 0 })).toBeNull();
  });

  test('the viewer is wrapped and styled only for a preview with changes', () => {
    const route = readFileSync(
      fileURLToPath(new URL('../../app/routes/$classroomSlug.$pageId/route.tsx', import.meta.url)),
      'utf8'
    );
    expect(route).toContain("previewHighlightCss(previewChanges, 'preview-highlight')");
    expect(route).toContain("className={previewHighlightStyle ? 'preview-highlight' : undefined}");
    expect(route).toContain('changesSummary={previewSummary}');
  });
});

test('an id cannot close the style element', () => {
  expect(cssAttrValue('</style><script>')).not.toContain('<');
});
