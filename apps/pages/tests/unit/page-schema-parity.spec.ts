/**
 * The server's page schema and the app's schemas build the SAME ProseMirror
 * schema.
 *
 * The collab server and the git worker convert live Yjs documents with
 * `createPageSchema()` from @classmoji/page-schema (no React, no DOM); the
 * editor and the reader (in the app and on the class site) run the app's
 * React specs.
 * y-prosemirror deletes, for everyone, any element a participant's schema
 * does not accept — so a node name, content expression, group or attribute
 * (with its default) that differs between the two is lost content, not a
 * cosmetic mismatch. This pins every schema the app builds to the server's.
 *
 * Renders (toDOM / parseDOM / node views) legitimately differ and are not
 * compared.
 */
import { test, expect } from '@playwright/test';
import { BlockNoteEditor } from '@blocknote/core';
import {
  SCHEMA_VERSION,
  createPageSchema,
  customBlockConfigs,
  type PageSchema,
} from '@classmoji/page-schema';

import { schema as appSchema } from '~/components/editor/blocks/index.tsx';
import { editingSchema } from '~/components/editor/blocks/editingSchema.ts';
import { viewerSchema } from '~/components/viewer/viewerBlocks.tsx';

type AnySchema = Pick<PageSchema, 'blockSpecs' | 'blockSchema'>;

/** The ProseMirror schema BlockNote builds for a block schema. */
function pmSchemaOf(schema: AnySchema) {
  return BlockNoteEditor.create({ schema: schema as never }).pmSchema;
}

/**
 * What y-prosemirror and the block <-> node conversion depend on, per node:
 * the document shape (name, content, group, marks, attrs with defaults) and
 * the editing flags (selectable, isolating, defining, code) that decide how
 * the editor handles the node.
 */
function nodeShapes(schema: AnySchema) {
  const pm = pmSchemaOf(schema);
  const out: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(pm.nodes)) {
    const spec = type.spec;
    out[name] = {
      content: spec.content ?? null,
      group: spec.group ?? null,
      marks: spec.marks ?? null,
      inline: spec.inline ?? false,
      atom: spec.atom ?? false,
      selectable: spec.selectable ?? true,
      isolating: spec.isolating ?? false,
      defining: spec.defining ?? false,
      code: spec.code ?? false,
      attrs: Object.fromEntries(
        Object.entries(spec.attrs ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, attr]) => [key, { default: attr.default ?? null }])
      ),
    };
  }
  return out;
}

function markNames(schema: AnySchema) {
  return Object.keys(pmSchemaOf(schema).marks).sort();
}

/** BlockNote's own view of each block: type, content kind, props with defaults. */
function blockShapes(schema: AnySchema) {
  return JSON.parse(JSON.stringify(schema.blockSchema)) as Record<string, unknown>;
}

const server = createPageSchema();

const appSchemas: Array<[string, AnySchema]> = [
  ['shared editor schema (blocks/index.tsx)', appSchema as unknown as AnySchema],
  ['editing schema (editingSchema.ts)', editingSchema as unknown as AnySchema],
  ['reader schema (viewerBlocks.tsx)', viewerSchema as unknown as AnySchema],
];

test.describe('the server page schema matches every app schema', () => {
  const serverBlocks = blockShapes(server);
  const serverMarks = markNames(server);

  for (const [name, schema] of appSchemas) {
    test(`${name}: same block types, content and props`, () => {
      expect(Object.keys(blockShapes(schema)).sort()).toEqual(Object.keys(serverBlocks).sort());
      expect(blockShapes(schema)).toEqual(serverBlocks);
    });

    test(`${name}: same ProseMirror nodes and marks`, () => {
      const serverNodes = nodeShapes(server);
      const nodes = nodeShapes(schema);
      expect(Object.keys(nodes).sort()).toEqual(Object.keys(serverNodes).sort());
      for (const node of Object.keys(serverNodes)) {
        expect(nodes[node], `node "${node}"`).toEqual(serverNodes[node]);
      }
      expect(markNames(schema)).toEqual(serverMarks);
    });
  }

  test('every custom block config is the one the app renders', () => {
    for (const [type, config] of Object.entries(customBlockConfigs)) {
      const spec = (appSchema.blockSpecs as Record<string, { config: unknown }>)[type];
      // Same object, not merely an equal one: the app builds from the shared config.
      expect(spec?.config, type).toBe(config);
    }
  });

  // BlockNote 0.56+ keeps a block's keyboard settings (Enter continues a
  // list, an empty column child stays in its column) on the spec it builds,
  // resolved from `experimental_keyboard`, which a built spec no longer
  // carries: a schema made from another schema's `blockSpecs` falls back to
  // the defaults. Every schema here must keep BlockNote's.
  test('every schema keeps BlockNote’s keyboard settings', () => {
    type Keyboard = { splitKeepsType: boolean; emptyEnterResets: boolean; emptyChildEnter: string };
    type Spec = { implementation: { keyboard: (block: unknown) => Keyboard } };
    const block = { id: 'b', type: 'x', props: {}, content: [], children: [] };
    const all: Array<[string, AnySchema]> = [['server schema', server], ...appSchemas];
    for (const [name, schema] of all) {
      const specs: Record<string, unknown> = schema.blockSpecs;
      const keyboard = (type: string) => (specs[type] as Spec).implementation.keyboard(block);
      for (const type of ['bulletListItem', 'numberedListItem', 'checkListItem']) {
        expect(keyboard(type).splitKeepsType, `${name}: ${type}`).toBe(true);
        expect(keyboard(type).emptyEnterResets, `${name}: ${type}`).toBe(true);
      }
      expect(keyboard('column').emptyChildEnter, `${name}: column`).toBe('stay');
    }
  });

  test('the schema version is a positive integer', () => {
    expect(Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION > 0).toBe(true);
  });
});
