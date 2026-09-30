/**
 * The document walk behind render-time URL resolution.
 *
 * Two properties matter and both are load-bearing:
 *
 *  - it finds references at ANY nesting depth, because a column layout puts
 *    images two levels down and a missed one renders broken;
 *  - the rewrite CLONES. The class-site path renders from a five-minute cache,
 *    and an in-place rewrite would leave one viewer's signed, tier-specific,
 *    expiring URLs in that cache for the next viewer.
 */

import { describe, it, expect } from 'vitest';
import {
  BLOCK_ASSET_REF_PROPS,
  collectBlockAssetRefs,
  mapBlockAssetRefs,
} from '../blockAssetRefs.ts';

const doc = () => [
  { id: '1', type: 'paragraph', content: [], children: [] },
  { id: '2', type: 'image', props: { url: 'pages/lab-1/assets/hero.png' } },
  {
    id: '3',
    type: 'columnList',
    children: [
      {
        id: '4',
        type: 'column',
        children: [
          { id: '5', type: 'video', props: { url: 'https://youtube.com/watch?v=x' } },
          { id: '6', type: 'profile', props: { imageUrl: 'pages/lab-1/assets/tim.jpg' } },
        ],
      },
    ],
  },
];

describe('collectBlockAssetRefs', () => {
  it('finds references at every depth, in document order', () => {
    expect(collectBlockAssetRefs(doc())).toEqual([
      'pages/lab-1/assets/hero.png',
      'https://youtube.com/watch?v=x',
      'pages/lab-1/assets/tim.jpg',
    ]);
  });

  it('ignores blocks with no reference prop, and empty-string props', () => {
    expect(collectBlockAssetRefs([{ type: 'paragraph', props: { url: '' } }])).toEqual([]);
    expect(collectBlockAssetRefs([{ type: 'divider' }])).toEqual([]);
  });

  it('survives shapes it was not designed for', () => {
    expect(collectBlockAssetRefs(null)).toEqual([]);
    expect(collectBlockAssetRefs([null, 'text', 7])).toEqual([]);
    expect(collectBlockAssetRefs([{ props: { url: 42 } }])).toEqual([]);
  });
});

describe('mapBlockAssetRefs', () => {
  it('rewrites at every depth without mutating the input', () => {
    const original = doc();
    const snapshot = JSON.parse(JSON.stringify(original));

    const mapped = mapBlockAssetRefs(original, ref =>
      ref.startsWith('pages/') ? `https://cdn.test/${ref}` : ref
    );

    // The source document is byte-identical afterwards — this is the property
    // that keeps a cached site document free of one viewer's signed URLs.
    expect(original).toEqual(snapshot);

    expect(collectBlockAssetRefs(mapped)).toEqual([
      'https://cdn.test/pages/lab-1/assets/hero.png',
      // An untouched reference keeps its exact value.
      'https://youtube.com/watch?v=x',
      'https://cdn.test/pages/lab-1/assets/tim.jpg',
    ]);
  });

  it('returns the very same object when nothing changed', () => {
    const original = doc();
    expect(mapBlockAssetRefs(original, ref => ref)).toBe(original);
  });

  it('copies only the branches that changed', () => {
    const original = doc();
    const mapped = mapBlockAssetRefs(original, ref => (ref.endsWith('.jpg') ? 'x.jpg' : ref));

    // The paragraph and the image block are untouched, so they are shared.
    expect(mapped[0]).toBe(original[0]);
    expect(mapped[1]).toBe(original[1]);
    // The column chain leading to the rewritten block is copied.
    expect(mapped[2]).not.toBe(original[2]);
  });
});

describe('BLOCK_ASSET_REF_PROPS — the rule', () => {
  // Every block prop that stores a file reference is named one of these. The
  // list is what the walk reads; a new name is a deliberate change here, and
  // the pages app pins its registered block propSchemas against this export.
  it('is exactly url and imageUrl', () => {
    expect([...BLOCK_ASSET_REF_PROPS]).toEqual(['url', 'imageUrl']);
  });

  it('reads those props and no other, on any block type', () => {
    const blocks = [
      { type: 'video', props: { url: 'media://a', caption: 'media://not-a-ref-prop' } },
      { type: 'customCard', props: { imageUrl: 'pages/x/assets/card.png', href: 'pages/x/a.pdf' } },
    ];
    expect(collectBlockAssetRefs(blocks)).toEqual(['media://a', 'pages/x/assets/card.png']);
  });
});
