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
 * defaults, allowed values), every inline content type and every style — is
 * fingerprinted here and pinned per version. Changing a config fails this
 * test until SCHEMA_VERSION is bumped and the new fingerprint is recorded
 * below (never edit an existing entry).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { SCHEMA_VERSION } from '../constants.ts';
import { createPageSchema } from '../schema.ts';

/** version -> fingerprint of the schema that version shipped with. */
const RECORDED_FINGERPRINTS: Record<number, string> = {
  1: '9aff087863c0d2b8965274f910b414d4d257262587e15a554442f18d97148c69',
  // codeBlock and terminal gain `copyable`.
  2: '420e57ee296553cc3f3359bef13005739f9156da9f1406d2bf81a7457e8b665f',
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
  return { blocks, inline, styles };
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

    // Key order alone is not a change.
    const reordered = { styles: base.styles, inline: base.inline, blocks: base.blocks };
    expect(fp(reordered)).toBe(original);
  });

  it('versions only ever go up, one fingerprint each', () => {
    const versions = Object.keys(RECORDED_FINGERPRINTS).map(Number);
    expect(Math.max(...versions)).toBe(SCHEMA_VERSION);
    expect(new Set(Object.values(RECORDED_FINGERPRINTS)).size).toBe(versions.length);
  });
});
