/**
 * GitLab instances: gitlab.com (the default, configured from env) plus any
 * number of self-managed GitLabs, each with its own OAuth application stored
 * in the GitLabInstance table.
 *
 * Everything that talks to GitLab (sign-in, "Connect Gitlab", token refresh,
 * the API adapter, git remotes) asks this module for the host and OAuth client
 * of the instance it is working on, instead of reading env directly. An
 * instance id of null always means the default instance.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import getPrisma from '@classmoji/database';
import { GITLAB_COM, normalizeGitlabHost } from '@classmoji/utils';

export interface GitLabOAuthClient {
  /** Null for the default instance. */
  instanceId: string | null;
  host: string;
  clientId: string;
  clientSecret: string;
}

export class GitLabInstanceError extends Error {
  code: 'not_configured' | 'not_found' | 'disabled' | 'invalid_host' | 'unreachable' | 'exists';
  constructor(code: GitLabInstanceError['code'], message: string) {
    super(message);
    this.name = 'GitLabInstanceError';
    this.code = code;
  }
}

// ─── Client secret encryption ────────────────────────────────────────────────
//
// Keyed off BETTER_AUTH_SECRET (with the same development fallback as
// @classmoji/auth), so the webapp and Trigger workers can both read it.
// Rotating that secret means re-entering every instance's client secret.

const DEV_SECRET = 'dev-secret-change-in-production-32chars!';

function secretKey(): Buffer {
  const secret = process.env.BETTER_AUTH_SECRET || DEV_SECRET;
  return createHash('sha256').update(`classmoji:gitlab-instance:${secret}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data]
    .map(p => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, data] = stored.split('.');
  if (version !== 'v1' || !iv || !tag || data === undefined) {
    throw new Error('Unrecognized encrypted secret');
  }
  const decipher = createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

// ─── Hosts ───────────────────────────────────────────────────────────────────

const allowHttp = () => process.env.NODE_ENV !== 'production';

/** The default instance's host: GITLAB_ISSUER / GITLAB_URL, else gitlab.com. */
export function defaultHost(): string {
  return (
    normalizeGitlabHost(process.env.GITLAB_ISSUER || process.env.GITLAB_URL, {
      allowHttp: allowHttp(),
    }) ?? GITLAB_COM
  );
}

/** GitLab sign-in and connections are possible on the default instance. */
export function defaultConfigured(): boolean {
  return Boolean(process.env.GITLAB_CLIENT_ID && process.env.GITLAB_CLIENT_SECRET);
}

export function normalizeHost(input: string | null | undefined): string | null {
  return normalizeGitlabHost(input, { allowHttp: allowHttp() });
}

/** The host of an instance (null: the default one). */
export async function hostFor(instanceId: string | null | undefined): Promise<string> {
  if (!instanceId) return defaultHost();
  const row = await getPrisma().gitLabInstance.findUnique({
    where: { id: instanceId },
    select: { host: true },
  });
  if (!row) throw new GitLabInstanceError('not_found', 'That Gitlab instance no longer exists');
  return row.host;
}

/**
 * The OAuth client for an instance. Throws when it can't be used. A disabled
 * instance refuses sign-in and new connections, but token refreshes for
 * classrooms already on it pass `allowDisabled` and keep working.
 */
export async function oauthClient(
  instanceId: string | null | undefined,
  { allowDisabled = false }: { allowDisabled?: boolean } = {}
): Promise<GitLabOAuthClient> {
  if (!instanceId) {
    if (!defaultConfigured()) {
      throw new GitLabInstanceError(
        'not_configured',
        'Gitlab is not configured (GITLAB_CLIENT_ID / GITLAB_CLIENT_SECRET)'
      );
    }
    return {
      instanceId: null,
      host: defaultHost(),
      clientId: process.env.GITLAB_CLIENT_ID as string,
      clientSecret: process.env.GITLAB_CLIENT_SECRET as string,
    };
  }
  const row = await getPrisma().gitLabInstance.findUnique({ where: { id: instanceId } });
  if (!row) throw new GitLabInstanceError('not_found', 'That Gitlab instance no longer exists');
  if (row.disabled_at && !allowDisabled) {
    throw new GitLabInstanceError('disabled', `Sign-in with ${row.host} is turned off`);
  }
  return {
    instanceId: row.id,
    host: row.host,
    clientId: row.client_id,
    clientSecret: decryptSecret(row.client_secret),
  };
}

/**
 * The instance a person means by a host they typed: `{ id: null }` for the
 * default instance, the row for a registered one, null when it isn't set up.
 */
export async function findByHost(
  input: string | null | undefined
): Promise<{ id: string | null; host: string; disabled: boolean } | null> {
  const host = normalizeHost(input);
  if (!host) return null;
  if (host === defaultHost()) {
    return defaultConfigured() ? { id: null, host, disabled: false } : null;
  }
  const row = await getPrisma().gitLabInstance.findUnique({
    where: { host },
    select: { id: true, host: true, disabled_at: true },
  });
  return row ? { id: row.id, host: row.host, disabled: Boolean(row.disabled_at) } : null;
}

/** An instance's public face (never its secret), for the sign-in page. */
export async function findPublic(instanceId: string) {
  const row = await getPrisma().gitLabInstance.findUnique({
    where: { id: instanceId },
    select: { id: true, host: true, disabled_at: true },
  });
  return row && !row.disabled_at ? { id: row.id, host: row.host } : null;
}

// ─── Registering an instance ─────────────────────────────────────────────────

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return PRIVATE_V4.some(re => re.test(address));
  const a = address.toLowerCase();
  if (a.startsWith('::ffff:')) return isPrivateAddress(a.slice(7));
  return (
    a === '::1' || a === '::' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80')
  );
}

/**
 * Classmoji's servers call this host (token exchange, API), so a host that
 * resolves to a private or loopback address is refused in production. Local
 * development may point at a GitLab container.
 */
async function assertPublicHost(host: string): Promise<void> {
  if (allowHttp()) return;
  const { hostname } = new URL(host);
  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new GitLabInstanceError('unreachable', `Could not find ${hostname}`);
  }
  if (addresses.length === 0 || addresses.some(a => isPrivateAddress(a.address))) {
    throw new GitLabInstanceError(
      'unreachable',
      `${hostname} is not reachable from the internet, so Classmoji can't connect to it`
    );
  }
}

/**
 * Check a host really is a GitLab that Classmoji can reach: GitLab serves its
 * OpenID configuration publicly, with its own origin as the issuer.
 */
export async function probe(input: string): Promise<string> {
  const host = normalizeHost(input);
  if (!host)
    throw new GitLabInstanceError(
      'invalid_host',
      'Enter your Gitlab address, like gitlab.school.edu'
    );
  await assertPublicHost(host);
  let issuer: unknown;
  try {
    const response = await fetch(`${host}/.well-known/openid-configuration`, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(String(response.status));
    issuer = ((await response.json()) as { issuer?: unknown }).issuer;
  } catch {
    throw new GitLabInstanceError('unreachable', `Classmoji couldn't reach a Gitlab at ${host}`);
  }
  if (typeof issuer !== 'string' || normalizeHost(issuer) !== host) {
    throw new GitLabInstanceError('unreachable', `${host} doesn't look like a Gitlab`);
  }
  return host;
}

/**
 * Store a new instance. Called only after an OAuth round trip with these
 * credentials succeeded, which proves they work.
 */
export async function create(input: {
  host: string;
  clientId: string;
  clientSecret: string;
  createdByUserId: string | null;
}) {
  const host = normalizeHost(input.host);
  if (!host) throw new GitLabInstanceError('invalid_host', 'Invalid Gitlab address');
  if (host === defaultHost()) {
    throw new GitLabInstanceError('exists', `${host} is already available`);
  }
  try {
    return await getPrisma().gitLabInstance.create({
      data: {
        host,
        client_id: input.clientId,
        client_secret: encryptSecret(input.clientSecret),
        created_by_user_id: input.createdByUserId,
      },
      select: { id: true, host: true },
    });
  } catch (error: unknown) {
    if ((error as { code?: string }).code === 'P2002') {
      throw new GitLabInstanceError('exists', `${host} is already set up`);
    }
    throw error;
  }
}

// ─── Platform admin ──────────────────────────────────────────────────────────

export function list() {
  return getPrisma().gitLabInstance.findMany({
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      host: true,
      client_id: true,
      disabled_at: true,
      created_at: true,
      created_by: { select: { id: true, name: true, login: true, email: true } },
      _count: { select: { git_organizations: true, connections: true } },
    },
  });
}

export function setDisabled(instanceId: string, disabled: boolean) {
  return getPrisma().gitLabInstance.update({
    where: { id: instanceId },
    data: { disabled_at: disabled ? new Date() : null },
    select: { id: true },
  });
}

/** Replace an instance's OAuth application (e.g. after the old one was deleted). */
export function updateCredentials(instanceId: string, clientId: string, clientSecret: string) {
  return getPrisma().gitLabInstance.update({
    where: { id: instanceId },
    data: { client_id: clientId, client_secret: encryptSecret(clientSecret) },
    select: { id: true },
  });
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

/**
 * Where an instance's project hooks deliver: GITLAB_WEBHOOK_URL for the
 * default instance, `<GITLAB_WEBHOOK_URL>/<instance id>` for a self-managed
 * one, so hook-station knows whose project and issue ids it is reading. Null
 * when webhooks aren't configured.
 */
export function webhookUrl(instanceId: string | null | undefined): string | null {
  const base = process.env.GITLAB_WEBHOOK_URL?.replace(/\/+$/, '');
  if (!base) return null;
  return instanceId ? `${base}/${instanceId}` : base;
}
