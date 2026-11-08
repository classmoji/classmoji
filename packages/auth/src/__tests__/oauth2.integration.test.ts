/**
 * The OAuth 2.1 server on a real Postgres:
 *   - packages/database/migrations/20261107180000_oauth2_provider_tables over
 *     the legacy (better-auth 1.4 `mcp` plugin) rows it copies;
 *   - then the REAL exported `auth` (../server.ts) on that database, over
 *     `auth.handler`: the authorization code and refresh grants end to end,
 *     the tokens they issue, the copied refresh tokens and client secrets, and
 *     the app connections a password change or a ban ends. Only the service
 *     layer is stood in;
 *   - on the same database: the sign-ins that resume an app connection
 *     (email, email verification, Github and gitlab.com state, a
 *     self-managed Gitlab's round trip, with its setup and link states), and a
 *     sign-up for an address that already has an account
 *     (resetUnverifiedPasswordAccount). They live here because a second
 *     real-database file would reset the same schema while this one runs.
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { serializeSignedCookie } from 'better-call';

const DATABASE_URL = process.env.OAUTH_IT_DATABASE_URL;
// The auth instance (imported once the migration has run) uses this database.
if (DATABASE_URL) process.env.DATABASE_URL = DATABASE_URL;
process.env.WEBAPP_URL = 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET = 'test-secret-that-is-at-least-32-chars!!';
// Github and gitlab.com sign-in are registered from these (read at import).
process.env.GITHUB_CLIENT_ID = 'it-github-client';
process.env.GITHUB_CLIENT_SECRET = 'it-github-secret';
process.env.GITLAB_CLIENT_ID = 'it-gitlab-client';
process.env.GITLAB_CLIENT_SECRET = 'it-gitlab-secret';

const services = vi.hoisted(() => ({
  /** Every code the auth server mailed, newest last. */
  sentCodes: [] as { email: string; otp: string; type: string }[],
  /** A self-managed Gitlab's answers, by URL (gitlabFetch). */
  gitlab: new Map<string, unknown>(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    user: { findById: vi.fn(), findByLogin: vi.fn() },
    classroom: { findBySlug: vi.fn(), getClassroomForUI: (c: unknown) => c },
    classroomMembership: { findByClassroomAndUser: vi.fn() },
    githubUserToken: { getGitHubTokenForUser: vi.fn(async () => null) },
    subscription: { getProStateForClassroomId: vi.fn() },
    authEmail: {
      sendAuthOtp: vi.fn(async (email: string, otp: string, type: string) => {
        services.sentCodes.push({ email, otp, type });
      }),
    },
    gitlabInstance: {
      oauthClient: vi.fn(async (instanceId: string) => ({
        instanceId,
        host: 'https://gitlab.example.edu',
        clientId: 'gl-client',
        clientSecret: 'gl-secret',
      })),
      probe: vi.fn(async (host: string) => `https://${host}`),
      findByHost: vi.fn(async () => null),
      encryptSecret: vi.fn((secret: string) => `sealed:${secret}`),
      decryptSecret: vi.fn((sealed: string) => sealed.replace(/^sealed:/, '')),
      create: vi.fn(async () => ({})),
      notifyAdminsOfRequest: vi.fn(async () => {}),
      gitlabFetch: vi.fn(async (url: string) => {
        const answer = services.gitlab.get(url);
        return answer === undefined
          ? new Response('not found', { status: 404 })
          : Response.json(answer);
      }),
    },
  },
}));
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
    ('tok-off-live', 'acc-off-live', 'ref-off', now() - interval '1 hour', now() + interval '2 days', 'offclient', 'u-3', 'read', '2026-11-04T00:00:00Z', '2026-11-04T00:00:00Z'),
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
    expect(await db.legacyOauthAccessToken.count()).toBe(9);
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
      ['tok-off-live', 'offclient', 'u-3', ['offline_access', 'read']],
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

describe.skipIf(!DATABASE_URL)('the authorization server (real Postgres)', () => {
  type Auth = typeof import('../server.ts');
  let server: Auth;
  let db: PrismaClient;
  let ownCookie: string;
  const BASE = 'http://localhost:3000/api/auth';
  const PUBLIC_REDIRECT = 'http://localhost:33418/callback';
  const WEB_SECRET = 'websecret-plaintext-abc';

  /** The JWT's claims, unverified (verifyJwt checks the signature). */
  const claimsOf = (jwt: string) =>
    JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;

  async function verifyJwt(jwt: string, audience: string) {
    // eslint's resolver misses this subpath export; TypeScript resolves it.
    // eslint-disable-next-line import/no-unresolved
    const { verifyJwsAccessToken } = await import('better-auth/oauth2');
    return verifyJwsAccessToken(jwt, {
      jwksFetch: async () => {
        const res = await server.auth.handler(new Request(`${BASE}/jwks`));
        return res.json();
      },
      verifyOptions: { issuer: server.AUTH_ISSUER, audience },
    });
  }

  const pkce = () => {
    const verifier = `v-${Math.random().toString(36).slice(2)}-${'x'.repeat(40)}`;
    return {
      verifier,
      challenge: createHash('sha256').update(verifier).digest('base64url'),
    };
  };

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

  /**
   * Authorize (always through the consent page), approve, and exchange the
   * code. `params` override the authorize query; `exchange` adds to the token
   * request.
   */
  async function connect({
    clientId = 'pubclient',
    redirectUri = PUBLIC_REDIRECT,
    params = {},
    exchange = {},
    headers = {},
    cookie = ownCookie,
  }: {
    clientId?: string;
    redirectUri?: string;
    params?: Record<string, string>;
    exchange?: Record<string, string>;
    headers?: Record<string, string>;
    cookie?: string;
  } = {}) {
    const { verifier, challenge } = pkce();
    const query = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: 'read write',
      state: 'st',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...params,
    });
    const authorize = await server.auth.handler(
      new Request(`${BASE}/oauth2/authorize?${query}`, { headers: { cookie } })
    );
    const location = authorize.headers.get('location') ?? '';
    expect(new URL(location, 'http://localhost:3000').pathname).toBe('/oauth/consent');
    const signedQuery = new URL(location, 'http://localhost:3000').searchParams.toString();
    const consent = await server.auth.handler(
      new Request(`${BASE}/oauth2/consent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          cookie,
        },
        body: JSON.stringify({ accept: true, oauth_query: signedQuery }),
      })
    );
    const { url } = (await consent.json()) as { url: string };
    const code = new URL(url).searchParams.get('code');
    expect(code).toBeTruthy();
    return token(
      {
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
        ...exchange,
      },
      headers
    );
  }

  beforeAll(async () => {
    db = new PrismaClient({ datasourceUrl: DATABASE_URL });
    server = await import('../server.ts');
    await db.session.create({
      data: {
        id: 'it-session-u1',
        token: 'it-session-token-u1',
        user_id: 'u-1',
        expires_at: new Date(Date.now() + 86_400_000),
      },
    });
    ownCookie = (
      await serializeSignedCookie(
        `${server.COOKIE_PREFIX}.session_token`,
        'it-session-token-u1',
        process.env.BETTER_AUTH_SECRET!
      )
    ).split(';')[0]!;
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
  });

  it('seeds the MCP resource at boot', async () => {
    // A first request lets init finish.
    await server.auth.handler(new Request(`${BASE}/ok`));
    expect(
      await db.oauthResource.findUnique({ where: { identifier: server.MCP_RESOURCE } })
    ).toBeTruthy();
  });

  // The copied 1.4 grants first: a later test's refresh-token reuse ends
  // the (pubclient, u-1) family, copied rows included.
  it('refreshes a copied 1.4 refresh token, and gives it the MCP resource', async () => {
    const res = await token({
      grant_type: 'refresh_token',
      refresh_token: 'ref-pub-live2',
      client_id: 'pubclient',
    });
    expect(res.status).toBe(200);
    expect(claimsOf(res.body.access_token)).toMatchObject({
      aud: server.MCP_RESOURCE,
      azp: 'pubclient',
      sub: 'u-1',
    });
    expect(
      (await db.oauthRefreshToken.findUnique({ where: { id: 'tok-pub-live2' } }))?.resources
    ).toEqual([server.MCP_RESOURCE]);
  });

  it("refreshes a copied confidential client's token with its secret (hashed as 1.7 expects)", async () => {
    const without = await token({
      grant_type: 'refresh_token',
      refresh_token: 'ref-web-live',
      client_id: 'webclient',
    });
    expect(without.body.error).toBe('invalid_client');

    const res = await token(
      { grant_type: 'refresh_token', refresh_token: 'ref-web-live' },
      { authorization: basic('webclient', WEB_SECRET) }
    );
    expect(res.status).toBe(200);
    expect(claimsOf(res.body.access_token)).toMatchObject({ azp: 'webclient', sub: 'u-2' });
  });

  it('refuses a copied token of a disabled client', async () => {
    const res = await token(
      { grant_type: 'refresh_token', refresh_token: 'ref-off' },
      { authorization: basic('offclient', 'offsecret') }
    );
    expect(res.body.error).toBe('invalid_client');
  });

  it('never refreshes an Ask Moji token', async () => {
    for (const clientId of ['classmoji-ask-moji', 'pubclient']) {
      const res = await token({
        grant_type: 'refresh_token',
        refresh_token: 'askmoji-live-refresh',
        client_id: clientId,
      });
      expect(res.status).not.toBe(200);
      expect(res.body.error).toBe(clientId === 'pubclient' ? 'invalid_grant' : 'invalid_client');
    }
  });

  it('issues a JWT for the MCP resource when the client names no resource', async () => {
    const res = await connect();

    expect(res.status).toBe(200);
    const { access_token, refresh_token, scope } = res.body;
    expect(access_token.split('.')).toHaveLength(3);
    const claims = claimsOf(access_token);
    expect(claims).toMatchObject({
      aud: server.MCP_RESOURCE,
      iss: 'http://localhost:3000',
      azp: 'pubclient',
      sub: 'u-1',
    });
    await expect(verifyJwt(access_token, server.MCP_RESOURCE)).resolves.toMatchObject({
      sub: 'u-1',
    });
    // offline_access was asked for on the client's behalf, so it may refresh.
    expect(scope.split(' ')).toEqual(expect.arrayContaining(['read', 'write', 'offline_access']));
    expect(typeof refresh_token).toBe('string');
    // No opaque access token row: a JWT has none.
    expect(await db.oauthAccessToken.count()).toBe(0);
    // Stored hashed, for the one resource.
    const row = await db.oauthRefreshToken.findUnique({ where: { token: hashed(refresh_token) } });
    expect(row).toMatchObject({
      clientId: 'pubclient',
      userId: 'u-1',
      resources: [server.MCP_RESOURCE],
    });
  });

  it('accepts the bare origin with a trailing slash on authorize, exchange and refresh', async () => {
    const slashed = `${new URL(server.MCP_RESOURCE).origin}/`;
    const res = await connect({
      params: { resource: slashed },
      exchange: { resource: slashed },
    });
    expect(res.status).toBe(200);
    expect(claimsOf(res.body.access_token).aud).toBe(server.MCP_RESOURCE);

    const refreshed = await token({
      grant_type: 'refresh_token',
      refresh_token: res.body.refresh_token,
      client_id: 'pubclient',
      resource: slashed,
    });
    expect(refreshed.status).toBe(200);
    expect(claimsOf(refreshed.body.access_token).aud).toBe(server.MCP_RESOURCE);
  });

  it('refuses a resource that is not the MCP server', async () => {
    const res = await token({
      grant_type: 'refresh_token',
      refresh_token: (await connect()).body.refresh_token,
      client_id: 'pubclient',
      resource: 'https://elsewhere.example/mcp',
    });
    expect(res.body.error).toBe('invalid_target');
  });

  it('gives a registered client with only authorization_code a refresh token', async () => {
    const reg = await server.auth.handler(
      new Request(`${BASE}/oauth2/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'SDK-style client',
          redirect_uris: ['http://127.0.0.1:4567/cb'],
          grant_types: ['authorization_code'],
          token_endpoint_auth_method: 'none',
        }),
      })
    );
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };

    const res = await connect({ clientId: client_id, redirectUri: 'http://127.0.0.1:4567/cb' });

    expect(res.status).toBe(200);
    expect(typeof res.body.refresh_token).toBe('string');
  });

  it('rotates refresh tokens, replays within 30 s, and ends the family after', async () => {
    const first = await connect();
    const r1 = first.body.refresh_token as string;

    const rotated = await token({
      grant_type: 'refresh_token',
      refresh_token: r1,
      client_id: 'pubclient',
    });
    expect(rotated.status).toBe(200);
    const r2 = rotated.body.refresh_token as string;
    expect(r2).not.toBe(r1);

    // Within the reuse interval the same response comes back.
    const replay = await token({
      grant_type: 'refresh_token',
      refresh_token: r1,
      client_id: 'pubclient',
    });
    expect(replay.status).toBe(200);
    expect(replay.body.refresh_token).toBe(r2);

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 31_000 });
    try {
      const late = await token({
        grant_type: 'refresh_token',
        refresh_token: r1,
        client_id: 'pubclient',
      });
      expect(late.body.error).toBe('invalid_grant');
      // The whole family for (client, user) is gone, the rotated one too.
      const after = await token({
        grant_type: 'refresh_token',
        refresh_token: r2,
        client_id: 'pubclient',
      });
      expect(after.body.error).toBe('invalid_grant');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets one of two parallel refreshes rotate', async () => {
    const { refresh_token } = (await connect()).body;
    const [a, b] = await Promise.all([
      token({ grant_type: 'refresh_token', refresh_token, client_id: 'pubclient' }),
      token({ grant_type: 'refresh_token', refresh_token, client_id: 'pubclient' }),
    ]);
    const issued = [a, b].filter(r => r.status === 200).map(r => r.body.refresh_token);
    expect(issued.length).toBeGreaterThanOrEqual(1);
    // One rotation: any second answer is the replay of the first.
    expect(new Set(issued).size).toBe(1);
  });

  it('exchanges a code once, even in parallel', async () => {
    const { verifier, challenge } = pkce();
    const query = new URLSearchParams({
      client_id: 'pubclient',
      response_type: 'code',
      redirect_uri: PUBLIC_REDIRECT,
      scope: 'read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const authorize = await server.auth.handler(
      new Request(`${BASE}/oauth2/authorize?${query}`, { headers: { cookie: ownCookie } })
    );
    const signedQuery = new URL(authorize.headers.get('location')!, 'http://x').searchParams;
    const consent = await server.auth.handler(
      new Request(`${BASE}/oauth2/consent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          cookie: ownCookie,
        },
        body: JSON.stringify({ accept: true, oauth_query: signedQuery.toString() }),
      })
    );
    const code = new URL(((await consent.json()) as { url: string }).url).searchParams.get('code')!;
    const exchange = () =>
      token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: PUBLIC_REDIRECT,
        client_id: 'pubclient',
        code_verifier: verifier,
      });
    const results = await Promise.all([exchange(), exchange()]);
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
  });

  describe('ending app connections', () => {
    const grantsOf = async (userId: string) => ({
      refresh: await db.oauthRefreshToken.count({ where: { userId } }),
      consents: await db.oauthConsent.count({ where: { userId } }),
    });
    const revokeRows = (userId: string) =>
      db.platformAuditLog.findMany({ where: { action: 'oauth_grants.revoke', target_id: userId } });

    it('a password reset ends them, with one audit row', async () => {
      await connect();
      expect((await grantsOf('u-1')).refresh).toBeGreaterThan(0);
      const ctx = await server.auth.$context;
      await ctx.internalAdapter.createVerificationValue({
        identifier: 'reset-password:it-reset-token',
        value: 'u-1',
        expiresAt: new Date(Date.now() + 600_000),
      });

      const res = await server.auth.handler(
        new Request(`${BASE}/reset-password`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
          body: JSON.stringify({ newPassword: 'a-new-password-1', token: 'it-reset-token' }),
        })
      );

      expect(res.status).toBe(200);
      expect(await grantsOf('u-1')).toEqual({ refresh: 0, consents: 0 });
      const rows = await revokeRows('u-1');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_id: 'u-1',
        target_type: 'user',
        data: expect.objectContaining({
          tool: 'auth:oauth_grants.revoke',
          reason: 'password_reset',
        }),
      });
    });

    it('a password change that signs out other sessions ends them; one that keeps them does not', async () => {
      // u-1 now has a password ('a-new-password-1') and a fresh session.
      await db.session.create({
        data: {
          id: 'it-session-u1-b',
          token: 'it-session-token-u1-b',
          user_id: 'u-1',
          expires_at: new Date(Date.now() + 86_400_000),
        },
      });
      const cookie = (
        await serializeSignedCookie(
          `${server.COOKIE_PREFIX}.session_token`,
          'it-session-token-u1-b',
          process.env.BETTER_AUTH_SECRET!
        )
      ).split(';')[0]!;
      const change = (body: Record<string, unknown>) =>
        server.auth.handler(
          new Request(`${BASE}/change-password`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin: 'http://localhost:3000',
              cookie,
            },
            body: JSON.stringify(body),
          })
        );

      await connect({ cookie });
      const kept = await change({
        currentPassword: 'a-new-password-1',
        newPassword: 'a-new-password-2',
      });
      expect(kept.status).toBe(200);
      expect((await grantsOf('u-1')).refresh).toBeGreaterThan(0);

      const ended = await change({
        currentPassword: 'a-new-password-2',
        newPassword: 'a-new-password-3',
        revokeOtherSessions: true,
      });
      expect(ended.status).toBe(200);
      expect(await grantsOf('u-1')).toEqual({ refresh: 0, consents: 0 });
      expect((await revokeRows('u-1')).map(r => (r.data as { reason?: string }).reason)).toEqual(
        expect.arrayContaining(['password_change'])
      );
    });

    it('a ban ends them', async () => {
      // u-2 holds the copied webclient grant.
      expect((await grantsOf('u-2')).consents).toBeGreaterThan(0);
      const ctx = await server.auth.$context;
      await ctx.internalAdapter.updateUser('u-2', { banned: true });
      expect(await grantsOf('u-2')).toEqual({ refresh: 0, consents: 0 });
      expect((await revokeRows('u-2')).map(r => (r.data as { reason?: string }).reason)).toEqual([
        'ban',
      ]);
    });
  });
});

describe.skipIf(!DATABASE_URL)('signing in to resume an app connection (real Postgres)', () => {
  type Auth = typeof import('../server.ts');
  let server: Auth;
  let db: PrismaClient;
  let gitlabInstance: Record<string, ReturnType<typeof vi.fn>>;
  const BASE = 'http://localhost:3000/api/auth';
  const GITLAB = 'https://gitlab.example.edu';

  beforeAll(async () => {
    db = new PrismaClient({ datasourceUrl: DATABASE_URL });
    server = await import('../server.ts');
    const { ClassmojiService } = await import('@classmoji/services');
    gitlabInstance = ClassmojiService.gitlabInstance as unknown as typeof gitlabInstance;
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
  });

  /** An authorization started while signed out: the signed query the sign-in page gets. */
  async function signedOutAuthorization(): Promise<string> {
    const query = new URLSearchParams({
      client_id: 'pubclient',
      response_type: 'code',
      redirect_uri: 'http://localhost:33418/callback',
      scope: 'read write',
      state: 'client-state',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
    });
    const res = await server.auth.handler(new Request(`${BASE}/oauth2/authorize?${query}`));
    const location = new URL(res.headers.get('location') ?? '', 'http://localhost:3000');
    expect(location.pathname).toBe('/');
    expect(location.searchParams.get('sig')).toBeTruthy();
    return location.searchParams.toString();
  }

  const post = (path: string, body: unknown, cookie?: string) =>
    server.auth.handler(
      new Request(`${BASE}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://localhost:3000',
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      })
    );

  /** The cookies a response sets, as a request's cookie header. */
  const cookiesOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map(c => c.split(';')[0]!)
      .join('; ');

  /** Where an answer sends the browser is the consent page, for the same authorization. */
  function expectConsentPage(url: string | null | undefined) {
    const target = new URL(url ?? '', 'http://localhost:3000');
    expect(target.pathname).toBe('/oauth/consent');
    expect(target.searchParams.get('client_id')).toBe('pubclient');
    expect(target.searchParams.get('state')).toBe('client-state');
    expect(target.searchParams.get('prompt')).toBe('consent');
  }

  /** The OAuth state a sign-in stored (database state), by the `state` of its authorize URL. */
  async function storedState(authorizeUrl: string) {
    const state = new URL(authorizeUrl).searchParams.get('state');
    const row = await db.verification.findFirst({ where: { identifier: `auth-state:${state}` } });
    expect(row, 'the OAuth state is stored').toBeTruthy();
    return JSON.parse(row!.value) as Record<string, any>;
  }

  /**
   * A self-managed Gitlab's half of the round trip: what its token and user
   * endpoints answer, then its redirect back to the callback with the code,
   * from the browser that started (its state cookie), as a navigation.
   */
  async function gitlabCallback(
    start: Response,
    profile: Record<string, unknown>,
    host = GITLAB
  ): Promise<Response> {
    expect(start.status).toBe(200);
    const { url } = (await start.clone().json()) as { url: string };
    expect(new URL(url).origin).toBe(host);
    services.gitlab.set(`${host}/oauth/token`, {
      access_token: `gl-access-${String(profile.id)}`,
      token_type: 'bearer',
      expires_in: 7200,
      scope: 'read_user',
    });
    services.gitlab.set(`${host}/api/v4/user`, { state: 'active', locked: false, ...profile });
    const state = new URL(url).searchParams.get('state');
    return server.auth.handler(
      new Request(`${BASE}/gitlab-instance/callback?code=gl-code&state=${state}`, {
        headers: { cookie: cookiesOf(start), 'sec-fetch-mode': 'navigate', accept: 'text/html' },
      })
    );
  }

  it('an email verification code resumes it at the consent page', async () => {
    const email = 'resume-verify@example.org';
    const signUp = await post('/sign-up/email', {
      name: 'Resume Verify',
      email,
      password: 'resume-password-1',
    });
    expect(signUp.status).toBe(200);
    const sent = await post('/email-otp/send-verification-otp', {
      email,
      type: 'email-verification',
    });
    expect(sent.status).toBe(200);
    const { otp } = services.sentCodes.filter(c => c.email === email).at(-1)!;

    const res = await post('/email-otp/verify-email', {
      email,
      otp,
      oauth_query: await signedOutAuthorization(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirect?: boolean; url?: string };
    expect(body.redirect).toBe(true);
    expectConsentPage(body.url);
  });

  it('an email and password sign-in resumes it at the consent page', async () => {
    // Verified by the test above.
    const res = await post('/sign-in/email', {
      email: 'resume-verify@example.org',
      password: 'resume-password-1',
      oauth_query: await signedOutAuthorization(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirect?: boolean; url?: string };
    expect(body.redirect).toBe(true);
    expectConsentPage(body.url);
  });

  it.each([['github'], ['gitlab']])(
    '%s sign-in carries it across the provider round trip (OAuth state)',
    async provider => {
      const oauthQuery = await signedOutAuthorization();

      const res = await post('/sign-in/social', {
        provider,
        callbackURL: '/select-organization',
        oauth_query: oauthQuery,
      });

      expect(res.status).toBe(200);
      const { url } = (await res.json()) as { url: string };
      const carried = new URLSearchParams((await storedState(url)).serverContext?.query);
      // The authorization, without its signature (oauth-provider's own form).
      expect(carried.get('client_id')).toBe('pubclient');
      expect(carried.get('state')).toBe('client-state');
      expect(carried.has('sig')).toBe(false);
    }
  );

  it('a self-managed Gitlab sign-in carries it across the round trip and resumes it', async () => {
    const oauthQuery = await signedOutAuthorization();
    const start = await post('/gitlab-instance/sign-in', {
      instanceId: 'inst-it',
      callbackURL: '/select-organization',
      errorCallbackURL: '/',
      oauth_query: oauthQuery,
    });
    const { url } = (await start.clone().json()) as { url: string };
    const stored = await storedState(url);
    expect(stored.gitlabInstanceId).toBe('inst-it');
    expect(new URLSearchParams(stored.serverContext?.query).get('client_id')).toBe('pubclient');

    const res = await gitlabCallback(start, {
      id: 4242,
      username: 'resume-gl',
      name: 'Resume Gitlab',
      email: 'resume-gl@example.org',
    });

    // Signed in, and on to the consent page rather than the callbackURL.
    expect(res.status).toBe(302);
    expect(cookiesOf(res)).toContain(`${server.COOKIE_PREFIX}.session_token=`);
    expectConsentPage(res.headers.get('location'));
    expect(
      await db.account.count({ where: { provider_id: 'gitlab', account_id: 'inst-it:4242' } })
    ).toBe(1);
  });

  it('a self-managed Gitlab sign-in without one goes to its callbackURL (instance in the state)', async () => {
    const start = await post('/gitlab-instance/sign-in', {
      instanceId: 'inst-it',
      callbackURL: '/select-organization',
      errorCallbackURL: '/',
    });
    const { url } = (await start.clone().json()) as { url: string };
    expect((await storedState(url)).serverContext).toBeUndefined();
    gitlabInstance.oauthClient!.mockClear();

    const res = await gitlabCallback(start, {
      id: 4343,
      username: 'plain-gl',
      name: 'Plain Gitlab',
      email: 'plain-gl@example.org',
    });

    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/select-organization');
    // The callback resolved the instance the sign-in named.
    expect(gitlabInstance.oauthClient).toHaveBeenCalledWith('inst-it');
  });

  it('a Gitlab setup carries its pending instance across the round trip', async () => {
    gitlabInstance.create!.mockClear();
    const start = await post('/gitlab-instance/setup', {
      host: 'gitlab.setup.example.edu',
      clientId: 'setup-client',
      clientSecret: 'setup-secret',
      note: 'CS 1',
      callbackURL: '/gitlab/setup',
      errorCallbackURL: '/gitlab/setup',
    });
    const { url } = (await start.clone().json()) as { url: string };
    // The secret rides the state sealed.
    expect((await storedState(url)).gitlabSetup).toMatchObject({
      host: 'https://gitlab.setup.example.edu',
      clientId: 'setup-client',
      clientSecret: 'sealed:setup-secret',
      note: 'CS 1',
    });

    const res = await gitlabCallback(
      start,
      { id: 77, username: 'setup-gl', name: 'Setup', email: 'setup-gl@example.org' },
      'https://gitlab.setup.example.edu'
    );

    expect(res.status).toBe(302);
    const next = new URL(res.headers.get('location')!);
    expect(`${next.pathname}${next.search}`).toBe('/gitlab/setup?gitlab_setup=pending');
    expect(gitlabInstance.create).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'https://gitlab.setup.example.edu',
        clientId: 'setup-client',
        clientSecret: 'setup-secret',
      })
    );
    expect(cookiesOf(res)).not.toContain(`${server.COOKIE_PREFIX}.session_token=`);
  });

  it('Connect Gitlab carries the signed-in user across the round trip', async () => {
    const user = await db.user.findFirstOrThrow({ where: { email: 'resume-verify@example.org' } });
    await db.session.create({
      data: {
        id: 'it-session-link',
        token: 'it-session-token-link',
        user_id: user.id,
        expires_at: new Date(Date.now() + 86_400_000),
      },
    });
    const cookie = (
      await serializeSignedCookie(
        `${server.COOKIE_PREFIX}.session_token`,
        'it-session-token-link',
        process.env.BETTER_AUTH_SECRET!
      )
    ).split(';')[0]!;
    const start = await post(
      '/gitlab-instance/link',
      { instanceId: 'inst-it', callbackURL: '/settings/connections' },
      cookie
    );
    const { url } = (await start.clone().json()) as { url: string };
    expect((await storedState(url)).link).toMatchObject({ userId: user.id, email: user.email });

    const res = await gitlabCallback(start, {
      id: 5151,
      username: 'linked-gl',
      name: 'Linked',
      email: 'linked-gl@example.org',
    });

    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/settings/connections');
    expect(
      await db.account.findFirst({
        where: { provider_id: 'gitlab', account_id: 'inst-it:5151' },
        select: { user_id: true },
      })
    ).toEqual({ user_id: user.id });
  });
});

describe.skipIf(!DATABASE_URL)(
  'a sign-up for an address that already has an account (real Postgres)',
  () => {
    type Auth = typeof import('../server.ts');
    let server: Auth;
    let db: PrismaClient;
    const BASE = 'http://localhost:3000/api/auth';

    beforeAll(async () => {
      db = new PrismaClient({ datasourceUrl: DATABASE_URL });
      server = await import('../server.ts');
    }, 120_000);

    afterAll(async () => {
      await db?.$disconnect();
    });

    const post = (path: string, body: unknown) =>
      server.auth.handler(
        new Request(`${BASE}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
          body: JSON.stringify(body),
        })
      );

    const signUp = (email: string, password: string, extra: Record<string, unknown> = {}) =>
      post('/sign-up/email', { name: 'Someone', email, password, ...extra });

    const signIn = (email: string, password: string) => post('/sign-in/email', { email, password });

    /** Mails a code of `type` to `email` and returns it. */
    async function codeFor(
      email: string,
      type: 'email-verification' | 'forget-password'
    ): Promise<string> {
      const res =
        type === 'email-verification'
          ? await post('/email-otp/send-verification-otp', { email, type })
          : await post('/email-otp/request-password-reset', { email });
      expect(res.status).toBe(200);
      return services.sentCodes.filter(c => c.email === email && c.type === type).at(-1)!.otp;
    }

    const userOf = (email: string) => db.user.findFirstOrThrow({ where: { email } });
    const passwordsOf = (userId: string) =>
      db.account.count({ where: { user_id: userId, provider_id: 'credential' } });
    const resetRows = (userId: string) =>
      db.platformAuditLog.findMany({
        where: { action: 'sign_up.unverified_reset', target_id: userId },
      });

    it('signed up first by someone else: that password no longer signs in', async () => {
      const email = 'a2-first@example.org';
      expect((await signUp(email, 'first-password-1')).status).toBe(200);
      const user = await userOf(email);

      const second = await signUp(email, 'second-password-1');

      // Answered as a new sign-up would be.
      expect(second.status).toBe(200);
      expect(await passwordsOf(user.id)).toBe(0);
      expect((await signIn(email, 'first-password-1')).status).toBe(401);
      // Neither does the second one: a sign-up for an existing address stores nothing.
      expect((await signIn(email, 'second-password-1')).status).toBe(401);
      expect(await resetRows(user.id)).toEqual([
        expect.objectContaining({
          actor_id: null,
          target_type: 'user',
          target_id: user.id,
          data: {
            tool: 'auth:sign_up.unverified_reset',
            path: '/sign-up/email',
            passwordsRemoved: 1,
            sessionsEnded: 0,
            cleared: ['image', 'school_id'],
          },
        }),
      ]);
    });

    it('the owner of the address, after a repeated sign-up, verifies it and sets a password with Forgot password', async () => {
      const email = 'a2-owner@example.org';
      expect((await signUp(email, 'owner-password-1')).status).toBe(200);
      const code = await codeFor(email, 'email-verification');
      expect((await signUp(email, 'other-password-1')).status).toBe(200);
      expect((await signIn(email, 'owner-password-1')).status).toBe(401);

      // The code still verifies the address, and signs its owner in.
      const verified = await post('/email-otp/verify-email', { email, otp: code });
      expect(verified.status).toBe(200);
      expect(verified.headers.getSetCookie().join(';')).toContain(
        `${server.COOKIE_PREFIX}.session_token=`
      );

      const reset = await post('/email-otp/reset-password', {
        email,
        otp: await codeFor(email, 'forget-password'),
        password: 'owner-password-2',
      });
      expect(reset.status).toBe(200);
      expect((await signIn(email, 'owner-password-2')).status).toBe(200);
    });

    it('clears the picture and School ID the first sign-up gave the account', async () => {
      const email = 'a2-profile@example.org';
      await signUp(email, 'first-password-1', {
        image: 'https://pictures.example.org/a.png',
        school_id: 'F00001',
      });
      const before = await userOf(email);
      expect(before).toMatchObject({
        image: 'https://pictures.example.org/a.png',
        school_id: 'F00001',
      });

      await signUp(email, 'second-password-1', {
        image: 'https://pictures.example.org/b.png',
        school_id: 'F00002',
      });

      expect(await userOf(email)).toMatchObject({
        image: null,
        school_id: null,
        emailVerified: false,
      });
    });

    it('ends the account’s sessions, and a "View as" session among them gets its end row', async () => {
      const email = 'a2-sessions@example.org';
      await signUp(email, 'first-password-1');
      const user = await userOf(email);
      await db.session.createMany({
        data: [
          {
            id: 'a2-own',
            token: 'a2-own-token',
            user_id: user.id,
            expires_at: new Date(Date.now() + 86_400_000),
          },
          {
            id: 'a2-viewing',
            token: 'a2-viewing-token',
            user_id: user.id,
            impersonatedBy: 'u-1',
            expires_at: new Date(Date.now() + 3_600_000),
          },
        ],
      });

      await signUp(email, 'second-password-1');

      expect(await db.session.count({ where: { user_id: user.id } })).toBe(0);
      const ends = await db.platformAuditLog.findMany({
        where: { action: 'impersonate.end', target_id: user.id },
      });
      expect(ends).toEqual([
        expect.objectContaining({
          actor_id: 'u-1',
          data: expect.objectContaining({
            sessionId: 'a2-viewing',
            path: '/sign-up/email',
            endedBy: 'system',
          }),
        }),
      ]);
      expect((await resetRows(user.id))[0]?.data).toMatchObject({ sessionsEnded: 2 });
    });

    it('leaves a Github user still in registration as they are: nothing removed, still signed in', async () => {
      const user = await db.user.create({
        data: {
          id: 'a2-github-user',
          email: 'a2-github@example.org',
          name: 'Github User',
          image: 'https://avatars.example.org/g.png',
          emailVerified: false,
        },
      });
      await db.account.create({
        data: {
          id: 'a2-github-account',
          user_id: user.id,
          provider_id: 'github',
          account_id: '909090',
        },
      });
      await db.session.create({
        data: {
          id: 'a2-github-session',
          token: 'a2-github-token',
          user_id: user.id,
          expires_at: new Date(Date.now() + 86_400_000),
        },
      });

      expect((await signUp('a2-github@example.org', 'some-password-1')).status).toBe(200);

      expect(await db.account.count({ where: { user_id: user.id } })).toBe(1);
      expect(await db.session.count({ where: { user_id: user.id } })).toBe(1);
      expect((await userOf('a2-github@example.org')).image).toBe(
        'https://avatars.example.org/g.png'
      );
      expect(await resetRows(user.id)).toEqual([]);
    });

    it('leaves a verified account as it is', async () => {
      // Verified (and signed in with) above.
      const user = await userOf('a2-owner@example.org');

      expect((await signUp('a2-owner@example.org', 'another-password-1')).status).toBe(200);

      expect(await passwordsOf(user.id)).toBe(1);
      expect((await signIn('a2-owner@example.org', 'owner-password-2')).status).toBe(200);
      expect(await resetRows(user.id)).toHaveLength(1);
    });
  }
);
