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
import { tasks } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import { escapeHtml, appUrl } from '../emails/escape.ts';
import { GITLAB_COM, GITLAB_PROJECTS_SUBGROUP, normalizeGitlabHost } from '@classmoji/utils';

export interface GitLabOAuthClient {
  /** Null for the default instance. */
  instanceId: string | null;
  host: string;
  clientId: string;
  clientSecret: string;
}

export class GitLabInstanceError extends Error {
  code:
    | 'not_configured'
    | 'not_found'
    | 'disabled'
    | 'pending'
    | 'invalid_host'
    | 'unreachable'
    | 'exists';
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
  if (!row.approved_at) {
    throw new GitLabInstanceError('pending', `${row.host} is waiting for Classmoji's approval`);
  }
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
): Promise<{ id: string | null; host: string; disabled: boolean; pending: boolean } | null> {
  const host = normalizeHost(input);
  if (!host) return null;
  if (host === defaultHost()) {
    return defaultConfigured() ? { id: null, host, disabled: false, pending: false } : null;
  }
  const row = await getPrisma().gitLabInstance.findUnique({
    where: { host },
    select: { id: true, host: true, disabled_at: true, approved_at: true },
  });
  return row
    ? {
        id: row.id,
        host: row.host,
        disabled: Boolean(row.disabled_at),
        pending: !row.approved_at,
      }
    : null;
}

/** An instance's public face (never its secret), for the sign-in page. */
export async function findPublic(instanceId: string) {
  const row = await getPrisma().gitLabInstance.findUnique({
    where: { id: instanceId },
    select: { id: true, host: true, disabled_at: true, approved_at: true },
  });
  return row && row.approved_at && !row.disabled_at ? { id: row.id, host: row.host } : null;
}

// ─── Registering an instance ─────────────────────────────────────────────────

/**
 * The addresses Classmoji's servers call out from (CLASSMOJI_EGRESS_IPS,
 * comma-separated), for a school whose GitLab only accepts known IPs.
 */
export function egressIps(): string[] {
  return (process.env.CLASSMOJI_EGRESS_IPS ?? '')
    .split(',')
    .map(ip => ip.trim())
    .filter(Boolean);
}

/** " Ask your IT team to allow …" when the IPs are known, else "". */
function allowlistHint(): string {
  const ips = egressIps();
  return ips.length
    ? ` If it's only reachable on your campus network, ask your IT team to allow Classmoji's addresses: ${ips.join(', ')}.`
    : '';
}

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
      `${hostname} is not reachable from the internet, so Classmoji can't connect to it.${allowlistHint()}`
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
    throw new GitLabInstanceError(
      'unreachable',
      `Classmoji couldn't reach a Gitlab at ${host}.${allowlistHint()}`
    );
  }
  if (typeof issuer !== 'string' || normalizeHost(issuer) !== host) {
    throw new GitLabInstanceError('unreachable', `${host} doesn't look like a Gitlab`);
  }
  return host;
}

/** Who asked for an instance, from their Gitlab profile at setup. */
export interface InstanceRequester {
  name: string | null;
  username: string | null;
  email: string | null;
  emailConfirmed: boolean;
  isAdmin: boolean;
  since: Date | null;
  note: string | null;
}

/**
 * Store a new instance, PENDING: nobody can sign in through it until a
 * platform admin approves it (never automatic). Called only after an OAuth
 * round trip with these credentials succeeded, which proves they work and
 * that the requester has an account on that Gitlab.
 *
 * Why approval: the OAuth application belongs to whoever made it on that
 * Gitlab, and everyone at the school signs in through it. Its owner can
 * revoke it (breaking sign-in) or add a redirect address of their own and
 * collect people's tokens, so a platform admin vets the requester first.
 */
export async function create(input: {
  host: string;
  clientId: string;
  clientSecret: string;
  createdByUserId: string | null;
  requester?: InstanceRequester;
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
        requester_name: input.requester?.name ?? null,
        requester_username: input.requester?.username ?? null,
        requester_email: input.requester?.email ?? null,
        requester_email_confirmed: input.requester?.emailConfirmed ?? false,
        requester_is_admin: input.requester?.isAdmin ?? false,
        requester_since: input.requester?.since ?? null,
        request_note: input.requester?.note ?? null,
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
      approved_at: true,
      created_at: true,
      requester_name: true,
      requester_username: true,
      requester_email: true,
      requester_email_confirmed: true,
      requester_is_admin: true,
      requester_since: true,
      request_note: true,
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

/** Approve a pending instance: sign-in through it opens, and the requester is told. */
export async function approve(instanceId: string) {
  const row = await getPrisma().gitLabInstance.update({
    where: { id: instanceId },
    data: { approved_at: new Date() },
    select: { host: true, requester_email: true, requester_name: true },
  });
  await emailRequester(row, true);
  return row;
}

/**
 * Decline a pending instance. The row is deleted (a pending instance has no
 * users, connections or classrooms), so the host can be requested again, and
 * the requester is told. An approved instance is turned off instead.
 */
export async function reject(instanceId: string) {
  const row = await getPrisma().gitLabInstance.findUnique({
    where: { id: instanceId },
    select: { host: true, approved_at: true, requester_email: true, requester_name: true },
  });
  if (!row) return null;
  if (row.approved_at) {
    throw new GitLabInstanceError('exists', `${row.host} is approved; turn it off instead`);
  }
  await getPrisma().gitLabInstance.delete({ where: { id: instanceId } });
  await emailRequester(row, false);
  return row;
}

// ─── Approval emails ─────────────────────────────────────────────────────────

function platformAdminIds(): string[] {
  return (process.env.PLATFORM_ADMIN_USER_IDS ?? '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);
}

/** Queue an email; best-effort (approval never hinges on mail). */
async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  try {
    await tasks.trigger('send_email', { to, subject, html });
  } catch (error: unknown) {
    console.error('[gitlabInstance] could not queue email', error);
  }
}

/** Tell every platform admin a Gitlab is waiting for approval. */
export async function notifyAdminsOfRequest(host: string, requester: InstanceRequester) {
  const ids = platformAdminIds();
  if (ids.length === 0) {
    console.warn(`[gitlabInstance] ${host} awaits approval, but PLATFORM_ADMIN_USER_IDS is empty`);
    return;
  }
  const admins = await getPrisma().user.findMany({
    where: { id: { in: ids }, email: { not: null } },
    select: { email: true },
  });
  const adminUrl = (process.env.ADMIN_URL || '').replace(/\/+$/, '');
  const who = [requester.name, requester.username ? `@${requester.username}` : null]
    .filter(Boolean)
    .join(' ');
  const html = [
    `<p>A Gitlab is waiting for your approval before anyone can sign in through it.</p>`,
    `<p><b>${escapeHtml(host)}</b><br/>`,
    `Requested by ${escapeHtml(who || 'unknown')}`,
    requester.email
      ? ` (${escapeHtml(requester.email)}${requester.emailConfirmed ? ', confirmed' : ', not confirmed'})`
      : '',
    requester.isAdmin ? `<br/>They are an administrator of this Gitlab.` : '',
    `</p>`,
    requester.note ? `<p>Their note: ${escapeHtml(requester.note)}</p>` : '',
    adminUrl
      ? `<p><a href="${escapeHtml(adminUrl)}/gitlab-instances">Review it in Classmoji Admin</a></p>`
      : '',
  ].join('');
  for (const admin of admins) {
    await sendEmail(admin.email as string, `Gitlab approval needed: ${host}`, html);
  }
}

async function emailRequester(
  row: { host: string; requester_email: string | null; requester_name: string | null },
  approved: boolean
) {
  if (!row.requester_email) return;
  const hello = row.requester_name ? `Hi ${escapeHtml(row.requester_name)},` : 'Hi,';
  const html = approved
    ? (() => {
        const link = `${appUrl()}/?gitlab=${encodeURIComponent(new URL(row.host).host)}`;
        return `<p>${hello}</p><p>${escapeHtml(row.host)} is now connected to Classmoji, and anyone with an account on it can sign in.</p><p>Share this sign-in link with your students (on the syllabus or course site) so they land on the right Gitlab without typing anything:<br/><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p>Classroom invite links pick your Gitlab automatically too.</p>`;
      })()
    : `<p>${hello}</p><p>We could not approve connecting ${escapeHtml(row.host)} to Classmoji. Reply to this email or write to hello@classmoji.io and we will sort it out with you.</p>`;
  await sendEmail(
    row.requester_email,
    approved ? `${row.host} is ready on Classmoji` : `About your Gitlab request for ${row.host}`,
    html
  );
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
 * Where project hooks deliver: GITLAB_WEBHOOK_URL, the same for every
 * instance. hook-station tells instances apart by the host in each payload's
 * project URL, so a relay (smee) that can't carry an extra path still works.
 * Null when webhooks aren't configured.
 */
export function webhookUrl(_instanceId?: string | null): string | null {
  return process.env.GITLAB_WEBHOOK_URL?.replace(/\/+$/, '') || null;
}

// ─── Health ──────────────────────────────────────────────────────────────────

export interface InstanceHealth {
  reachable: boolean;
  error: string | null;
  /** Student and content projects whose hooks were checked (sampled). */
  projectsChecked: number;
  missingHooks: number;
  failingHooks: number;
  /** A few affected projects, for the admin to look at. */
  examples: string[];
}

const HEALTH_SAMPLE = 60;

/**
 * Is an instance reachable, and do its classrooms' projects still carry a
 * working Classmoji webhook? Checks up to HEALTH_SAMPLE projects, newest
 * classrooms first. Imports the provider lazily (it imports this module).
 */
export async function checkHealth(instanceId: string): Promise<InstanceHealth> {
  const health: InstanceHealth = {
    reachable: false,
    error: null,
    projectsChecked: 0,
    missingHooks: 0,
    failingHooks: 0,
    examples: [],
  };
  const row = await getPrisma().gitLabInstance.findUnique({
    where: { id: instanceId },
    select: { host: true },
  });
  if (!row) return { ...health, error: 'Instance not found' };
  try {
    await probe(row.host);
    health.reachable = true;
  } catch (error: unknown) {
    health.error = error instanceof Error ? error.message : String(error);
    return health;
  }

  const url = webhookUrl();
  if (!url) return { ...health, error: 'GITLAB_WEBHOOK_URL is not set' };

  const { getGitProvider } = await import('../git/index.ts');
  const classrooms = await getPrisma().classroom.findMany({
    where: {
      is_archived: false,
      git_namespace: { not: null },
      git_organization: { gitlab_instance_id: instanceId },
    },
    orderBy: { created_at: 'desc' },
    select: {
      git_namespace: true,
      git_organization: true,
      git_repos: { where: { provider: 'GITLAB' }, select: { name: true } },
    },
  });

  for (const classroom of classrooms) {
    if (health.projectsChecked >= HEALTH_SAMPLE) break;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let provider: any;
    try {
      provider = getGitProvider(classroom.git_organization);
    } catch {
      continue;
    }
    for (const repo of classroom.git_repos) {
      if (health.projectsChecked >= HEALTH_SAMPLE) break;
      health.projectsChecked += 1;
      const group = `${classroom.git_namespace}/${GITLAB_PROJECTS_SUBGROUP}`;
      const project = `${group}/${repo.name}`;
      try {
        const status = await provider.getClassmojiHookStatus(
          group,
          repo.name,
          url
        );
        if (status === 'ok') continue;
        if (status === 'missing') health.missingHooks += 1;
        else health.failingHooks += 1;
        if (health.examples.length < 5) health.examples.push(`${project} (${status})`);
      } catch {
        health.missingHooks += 1;
        if (health.examples.length < 5) health.examples.push(`${project} (unreadable)`);
      }
    }
  }
  return health;
}
