import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { SCHEMA_MODELS } from '../testing/schemaDmmf.ts';

const require = createRequire(import.meta.url);

describe('the schema description for tests', () => {
  it('comes from the engines of the installed Prisma', () => {
    const { enginesVersion } = require('@prisma/engines-version/package.json').prisma as {
      enginesVersion: string;
    };
    const wasm = require('@prisma/prisma-schema-wasm/package.json').version as string;
    // Bump @prisma/prisma-schema-wasm to the version ending in this hash.
    expect(wasm.endsWith(`.${enginesVersion}`), `${wasm} vs engines ${enginesVersion}`).toBe(true);
  });

  it('carries what the generated client no longer does', () => {
    const user = SCHEMA_MODELS.find(model => model.name === 'User');
    expect(user?.dbName).toBe('users');
    expect(user?.fields.find(field => field.name === 'email')).toMatchObject({
      kind: 'scalar',
      isRequired: false,
      isUnique: true,
    });
    expect(user?.fields.find(field => field.name === 'id')).toMatchObject({
      isId: true,
      isRequired: true,
      hasDefaultValue: true,
    });
    // A compound unique index, a primary key and an @updatedAt column somewhere.
    expect(SCHEMA_MODELS.some(model => model.uniqueIndexes.length > 0)).toBe(true);
    expect(SCHEMA_MODELS.some(model => model.primaryKey)).toBe(true);
    expect(SCHEMA_MODELS.some(model => model.fields.some(field => field.isUpdatedAt))).toBe(true);
  });
});
