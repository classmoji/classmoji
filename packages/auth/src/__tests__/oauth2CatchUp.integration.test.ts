/**
 * The CX-2 catch-up (packages/database/scripts/catchUpOauth2Grants.ts) on a
 * real Postgres, run the way an operator runs it: a child process with only
 * PATH and DATABASE_URL in its environment.
 *
 * Two throwaway databases:
 *   - the CATCH-UP database: the legacy rows that existed before the
 *     20261107180000_oauth2_provider_tables migration, the migration, some
 *     1.7 activity, then legacy rows written AFTER it (a 1.4 machine still
 *     serving during the deploy), then the script;
 *   - the REFERENCE database (`<name>_ref_it`, created when missing): the same
 *     legacy rows, every one of them written BEFORE the migration.
 * Every row the script adds must equal the row the migration made of the same
 * legacy row on the reference database, except where Tim's rules differ on
 * purpose (a pair that already has a consent keeps it).
 *
 * Then the REAL `auth` (../server.ts) on the catch-up database refreshes the
 * caught-up tokens to JWTs, and a JWT issued before the catch-up still passes
 * the MCP's consent check (apps/mcp/src/auth/jwtAccessToken.ts).
 *
 *   OAUTH_CATCHUP_IT_DATABASE_URL=postgresql://…@localhost:5433/classmoji_b2_cx2_it npm test -- oauth2CatchUp
 *
 * Both databases must be on localhost with names ending in `_it`; the test
 * empties their `public` schemas. Skipped when the variable is unset.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

const CX_URL = process.env.OAUTH_CATCHUP_IT_DATABASE_URL;
// The auth instance (imported once the migration has run) uses this database.
if (CX_URL) process.env.DATABASE_URL = CX_URL;
process.env.WEBAPP_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-chars!!';
process.env.GITHUB_CLIENT_ID = 'it-github-client';
process.env.GITHUB_CLIENT_SECRET = 'it-github-secret';
process.env.GITLAB_CLIENT_ID = 'it-gitlab-client';
process.env.GITLAB_CLIENT_SECRET = 'it-gitlab-secret';

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: { findById: vi.fn(), findByLogin: vi.fn() },
    classroom: { findBySlug: vi.fn(), getClassroomForUI: (c: unknown) => c },
    classroomMembership: { findByClassroomAndUser: vi.fn() },
    githubUserToken: { getGitHubTokenForUser: vi.fn(async () => null) },
    subscription: { getProStateForClassroomId: vi.fn() },
    authEmail: { sendAuthOtp: vi.fn(async () => {}) },
    gitlabInstance: {
      oauthClient: vi.fn(),
      probe: vi.fn(),
      findByHost: vi.fn(async () => null),
      encryptSecret: vi.fn(),
      decryptSecret: vi.fn(),
      create: vi.fn(),
      notifyAdminsOfRequest: vi.fn(),
      gitlabFetch: vi.fn(),
    },
  },
}));

const MIGRATION = '20261107180000_oauth2_provider_tables';
const DATABASE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../database');
const SCRIPT = join(DATABASE_DIR, 'scripts', 'catchUpOauth2Grants.ts');
const PRISMA_CLI = createRequire(import.meta.url).resolve('prisma/build/index.js');
const REF_URL = CX_URL
  ? (() => {
      const url = new URL(CX_URL);
      url.pathname = url.pathname.replace(/_it$/, '_ref_it');
      return url.toString();
    })()
  : undefined;

/** oauth-provider's `defaultHasher`: SHA-256, base64url without padding. */
const hashed = (value: string) => createHash('sha256').update(value, 'utf8').digest('base64url');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY = 86_400_000;
const lit = (d: Date) => `'${d.toISOString()}'`;

/** A throwaway database only: localhost, a name ending in `_it`, not another suite's. */
function assertThrowawayDatabase(url: string): string {
  const parsed = new URL(url);
  const name = parsed.pathname.replace(/^\//, '');
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || !name.endsWith('_it')) {
    throw new Error(`expected a local database ending in _it (got ${parsed.hostname}/${name})`);
  }
  if (url === process.env.OAUTH_IT_DATABASE_URL) {
    throw new Error('use a database of its own, not the oauth2.integration one');
  }
  return name;
}

function prisma(args: string[], url: string): string {
  try {
    return execFileSync(process.execPath, [PRISMA_CLI, ...args], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(`${e.message}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`);
  }
}

/** A copy of packages/database with every migration before this one. */
function migrationsBefore(dir: string): string {
  cpSync(join(DATABASE_DIR, 'schema.prisma'), join(dir, 'schema.prisma'));
  cpSync(
    join(DATABASE_DIR, 'migrations', 'migration_lock.toml'),
    join(dir, 'migrations', 'migration_lock.toml')
  );
  for (const entry of readdirSync(join(DATABASE_DIR, 'migrations'), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name >= MIGRATION) continue;
    cpSync(join(DATABASE_DIR, 'migrations', entry.name), join(dir, 'migrations', entry.name), {
      recursive: true,
    });
  }
  return join(dir, 'schema.prisma');
}

type CatchUp = {
  status: number | null;
  stdout: string;
  stderr: string;
  result?: {
    mode: string;
    runStartedAt: string;
    since: string;
    sinceFrom: string;
    window: Record<string, number>;
    clientsAlreadyCopied: number;
    produced: Record<string, number>;
    insert: Record<string, number>;
  };
};

/** Runs the script as an operator would: only PATH and DATABASE_URL. */
function catchUp(args: string[], env: Record<string, string> = { DATABASE_URL: CX_URL! }): CatchUp {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { PATH: process.env.PATH!, ...env },
    encoding: 'utf8',
  });
  const line = run.stdout.split('\n').find(l => l.startsWith('RESULT '));
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    result: line ? JSON.parse(line.slice('RESULT '.length)) : undefined,
  };
}

/** Every base table in `public`, each as its rows' JSON, sorted. */
async function snapshot(db: PrismaClient): Promise<Record<string, string[]>> {
  const tables = await db.$queryRawUnsafe<{ name: string }[]>(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`
  );
  const out: Record<string, string[]> = {};
  for (const { name } of tables) {
    const [{ rows }] = await db.$queryRawUnsafe<{ rows: string[] }[]>(
      `SELECT coalesce(array_agg(to_jsonb(t)::text ORDER BY to_jsonb(t)::text), '{}') AS rows
       FROM "${name}" t`
    );
    out[name] = rows;
  }
  return out;
}

const added = (before: string[], after: string[]) => after.filter(row => !before.includes(row));
const json = (rows: string[]) => rows.map(row => JSON.parse(row) as Record<string, any>);

/** The rows of one table as JSON objects (to_jsonb), ordered. */
async function tableRows(db: PrismaClient, table: string, where = 'true') {
  const rows = await db.$queryRawUnsafe<{ row: Record<string, any> }[]>(
    `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE ${where} ORDER BY to_jsonb(t)::text`
  );
  return rows.map(r => r.row);
}

const without = (row: Record<string, any>, ...keys: string[]) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));

/**
 * The legacy rows. `pre` exist before the migration on both databases;
 * `window` are written after it on the catch-up database (as a 1.4 machine
 * would during the deploy) and before it on the reference database. All
 * timestamps are absolute, so both databases get the same values: expiries
 * from `base`, the window's creation times from `t`, which is after the
 * catch-up database's migration started.
 */
function legacyRows(base: Date, t: Date) {
  const from = (ms: number) => lit(new Date(base.getTime() + ms));
  const at = (ms: number) => lit(new Date(t.getTime() + ms));
  const live = from(5 * DAY);
  const accessGone = from(-DAY);
  const accessLive = from(3_600_000);
  const pre = [
    `INSERT INTO "users" ("id", "email", "name") VALUES
      ('u-1', 'u1@example.org', 'User One'),
      ('u-2', 'u2@example.org', 'User Two'),
      ('u-3', 'u3@example.org', 'User Three'),
      ('u-4', 'u4@example.org', 'User Four'),
      ('u-del', 'udel@example.org', 'User Deleted')`,
    `INSERT INTO "oauth_applications" ("id", "name", "icon", "metadata", "client_id", "client_secret", "redirect_urls", "type", "disabled", "user_id", "created_at", "updated_at") VALUES
      ('app-pub', 'Claude Code', NULL, NULL, 'pubclient', '', 'http://localhost:33418/callback,http://127.0.0.1:33418/callback', 'public', false, NULL, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'),
      ('app-web', 'claude.ai', 'https://claude.ai/icon.png', '{"x":1}', 'webclient', 'websecret-plaintext-abc', 'https://claude.ai/api/mcp/auth_callback', 'web', NULL, 'u-2', '2026-08-02T00:00:00Z', '2026-08-02T00:00:00Z'),
      ('app-askmoji', 'Ask Moji', NULL, NULL, 'classmoji-ask-moji', '', '', 'confidential', false, NULL, '2026-08-06T00:00:00Z', '2026-08-06T00:00:00Z')`,
    `INSERT INTO "oauth_consents" ("id", "client_id", "user_id", "scopes", "consent_given", "created_at", "updated_at") VALUES
      ('consent-pub-u1', 'pubclient', 'u-1', 'openid read write offline_access', true, '2026-09-10T00:00:00Z', '2026-09-10T00:00:00Z'),
      ('consent-pub-u2-denied', 'pubclient', 'u-2', 'read', false, '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z'),
      ('consent-web-u2', 'webclient', 'u-2', 'read write', true, '2026-09-12T00:00:00Z', '2026-09-12T00:00:00Z')`,
    `INSERT INTO "oauth_access_tokens" ("id", "access_token", "refresh_token", "access_token_expires_at", "refresh_token_expires_at", "client_id", "user_id", "scopes", "created_at", "updated_at") VALUES
      ('tok-pub-u1', 'acc-pub-u1', 'ref-pub-u1', ${accessGone}, ${live}, 'pubclient', 'u-1', 'openid read write offline_access', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'),
      ('tok-web-u2', 'acc-web-u2', 'ref-web-u2', ${accessGone}, ${live}, 'webclient', 'u-2', 'read write', '2026-11-02T00:00:00Z', '2026-11-02T00:00:00Z'),
      ('tok-askmoji', 'askmoji_aaa', 'askmoji-norefresh_aaa', ${from(30 * 60_000)}, ${from(-1000)}, 'classmoji-ask-moji', 'u-3', 'read', '2026-11-05T00:00:00Z', '2026-11-05T00:00:00Z')`,
  ];
  const window = [
    // A public client and a confidential one, registered on a 1.4 machine;
    // apps/mcp's dev mint creating its reserved application.
    `INSERT INTO "oauth_applications" ("id", "name", "icon", "metadata", "client_id", "client_secret", "redirect_urls", "type", "disabled", "user_id", "created_at", "updated_at") VALUES
      ('app-w-pub', 'Cursor', NULL, NULL, 'wpubclient', '', 'http://127.0.0.1:44100/callback,cursor://anysphere.cursor-retrieval/oauth/callback', 'public', false, NULL, ${at(1)}, ${at(1)}),
      ('app-w-web', 'Web app', 'https://w.example.org/i.png', 'not json', 'wwebclient', 'wwebsecret-plain-xyz', 'https://w.example.org/cb,https://w.example.org/cb2', 'web', false, 'u-3', ${at(2)}, ${at(2)}),
      ('app-w-devmint', 'Classmoji dev mint', NULL, NULL, 'classmoji-dev-mint', '', '', 'confidential', false, NULL, ${at(3)}, ${at(3)})`,
    `INSERT INTO "oauth_consents" ("id", "client_id", "user_id", "scopes", "consent_given", "created_at", "updated_at") VALUES
      ('w-consent-pub-u1', 'pubclient', 'u-1', 'openid profile read write', true, ${at(10)}, ${at(10)}),
      ('w-consent-web-u1', 'webclient', 'u-1', 'read', true, ${at(11)}, ${at(11)}),
      ('w-consent-wpub-u1-a', 'wpubclient', 'u-1', 'read', true, ${at(12)}, ${at(12)}),
      ('w-consent-wpub-u1-b', 'wpubclient', 'u-1', 'read write offline_access', true, ${at(13)}, ${at(13)}),
      ('w-consent-wweb-u2-denied', 'wwebclient', 'u-2', 'read', false, ${at(14)}, ${at(14)}),
      ('w-consent-askmoji', 'classmoji-ask-moji', 'u-3', 'read', true, ${at(15)}, ${at(15)}),
      ('w-consent-pub-u4', 'pubclient', 'u-4', 'read write', true, ${at(16)}, ${at(16)})`,
    `INSERT INTO "oauth_access_tokens" ("id", "access_token", "refresh_token", "access_token_expires_at", "refresh_token_expires_at", "client_id", "user_id", "scopes", "created_at", "updated_at") VALUES
      ('w-tok-pub-u1-rot', 'acc-w1', 'ref-w-pub-u1-rot', ${accessLive}, ${live}, 'pubclient', 'u-1', 'openid read write offline_access', ${at(20)}, ${at(20)}),
      ('w-tok-pub-u2', 'acc-w2', 'ref-w-pub-u2', ${accessLive}, ${live}, 'pubclient', 'u-2', 'read', ${at(21)}, ${at(21)}),
      ('w-tok-wweb-u3', 'acc-w3', 'ref-w-wweb-u3', ${accessLive}, ${live}, 'wwebclient', 'u-3', 'read write', ${at(22)}, ${at(22)}),
      ('w-tok-wpub-u1', 'acc-w4', 'ref-w-wpub-u1', ${accessLive}, ${live}, 'wpubclient', 'u-1', 'read write', ${at(23)}, ${at(23)}),
      ('w-tok-expired', 'acc-w5', 'ref-w-expired', ${accessGone}, ${accessGone}, 'pubclient', 'u-2', 'read', ${at(24)}, ${at(24)}),
      ('w-tok-nouser', 'acc-w6', 'ref-w-nouser', ${accessLive}, ${live}, 'wwebclient', NULL, 'read', ${at(25)}, ${at(25)}),
      ('w-tok-askmoji', 'askmoji_w', 'askmoji-live-w', ${accessLive}, ${live}, 'classmoji-ask-moji', 'u-3', 'read', ${at(26)}, ${at(26)}),
      ('w-tok-devmint', 'acc-w8', 'ref-w-devmint', ${accessLive}, ${live}, 'classmoji-dev-mint', 'u-3', 'read', ${at(27)}, ${at(27)}),
      ('w-tok-del', 'acc-w9', 'ref-w-del', ${accessLive}, ${live}, 'pubclient', 'u-del', 'read', ${at(28)}, ${at(28)}),
      ('w-tok-pub-u4', 'acc-w10', 'ref-w-pub-u4', ${accessLive}, ${live}, 'pubclient', 'u-4', 'read write', ${at(29)}, ${at(29)})`,
    // A refresh token whose user is then deleted: the legacy foreign key
    // takes the token with it.
    `DELETE FROM "users" WHERE "id" = 'u-del'`,
  ];
  return { pre, window };
}

describe.skipIf(!CX_URL)('the CX-2 catch-up (real Postgres)', () => {
  type Auth = typeof import('../server.ts');
  let server: Auth;
  let cx: PrismaClient;
  let ref: PrismaClient;
  let work: string;
  let watermark: Date;
  let jwtBefore: string;
  let beforeWrite: Record<string, string[]>;
  let afterWrite: Record<string, string[]>;
  let firstWrite: CatchUp;
  let writeStartedAt: number;
  const BASE = 'http://localhost:3000/api/auth';

  const claimsOf = (jwt: string) =>
    JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as Record<
      string,
      any
    >;
  const basic = (id: string, secret: string) =>
    `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

  async function token(body: Record<string, string>, headers: Record<string, string> = {}) {
    const res = await server.auth.handler(
      new Request(`${BASE}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(body).toString(),
      })
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  async function verifyJwt(jwt: string) {
    return server.verifyJwsAccessToken(jwt, {
      jwksFetch: async () => (await server.auth.handler(new Request(`${BASE}/jwks`))).json(),
      verifyOptions: { issuer: server.AUTH_ISSUER, audience: server.MCP_RESOURCE },
    });
  }

  /**
   * The MCP's consent check for a JWT (apps/mcp/src/auth/jwtAccessToken.ts):
   * the newest consent for (azp, sub) exists and was given no later than the
   * second the token was issued.
   */
  async function consentAccepts(jwt: string): Promise<boolean> {
    const { iat, azp, sub } = claimsOf(jwt);
    const consent = await cx.oauthConsent.findFirst({
      where: { clientId: azp, userId: sub },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return !!consent && iat >= Math.floor(consent.createdAt.getTime() / 1000);
  }

  beforeAll(async () => {
    const cxName = assertThrowawayDatabase(CX_URL!);
    const refName = assertThrowawayDatabase(REF_URL!);
    cx = new PrismaClient({ datasourceUrl: CX_URL });
    const exists = await cx.$queryRawUnsafe<unknown[]>(
      `SELECT 1 FROM pg_database WHERE datname = '${refName}'`
    );
    if (!exists.length) await cx.$executeRawUnsafe(`CREATE DATABASE "${refName}"`);
    expect(refName).not.toBe(cxName);
    ref = new PrismaClient({ datasourceUrl: REF_URL });
    for (const db of [cx, ref]) {
      await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
      await db.$executeRawUnsafe('CREATE SCHEMA public');
    }
    work = mkdtempSync(join(tmpdir(), 'oauth2-catchup-it-'));
    const before = migrationsBefore(join(work, 'before'));
    const all = join(DATABASE_DIR, 'schema.prisma');

    // The catch-up database: the pre-migration rows, then the migration.
    // The window's timestamps come after its start (the watermark).
    const base = new Date();
    prisma(['migrate', 'deploy', '--schema', before], CX_URL!);
    for (const statement of legacyRows(base, base).pre) await cx.$executeRawUnsafe(statement);
    prisma(['migrate', 'deploy', '--schema', all], CX_URL!);
    const [{ started_at }] = await cx.$queryRawUnsafe<{ started_at: Date }[]>(
      `SELECT started_at FROM _prisma_migrations WHERE migration_name = '${MIGRATION}'`
    );
    watermark = started_at;
    const rows = legacyRows(base, new Date(Math.max(Date.now(), started_at.getTime() + 1)));

    // The reference database: every legacy row before the migration.
    prisma(['migrate', 'deploy', '--schema', before], REF_URL!);
    for (const statement of [...rows.pre, ...rows.window]) await ref.$executeRawUnsafe(statement);
    prisma(['migrate', 'deploy', '--schema', all], REF_URL!);

    // 1.7 machines serve while 1.4 ones still do: a migrated token is
    // refreshed (a JWT exists for (pubclient, u-1)), and then that family
    // ends (refresh-token reuse: oauth-provider deletes the pair's refresh
    // tokens, invalidateRefreshFamily, and leaves the 1.4 rows); u-2 changes
    // their password, which ends their migrated (webclient, u-2) grant, the
    // 1.4 rows included; an app connection is approved for (webclient, u-1)
    // (a 1.7 consent, on a whole second).
    server = await import('../server.ts');
    await server.auth.handler(new Request(`${BASE}/ok`));
    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: 'ref-pub-u1',
      client_id: 'pubclient',
    });
    expect(refreshed.status).toBe(200);
    jwtBefore = refreshed.body.access_token;
    await cx.$executeRawUnsafe(
      `DELETE FROM "oauth2_refresh_tokens" WHERE "client_id" = 'pubclient' AND "user_id" = 'u-1'`
    );
    expect(await cx.oauthConsent.findUnique({ where: { id: 'consent-web-u2' } })).toBeTruthy();
    await server.revokeOAuthGrants('u-2', 'password_change');
    expect(await cx.oauthRefreshToken.count({ where: { userId: 'u-2' } })).toBe(0);
    expect(await cx.oauthConsent.count({ where: { userId: 'u-2' } })).toBe(0);
    expect(await cx.legacyOauthAccessToken.count({ where: { userId: 'u-2' } })).toBe(0);
    expect(await cx.legacyOauthConsent.count({ where: { userId: 'u-2' } })).toBe(0);
    await cx.$executeRawUnsafe(
      `INSERT INTO "oauth2_consents" ("id", "client_id", "user_id", "scopes", "created_at", "updated_at")
       VALUES ('consent-17-web-u1', 'webclient', 'u-1', ARRAY['read'], date_trunc('second', now()), date_trunc('second', now()))`
    );

    // A 1.4 machine during the deploy; then u-4, who connected on it, resets
    // their password on a 1.7 machine.
    for (const statement of rows.window) await cx.$executeRawUnsafe(statement);
    await server.revokeOAuthGrants('u-4', 'password_reset');
    expect(await cx.legacyOauthAccessToken.count({ where: { userId: 'u-4' } })).toBe(0);
    expect(await cx.legacyOauthConsent.count({ where: { userId: 'u-4' } })).toBe(0);
  }, 600_000);

  afterAll(async () => {
    await cx?.$disconnect();
    await ref?.$disconnect();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('needs DATABASE_URL in its environment and refuses unknown arguments', () => {
    const noUrl = catchUp([], {});
    expect(noUrl.status).toBe(2);
    expect(noUrl.stderr).toContain('DATABASE_URL must be set');
    const typo = catchUp(['--wirte']);
    expect(typo.status).toBe(2);
    expect(typo.stdout).not.toContain('connected');
  });

  it('refuses, writing nothing, when the migration file is not the one that ran', async () => {
    const before = await snapshot(cx);
    const [{ checksum }] = await cx.$queryRawUnsafe<{ checksum: string }[]>(
      `SELECT checksum FROM _prisma_migrations WHERE migration_name = '${MIGRATION}'`
    );
    await cx.$executeRawUnsafe(
      `UPDATE _prisma_migrations SET checksum = 'not-this-file' WHERE migration_name = '${MIGRATION}'`
    );
    try {
      for (const args of [[], ['--write']]) {
        const run = catchUp(args);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain('is not the file that ran on this database');
      }
    } finally {
      await cx.$executeRawUnsafe(
        `UPDATE _prisma_migrations SET checksum = '${checksum}' WHERE migration_name = '${MIGRATION}'`
      );
    }
    expect(await snapshot(cx)).toEqual(before);
  });

  it('refuses in both modes when a row to insert collides with one under another id', async () => {
    const before = await snapshot(cx);
    // A refresh token already stored with the hash of a window token.
    await cx.$executeRawUnsafe(
      `INSERT INTO "oauth2_refresh_tokens" ("id", "token", "client_id", "user_id", "expires_at", "scopes")
       VALUES ('conflict-refresh', '${hashed('ref-w-pub-u2')}', 'pubclient', 'u-2', now() + interval '1 day', ARRAY['read'])`
    );
    try {
      for (const args of [[], ['--write']]) {
        const run = catchUp(args);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain(
          'refresh tokens whose hash is already stored under another id'
        );
        expect(run.stderr).toContain('w-tok-pub-u2');
      }
    } finally {
      await cx.$executeRawUnsafe(
        `DELETE FROM "oauth2_refresh_tokens" WHERE "id" = 'conflict-refresh'`
      );
    }
    // A window client's client id already held by another client row.
    await cx.$executeRawUnsafe(
      `INSERT INTO "oauth2_clients" ("id", "client_id", "redirect_uris") VALUES ('conflict-client', 'wpubclient', ARRAY[]::text[])`
    );
    try {
      for (const args of [[], ['--write']]) {
        const run = catchUp(args);
        expect(run.status).toBe(1);
        expect(run.stderr).toContain("the migration's statement for oauth2_clients failed");
        expect(run.stderr).toContain('wpubclient');
      }
    } finally {
      await cx.$executeRawUnsafe(`DELETE FROM "oauth2_clients" WHERE "id" = 'conflict-client'`);
    }
    expect(await snapshot(cx)).toEqual(before);
  });

  it('dry run: prints what it would insert and changes nothing', async () => {
    const before = await snapshot(cx);
    const run = catchUp([]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('OAuth 1.4 → 1.7 catch-up (CX-2) on localhost:5433/');
    expect(run.stdout).toContain('mode: dry run');
    expect(run.stdout).toContain('dry run: transaction_read_only = on');
    expect(run.stdout).toContain('nothing was written');
    expect(run.result).toEqual({
      mode: 'dry-run',
      database: new URL(CX_URL!).pathname.slice(1),
      migrationStartedAt: watermark.toISOString(),
      runStartedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      since: watermark.toISOString(),
      sinceFrom: 'migration',
      // The deleted user's token went with the user (legacy foreign key).
      window: { oauth_applications: 3, oauth_consents: 6, oauth_access_tokens: 8 },
      clientsAlreadyCopied: 0,
      // Clients: the dev mint is reserved. Consents: 5 pairs on non-reserved
      // clients; 2 already have one. Tokens: the expired, user-less and
      // reserved ones are not copied.
      produced: { oauth2_clients: 2, oauth2_consents: 5, oauth2_refresh_tokens: 4 },
      insert: { oauth2_clients: 2, oauth2_consents: 3, oauth2_refresh_tokens: 4 },
    });
    expect(await snapshot(cx)).toEqual(before);
  });

  it('write: inserts exactly what the dry run said, and changes no existing row', async () => {
    beforeWrite = await snapshot(cx);
    writeStartedAt = Date.now();
    firstWrite = catchUp(['--write']);
    expect(firstWrite.status, firstWrite.stderr).toBe(0);
    expect(firstWrite.stdout).toContain('mode: WRITE');
    expect(firstWrite.stdout).toContain('committed.');
    expect(firstWrite.result?.insert).toEqual({
      oauth2_clients: 2,
      oauth2_consents: 3,
      oauth2_refresh_tokens: 4,
    });
    afterWrite = await snapshot(cx);

    // No update and no delete: every row that was there is there unchanged.
    for (const [table, rows] of Object.entries(beforeWrite)) {
      expect(added(afterWrite[table]!, rows), table).toEqual([]);
    }
    // Only the three tables gain rows; the legacy tables are only read.
    const gained = Object.fromEntries(
      Object.keys(afterWrite)
        .map(table => [table, added(beforeWrite[table] ?? [], afterWrite[table]!).length])
        .filter(([, n]) => n)
    );
    expect(gained).toEqual({ oauth2_clients: 2, oauth2_consents: 3, oauth2_refresh_tokens: 4 });

    const clients = json(added(beforeWrite.oauth2_clients!, afterWrite.oauth2_clients!));
    expect(clients.map(c => [c.id, c.client_id]).sort()).toEqual([
      ['app-w-pub', 'wpubclient'],
      ['app-w-web', 'wwebclient'],
    ]);
    const tokens = json(
      added(beforeWrite.oauth2_refresh_tokens!, afterWrite.oauth2_refresh_tokens!)
    );
    expect(tokens.map(r => r.id).sort()).toEqual([
      'w-tok-pub-u1-rot',
      'w-tok-pub-u2',
      'w-tok-wpub-u1',
      'w-tok-wweb-u3',
    ]);
    const consents = json(added(beforeWrite.oauth2_consents!, afterWrite.oauth2_consents!));
    expect(consents.map(c => `${c.client_id}/${c.user_id}`).sort()).toEqual([
      'pubclient/u-2',
      'wpubclient/u-1',
      'wwebclient/u-3',
    ]);
    for (const consent of consents) {
      const created = Date.parse(`${consent.created_at}Z`);
      expect(created).toBeGreaterThanOrEqual(writeStartedAt - 1000);
      expect(created).toBeLessThanOrEqual(Date.now());
    }
  });

  it('copies each client and refresh token exactly as the migration copied the same legacy row', async () => {
    for (const [table, ids] of [
      ['oauth2_clients', ['app-w-pub', 'app-w-web']],
      [
        'oauth2_refresh_tokens',
        ['w-tok-pub-u1-rot', 'w-tok-pub-u2', 'w-tok-wpub-u1', 'w-tok-wweb-u3'],
      ],
    ] as const) {
      const where = `"id" IN (${ids.map(id => `'${id}'`).join(', ')})`;
      const ours = json(added(beforeWrite[table]!, afterWrite[table]!));
      const reference = await tableRows(ref, table, where);
      expect(reference).toHaveLength(ids.length);
      // Every column, byte for byte: hash, auth method, application type,
      // split redirect URIs, scopes written out, NULL lists, timestamps.
      expect(ours.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
        reference.sort((a, b) => a.id.localeCompare(b.id))
      );
    }
    // A few of those values, spelled out.
    const [pub] = await tableRows(cx, 'oauth2_clients', `"id" = 'app-w-pub'`);
    expect(pub).toMatchObject({
      client_secret: null,
      token_endpoint_auth_method: 'none',
      application_type: 'native',
      redirect_uris: [
        'http://127.0.0.1:44100/callback',
        'cursor://anysphere.cursor-retrieval/oauth/callback',
      ],
      scopes: ['openid', 'profile', 'email', 'offline_access', 'read', 'write'],
      grant_types: ['authorization_code', 'refresh_token'],
    });
    const [web] = await tableRows(cx, 'oauth2_clients', `"id" = 'app-w-web'`);
    expect(web).toMatchObject({
      client_secret: hashed('wwebsecret-plain-xyz'),
      token_endpoint_auth_method: 'client_secret_basic',
      application_type: 'web',
      user_id: null,
      metadata: null,
    });
    const [rot] = await tableRows(cx, 'oauth2_refresh_tokens', `"id" = 'w-tok-pub-u1-rot'`);
    expect(rot).toMatchObject({
      token: hashed('ref-w-pub-u1-rot'),
      scopes: ['offline_access', 'openid', 'read', 'write'],
      resources: null,
      session_id: null,
      revoked: null,
    });
  });

  it('copies each consent as the migration made it for a pair that had none', async () => {
    const ours = json(added(beforeWrite.oauth2_consents!, afterWrite.oauth2_consents!));
    const reference = await tableRows(
      ref,
      'oauth2_consents',
      `("client_id", "user_id") IN (('wpubclient', 'u-1'), ('pubclient', 'u-2'), ('wwebclient', 'u-3'))`
    );
    const byPair = (rows: Record<string, any>[]) =>
      Object.fromEntries(rows.map(r => [`${r.client_id}/${r.user_id}`, r]));
    const a = byPair(ours);
    const b = byPair(reference);
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    for (const pair of Object.keys(a)) {
      // Created when each ran; a synthesized consent gets a new uuid.
      expect(without(a[pair]!, 'id', 'created_at', 'updated_at')).toEqual(
        without(b[pair]!, 'id', 'created_at', 'updated_at')
      );
    }
    // The newest given consent's id; all scopes of the pair's consents and tokens.
    expect(a['wpubclient/u-1']).toMatchObject({
      id: 'w-consent-wpub-u1-b',
      scopes: ['offline_access', 'read', 'write'],
    });
    expect(b['wpubclient/u-1']!.id).toBe('w-consent-wpub-u1-b');
    // Synthesized from a live refresh token (a denied consent does not count).
    for (const pair of ['pubclient/u-2', 'wwebclient/u-3']) {
      expect(a[pair]!.id).toMatch(UUID);
      expect(b[pair]!.id).toMatch(UUID);
    }
  });

  it('keeps the consent a pair already has, so a JWT issued before the catch-up still passes', async () => {
    // Tim's rule, on purpose unlike the reference: there the window's consent
    // merged into the pair's consent; here the pair's consent is untouched.
    const kept = (rows: string[]) =>
      json(rows).filter(c =>
        ['pubclient/u-1', 'webclient/u-1'].includes(`${c.client_id}/${c.user_id}`)
      );
    expect(kept(afterWrite.oauth2_consents!)).toEqual(kept(beforeWrite.oauth2_consents!));
    expect(
      kept(afterWrite.oauth2_consents!)
        .map(c => c.id)
        .sort()
    ).toEqual(['consent-17-web-u1', 'consent-pub-u1']);
    const reference = await tableRows(
      ref,
      'oauth2_consents',
      `("client_id", "user_id") IN (('pubclient', 'u-1'), ('webclient', 'u-1'))`
    );
    expect(reference.map(c => [c.id, c.scopes])).toEqual(
      expect.arrayContaining([
        ['w-consent-pub-u1', ['offline_access', 'openid', 'profile', 'read', 'write']],
        ['w-consent-web-u1', ['read']],
      ])
    );

    // The watermark constraint: the JWT predates the catch-up by at least a
    // second, so a consent created by the catch-up would have refused it.
    expect(claimsOf(jwtBefore).iat).toBeLessThan(Math.floor(writeStartedAt / 1000));
    expect(await consentAccepts(jwtBefore)).toBe(true);
    // One consent per pair, as before.
    const [{ duplicates }] = await cx.$queryRawUnsafe<{ duplicates: number }[]>(
      `SELECT count(*)::int AS duplicates FROM (
         SELECT 1 FROM "oauth2_consents" GROUP BY "client_id", "user_id" HAVING count(*) > 1) d`
    );
    expect(duplicates).toBe(0);
  });

  it('copies nothing of the reserved clients, expired or user-less tokens, or access tokens', async () => {
    const all = (table: string) => json(afterWrite[table]!);
    expect(all('oauth2_clients').map(c => c.id)).not.toContain('app-w-devmint');
    expect(all('oauth2_clients').filter(c => c.client_id === 'classmoji-dev-mint')).toHaveLength(1);
    for (const id of [
      'w-tok-expired',
      'w-tok-nouser',
      'w-tok-askmoji',
      'w-tok-devmint',
      'w-tok-del',
    ]) {
      expect(all('oauth2_refresh_tokens').map(r => r.id)).not.toContain(id);
    }
    expect(all('oauth2_consents').map(c => c.client_id)).not.toContain('classmoji-ask-moji');
    expect(all('oauth2_consents').map(c => `${c.client_id}/${c.user_id}`)).not.toContain(
      'wwebclient/u-2'
    );
    expect(afterWrite.oauth2_access_tokens).toEqual(beforeWrite.oauth2_access_tokens);
  });

  it('never puts back a copied grant that 1.7 has deleted since', async () => {
    // tok-pub-u1 was copied by the migration and its family ended on 1.7;
    // its legacy row is still there, but older than the migration.
    const tokens = json(afterWrite.oauth2_refresh_tokens!).map(r => r.id);
    expect(tokens).not.toContain('tok-pub-u1');
    expect(json(afterWrite.oauth_access_tokens!).map(r => r.id)).toContain('tok-pub-u1');
    // u-2's password change ended the migrated (webclient, u-2) grant, and
    // its legacy rows with it.
    expect(tokens).not.toContain('tok-web-u2');
    expect(json(afterWrite.oauth2_consents!).map(c => `${c.client_id}/${c.user_id}`)).not.toContain(
      'webclient/u-2'
    );
    // A token a 1.4 machine issued for u-2 after that change is copied like
    // any other.
    expect(tokens).toContain('w-tok-pub-u2');
  });

  it('copies nothing of a user whose password was reset after a 1.4 machine connected them', async () => {
    for (const table of ['oauth2_refresh_tokens', 'oauth2_consents']) {
      expect(
        json(afterWrite[table]!).filter(r => r.user_id === 'u-4'),
        table
      ).toEqual([]);
    }
    expect(json(afterWrite.oauth_access_tokens!).map(r => r.id)).not.toContain('w-tok-pub-u4');
  });

  it('run again: inserts nothing and changes nothing', async () => {
    for (const args of [[], ['--write']]) {
      const run = catchUp(args);
      expect(run.status, run.stderr).toBe(0);
      expect(run.result).toMatchObject({
        clientsAlreadyCopied: 2,
        produced: { oauth2_clients: 0, oauth2_consents: 5, oauth2_refresh_tokens: 4 },
        insert: { oauth2_clients: 0, oauth2_consents: 0, oauth2_refresh_tokens: 0 },
      });
      expect(await snapshot(cx)).toEqual(afterWrite);
    }
  });

  it('refreshes caught-up tokens on the 1.7 server to JWTs the MCP accepts', async () => {
    // A new public client.
    const pub = await token({
      grant_type: 'refresh_token',
      refresh_token: 'ref-w-wpub-u1',
      client_id: 'wpubclient',
    });
    expect(pub.status, JSON.stringify(pub.body)).toBe(200);
    expect(claimsOf(pub.body.access_token)).toMatchObject({
      aud: server.MCP_RESOURCE,
      azp: 'wpubclient',
      sub: 'u-1',
    });
    await expect(verifyJwt(pub.body.access_token)).resolves.toMatchObject({ sub: 'u-1' });
    expect(await consentAccepts(pub.body.access_token)).toBe(true);
    expect(typeof pub.body.refresh_token).toBe('string');
    // The token endpoint's rule gave the copied row its resource.
    expect(
      (await cx.oauthRefreshToken.findUnique({ where: { id: 'w-tok-wpub-u1' } }))?.resources
    ).toEqual([server.MCP_RESOURCE]);

    // A new confidential client: only with its secret.
    const noSecret = await token({
      grant_type: 'refresh_token',
      refresh_token: 'ref-w-wweb-u3',
      client_id: 'wwebclient',
    });
    expect(noSecret.body.error).toBe('invalid_client');
    const web = await token(
      { grant_type: 'refresh_token', refresh_token: 'ref-w-wweb-u3' },
      { authorization: basic('wwebclient', 'wwebsecret-plain-xyz') }
    );
    expect(web.status, JSON.stringify(web.body)).toBe(200);
    expect(claimsOf(web.body.access_token)).toMatchObject({ azp: 'wwebclient', sub: 'u-3' });
    await expect(verifyJwt(web.body.access_token)).resolves.toBeTruthy();
    expect(await consentAccepts(web.body.access_token)).toBe(true);

    // A migrated client: a token a 1.4 machine issued, and one it rotated.
    for (const [refreshToken, sub] of [
      ['ref-w-pub-u2', 'u-2'],
      ['ref-w-pub-u1-rot', 'u-1'],
    ] as const) {
      const res = await token({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: 'pubclient',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(claimsOf(res.body.access_token)).toMatchObject({ azp: 'pubclient', sub });
      expect(await consentAccepts(res.body.access_token)).toBe(true);
    }

    // Not copied, so not refreshable.
    const expired = await token({
      grant_type: 'refresh_token',
      refresh_token: 'ref-w-expired',
      client_id: 'pubclient',
    });
    expect(expired.status).not.toBe(200);
  });

  describe('a later run, after a rollback and a roll-forward (--since)', () => {
    // The previous release served for a while (1.4 wrote rows again), then
    // 1.7 came back. Meanwhile 1.7 had ended a family the first run had
    // caught up: (wpubclient, u-1), refreshed above, then reused.
    let rollbackAt: Date;
    let previousRun: string;

    beforeAll(async () => {
      previousRun = firstWrite.result!.runStartedAt;
      await cx.$executeRawUnsafe(
        `DELETE FROM "oauth2_refresh_tokens" WHERE "client_id" = 'wpubclient' AND "user_id" = 'u-1'`
      );
      rollbackAt = new Date(Math.max(Date.now(), Date.parse(previousRun) + 1));
      const at = (ms: number) => lit(new Date(rollbackAt.getTime() + ms));
      const live = lit(new Date(Date.now() + 5 * DAY));
      for (const statement of [
        `INSERT INTO "oauth_applications" ("id", "name", "client_id", "client_secret", "redirect_urls", "type", "disabled", "created_at", "updated_at") VALUES
          ('app-rb-pub', 'Registered during the rollback', 'rbclient', '', 'http://127.0.0.1:44200/callback', 'public', false, ${at(1)}, ${at(1)})`,
        `INSERT INTO "oauth_consents" ("id", "client_id", "user_id", "scopes", "consent_given", "created_at", "updated_at") VALUES
          ('rb-consent-u1', 'rbclient', 'u-1', 'read write offline_access', true, ${at(2)}, ${at(2)})`,
        `INSERT INTO "oauth_access_tokens" ("id", "access_token", "refresh_token", "access_token_expires_at", "refresh_token_expires_at", "client_id", "user_id", "scopes", "created_at", "updated_at") VALUES
          ('rb-tok-u1', 'acc-rb1', 'ref-rb-u1', ${live}, ${live}, 'rbclient', 'u-1', 'read write', ${at(3)}, ${at(3)}),
          ('rb-tok-wweb-u3', 'acc-rb2', 'ref-rb-wweb-u3', ${live}, ${live}, 'wwebclient', 'u-3', 'read write', ${at(4)}, ${at(4)})`,
      ]) {
        await cx.$executeRawUnsafe(statement);
      }
    });

    it('without --since, would read the first run’s window again and bring back what 1.7 ended', () => {
      const control = catchUp([]);
      expect(control.status, control.stderr).toBe(0);
      expect(control.result).toMatchObject({
        sinceFrom: 'migration',
        // w-tok-wpub-u1 again, beside the two rollback tokens.
        insert: { oauth2_clients: 1, oauth2_consents: 1, oauth2_refresh_tokens: 3 },
      });
    });

    it('with the previous run’s start, copies the rollback’s rows and nothing 1.7 ended', async () => {
      const before = await snapshot(cx);
      const dry = catchUp(['--since', previousRun]);
      expect(dry.status, dry.stderr).toBe(0);
      expect(dry.stdout).toContain(
        `window: legacy rows created at or after ${previousRun} (--since)`
      );
      expect(dry.result).toMatchObject({
        mode: 'dry-run',
        since: previousRun,
        sinceFrom: 'option',
        window: { oauth_applications: 1, oauth_consents: 1, oauth_access_tokens: 2 },
        insert: { oauth2_clients: 1, oauth2_consents: 1, oauth2_refresh_tokens: 2 },
      });
      expect(await snapshot(cx)).toEqual(before);

      const write = catchUp(['--since', previousRun, '--write']);
      expect(write.status, write.stderr).toBe(0);
      expect(write.result?.insert).toEqual(dry.result?.insert);
      const after = await snapshot(cx);
      for (const [table, rows] of Object.entries(before)) {
        expect(added(after[table]!, rows), table).toEqual([]);
      }
      const tokens = json(added(before.oauth2_refresh_tokens!, after.oauth2_refresh_tokens!));
      expect(tokens.map(r => r.id).sort()).toEqual(['rb-tok-u1', 'rb-tok-wweb-u3']);
      expect(json(after.oauth2_refresh_tokens!).map(r => r.id)).not.toContain('w-tok-wpub-u1');
      expect(json(added(before.oauth2_consents!, after.oauth2_consents!)).map(c => c.id)).toEqual([
        'rb-consent-u1',
      ]);

      // Again with the same --since: nothing more.
      const again = catchUp(['--since', previousRun, '--write']);
      expect(again.result?.insert).toEqual({
        oauth2_clients: 0,
        oauth2_consents: 0,
        oauth2_refresh_tokens: 0,
      });

      // The rollback's token refreshes on 1.7 to a JWT the MCP accepts.
      const res = await token({
        grant_type: 'refresh_token',
        refresh_token: 'ref-rb-u1',
        client_id: 'rbclient',
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(claimsOf(res.body.access_token)).toMatchObject({ azp: 'rbclient', sub: 'u-1' });
      expect(await consentAccepts(res.body.access_token)).toBe(true);
    });

    it('refuses a --since before the migration’s start or after the run’s, writing nothing', async () => {
      const before = await snapshot(cx);
      const early = catchUp(['--since', '2026-01-01T00:00:00Z', '--write']);
      expect(early.status).toBe(1);
      expect(early.stderr).toContain("is before the migration's start");
      const late = catchUp(['--since', '2999-01-01T00:00:00.000Z', '--write']);
      expect(late.status).toBe(1);
      expect(late.stderr).toContain("is after this run's start");
      expect(await snapshot(cx)).toEqual(before);
    });

    it.each([
      [['--since']],
      [['--since', 'yesterday']],
      [['--since', '2026-11-09T10:00:00']],
      [['--since', '2026-11-09T10:00:00.1234Z']],
      [['--since', '2026-11-09T10:00:00Z', '--since', '2026-11-09T10:00:00Z']],
    ])('refuses %j before connecting (usage)', args => {
      const run = catchUp(args);
      expect(run.status).toBe(2);
      expect(run.stdout).not.toContain('connected');
    });
  });
});
