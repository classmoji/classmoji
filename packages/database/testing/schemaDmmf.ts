/**
 * The full description (DMMF) of schema.prisma, for tests that check queries
 * or columns against the real schema (apps/mcp's prismaSchemaStub, packages/auth's
 * authSchema test).
 *
 * Prisma 7's generated client no longer carries it: `Prisma.dmmf` and the
 * client's `_runtimeDataModel` keep only each field's name, kind and type
 * (no `isRequired`, `hasDefaultValue`, `isUpdatedAt`, unique indexes or
 * primary keys). So this asks Prisma's own schema engine, built to wasm and
 * published as `@prisma/prisma-schema-wasm`, for the same document Prisma 6's
 * client exported. On every property those tests read it is identical to
 * Prisma 6.19.3's `Prisma.dmmf.datamodel`.
 *
 * The package is versioned with the engines of one Prisma release: its version
 * ends in the engines hash `@prisma/engines-version` names, and a test
 * (schemaDmmf.test.ts) fails when the two part, so a Prisma bump moves this pin
 * with it. Test-only: nothing outside tests may import it.
 */
import { readFileSync } from 'node:fs';
// The generated client's `Prisma.DMMF` is `typeof runtime.DMMF`, a value type
// with no member types; the types are the runtime's own (what Prisma 6's
// `Prisma.DMMF` re-exported).
import type { DMMF } from '@prisma/client/runtime/client';
import { get_dmmf } from '@prisma/prisma-schema-wasm';

export type SchemaModel = DMMF.Model;
export type SchemaField = DMMF.Field;

const schema = readFileSync(new URL('../schema.prisma', import.meta.url), 'utf8');
const document = JSON.parse(get_dmmf(JSON.stringify({ prismaSchema: schema }))) as {
  datamodel: { models: SchemaModel[] };
};

/** Every model of schema.prisma, as Prisma 6's `Prisma.dmmf.datamodel.models` listed them. */
export const SCHEMA_MODELS: readonly SchemaModel[] = document.datamodel.models;
