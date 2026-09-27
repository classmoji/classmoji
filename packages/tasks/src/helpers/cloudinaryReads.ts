/**
 * The migration's live READS: the Cloudinary Admin API listing, the deck and
 * classroom rows, and the deck files in each content repo. Shared by the
 * Trigger task (dry run and execute alike) and the dry-run CLI.
 *
 * ## Why this module imports neither `@classmoji/services` nor `@classmoji/database`
 *
 * `@classmoji/database` builds its Prisma client from `DATABASE_URL` the moment
 * it is imported, and every services module imports it. The dry-run CLI runs
 * against production through ONE read-only connection it opens itself, so the
 * Prisma client is injected here and nothing on this path may reach for the
 * global one. That is also why the Pro rule and the live-rows rule are restated
 * below instead of called: both originals read through `getPrisma()`. Tests pin
 * them to the services' constants.
 *
 * ## Every call here is a read
 *
 * - Prisma: `slide.findMany`, `classroom.findMany`, `mediaObject.findMany`.
 * - Cloudinary: `GET /v1_1/{cloud}/resources/video/upload` (Admin API, basic auth).
 * - GitHub: `GET /repos/{o}/{r}/contents/{path}` (default branch and the deck's
 *   preview branch) and `GET /repos/{o}/{r}/git/blobs/{sha}` for files over the
 *   Contents API's 1 MB inline limit. The one non-GET is the token mint,
 *   `POST /app/installations/{id}/access_tokens`, which asks for
 *   `{ contents: 'read' }` only — the token itself cannot write.
 */

import jwt from 'jsonwebtoken';

import {
  CLOUDINARY_PREFIX,
  type ClassroomFacts,
  type CloudinaryAsset,
  type DeckFile,
  type DeckRead,
  type DeckRecord,
  type PlanReadDeps,
} from './cloudinaryPlan.ts';

type Fetch = typeof fetch;

// ─────────────────────────────────────────────────────────────────────────────
// Cloudinary Admin API
// ─────────────────────────────────────────────────────────────────────────────

export interface CloudinaryCredentials {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/** The existing env names (see the removed slides `cloudinaryService.server.ts`). */
export function cloudinaryCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): CloudinaryCredentials {
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  const apiKey = env.CLOUDINARY_API_KEY;
  const apiSecret = env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      'CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET are required'
    );
  }
  return { cloudName, apiKey, apiSecret };
}

/** The Admin API's ceiling for `max_results` on the resources listing. */
const PAGE_SIZE = 500;
/** A runaway cursor loop stops here (500 × 200 = 100k assets). */
const MAX_PAGES = 200;

interface AdminResource {
  public_id?: unknown;
  format?: unknown;
  bytes?: unknown;
  version?: unknown;
  secure_url?: unknown;
  created_at?: unknown;
}

/**
 * Every video under `classmoji/slides/`, following `next_cursor` to the end.
 * Resources missing a field the migration needs are refused loudly rather than
 * dropped: a silently shorter inventory is the failure worth avoiding.
 */
export async function listCloudinaryVideos(
  creds: CloudinaryCredentials,
  fetchImpl: Fetch = fetch
): Promise<CloudinaryAsset[]> {
  const auth = Buffer.from(`${creds.apiKey}:${creds.apiSecret}`).toString('base64');
  const out: CloudinaryAsset[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(
      `https://api.cloudinary.com/v1_1/${encodeURIComponent(creds.cloudName)}/resources/video/upload`
    );
    url.searchParams.set('prefix', CLOUDINARY_PREFIX);
    url.searchParams.set('max_results', String(PAGE_SIZE));
    if (cursor) url.searchParams.set('next_cursor', cursor);

    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`Cloudinary list failed: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { resources?: AdminResource[]; next_cursor?: unknown };
    for (const resource of body.resources ?? []) {
      const { public_id, format, bytes, version, secure_url, created_at } = resource;
      if (
        typeof public_id !== 'string' ||
        typeof format !== 'string' ||
        typeof bytes !== 'number' ||
        typeof secure_url !== 'string'
      ) {
        throw new Error(`Cloudinary returned an incomplete resource: ${JSON.stringify(resource)}`);
      }
      out.push({
        publicId: public_id,
        format: format.toLowerCase(),
        bytes,
        version: typeof version === 'number' ? version : 0,
        secureUrl: secure_url,
        createdAt: typeof created_at === 'string' ? created_at : null,
      });
    }
    cursor = typeof body.next_cursor === 'string' && body.next_cursor ? body.next_cursor : null;
    if (!cursor) return out;
  }
  throw new Error(`Cloudinary listing did not end after ${MAX_PAGES} pages`);
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub, read-only
// ─────────────────────────────────────────────────────────────────────────────

export interface GitHubAppCredentials {
  appId: string;
  privateKeyPem: string;
}

export function gitHubAppCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env
): GitHubAppCredentials {
  const appId = env.GITHUB_APP_ID;
  const encoded = env.GITHUB_PRIVATE_KEY_BASE64;
  if (!appId || !encoded) {
    throw new Error('GITHUB_APP_ID and GITHUB_PRIVATE_KEY_BASE64 are required');
  }
  return { appId, privateKeyPem: Buffer.from(encoded, 'base64').toString('utf8') };
}

export interface RepoFile {
  sha: string;
  text: string;
}

export interface GitHubReader {
  /** A file's utf-8 text and blob sha, or null when it (or the ref) is absent. */
  readFile(
    installationId: string,
    owner: string,
    repo: string,
    path: string,
    ref?: string
  ): Promise<RepoFile | null>;
}

const GITHUB_API = 'https://api.github.com';
const TOKEN_SKEW_MS = 5 * 60 * 1000;

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * A reader that only ever GETs. Tokens are minted per installation with
 * `permissions: { contents: 'read' }`, cached until five minutes before they
 * expire.
 */
export function createGitHubReader(
  creds: GitHubAppCredentials,
  fetchImpl: Fetch = fetch
): GitHubReader {
  const tokens = new Map<string, { token: string; expiresAtMs: number }>();
  const minting = new Map<string, Promise<string>>();

  async function mint(installationId: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const appJwt = jwt.sign(
      { iat: now - 30, exp: now + 9 * 60, iss: creds.appId },
      creds.privateKeyPem,
      {
        algorithm: 'RS256',
      }
    );
    const response = await fetchImpl(
      `${GITHUB_API}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${appJwt}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ permissions: { contents: 'read' } }),
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (!response.ok) throw new Error(`GitHub token mint failed: HTTP ${response.status}`);
    const body = (await response.json()) as { token?: string; expires_at?: string };
    if (!body.token) throw new Error('GitHub token mint returned no token');
    const expiresAtMs = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 50 * 60 * 1000;
    tokens.set(installationId, { token: body.token, expiresAtMs });
    return body.token;
  }

  async function tokenFor(installationId: string): Promise<string> {
    const cached = tokens.get(installationId);
    if (cached && Date.now() < cached.expiresAtMs - TOKEN_SKEW_MS) return cached.token;
    const pending =
      minting.get(installationId) ??
      mint(installationId).finally(() => minting.delete(installationId));
    minting.set(installationId, pending);
    return pending;
  }

  async function get(installationId: string, url: string): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      const token = await tokenFor(installationId);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        if (attempt >= 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      const after = Number(response.headers.get('retry-after'));
      const shortWait = Number.isFinite(after) && after > 0 && after <= 60;
      // A secondary rate limit is a 403 with `retry-after`; worth one short wait.
      const retriable =
        response.status >= 500 || response.status === 429 || (response.status === 403 && shortWait);
      if (!retriable || attempt >= 3) return response;
      await new Promise(resolve => setTimeout(resolve, shortWait ? after * 1000 : 1000 * attempt));
    }
  }

  return {
    async readFile(installationId, owner, repo, path, ref) {
      const base = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const response = await get(installationId, `${base}/contents/${encodePath(path)}${query}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`GitHub read of ${path} failed: HTTP ${response.status}`);
      const data = (await response.json()) as {
        type?: string;
        sha?: string;
        content?: string;
        encoding?: string;
      };
      if (data.type !== 'file' || !data.sha) return null;
      if (data.encoding === 'base64' && typeof data.content === 'string') {
        return { sha: data.sha, text: Buffer.from(data.content, 'base64').toString('utf8') };
      }
      // Over 1 MB the Contents API answers with `encoding: "none"` and no body.
      const blob = await get(installationId, `${base}/git/blobs/${encodeURIComponent(data.sha)}`);
      if (!blob.ok) throw new Error(`GitHub blob read of ${path} failed: HTTP ${blob.status}`);
      const blobData = (await blob.json()) as { content?: string };
      const base64 = String(blobData.content ?? '').replace(/\n/g, '');
      return { sha: data.sha, text: Buffer.from(base64, 'base64').toString('utf8') };
    },
  };
}

/** `preview/<content_path>` — `previewBranchName` in slides services. */
export function previewBranchFor(contentPath: string): string {
  return `preview/${contentPath}`;
}

/**
 * A deck's files: `deck.json` and `index.html` on the default branch, and
 * `deck.json` on its preview branch (preview branches carry source only).
 */
export async function readDeckFiles(
  reader: GitHubReader,
  deck: DeckRecord,
  classroom: ClassroomFacts | undefined,
  installationId: string | null
): Promise<DeckRead> {
  const none = (reason: string): DeckRead => ({
    files: [],
    previewFiles: [],
    previewBranch: null,
    unscanned: reason,
  });
  if (!classroom) return none('classroom not found');
  if (classroom.gitProvider !== 'GITHUB')
    return none(`provider ${classroom.gitProvider ?? 'none'}`);
  if (!installationId) return none('no GitHub App installation');
  if (!classroom.gitOrgLogin || !classroom.contentRepo) return none('no content repo');

  const owner = classroom.gitOrgLogin;
  const repo = classroom.contentRepo;
  const files: DeckFile[] = [];
  for (const name of ['deck.json', 'index.html']) {
    const path = `${deck.contentPath}/${name}`;
    const file = await reader.readFile(installationId, owner, repo, path);
    if (file) files.push({ path, sha: file.sha, text: file.text });
  }
  if (files.length === 0) return none('no deck.json or index.html');

  const branch = previewBranchFor(deck.contentPath);
  const previewPath = `${deck.contentPath}/deck.json`;
  const preview = await reader.readFile(installationId, owner, repo, previewPath, branch);
  return {
    files,
    previewFiles: preview ? [{ path: previewPath, sha: preview.sha, text: preview.text }] : [],
    previewBranch: preview ? branch : null,
    unscanned: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Database reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Prisma surface these reads use — three `findMany`s, nothing else. A
 * PrismaClient satisfies it; tests pass fakes. No write method is reachable
 * through this type.
 */
export interface ReadPrisma {
  slide: { findMany(args: unknown): Promise<unknown[]> };
  classroom: { findMany(args: unknown): Promise<unknown[]> };
  mediaObject: { findMany(args: unknown): Promise<unknown[]> };
}

/** `RESERVATION_WINDOW_MS` in services `mediaQuota.ts` (pinned by a test). */
export const RESERVATION_WINDOW_MS = 24 * 60 * 60 * 1000;
/** `PRO_QUOTA_BYTES` in services `mediaQuota.ts` (pinned by a test). */
export const PRO_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;

export interface OwnerSubscription {
  tier: string;
  ends_at: Date | string | null;
}

function isActive(subscription: OwnerSubscription, now: number): boolean {
  if (subscription.ends_at === null || subscription.ends_at === undefined) return true;
  const ends = new Date(subscription.ends_at).getTime();
  return !Number.isNaN(ends) && ends > now;
}

/**
 * `getProStateForClassroomId`'s two rules, over the owners' latest
 * subscriptions in oldest-owner-first order: any owner with an active PRO wins;
 * otherwise the oldest owner's row decides. A null `ends_at` is open-ended.
 */
export function isProFromOwners(
  latestByOwner: (OwnerSubscription | null)[],
  now: number = Date.now()
): boolean {
  if (latestByOwner.some(sub => sub?.tier === 'PRO' && isActive(sub, now))) return true;
  const oldest = latestByOwner[0];
  return Boolean(oldest && oldest.tier === 'PRO' && isActive(oldest, now));
}

interface LiveRow {
  classroom_id: string;
  size_bytes: bigint | number;
  rendition_bytes: bigint | number | null;
  original_deleted_at: Date | null;
}

/** `billedBytes` in services `mediaLookup.ts`. */
export function billedBytes(row: Omit<LiveRow, 'classroom_id'>): number {
  if (row.original_deleted_at !== null && row.rendition_bytes !== null) {
    return Number(row.rendition_bytes);
  }
  return Number(row.size_bytes);
}

export async function listDeckRecords(prisma: ReadPrisma): Promise<DeckRecord[]> {
  const rows = (await prisma.slide.findMany({
    where: { kind: 'DECK' },
    select: { id: true, classroom_id: true, title: true, content_path: true, created_by: true },
    orderBy: [{ classroom_id: 'asc' }, { id: 'asc' }],
  })) as {
    id: string;
    classroom_id: string;
    title: string;
    content_path: string;
    created_by: string;
  }[];
  return rows.map(row => ({
    slideId: row.id,
    classroomId: row.classroom_id,
    title: row.title,
    contentPath: row.content_path,
    createdBy: row.created_by,
  }));
}

export interface ClassroomReadResult {
  facts: ClassroomFacts[];
  /** classroomId → GitHub App installation id (kept out of the plan output). */
  installations: Map<string, string | null>;
}

/**
 * Facts for every classroom that has a deck — archived and lapsed included,
 * nothing filtered by status. `git_organizations.access_token` is never
 * selected.
 */
export async function readClassroomFacts(
  prisma: ReadPrisma,
  classroomIds: string[],
  now: number = Date.now()
): Promise<ClassroomReadResult> {
  if (classroomIds.length === 0) return { facts: [], installations: new Map() };
  const rows = (await prisma.classroom.findMany({
    where: { id: { in: classroomIds } },
    select: {
      id: true,
      slug: true,
      name: true,
      is_archived: true,
      status: true,
      content_repo: true,
      content_delivery_enabled: true,
      git_organization: {
        select: { provider: true, login: true, github_installation_id: true },
      },
      memberships: {
        where: { role: 'OWNER', has_accepted_invite: true },
        orderBy: { created_at: 'asc' },
        select: {
          user: {
            select: {
              subscriptions: {
                orderBy: { created_at: 'desc' },
                take: 1,
                select: { tier: true, ends_at: true },
              },
            },
          },
        },
      },
    },
  })) as {
    id: string;
    slug: string;
    name: string;
    is_archived: boolean;
    status: string;
    content_repo: string | null;
    content_delivery_enabled: boolean | null;
    git_organization: {
      provider: string;
      login: string;
      github_installation_id: string | null;
    } | null;
    memberships: { user: { subscriptions: OwnerSubscription[] } }[];
  }[];

  // Before the media release reaches a database, `media_objects` does not
  // exist there (Prisma P2021). A dry run is still meaningful then: nothing
  // has been stored yet, so every classroom's usage is zero.
  const live = (await prisma.mediaObject
    .findMany({
      where: {
        classroom_id: { in: classroomIds },
        OR: [
          { status: 'READY' },
          {
            status: { in: ['UPLOADING', 'STAGING'] },
            created_at: { gte: new Date(now - RESERVATION_WINDOW_MS) },
          },
        ],
      },
      select: {
        classroom_id: true,
        size_bytes: true,
        rendition_bytes: true,
        original_deleted_at: true,
      },
    })
    .catch((error: unknown) => {
      if ((error as { code?: string } | null)?.code === 'P2021') return [];
      throw error;
    })) as LiveRow[];
  const used = new Map<string, number>();
  for (const row of live) {
    used.set(row.classroom_id, (used.get(row.classroom_id) ?? 0) + billedBytes(row));
  }

  const installations = new Map<string, string | null>();
  const facts = rows.map(row => {
    installations.set(row.id, row.git_organization?.github_installation_id ?? null);
    return {
      classroomId: row.id,
      slug: row.slug,
      name: row.name,
      isArchived: row.is_archived,
      status: row.status,
      isPro: isProFromOwners(
        row.memberships.map(m => m.user.subscriptions[0] ?? null),
        now
      ),
      usedBytes: used.get(row.id) ?? 0,
      canServeMedia:
        row.content_delivery_enabled === true &&
        Boolean(row.content_repo) &&
        Boolean(row.git_organization?.login),
      gitProvider: row.git_organization?.provider ?? null,
      gitOrgLogin: row.git_organization?.login ?? null,
      contentRepo: row.content_repo,
    };
  });
  return { facts, installations };
}

/** The live read deps, over an injected Prisma client and injected fetch. */
export function createLiveReadDeps(opts: {
  prisma: ReadPrisma;
  cloudinary: CloudinaryCredentials;
  github: GitHubAppCredentials;
  proQuotaBytes?: number;
  fetchImpl?: Fetch;
  concurrency?: number;
  log?: PlanReadDeps['log'];
}): PlanReadDeps {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const reader = createGitHubReader(opts.github, fetchImpl);
  const installations = new Map<string, string | null>();
  return {
    cloudName: opts.cloudinary.cloudName,
    proQuotaBytes: opts.proQuotaBytes ?? PRO_QUOTA_BYTES,
    concurrency: opts.concurrency ?? 4,
    log: opts.log,
    listCloudinaryAssets: () => listCloudinaryVideos(opts.cloudinary, fetchImpl),
    listDecks: () => listDeckRecords(opts.prisma),
    classroomFacts: async ids => {
      const result = await readClassroomFacts(opts.prisma, ids);
      for (const [id, installation] of result.installations) installations.set(id, installation);
      return result.facts;
    },
    readDeck: (deck, classroom) =>
      readDeckFiles(reader, deck, classroom, installations.get(deck.classroomId) ?? null),
  };
}
