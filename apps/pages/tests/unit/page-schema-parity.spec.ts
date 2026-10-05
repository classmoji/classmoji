/**
 * The server's page schema and the app's schemas build the SAME ProseMirror
 * schema.
 *
 * The collab server and the git worker convert live Yjs documents with
 * `createPageSchema()` from @classmoji/page-schema (no React, no DOM); the
 * editor, the in-app viewer and the class site run the app's React specs.
 * y-prosemirror deletes, for everyone, any element a participant's schema
 * does not accept — so a node name, content expression, group or attribute
 * (with its default) that differs between the two is lost content, not a
 * cosmetic mismatch. This pins every schema the app builds to the server's.
 *
 * Renders (toDOM / parseDOM / node views) legitimately differ and are not
 * compared.
 */
import { test, expect } from '@playwright/test';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import {
  SCHEMA_VERSION,
  createPageSchema,
  customBlockConfigs,
  type PageSchema,
} from '@classmoji/page-schema';

import { schema as appSchema } from '~/components/editor/blocks/index.tsx';
import { editingSchema } from '~/components/editor/blocks/editingSchema.ts';
import { viewerSchema } from '~/components/viewer/viewerBlocks.tsx';
import { createViewerSchema } from '~/site/viewerSchema.server.ts';

type AnySchema = Pick<PageSchema, 'blockSpecs' | 'blockSchema'>;

/** The ProseMirror schema BlockNote builds for a block schema. */
function pmSchemaOf(schema: AnySchema) {
  return ServerBlockNoteEditor.create({ schema: schema as never }).editor.pmSchema;
}

/**
 * What y-prosemirror and the block <-> node conversion depend on, per node:
 * the document shape (name, content, group, marks, attrs with defaults) and,
 * unless `documentOnly`, the editing flags (selectable, isolating, defining,
 * code) that decide how the editor handles the node.
 */
function nodeShapes(schema: AnySchema, documentOnly = false) {
  const pm = pmSchemaOf(schema);
  const out: Record<string, unknown> = {};
  for (const [name, type] of Object.entries(pm.nodes)) {
    const spec = type.spec;
    const flags = documentOnly
      ? {}
      : {
          selectable: spec.selectable ?? true,
          isolating: spec.isolating ?? false,
          defining: spec.defining ?? false,
          code: spec.code ?? false,
        };
    out[name] = {
      content: spec.content ?? null,
      group: spec.group ?? null,
      marks: spec.marks ?? null,
      inline: spec.inline ?? false,
      atom: spec.atom ?? false,
      ...flags,
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

/**
 * `documentOnly` for the class-site schemas: they are rendered once, read-only,
 * on the server, and never join a live document. Their static specs are
 * rebuilt from each block's config WITHOUT its implementation meta, so two
 * editing flags differ from the editor's (pinned in the last test below);
 * the document shape must still be identical.
 */
const appSchemas: Array<[string, AnySchema, { documentOnly: boolean }]> = [
  [
    'shared editor schema (blocks/index.tsx)',
    appSchema as unknown as AnySchema,
    { documentOnly: false },
  ],
  [
    'editing schema (editingSchema.ts)',
    editingSchema as unknown as AnySchema,
    { documentOnly: false },
  ],
  [
    'in-app viewer schema (viewerBlocks.tsx)',
    viewerSchema as unknown as AnySchema,
    { documentOnly: false },
  ],
  [
    'class-site schema (viewerSchema.server.ts, with downloads)',
    createViewerSchema(() => null, {
      downloads: { 'media://x': 'https://example.com/x' },
    }) as unknown as AnySchema,
    { documentOnly: true },
  ],
  [
    'class-site schema (viewerSchema.server.ts, plain)',
    createViewerSchema(() => null) as unknown as AnySchema,
    { documentOnly: true },
  ],
];

test.describe('the server page schema matches every app schema', () => {
  const serverBlocks = blockShapes(server);
  const serverMarks = markNames(server);

  for (const [name, schema, { documentOnly }] of appSchemas) {
    test(`${name}: same block types, content and props`, () => {
      expect(Object.keys(blockShapes(schema)).sort()).toEqual(Object.keys(serverBlocks).sort());
      expect(blockShapes(schema)).toEqual(serverBlocks);
    });

    test(`${name}: same ProseMirror nodes and marks`, () => {
      const serverNodes = nodeShapes(server, documentOnly);
      const nodes = nodeShapes(schema, documentOnly);
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

  test('the class site differs only in the editing flags it never uses', () => {
    const site = pmSchemaOf(createViewerSchema(() => null) as unknown as AnySchema);
    const pm = pmSchemaOf(server);
    const flagDiffs: string[] = [];
    for (const [node, type] of Object.entries(pm.nodes)) {
      for (const flag of ['selectable', 'isolating', 'defining', 'code'] as const) {
        if (type.spec[flag] !== site.nodes[node].spec[flag]) flagDiffs.push(`${node}.${flag}`);
      }
    }
    expect(flagDiffs.sort()).toEqual([
      'codeBlock.code',
      'codeBlock.isolating',
      'toggleListItem.isolating',
    ]);
  });

  test('the schema version is a positive integer', () => {
    expect(Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION > 0).toBe(true);
  });
});
