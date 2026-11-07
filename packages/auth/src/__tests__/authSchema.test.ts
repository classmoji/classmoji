/**
 * The tables and columns better-auth writes, built from our real `auth`
 * options, against the generated Prisma client's data model.
 *
 * better-auth 1.7.3+ runs this comparison itself at startup and refuses every
 * auth request when it finds a missing table or column (the Prisma adapter's
 * `findPrismaSchemaProblems`, which reads the client's `_runtimeDataModel`).
 * The other suites stand in a mock client with no data model, so the check
 * never runs there. This one hands the adapter the real `@classmoji/database`
 * client (no query is made) and repeats the comparison the same way:
 *
 *   - models matched by name with the first letter lowercased
 *     (`oauthApplication` is Prisma's `OauthApplication`);
 *   - every field better-auth writes (`fieldName`, else its key) plus `id`
 *     must be a scalar field of that model;
 *   - a required scalar field better-auth never writes must have a default.
 *
 * Plugin fields (the admin plugin's `banReason`, `impersonatedBy`, ...) take
 * their names from the plugin's own schema option, not from `user.fields` or
 * `session.fields`, which only rename core fields.
 */

import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
// eslint's resolver misses these subpath exports; TypeScript resolves them.
// eslint-disable-next-line import/no-unresolved
import { getAuthTables } from 'better-auth/db';

process.env.WEBAPP_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-chars!!';
// Read only when a query is made, and none is.
process.env.DATABASE_URL ??= 'postgresql://unused:unused@127.0.0.1:1/unused';

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: { findById: vi.fn(), findByLogin: vi.fn() },
    classroom: { findBySlug: vi.fn(), getClassroomForUI: (c: unknown) => c },
    classroomMembership: { findByClassroomAndUser: vi.fn() },
    githubUserToken: { getGitHubTokenForUser: vi.fn(async () => null) },
    subscription: { getProStateForClassroomId: vi.fn() },
  },
}));

const { auth } = await import('../server.ts');

const clientProperty = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

/** Every column better-auth writes, per model, keyed as the adapter addresses it. */
function expectedSchema(): Map<string, Set<string>> {
  const expected = new Map<string, Set<string>>();
  for (const table of Object.values(getAuthTables(auth.options))) {
    const name = clientProperty(table.modelName);
    const columns = expected.get(name) ?? new Set<string>(['id']);
    for (const [key, field] of Object.entries(table.fields)) {
      columns.add(field.fieldName || key);
    }
    expected.set(name, columns);
  }
  return expected;
}

function schemaFindings(): string[] {
  const models = new Map(
    Prisma.dmmf.datamodel.models.map(model => [clientProperty(model.name), model])
  );
  const findings: string[] = [];
  for (const [table, written] of expectedSchema()) {
    const model = models.get(table);
    if (!model) {
      findings.push(`missing table ${table}`);
      continue;
    }
    const columns = model.fields.filter(field => field.kind !== 'object');
    for (const column of written) {
      if (!columns.some(field => field.name === column)) {
        findings.push(`missing column ${table}.${column}`);
      }
    }
    for (const field of columns) {
      if (written.has(field.name) || !field.isRequired) continue;
      if (field.hasDefaultValue || field.isUpdatedAt) continue;
      findings.push(`required column better-auth never writes: ${table}.${field.name}`);
    }
  }
  return findings;
}

describe('better-auth schema vs the generated Prisma client', () => {
  it('finds every table and column better-auth writes', () => {
    expect(schemaFindings()).toEqual([]);
  });

  it('compares the admin plugin fields under their mapped names', () => {
    const expected = expectedSchema();
    // Core models, renamed through user/session/account/verification options.
    expect([...expected.keys()]).toEqual(
      expect.arrayContaining(['user', 'session', 'account', 'verification'])
    );
    expect([...expected.get('user')!]).toEqual(
      expect.arrayContaining(['role', 'banned', 'ban_reason', 'ban_expires_at', 'created_at'])
    );
    expect(expected.get('user')!.has('banReason')).toBe(false);
    expect(expected.get('user')!.has('banExpires')).toBe(false);
    // Prisma names the field impersonatedBy (mapped to impersonated_by in SQL).
    expect([...expected.get('session')!]).toEqual(
      expect.arrayContaining(['impersonatedBy', 'user_id', 'sign_in_provider'])
    );
  });

  it('compares every table the authorization server and its signing keys use', () => {
    const expected = expectedSchema();
    expect([...expected.keys()].sort()).toEqual(
      [
        'account',
        'jwks',
        'oauthAccessToken',
        'oauthClient',
        'oauthClientAssertion',
        'oauthClientResource',
        'oauthConsent',
        'oauthRefreshToken',
        'oauthResource',
        'session',
        'user',
        'verification',
      ].sort()
    );
  });

  // better-auth runs the same comparison itself (the Prisma adapter's
  // `findPrismaSchemaProblems`) when the client it is given carries Prisma's
  // data model, and awaits it before every auth call. It must be registered
  // on the app's client, and clean.
  it('registers better-auth’s own startup check on the client it is given, and passes it', async () => {
    const ctx = await auth.$context;
    expect(typeof ctx.checkSchema).toBe('function');
    // Throws SchemaMismatchError on a mismatch.
    await ctx.checkSchema!();
  });

  // Every auth call awaits that check first and throws SchemaMismatchError on
  // a mismatch. With no session cookie this makes no query.
  it('answers a session lookup without a schema error', async () => {
    await expect(auth.api.getSession({ headers: new Headers() })).resolves.toBeNull();
  });
});
