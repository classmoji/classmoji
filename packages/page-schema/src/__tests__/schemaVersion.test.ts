/**
 * SCHEMA_VERSION must move with the schema.
 *
 * The collab server refuses a browser whose schema version differs, because a
 * participant with a different schema deletes the blocks (and marks) it does
 * not know — for everyone in the room. That guard is only as good as the
 * version number: a config change that ships without a bump lets old and new
 * editors share a room.
 *
 * So the schema's shape — every block type's content kind and props (types,
 * defaults, allowed values), every inline content type, every style, and
 * which marks each mark excludes (the marks a run may carry together) — is
 * fingerprinted here and pinned per version. Changing a config fails this
 * test until SCHEMA_VERSION is bumped and the new fingerprint is recorded
 * below (never edit an existing entry).
 */
import { createHash } from 'node:crypto';
import { BlockNoteEditor } from '@blocknote/core';
import { describe, expect, it } from 'vitest';

import { SCHEMA_VERSION } from '../constants.ts';
import { createPageSchema } from '../schema.ts';

/** version -> fingerprint of the schema that version shipped with. */
const RECORDED_FINGERPRINTS: Record<number, string> = {
  1: '9aff087863c0d2b8965274f910b414d4d257262587e15a554442f18d97148c69',
  // codeBlock and terminal gain `copyable`.
  2: '420e57ee296553cc3f3359bef13005739f9156da9f1406d2bf81a7457e8b665f',
  // heading gains `checkable` (no default); new `lockedSection` block.
  // Re-recorded before v3 was released: lockedSection's title moved from inline
  // content to a `title` prop (`content: 'none'`). No v3 document or client
  // exists with the earlier shape.
  3: '59cdf539e308941e85052887eb15d24648f2f6b12e31a594ea42253e5f9f3ba5',
  // checkListItem gains `personal` (no default): student check lists.
  4: 'c03cb77ae791cce772cdbcfb87424d72b0b9a33eaea8fb3ef264c958e20e364d',
  // codeBlock gains `collapsible` (no default): long code shows its first lines.
  5: 'a0e014fd58ca64ff7b68f21b9fb7e4f54f860c3d8ab55500edcfa1b19d20687e',
  // The fingerprint now includes each mark's exclusions (v5 shipped with
  // inline code excluding only itself, a change the fingerprint could not
  // see); the code mark goes back to BlockNote's: it excludes every other
  // formatting mark and the link.
  6: '8295da221de0e30063f0fc83b5c8823828ab400a5d6d436fadf220e9a6729233',
};

/** Sorted-key JSON; functions and undefined are left out (they are not shape). */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || value === undefined
      ? 'null'
      : (JSON.stringify(value) ?? 'null');
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter(key => record[key] !== undefined && typeof record[key] !== 'function')
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

/** The parts of the schema that decide what a document may contain. */
function schemaShape(schema = createPageSchema()) {
  const blocks = Object.fromEntries(
    Object.entries(schema.blockSchema as unknown as Record<string, Record<string, unknown>>).map(
      ([type, config]) => [type, { content: config.content, propSchema: config.propSchema }]
    )
  );
  const inline = Object.fromEntries(
    Object.entries(schema.inlineContentSchema as unknown as Record<string, unknown>).map(
      ([type, config]) => [
        type,
        typeof config === 'string'
          ? config
          : {
              content: (config as { content?: unknown }).content,
              propSchema: (config as { propSchema?: unknown }).propSchema,
            },
      ]
    )
  );
  const styles = Object.fromEntries(
    Object.entries(schema.styleSchema as unknown as Record<string, { propSchema?: unknown }>).map(
      ([type, config]) => [type, config.propSchema]
    )
  );
  // Which marks each mark excludes: a run one schema accepts and another
  // refuses is a document one editor opens and another throws on.
  const pm = BlockNoteEditor.create({ schema: schema as never }).pmSchema;
  const names = Object.keys(pm.marks).sort();
  const markExcludes = Object.fromEntries(
    names.map(name => [name, names.filter(other => pm.marks[name].excludes(pm.marks[other]))])
  );
  return { blocks, inline, styles, markExcludes };
}

function schemaFingerprint(schema = createPageSchema()): string {
  return createHash('sha256')
    .update(stableJson(schemaShape(schema)))
    .digest('hex');
}

describe('SCHEMA_VERSION', () => {
  it('has a recorded fingerprint, and the schema still matches it', () => {
    const recorded = RECORDED_FINGERPRINTS[SCHEMA_VERSION];
    expect(
      recorded,
      `No fingerprint recorded for SCHEMA_VERSION ${SCHEMA_VERSION}: add ${schemaFingerprint()}`
    ).toBeTruthy();
    expect(
      schemaFingerprint(),
      `The page schema changed: bump SCHEMA_VERSION and record ${schemaFingerprint()}`
    ).toBe(recorded);
  });

  it('the fingerprint sees a prop default, a prop value list and a new block', () => {
    const base = schemaShape();
    const fp = (shape: unknown) => createHash('sha256').update(stableJson(shape)).digest('hex');
    const original = fp(base);

    const changedDefault = structuredClone(base);
    (changedDefault.blocks.callout.propSchema as Record<string, { default?: unknown }>).emoji = {
      default: '🔥',
    };
    expect(fp(changedDefault)).not.toBe(original);

    const extraBlock = structuredClone(base);
    (extraBlock.blocks as Record<string, unknown>).quizEmbed = { content: 'none', propSchema: {} };
    expect(fp(extraBlock)).not.toBe(original);

    // A mark's exclusions (v5 relaxed inline code and the fingerprint missed it).
    const relaxedCode = structuredClone(base);
    relaxedCode.markExcludes.code = ['code'];
    expect(fp(relaxedCode)).not.toBe(original);

    // Key order alone is not a change.
    const reordered = {
      markExcludes: base.markExcludes,
      styles: base.styles,
      inline: base.inline,
      blocks: base.blocks,
    };
    expect(fp(reordered)).toBe(original);
  });

  it('versions only ever go up, one fingerprint each', () => {
    const versions = Object.keys(RECORDED_FINGERPRINTS).map(Number);
    expect(Math.max(...versions)).toBe(SCHEMA_VERSION);
    expect(new Set(Object.values(RECORDED_FINGERPRINTS)).size).toBe(versions.length);
  });
});
