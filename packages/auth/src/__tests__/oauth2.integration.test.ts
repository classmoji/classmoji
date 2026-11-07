/**
 * The OAuth 2.1 server's tables on a real Postgres:
 * packages/database/migrations/20261107180000_oauth2_provider_tables over the
 * legacy (better-auth 1.4 `mcp` plugin) rows it copies.
 *
 * Needs a throwaway database: set OAUTH_IT_DATABASE_URL to a Postgres URL on
 * localhost whose database name ends in `_it`. The test empties its `public`
 * schema. Skipped when the variable is unset, so the ordinary test run needs
 * no database.
 *
 *   OAUTH_IT_DATABASE_URL=postgresql://…@localhost:5433/classmoji_b2_it npm test
 *
 * Setup, in order:
 *   1. every migration before this one, then the legacy fixture below;
 *   2. this migration with a failing statement added before its COMMIT: the
 *      deploy must fail and leave none of its tables behind;
 *   3. `prisma migrate resolve --rolled-back` (the runbook step), then the
 *      real migration through `prisma migrate deploy`.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.OAUTH_IT_DATABASE_URL;
const MIGRATION = '20261107180000_oauth2_provider_tables';
const DATABASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../database');
const PRISMA_CLI = createRequire(import.meta.url).resolve('prisma/build/index.js');

/** SHA-256, base64url without padding: oauth-provider's `defaultHasher`
 * (@better-auth/oauth-provider 1.7.18 dist/utils-*.mjs, `defaultHasher`), used
 * for stored client secrets and refresh tokens. */
const hashed = (value: string) => createHash('sha256').update(value, 'utf8').digest('base64url');

const SERVER_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'read', 'write'];

const LEGACY_FIXTURE = [
  `INSERT INTO "users" ("id", "email", "name") VALUES
    ('u-1', 'u1@example.org', 'User One'),
    ('u-2', 'u2@example.org', 'User Two'),
    ('u-3', 'u3@example.org', 'User Three')`,
  `INSERT INTO "oauth_applications" ("id", "name", "icon", "metadata", "client_id", "client_secret", "redirect_urls", "type", "disabled", "user_id", "created_at", "updated_at") VALUES
    ('app-pub', 'Claude Code', NULL, NULL, 'pubclient', '', 'http://localhost:33418/callback,http://127.0.0.1:33418/callback', 'public', false, NULL, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
    ('app-web', 'claude.ai', 'https://claude.ai/icon.png', '{"x":1}', 'webclient', 'websecret-plaintext-abc', 'https://claude.ai/api/mcp/auth_callback', 'web', NULL, 'u-2', '2026-08-02T00:00:00Z', '2026-08-02T00:00:00Z'),
    ('app-web-nosecret', 'No secret', NULL, 'not json', 'webnosecret', '', 'https://example.org/cb', 'web', false, NULL, '2026-08-03T00:00:00Z', '2026-08-03T00:00:00Z'),
    ('app-cursor', 'Cursor', NULL, NULL, 'cursorclient', '', 'cursor://anysphere.cursor-retrieval/oauth/callback', 'public', false, NULL, '2026-08-04T00:00:00Z', '2026-08-04T00:00:00Z'),
    ('app-off', 'Turned off', NULL, NULL, 'offclient', 'offsecret', 'https://off.example.org/cb', 'web', true, NULL, '2026-08-05T00:00:00Z', '2026-08-05T00:00:00Z'),
    ('app-askmoji', 'Ask Moji', NULL, NULL, 'classmoji-ask-moji', '', '', 'confidential', false, NULL, '2026-08-06T00:00:00Z', '2026-08-06T00:00:00Z')`,
  `INSERT INTO "oauth_consents" ("id", "client_id", "user_id", "scopes", "consent_given", "created_at", "updated_at") VALUES
    ('consent-old', 'pubclient', 'u-1', 'openid read', true, '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z'),
    ('consent-new', 'pubclient', 'u-1', 'openid read write offline_access', true, '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z'),
    ('consent-denied', 'cursorclient', 'u-1', 'read', false, '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z'),
    ('consent-off', 'offclient', 'u-3', 'read', true, '2026-09-12T00:00:00Z', '2026-09-12T00:00:00Z'),
    ('consent-askmoji', 'classmoji-ask-moji', 'u-3', 'read', true, '2026-09-13T00:00:00Z', '2026-09-13T00:00:00Z')`,
  `INSERT INTO "oauth_access_tokens" ("id", "access_token", "refresh_token", "access_token_expires_at", "refresh_token_expires_at", "client_id", "user_id", "scopes", "created_at", "updated_at") VALUES
    ('tok-pub-live', 'acc-pub-live', 'ref-pub-live', now() - interval '2 hours', now() + interval '5 days', 'pubclient', 'u-1', 'openid read write offline_access', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'),
    ('tok-pub-live2', 'acc-pub-live2', 'ref-pub-live2', now() + interval '20 minutes', now() + interval '6 days', 'pubclient', 'u-1', 'read write', '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z'),
    ('tok-pub-dead', 'acc-pub-dead', 'ref-pub-dead', now() - interval '9 days', now() - interval '1 day', 'pubclient', 'u-1', 'read write', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
    ('tok-web-live', 'acc-web-live', 'ref-web-live', now() - interval '1 hour', now() + interval '3 days', 'webclient', 'u-2', 'read write', '2026-11-03T00:00:00Z', '2026-11-03T00:00:00Z'),
    ('tok-web-nouser', 'acc-web-nouser', 'ref-web-nouser', now() - interval '1 hour', now() + interval '3 days', 'webclient', NULL, 'read', '2026-11-03T00:00:00Z', '2026-11-03T00:00:00Z'),
    ('tok-cursor-live', 'acc-cursor-live', 'ref-cursor-live', now() - interval '1 hour', now() + interval '2 days', 'cursorclient', 'u-1', 'read', '2026-11-04T00:00:00Z', '2026-11-04T00:00:00Z'),
    ('tok-askmoji', 'askmoji_aaa', 'askmoji-norefresh_aaa', now() + interval '30 minutes', now() - interval '1 second', 'classmoji-ask-moji', 'u-3', 'read', '2026-11-05T00:00:00Z', '2026-11-05T00:00:00Z'),
    ('tok-askmoji-live', 'askmoji_bbb', 'askmoji-live-refresh', now() + interval '30 minutes', now() + interval '5 days', 'classmoji-ask-moji', 'u-3', 'read', '2026-11-05T00:00:00Z', '2026-11-05T00:00:00Z')`,
];

/** A throwaway database only: localhost, and a name ending in `_it`. */
function assertThrowawayDatabase(url: string): void {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '');
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !name.endsWith('_it')) {
    throw new Error(
      `OAUTH_IT_DATABASE_URL must name a local database ending in _it (got ${parsed.hostname}/${name})`
    );
  }
}

/** A copy of packages/database (schema + migrations) to deploy from. */
function migrationsCopy(dir: string, { through }: { through: 'before' | 'all' }): string {
  const target = join(dir, through);
  cpSync(join(DATABASE_DIR, 'schema.prisma'), join(target, 'schema.prisma'));
  cpSync(
    join(DATABASE_DIR, 'migrations', 'migration_lock.toml'),
    join(target, 'migrations', 'migration_lock.toml')
  );
  for (const entry of readdirSync(join(DATABASE_DIR, 'migrations'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (through === 'before' && entry.name >= MIGRATION) continue;
    cpSync(join(DATABASE_DIR, 'migrations', entry.name), join(target, 'migrations', entry.name), {
      recursive: true,
    });
  }
  return join(target, 'schema.prisma');
}

/** Runs the Prisma CLI against the test database; returns its output, or throws with it. */
function prisma(args: string[]): string {
  try {
    return execFileSync(process.execPath, [PRISMA_CLI, ...args], {
      env: { ...process.env, DATABASE_URL },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(`${e.message}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`);
  }
}

describe.skipIf(!DATABASE_URL)('the oauth2 migration (real Postgres)', () => {
  let db: PrismaClient;
  let work: string;
  let failedDeploy: string;
  let afterFailedDeploy: { tables: number; legacyApplications: number; recorded: unknown[] };

  beforeAll(async () => {
    assertThrowawayDatabase(DATABASE_URL!);
    db = new PrismaClient({ datasourceUrl: DATABASE_URL });
    await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await db.$executeRawUnsafe('CREATE SCHEMA public');

    work = mkdtempSync(join(tmpdir(), 'oauth2-it-'));
    prisma(['migrate', 'deploy', '--schema', migrationsCopy(work, { through: 'before' })]);
    for (const statement of LEGACY_FIXTURE) await db.$executeRawUnsafe(statement);

    // A failing statement just before COMMIT: nothing may be left behind.
    const failing = migrationsCopy(join(work, 'failing'), { through: 'all' });
    const failingFile = join(dirname(failing), 'migrations', MIGRATION, 'migration.sql');
    const sql = readFileSync(failingFile, 'utf8');
    expect(sql).toMatch(/\nCOMMIT;\n/);
    writeFileSync(failingFile, sql.replace(/\nCOMMIT;\n/, '\nSELECT 1/0;\nCOMMIT;\n'));
    try {
      prisma(['migrate', 'deploy', '--schema', failing]);
      failedDeploy = 'succeeded';
    } catch (error) {
      failedDeploy = (error as Error).message;
    }
    const [{ count: tables }] = await db.$queryRawUnsafe<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM information_schema.tables
       WHERE table_schema = 'public'
         AND (table_name LIKE 'oauth2\\_%' OR table_name IN ('jwks', 'mcp_internal_tokens'))`
    );
    const [{ count: legacyApplications }] = await db.$queryRawUnsafe<{ count: number }[]>(
      'SELECT count(*)::int AS count FROM "oauth_applications"'
    );
    const recorded = await db.$queryRawUnsafe<unknown[]>(
      `SELECT finished_at IS NULL AS unfinished, rolled_back_at IS NULL AS not_rolled_back
       FROM "_prisma_migrations" WHERE migration_name = '${MIGRATION}'`
    );
    afterFailedDeploy = { tables, legacyApplications, recorded };

    // The runbook: mark the failed attempt rolled back, then deploy again.
    const real = migrationsCopy(join(work, 'real'), { through: 'all' });
    prisma(['migrate', 'resolve', '--rolled-back', MIGRATION, '--schema', real]);
    prisma(['migrate', 'deploy', '--schema', real]);
  }, 300_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('fails as a whole: a failing last statement leaves none of its tables', () => {
    expect(failedDeploy).not.toBe('succeeded');
    expect(afterFailedDeploy.tables).toBe(0);
    expect(afterFailedDeploy.legacyApplications).toBe(6);
    // Recorded as failed, so the next deploy stops until it is resolved.
    expect(afterFailedDeploy.recorded).toEqual([{ unfinished: true, not_rolled_back: true }]);
  });

  it('leaves the legacy tables as they were', async () => {
    expect(await db.legacyOauthApplication.count()).toBe(6);
    expect(await db.legacyOauthConsent.count()).toBe(5);
    expect(await db.legacyOauthAccessToken.count()).toBe(8);
    expect(
      (await db.legacyOauthApplication.findUnique({ where: { clientId: 'webclient' } }))
        ?.clientSecret
    ).toBe('websecret-plaintext-abc');
  });

  it('copies every client except the Classmoji-owned ids, and reserves those disabled', async () => {
    const clients = await db.oauthClient.findMany({ orderBy: { clientId: 'asc' } });
    expect(clients.map(c => c.clientId)).toEqual([
      'classmoji-ask-moji',
      'classmoji-dev-mint',
      'cursorclient',
      'offclient',
      'pubclient',
      'webclient',
      'webnosecret',
    ]);
    for (const id of ['classmoji-ask-moji', 'classmoji-dev-mint']) {
      const reserved = clients.find(c => c.clientId === id)!;
      expect(reserved).toMatchObject({
        disabled: true,
        clientSecret: null,
        redirectUris: [],
        grantTypes: [],
        responseTypes: [],
        tokenEndpointAuthMethod: 'client_secret_basic',
      });
      // Not the legacy row's id: the reserved row is new.
      expect(reserved.id).not.toBe('app-askmoji');
    }
  });

  it('maps a public client to `none` with no secret, and keeps its redirect URIs', async () => {
    const pub = await db.oauthClient.findUnique({ where: { clientId: 'pubclient' } });
    expect(pub).toMatchObject({
      id: 'app-pub',
      name: 'Claude Code',
      clientSecret: null,
      tokenEndpointAuthMethod: 'none',
      applicationType: 'native',
      disabled: false,
      redirectUris: ['http://localhost:33418/callback', 'http://127.0.0.1:33418/callback'],
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      scopes: SERVER_SCOPES,
      backchannelLogoutUri: null,
      backchannelLogoutSessionRequired: null,
    });
    const cursor = await db.oauthClient.findUnique({ where: { clientId: 'cursorclient' } });
    expect(cursor).toMatchObject({ applicationType: 'native', tokenEndpointAuthMethod: 'none' });
  });

  it('maps any other client to client_secret_basic with its secret hashed', async () => {
    const web = await db.oauthClient.findUnique({ where: { clientId: 'webclient' } });
    expect(web).toMatchObject({
      id: 'app-web',
      tokenEndpointAuthMethod: 'client_secret_basic',
      applicationType: 'web',
      clientSecret: hashed('websecret-plaintext-abc'),
      icon: 'https://claude.ai/icon.png',
      userId: 'u-2',
      disabled: false,
      metadata: null,
    });
    // An empty legacy secret becomes no secret, not the hash of ''.
    const noSecret = await db.oauthClient.findUnique({ where: { clientId: 'webnosecret' } });
    expect(noSecret).toMatchObject({
      clientSecret: null,
      tokenEndpointAuthMethod: 'client_secret_basic',
    });
    // The disabled flag is kept.
    const off = await db.oauthClient.findUnique({ where: { clientId: 'offclient' } });
    expect(off).toMatchObject({ disabled: true, clientSecret: hashed('offsecret') });
  });

  it('writes one consent per (client, user) with a given consent or a live refresh token', async () => {
    const consents = await db.oauthConsent.findMany({ orderBy: { clientId: 'asc' } });
    expect(consents.map(c => [c.clientId, c.userId, [...c.scopes].sort(), c.resources])).toEqual([
      // A denied consent, but a live refresh token: the grant is live.
      ['cursorclient', 'u-1', ['read'], []],
      ['offclient', 'u-3', ['read'], []],
      // Two given consents and two live refresh tokens: one row, all scopes.
      ['pubclient', 'u-1', ['offline_access', 'openid', 'read', 'write'], []],
      // No consent row, but a live refresh token: synthesized.
      ['webclient', 'u-2', ['read', 'write'], []],
    ]);
    // The newest consent row's id is kept.
    expect(consents.find(c => c.clientId === 'pubclient')!.id).toBe('consent-new');
    // Created at migration time, so no JWT can predate it.
    for (const consent of consents) {
      expect(Date.now() - consent.createdAt.getTime()).toBeLessThan(10 * 60 * 1000);
    }
  });

  it('copies live refresh tokens of a user on a copied client, hashed, with offline_access', async () => {
    const tokens = await db.oauthRefreshToken.findMany({ orderBy: { id: 'asc' } });
    expect(tokens.map(t => [t.id, t.clientId, t.userId, [...t.scopes].sort()])).toEqual([
      ['tok-cursor-live', 'cursorclient', 'u-1', ['offline_access', 'read']],
      ['tok-pub-live', 'pubclient', 'u-1', ['offline_access', 'openid', 'read', 'write']],
      ['tok-pub-live2', 'pubclient', 'u-1', ['offline_access', 'read', 'write']],
      ['tok-web-live', 'webclient', 'u-2', ['offline_access', 'read', 'write']],
    ]);
    const pub = tokens.find(t => t.id === 'tok-pub-live')!;
    expect(pub.token).toBe(hashed('ref-pub-live'));
    expect(pub).toMatchObject({ sessionId: null, revoked: null, resources: [] });
    const legacy = await db.legacyOauthAccessToken.findUnique({ where: { id: 'tok-pub-live' } });
    expect(pub.expiresAt.getTime()).toBe(legacy!.refreshTokenExpiresAt.getTime());
    expect(pub.createdAt.getTime()).toBe(legacy!.createdAt.getTime());
    // No access tokens are copied.
    expect(await db.oauthAccessToken.count()).toBe(0);
  });

  it('copies nothing of the Classmoji-owned clients: no consent, no refresh token', async () => {
    expect(await db.oauthConsent.count({ where: { clientId: 'classmoji-ask-moji' } })).toBe(0);
    expect(await db.oauthRefreshToken.count({ where: { clientId: 'classmoji-ask-moji' } })).toBe(0);
  });

  it('creates the signing-key and internal-token tables empty', async () => {
    expect(await db.jwks.count()).toBe(0);
    expect(await db.mcpInternalToken.count()).toBe(0);
  });

  it('leaves the database exactly as schema.prisma describes it', () => {
    const drift = prisma([
      'migrate',
      'diff',
      '--from-url',
      DATABASE_URL!,
      '--to-schema-datamodel',
      join(DATABASE_DIR, 'schema.prisma'),
      '--script',
    ]);
    const statements = drift.split('\n').filter(line => line.trim() && !line.startsWith('--'));
    // `_page_slug_repairs` is an older migration's work table that
    // schema.prisma never described; nothing else may differ.
    expect(statements).toEqual(['DROP TABLE "_page_slug_repairs";']);
  });
});
