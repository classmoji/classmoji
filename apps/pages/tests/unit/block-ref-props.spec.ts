/**
 * Every block prop that can hold a file reference is one the asset walk knows.
 *
 * `collectBlockAssetRefs` / `mapBlockAssetRefs` (`@classmoji/utils`, driven by
 * its `REF_PROPS` list) are what find a page's files: to sign them for display,
 * to canonicalize a signed URL back into a reference on save, to copy media on
 * a class import, to empty an unresolved `media://` before the class site
 * renders. A block that stores a file under a prop the walk does not know
 * breaks all of that silently — the file shows as a dead link, or a signed URL
 * gets frozen into content.json.
 *
 * So this enumerates EVERY string prop of EVERY block spec the pages app
 * registers and makes each one declare itself: either it is on the short list
 * of props that are never a file (colours, captions, titles, JSON blobs of
 * links…), or the walk must find a reference stored in it. A new block, or a
 * new prop on an old one, fails here until someone decides which it is.
 */

import { test, expect } from '@playwright/test';
import * as utils from '@classmoji/utils';
import { collectBlockAssetRefs, mapBlockAssetRefs } from '@classmoji/utils';

import { schema } from '~/components/editor/blocks/index.tsx';
import { viewerSchema } from '~/components/viewer/viewerBlocks.tsx';

/**
 * String props that are never a file reference, with why. Adding a name here
 * is a claim about what the prop holds — check before you do.
 */
const NOT_FILE_REFS: Record<string, string> = {
  backgroundColor: 'a colour name',
  textColor: 'a colour name',
  textAlignment: 'left / center / right / justify',
  name: "a file's display name, not its location",
  caption: 'text under a file',
  language: 'a code block language id',
  emoji: 'a callout emoji',
  code: 'terminal text',
  title: 'a heading string',
  type: "an embed's provider hint",
  pageId: 'a page id, resolved by the link resolver',
  pageTitle: 'a denormalized page title',
  entries: 'navGrid JSON: page ids and external links, never files',
  links: 'profile JSON: external links, never files',
};

type PropSpec = { default?: unknown; type?: unknown };
type Spec = { config: { propSchema: Record<string, PropSpec> } };

/** Every `(block type, prop)` whose value is a string. */
function stringProps(blockSpecs: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [type, spec] of Object.entries(blockSpecs as Record<string, Spec>)) {
    for (const [prop, def] of Object.entries(spec.config.propSchema)) {
      if (typeof def.default === 'string' || def.type === 'string') out.push([type, prop]);
    }
  }
  return out;
}

const REF = 'pages/lab-1/assets/diagram.png';

for (const [label, blockSpecs] of [
  ['editor', schema.blockSpecs],
  ['viewer', viewerSchema.blockSpecs],
] as const) {
  test.describe(`the ${label} schema`, () => {
    const props = stringProps(blockSpecs as Record<string, unknown>);

    test('has string props to check (the enumeration is not vacuous)', () => {
      expect(props.length).toBeGreaterThan(20);
      expect(props).toContainEqual(['video', 'url']);
      expect(props).toContainEqual(['profile', 'imageUrl']);
    });

    for (const [type, prop] of props) {
      if (prop in NOT_FILE_REFS) continue;

      test(`${type}.${prop} is found and rewritten by the asset walk`, () => {
        const block = { type, props: { [prop]: REF } };
        expect(
          collectBlockAssetRefs([block]),
          `${type}.${prop} can hold a file but the asset walk does not read it. ` +
            'Add it to REF_PROPS in @classmoji/utils — or, if it never holds a file, ' +
            'to NOT_FILE_REFS in this spec with the reason.'
        ).toEqual([REF]);
        const [mapped] = mapBlockAssetRefs([block], () => 'rewritten') as Array<{
          props: Record<string, unknown>;
        }>;
        expect(mapped.props[prop]).toBe('rewritten');
      });
    }
  });
}

test('every prop the walk reads is on REF_PROPS, when @classmoji/utils exports it', () => {
  const exported = (utils as Record<string, unknown>).REF_PROPS;
  test.skip(!Array.isArray(exported), 'REF_PROPS is not exported from @classmoji/utils yet');
  const refProps = new Set(exported as string[]);
  for (const [type, prop] of stringProps(schema.blockSpecs as Record<string, unknown>)) {
    if (prop in NOT_FILE_REFS) continue;
    expect(refProps.has(prop), `${type}.${prop}`).toBe(true);
  }
});

test('the not-a-file list is honest: none of those props is read as a reference', () => {
  for (const prop of Object.keys(NOT_FILE_REFS)) {
    expect(collectBlockAssetRefs([{ type: 'x', props: { [prop]: REF } }]), prop).toEqual([]);
  }
});
