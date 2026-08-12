/**
 * ContentService - Write operations via GitHub API
 *
 * Reads go directly to GitHub Pages CDN (see urls.js)
 * Writes go through this service using the GitHub API
 */

import getPrisma from '@classmoji/database';
import { getGitProvider } from '../git/index.ts';
import { validateFile, sanitizeFilename } from './utils/validateFile.ts';

interface GitOrganizationRecord {
  provider: string;
  login: string;
  github_installation_id?: string | null;
  access_token?: string | null;
  base_url?: string | null;
  gitlab_group_id?: string | null;
}

interface CacheEntry<T = unknown> {
  data: T;
  expiresAt: number;
}

interface RepositoryContentItem {
  name: string;
  path: string;
  type: string;
  sha: string;
  content?: string;
}

interface ErrorWithStatus {
  status?: number;
  message?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response Cache for GitHub Content API
// Prevents redundant API calls during rapid operations (e.g., tests)
// TTL: 60 seconds - short enough to avoid stale data, long enough to help tests
// ─────────────────────────────────────────────────────────────────────────────

const responseCache = new Map<string, CacheEntry>();
const CACHE_TTL = 60 * 1000; // 60 seconds

/**
 * Generate cache key from org, repo, and path
 * @param {string} org - Organization login
 * @param {string} repo - Repository name
 * @param {string} path - File/folder path
 * @returns {string}
 */
function getCacheKey(org: string, repo: string, path: string): string {
  return `${org}:${repo}:${path}`;
}

/**
 * Get cached response if not expired
 * @param {string} key - Cache key
 * @returns {any | null}
 */
function getCache<T>(key: string): T | null {
  const cached = responseCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data as T;
  }
  responseCache.delete(key);
  return null;
}

/**
 * Store response in cache
 * @param {string} key - Cache key
 * @param {any} data - Data to cache
 */
function setCache<T>(key: string, data: T): void {
  responseCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL });
}

/**
 * Invalidate cache for a path and its parent folder
 * Called after write operations to ensure fresh reads
 * @param {string} org - Organization login
 * @param {string} repo - Repository name
 * @param {string} path - File/folder path that was modified
 */
function invalidateCache(org: string, repo: string, path: string): void {
  // Invalidate all cache entries for this path
  // getContent uses ':content' and ':content:raw' suffixes
  // getMeta uses ':meta' suffix
  const key = getCacheKey(org, repo, path);
  responseCache.delete(key);
  responseCache.delete(key + ':meta');
  responseCache.delete(key + ':content');
  responseCache.delete(key + ':content:raw');

  // Invalidate parent folder (folder listings become stale after file changes)
  const parentPath = path.split('/').slice(0, -1).join('/');
  if (parentPath) {
    responseCache.delete(getCacheKey(org, repo, parentPath));
  }
}

/**
 * Check if a path looks like an image (skip caching for large binary files)
 * @param {string} path - File path
 * @returns {boolean}
 */
function isImagePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(ext || '');
}

/**
 * Helper to resolve gitOrganization from either:
 * - Full gitOrganization object (has .provider, .login, etc.)
 * - orgLogin string (org login name, assumes GITHUB provider)
 *
 * @param {Object|undefined} gitOrganization - Full gitOrganization object
 * @param {string|undefined} orgLogin - Organization login string (fallback)
 * @returns {Promise<Object>} - GitOrganization record
 */
async function resolveGitOrganization(
  gitOrganization: GitOrganizationRecord | undefined,
  orgLogin: string | undefined
): Promise<GitOrganizationRecord> {
  // If gitOrganization is a valid object with provider, use it directly
  if (gitOrganization?.provider) {
    return gitOrganization;
  }

  // Fall back to looking up by orgLogin (assumes GITHUB provider)
  if (orgLogin) {
    const org = await getPrisma().gitOrganization.findFirst({
      where: {
        provider: 'GITHUB',
        login: orgLogin,
      },
    });
    if (org) {
      return org;
    }
    throw new Error(`Git organization not found: ${orgLogin}`);
  }

  throw new Error('Either gitOrganization or orgLogin must be provided');
}

/**
 * Helper to get Octokit from git organization
 * ContentService methods need the raw Octokit for direct API calls
 */
async function getOctokit(gitOrganization: GitOrganizationRecord): Promise<any> {
  const provider = getGitProvider(gitOrganization);
  return provider.getOctokit();
}

const hasStatus = (error: unknown, status: number): boolean => {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as ErrorWithStatus).status === status
  );
};

const isGitRaceCondition = (error: unknown): error is ErrorWithStatus => {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    'message' in error &&
    (error as ErrorWithStatus).status === 422 &&
    Boolean((error as ErrorWithStatus).message?.includes('not a fast forward'))
  );
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class ContentService {
  /**
   * Execute Git Trees operation with retry on race condition
   * Uses exponential backoff with jitter to minimize collision probability
   * @private
   * @param {Function} operation - Async function that performs the Git Trees operation
   * @param {Object} [options] - Retry options
   * @param {number} [options.maxRetries=5] - Maximum retry attempts
   * @param {number} [options.baseDelay=200] - Base delay in ms (doubles each retry)
   * @returns {Promise<any>} - Result from the operation
   */
  static async #withGitRetry<T>(
    operation: () => Promise<T>,
    { maxRetries = 5, baseDelay = 200 }: { maxRetries?: number; baseDelay?: number } = {}
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: unknown) {
        if (!isGitRaceCondition(error) || attempt === maxRetries) {
          throw error;
        }

        console.warn(
          `[ContentService] Git race condition detected, retry ${attempt + 1}/${maxRetries}`
        );

        // Exponential backoff with jitter: 200-400ms, 400-800ms, 800-1600ms, etc.
        const delay = baseDelay * Math.pow(2, attempt);
        const jitter = Math.random() * delay; // 0-100% jitter
        await new Promise(r => setTimeout(r, delay + jitter));
      }
    }

    throw new Error('Git retry exhausted without returning a result');
  }

  /**
   * Get file metadata (SHA) for optimistic locking
   * @param {Object} options
   * @param {Object} [options.gitOrganization] - GitOrganization record from database
   * @param {string} [options.orgLogin] - Organization login (fallback, assumes GITHUB)
   * @param {string} options.repo - Repository name
   * @param {string} options.path - File path
   * @param {string} [options.ref] - Git ref (branch/tag/sha) to read from; bypasses the cache
   * @param {boolean} [options.skipCache=false] - Skip cache (for write operations)
   * @returns {Promise<{ sha: string, size: number } | null>}
   */
  static async getMeta({
    gitOrganization,
    orgLogin,
    repo,
    path,
    ref,
    skipCache = false,
  }: {
    gitOrganization?: GitOrganizationRecord;
    orgLogin?: string;
    repo: string;
    path: string;
    ref?: string;
    skipCache?: boolean;
  }): Promise<{ sha: string; size: number } | null> {
    try {
      const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);

      // Check cache first (unless explicitly skipped or is an image).
      // Ref-bearing reads bypass the cache entirely: the cache is keyed
      // org:repo:path (default branch only), so a branch read must never
      // serve — or be stored into — the default branch's entries.
      const cacheKey = getCacheKey(resolvedOrg.login, repo, path);
      if (!skipCache && !ref && !isImagePath(path)) {
        const cached = getCache<{ sha: string; size: number }>(cacheKey + ':meta');
        if (cached !== null) {
          return cached;
        }
      }

      const octokit = await getOctokit(resolvedOrg);
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: resolvedOrg.login,
        repo,
        path,
        ...(ref ? { ref } : {}),
      });

      const result = {
        sha: data.sha,
        size: data.size,
      };

      // Cache the result (unless it's an image or a ref-bearing read)
      if (!ref && !isImagePath(path)) {
        setCache(cacheKey + ':meta', result);
      }

      return result;
    } catch (error: unknown) {
      if (hasStatus(error, 404)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Get file content directly from GitHub API (bypasses CDN cache)
   * Use this when you need the latest version, e.g., for editing
   * @param {Object} options
   * @param {Object} [options.gitOrganization] - GitOrganization record from database
   * @param {string} [options.orgLogin] - Organization login (fallback, assumes GITHUB)
   * @param {string} options.repo - Repository name
   * @param {string} options.path - File path
   * @param {string} [options.ref] - Git ref (branch/tag/sha) to read from; bypasses the cache
   * @param {boolean} [options.raw=false] - If true, returns raw base64 string (for binary files)
   * @param {boolean} [options.skipCache=false] - Skip cache (for fetching latest content)
   * @returns {Promise<{ content: string, sha: string } | null>}
   */
  static async getContent({
    gitOrganization,
    orgLogin,
    repo,
    path,
    ref,
    raw = false,
    skipCache = false,
  }: {
    gitOrganization?: GitOrganizationRecord;
    orgLogin?: string;
    repo: string;
    path: string;
    ref?: string;
    raw?: boolean;
    skipCache?: boolean;
  }): Promise<{ content: string; sha: string } | null> {
    try {
      const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);

      // Check cache first (unless explicitly skipped or is an image)
      // Images are excluded because they're large and rarely refetched
      // Ref-bearing reads bypass the cache entirely (cache is keyed
      // org:repo:path for the default branch only)
      const cacheKey = getCacheKey(resolvedOrg.login, repo, path);
      const cacheKeyWithRaw = raw ? cacheKey + ':content:raw' : cacheKey + ':content';
      if (!skipCache && !ref && !isImagePath(path)) {
        const cached = getCache<{ content: string; sha: string }>(cacheKeyWithRaw);
        if (cached !== null) {
          return cached;
        }
      }

      const octokit = await getOctokit(resolvedOrg);
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: resolvedOrg.login,
        repo,
        path,
        ...(ref ? { ref } : {}),
      });

      // GitHub returns base64-encoded content for files
      // For binary files (raw=true), return the base64 string as-is
      // For text files, decode to UTF-8 string
      const content = raw
        ? data.content.replace(/\n/g, '') // GitHub adds newlines in base64, strip them
        : Buffer.from(data.content, 'base64').toString('utf-8');

      const result = {
        content,
        sha: data.sha,
      };

      // Cache the result (unless it's an image or a ref-bearing read)
      if (!ref && !isImagePath(path)) {
        setCache(cacheKeyWithRaw, result);
      }

      return result;
    } catch (error: unknown) {
      if (hasStatus(error, 404)) {
        const e = error as ErrorWithStatus & { request?: { url?: string }; message?: string };
        console.warn(
          `[ContentService.getContent] 404 for ${repo}/${path} url=${e.request?.url ?? '?'} msg=${e.message ?? '?'}`
        );
        return null;
      }
      // Log status + message only — the full error object carries request
      // headers (auth tokens) and payloads that must not land in logs.
      const e = error as ErrorWithStatus;
      console.error(
        `[ContentService.getContent] error for ${repo}/${path}: status=${e.status ?? '?'} msg=${e.message ?? '?'}`
      );
      throw error;
    }
  }

  /**
   * Get large file content using Git Blobs API (up to 100MB)
   * Use this for files > 1MB that exceed the Contents API limit
   * @param {Object} options
   * @param {Object} [options.gitOrganization] - GitOrganization record from database
   * @param {string} [options.orgLogin] - Organization login (fallback, assumes GITHUB)
   * @param {string} options.repo - Repository name
   * @param {string} options.path - File path
   * @returns {Promise<{ content: string, sha: string } | null>} - content is base64-encoded
   */
  static async getLargeContent({
    gitOrganization,
    orgLogin,
    repo,
    path,
  }: {
    gitOrganization?: GitOrganizationRecord;
    orgLogin?: string;
    repo: string;
    path: string;
  }): Promise<{ content: string; sha: string } | null> {
    try {
      const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);
      const octokit = await getOctokit(resolvedOrg);

      // Step 1: Get the file SHA from Contents API (metadata only, works for any size)
      const { data: fileData } = await octokit.request(
        'GET /repos/{owner}/{repo}/contents/{path}',
        {
          owner: resolvedOrg.login,
          repo,
          path,
        }
      );

      // Step 2: Use Git Blobs API to fetch the actual content (supports up to 100MB)
      const { data: blobData } = await octokit.request(
        'GET /repos/{owner}/{repo}/git/blobs/{file_sha}',
        {
          owner: resolvedOrg.login,
          repo,
          file_sha: fileData.sha,
        }
      );

      // Blobs API returns base64-encoded content
      return {
        content: blobData.content.replace(/\n/g, ''), // Strip newlines from base64
        sha: fileData.sha,
      };
    } catch (error: unknown) {
      if (hasStatus(error, 404)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Fetch a blob's decoded utf-8 content by its blob sha (Git Blobs API).
   * Blob shas are content-addressed — no ref is needed and the content can
   * never change under the sha, so this is the canonical way to read "the
   * file as it was when a conflict token was handed out" (content-tools plan
   * §3b Phase 7.5: the editor's stale token IS the 3-way merge base).
   *
   * Never cached (immutable content, read once per stale save).
   *
   * @param {Object} options
   * @param {Object} [options.gitOrganization] - GitOrganization record from database
   * @param {string} [options.orgLogin] - Organization login (fallback, assumes GITHUB)
   * @param {string} options.repo - Repository name
   * @param {string} options.sha - The blob sha to fetch
   * @returns {Promise<{ content: string, sha: string } | null>} - null when the
   *   blob does not exist in the repo (404, or GitHub's 422 for a malformed sha)
   */
  static async getBlobContent({
    gitOrganization,
    orgLogin,
    repo,
    sha,
  }: {
    gitOrganization?: GitOrganizationRecord;
    orgLogin?: string;
    repo: string;
    sha: string;
  }): Promise<{ content: string; sha: string } | null> {
    try {
      const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);
      const octokit = await getOctokit(resolvedOrg);
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', {
        owner: resolvedOrg.login,
        repo,
        file_sha: sha,
      });
      return {
        content: Buffer.from(data.content, 'base64').toString('utf-8'),
        sha,
      };
    } catch (error: unknown) {
      if (hasStatus(error, 404) || hasStatus(error, 422)) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create or update a text file
   * @param {Object} options
   * @param {Object} [options.gitOrganization] - GitOrganization record from database
   * @param {string} [options.orgLogin] - Organization login (fallback, assumes GITHUB)
   * @param {string} options.repo - Repository name
   * @param {string} options.path - File path
   * @param {string} options.content - File content
   * @param {string} [options.expectedSha] - Expected SHA for optimistic
   *   locking. Sent as the PUT's `sha` so GitHub enforces it ATOMICALLY
   *   (compare-and-swap, not check-then-act); the uncached pre-check only
   *   exists for a clear early 409 and the deleted-file case. Without it, the
   *   write adopts whatever sha a fresh read returns (last-writer-wins).
   * @param {string} [options.branch] - Branch to commit to (default: repository default branch)
   * @param {string} [options.message] - Commit message
   * @param {boolean} [options.createOnly] - Create-only write: no sha is ever
   *   sent (never updates), and GitHub's 422 "file exists" rejection is mapped
   *   to a 409 so callers can treat it as an existence race. Mutually
   *   exclusive with expectedSha.
   * @returns {Promise<{ sha: string, commit: string }>}
   * @throws {Error} 409 Conflict if expectedSha doesn't match, if the file was
   *   deleted since it was read (expectedSha given but file missing), or if a
   *   createOnly write finds the file already exists
   */
  static async put({
    gitOrganization,
    orgLogin,
    repo,
    path,
    content,
    expectedSha,
    branch,
    message,
    createOnly = false,
  }: {
    gitOrganization?: GitOrganizationRecord;
    orgLogin?: string;
    repo: string;
    path: string;
    content: string;
    expectedSha?: string;
    branch?: string;
    message?: string;
    createOnly?: boolean;
  }): Promise<{ sha: string; commit: string }> {
    const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);
    const octokit = await getOctokit(resolvedOrg);

    if (createOnly && expectedSha) {
      throw new Error('createOnly and expectedSha are mutually exclusive');
    }

    // Pre-check when optimistic locking is requested (branch writes check the
    // sha on that branch). skipCache is REQUIRED here: a cached read could
    // vouch for a sha that main has already moved past, and the check exists
    // to produce a clear, early 409 — GitHub enforces the real precondition
    // below. The deleted-file case (404) can only be caught here: a sha-bearing
    // PUT against a missing file is not a conflict to GitHub.
    if (expectedSha) {
      const current = await this.getMeta({
        gitOrganization: resolvedOrg,
        repo,
        path,
        ref: branch,
        skipCache: true,
      });
      if (!current) {
        // A sha was expected but the file is gone: deleted = changed. Silently
        // recreating would resurrect content the deleter meant to remove.
        const error = new Error('File was deleted since it was read') as Error & { status: number };
        error.status = 409;
        throw error;
      }
      if (current.sha !== expectedSha) {
        const error = new Error('File was modified by someone else') as Error & { status: number };
        error.status = 409;
        throw error;
      }
    }

    // Get current SHA for update (required by GitHub API) — only when the
    // caller did NOT lock: expectedSha writes send the caller's sha directly
    // so GitHub enforces it atomically (a second read here would adopt a
    // concurrent write and defeat the lock — check-then-act, not CAS).
    // createOnly writes send no sha, so GitHub itself enforces non-existence
    // (422 when the file materialized concurrently).
    const existing =
      createOnly || expectedSha
        ? null
        : await this.getMeta({ gitOrganization: resolvedOrg, repo, path, ref: branch });

    let response;
    try {
      response = await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
        owner: resolvedOrg.login,
        repo,
        path,
        message: message || `Update ${path}`,
        content: Buffer.from(content).toString('base64'),
        // expectedSha is the atomic precondition; otherwise the fresh read's
        // sha (required for updates), undefined for creates.
        sha: expectedSha ?? existing?.sha,
        ...(branch ? { branch } : {}),
      });
    } catch (error: unknown) {
      // Sha-less create against an existing file → GitHub 422. For createOnly
      // callers that's the existence race, surfaced with conflict semantics.
      if (createOnly && hasStatus(error, 422)) {
        const conflict = new Error(
          `File already exists: ${path} (create-only write refused)`
        ) as Error & { status: number };
        conflict.status = 409;
        throw conflict;
      }
      // GitHub rejected the expectedSha precondition: the file moved between
      // the pre-check and the PUT. It answers 409 Conflict, and (observed in
      // practice) 422 "sha … does not match" for the SAME mismatch — map both
      // to the same conflict so the caller never gets a raw 422.
      if (
        expectedSha &&
        (hasStatus(error, 409) ||
          (hasStatus(error, 422) && /does not match|sha/i.test(getErrorMessage(error))))
      ) {
        const conflict = new Error('File was modified by someone else') as Error & {
          status: number;
        };
        conflict.status = 409;
        throw conflict;
      }
      throw error;
    }

    // Concurrent-delete race (live-probed): with an expectedSha the pre-check
    // saw the file present, but it was DELETED before this PUT landed. GitHub
    // has no "update-only" mode — a sha-bearing PUT on a now-missing path
    // CREATES the file (HTTP 201) instead of conflicting, silently resurrecting
    // content the deleter removed. The create cannot be cheaply prevented (no
    // compare-and-swap-on-delete API), so we surface the delete as the same
    // conflict AFTER the unwanted create; the caller reloads and the stray file
    // is reconciled (overwritten/removed) on the next write.
    if (expectedSha && response.status === 201) {
      const conflict = new Error('File was deleted since it was read') as Error & {
        status: number;
      };
      conflict.status = 409;
      throw conflict;
    }

    const { data } = response;

    // Invalidate cache for this path (and parent folder).
    // Branch writes don't touch the default branch's content, so they must
    // not disturb its (org:repo:path-keyed) cache entries.
    if (!branch) {
      invalidateCache(resolvedOrg.login, repo, path);
    }

    return {
      sha: data.content.sha,
      commit: data.commit.sha,
    };
  }

  /**
   * Upload a binary file (image, PDF, etc.)
   * Automatically uses Git Blobs API for files > 1MB
   * @param {Object} options
   * @param {Object} [options.gitOrganization] - GitOrganization record from database
   * @param {string} [options.orgLogin] - Organization login (fallback, assumes GITHUB)
   * @param {string} options.repo - Repository name
   * @param {Buffer} options.file - File buffer
   * @param {string} options.filename - Original filename
   * @param {string} options.folder - Target folder path
   * @param {string} [options.branch] - Branch name (default: 'main')
   * @param {string} [options.message] - Commit message
   * @returns {Promise<{ path: string, sha: string, url: string }>}
   */
  static async upload({
    gitOrganization,
    orgLogin,
    repo,
    file,
    filename,
    folder,
    branch = 'main',
    message,
  }: {
    gitOrganization?: GitOrganizationRecord;
    orgLogin?: string;
    repo: string;
    file: Buffer;
    filename: string;
    folder: string;
    branch?: string;
    message?: string;
  }): Promise<{ path: string; sha: string; url: string }> {
    const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);

    // Validate file
    const validation = validateFile({ filename, size: file.length });
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    // Sanitize filename with timestamp
    const sanitizedFilename = sanitizeFilename(filename);
    const filePath = folder
      ? `${folder.replace(/\/$/, '')}/${sanitizedFilename}`
      : sanitizedFilename;

    // Use Git Blobs API for files > 1MB (Contents API limit)
    const ONE_MB = 1024 * 1024;
    if (file.length > ONE_MB) {
      return this.uploadLarge({
        gitOrganization: resolvedOrg,
        repo,
        file,
        filePath,
        branch,
        message: message || `Upload ${sanitizedFilename}`,
      });
    }

    const octokit = await getOctokit(resolvedOrg);

    const { data } = await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
      owner: resolvedOrg.login,
      repo,
      path: filePath,
      message: message || `Upload ${sanitizedFilename}`,
      content: file.toString('base64'),
    });

    // Invalidate cache for this path (and parent folder)
    invalidateCache(resolvedOrg.login, repo, filePath);

    // Return raw.githubusercontent.com URL for immediate availability
    // GitHub Pages CDN can take 1-2 minutes to propagate new files
    return {
      path: filePath,
      sha: data.content.sha,
      url: `https://raw.githubusercontent.com/${resolvedOrg.login}/${repo}/${branch}/${filePath}`,
    };
  }

  /**
   * Upload a large file (> 1MB) using Git Blobs API
   * This bypasses the Contents API's 1MB limit, supporting up to 100MB
   * @param {Object} options
   * @param {Object} options.gitOrganization - GitOrganization record from database
   * @param {string} options.repo - Repository name
   * @param {Buffer} options.file - File buffer
   * @param {string} options.filePath - Full file path (already sanitized)
   * @param {string} [options.branch] - Branch name (default: 'main')
   * @param {string} [options.message] - Commit message
   * @returns {Promise<{ path: string, sha: string, url: string }>}
   */
  static async uploadLarge({
    gitOrganization,
    repo,
    file,
    filePath,
    branch = 'main',
    message,
  }: {
    gitOrganization: GitOrganizationRecord;
    repo: string;
    file: Buffer;
    filePath: string;
    branch?: string;
    message?: string;
  }): Promise<{ path: string; sha: string; url: string }> {
    const octokit = await getOctokit(gitOrganization);

    // Step 1: Create the blob with file content (done once, content-addressed and idempotent)
    const { data: blob } = await octokit.request('POST /repos/{owner}/{repo}/git/blobs', {
      owner: gitOrganization.login,
      repo,
      content: file.toString('base64'),
      encoding: 'base64',
    });

    // Git Trees operation wrapped in retry logic for race condition handling
    const gitOperation = async () => {
      // Step 2: Get the current commit SHA for the branch (fresh on each attempt)
      const { data: refData } = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        owner: gitOrganization.login,
        repo,
        ref: `heads/${branch}`,
      });
      const currentCommitSha = refData.object.sha;

      // Step 3: Get the tree SHA from the current commit
      const { data: commitData } = await octokit.request(
        'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
        {
          owner: gitOrganization.login,
          repo,
          commit_sha: currentCommitSha,
        }
      );
      const baseTreeSha = commitData.tree.sha;

      // Step 4: Create a new tree with the blob
      const { data: treeData } = await octokit.request('POST /repos/{owner}/{repo}/git/trees', {
        owner: gitOrganization.login,
        repo,
        base_tree: baseTreeSha,
        tree: [
          {
            path: filePath,
            mode: '100644', // Regular file
            type: 'blob',
            sha: blob.sha,
          },
        ],
      });

      // Step 5: Create a new commit pointing to the new tree
      const { data: newCommit } = await octokit.request('POST /repos/{owner}/{repo}/git/commits', {
        owner: gitOrganization.login,
        repo,
        message: message || `Upload ${filePath}`,
        tree: treeData.sha,
        parents: [currentCommitSha],
      });

      // Step 6: Update the branch reference (this is where race condition can occur)
      await octokit.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
        owner: gitOrganization.login,
        repo,
        ref: `heads/${branch}`,
        sha: newCommit.sha,
      });

      return {
        path: filePath,
        sha: blob.sha,
        url: `https://raw.githubusercontent.com/${gitOrganization.login}/${repo}/${branch}/${filePath}`,
      };
    };

    const result = await this.#withGitRetry(gitOperation);

    // Invalidate cache for this path (and parent folder)
    invalidateCache(gitOrganization.login, repo, filePath);

    return result;
  }

  /**
   * Delete a file
   * @param {Object} options
   * @param {Object} [options.gitOrganization] - GitOrganization record from database
   * @param {string} [options.orgLogin] - Organization login (fallback, assumes GITHUB)
   * @param {string} options.repo - Repository name
   * @param {string} options.path - File path
   * @param {string} [options.message] - Commit message
   * @returns {Promise<{ commit: string }>}
   */
  static async delete({
    gitOrganization,
    orgLogin,
    repo,
    path,
    message,
  }: {
    gitOrganization?: GitOrganizationRecord;
    orgLogin?: string;
    repo: string;
    path: string;
    message?: string;
  }): Promise<{ commit: string }> {
    const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);
    const octokit = await getOctokit(resolvedOrg);

    // Get current SHA (required for delete)
    const existing = await this.getMeta({ gitOrganization: resolvedOrg, repo, path });
    if (!existing) {
      throw new Error(`File not found: ${path}`);
    }

    const { data } = await octokit.request('DELETE /repos/{owner}/{repo}/contents/{path}', {
      owner: resolvedOrg.login,
      repo,
      path,
      message: message || `Delete ${path}`,
      sha: existing.sha,
    });

    // Invalidate cache for this path (and parent folder)
    invalidateCache(resolvedOrg.login, repo, path);

    return {
      commit: data.commit.sha,
    };
  }

  /**
   * Check if a file or folder exists
   * @param {Object} options
   * @param {Object} options.gitOrganization - GitOrganization record from database
   * @param {string} options.repo - Repository name
   * @param {string} options.path - Path to check
   * @returns {Promise<boolean>}
   */
  static async exists({
    gitOrganization,
    repo,
    path,
  }: {
    gitOrganization: GitOrganizationRecord;
    repo: string;
    path: string;
  }): Promise<boolean> {
    const meta = await this.getMeta({ gitOrganization, repo, path });
    return meta !== null;
  }

  /**
   * Get folder contents (list files)
   * @param {Object} options
   * @param {Object} [options.gitOrganization] - GitOrganization record from database
   * @param {string} [options.orgLogin] - Organization login (fallback, assumes GITHUB)
   * @param {string} options.repo - Repository name
   * @param {string} options.path - Folder path
   * @param {string} [options.ref] - Git ref (branch/tag/sha) to read from; bypasses the cache
   * @param {boolean} [options.skipCache=false] - Skip cache
   * @returns {Promise<Array<{ name: string, path: string, type: 'file' | 'dir', sha: string }>>}
   */
  static async listFolder({
    gitOrganization,
    orgLogin,
    repo,
    path,
    ref,
    skipCache = false,
  }: {
    gitOrganization?: GitOrganizationRecord;
    orgLogin?: string;
    repo: string;
    path: string;
    ref?: string;
    skipCache?: boolean;
  }): Promise<Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string }>> {
    try {
      const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);

      // Check cache first (ref-bearing reads bypass the cache entirely —
      // it is keyed org:repo:path for the default branch only)
      const cacheKey = getCacheKey(resolvedOrg.login, repo, path) + ':list';
      if (!skipCache && !ref) {
        const cached =
          getCache<Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string }>>(
            cacheKey
          );
        if (cached !== null) {
          return cached;
        }
      }

      const octokit = await getOctokit(resolvedOrg);
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: resolvedOrg.login,
        repo,
        path,
        ...(ref ? { ref } : {}),
      });

      // GitHub returns array for directories, object for files
      if (!Array.isArray(data)) {
        return [];
      }

      const result: Array<{ name: string; path: string; type: 'file' | 'dir'; sha: string }> = (
        data as RepositoryContentItem[]
      ).map(item => ({
        name: item.name,
        path: item.path,
        type: item.type === 'dir' ? 'dir' : 'file',
        sha: item.sha,
      }));

      // Cache the result (not for ref-bearing reads)
      if (!ref) {
        setCache(cacheKey, result);
      }

      return result;
    } catch (error: unknown) {
      if (hasStatus(error, 404)) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Find orphaned images in a folder that aren't referenced in HTML content
   * @param {Object} options
   * @param {Object} [options.gitOrganization] - GitOrganization record from database
   * @param {string} [options.orgLogin] - Organization login (fallback, assumes GITHUB)
   * @param {string} options.repo - Repository name
   * @param {string} options.imagesFolder - Path to images folder
   * @param {string} options.htmlContent - HTML content to check for references
   * @param {string} [options.branch] - Branch name (default: 'main')
   * @returns {Promise<Array<{ name: string, path: string, url: string }>>}
   */
  static async findOrphanedImages({
    gitOrganization,
    orgLogin,
    repo,
    imagesFolder,
    htmlContent,
    branch = 'main',
  }: {
    gitOrganization?: GitOrganizationRecord;
    orgLogin?: string;
    repo: string;
    imagesFolder: string;
    htmlContent: string;
    branch?: string;
  }): Promise<Array<{ name: string; path: string; url: string }>> {
    const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);
    // List all files in the images folder
    const files = await this.listFolder({ gitOrganization: resolvedOrg, repo, path: imagesFolder });

    // Filter to only image files
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
    const imageFiles = files.filter(
      f => f.type === 'file' && imageExtensions.some(ext => f.name.toLowerCase().endsWith(ext))
    );

    if (imageFiles.length === 0) {
      return [];
    }

    // Find which images are referenced in the HTML
    // Check for both raw.githubusercontent.com and github.io URLs
    const orphaned = imageFiles.filter(file => {
      // Check if filename appears in HTML (could be in various URL formats)
      const filenameInHtml = htmlContent.includes(file.name);
      const fullPathInHtml = htmlContent.includes(file.path);
      return !filenameInHtml && !fullPathInHtml;
    });

    // Return with URLs for display
    return orphaned.map(file => ({
      name: file.name,
      path: file.path,
      url: `https://raw.githubusercontent.com/${resolvedOrg.login}/${repo}/${branch}/${file.path}`,
    }));
  }

  /**
   * Delete multiple files in a single operation
   * @param {Object} options
   * @param {Object} [options.gitOrganization] - GitOrganization record from database
   * @param {string} [options.orgLogin] - Organization login (fallback, assumes GITHUB)
   * @param {string} options.repo - Repository name
   * @param {string[]} options.paths - Array of file paths to delete
   * @param {string} [options.message] - Commit message
   * @returns {Promise<{ deleted: number, errors: string[] }>}
   */
  static async deleteMultiple({
    gitOrganization,
    orgLogin,
    repo,
    paths,
    message,
  }: {
    gitOrganization?: GitOrganizationRecord;
    orgLogin?: string;
    repo: string;
    paths: string[];
    message?: string;
  }): Promise<{ deleted: number; errors: string[] }> {
    const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);
    let deleted = 0;
    const errors: string[] = [];

    for (const path of paths) {
      try {
        await this.delete({
          gitOrganization: resolvedOrg,
          repo,
          path,
          message: message || `Delete ${path}`,
        });
        deleted++;
      } catch (error: unknown) {
        errors.push(`${path}: ${getErrorMessage(error)}`);
      }
    }

    return { deleted, errors };
  }

  /**
   * Upload multiple files in a single commit using Git Trees API.
   * This is much more efficient than individual uploads - 50 images = 1 commit instead of 50.
   * All files are uploaded atomically (all succeed or none).
   * @param {Object} options
   * @param {Object} [options.gitOrganization] - GitOrganization record from database
   * @param {string} [options.orgLogin] - Organization login (fallback, assumes GITHUB)
   * @param {string} options.repo - Repository name
   * @param {Array<{path: string, content: string, encoding?: 'utf-8' | 'base64'}>} options.files - Files to upload
   * @param {string} [options.branch] - Branch name (default: 'main')
   * @param {string} [options.message] - Commit message
   * @returns {Promise<{ commit: string, filesUploaded: number, files: Array<{ path: string, sha: string }> }>}
   *   `files` carries each file's blob sha (identical to the Contents-API file
   *   sha), so callers can compare against future getMeta reads.
   */
  static async uploadBatch({
    gitOrganization,
    orgLogin,
    repo,
    files,
    branch = 'main',
    message,
    onProgress,
    verifyBaseTree,
    primeCache = false,
    allowRootCommit = false,
  }: {
    gitOrganization?: GitOrganizationRecord;
    orgLogin?: string;
    repo: string;
    files: Array<{ path: string; content: string; encoding?: 'utf-8' | 'base64' }>;
    branch?: string;
    message?: string;
    onProgress?: (progress: {
      current: number;
      total: number;
      filename: string | undefined;
    }) => void;
    /**
     * Opt-in read-after-write coherence: on success (default-branch writes
     * only), store each utf-8 file's { content, sha } into the response cache
     * getContent reads, so a same-process read immediately after the commit
     * sees the new content despite GitHub's Contents-API replication lag.
     */
    primeCache?: boolean;
    /**
     * Optimistic-concurrency hook, run on EVERY retry attempt against the
     * commit the new tree will be based on. `getFileSha(path)` returns the
     * blob sha of `path` at that base commit (null if absent). Throw to abort
     * the write — unlike put(), the Trees API has no per-file precondition and
     * #withGitRetry would otherwise retry PAST a concurrent commit, so this is
     * the only way to make batch writes a true compare-and-swap.
     */
    verifyBaseTree?: (ctx: {
      getFileSha: (path: string) => Promise<string | null>;
    }) => Promise<void>;
    /**
     * Allow writing into a repository that has NO commits yet. Until an initial
     * commit exists GitHub answers 409 "Git Repository is empty" to the whole
     * Git Data API — `POST /git/blobs` included — so a root commit cannot be
     * assembled at all. The only endpoint that works on an empty repo is the
     * Contents API, so this seeds `files[0]` through it (creating `branch`,
     * which becomes the repo's default) and then runs the normal batch path.
     * Off by default — every existing caller writes to a branch that exists,
     * where a missing ref is a real error worth surfacing.
     */
    allowRootCommit?: boolean;
  }): Promise<{
    commit: string;
    filesUploaded: number;
    files: Array<{ path: string; sha: string }>;
  }> {
    if (!files || files.length === 0) {
      throw new Error('No files to upload');
    }

    const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);
    const octokit = await getOctokit(resolvedOrg);

    // Step 0 (opt-in): give an EMPTY repository its initial commit, because
    // every Git Data API call below — starting with blob creation — answers
    // 409 "Git Repository is empty" until one exists. Passing `branch`
    // explicitly makes the seed create that branch, so the result does not
    // depend on the org's default-branch-name setting.
    if (allowRootCommit) {
      let repositoryIsEmpty = false;
      try {
        await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
          owner: resolvedOrg.login,
          repo,
          ref: `heads/${branch}`,
        });
      } catch (error: unknown) {
        // 409 is specifically "no commits yet". A 404 here means the REPO has
        // commits but this branch is missing — a real error, left to surface.
        if (!hasStatus(error, 409)) throw error;
        repositoryIsEmpty = true;
      }
      if (repositoryIsEmpty) {
        const seed = files[0]!;
        await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
          owner: resolvedOrg.login,
          repo,
          path: seed.path,
          message: message || `Upload ${files.length} files`,
          content:
            (seed.encoding ?? 'utf-8') === 'base64'
              ? seed.content
              : Buffer.from(seed.content).toString('base64'),
          branch,
        });
        // The seed file is re-written identically by the batch below, so the
        // final tree is exactly `files` either way.
      }
    }

    // Step 1: Create blobs for all files in parallel (done once, content-addressed and idempotent)
    // Track progress as each blob completes
    let completedCount = 0;
    const totalFiles = files.length;

    const blobResults = await Promise.all(
      files.map(async ({ path, content, encoding = 'utf-8' }) => {
        const { data } = await octokit.request('POST /repos/{owner}/{repo}/git/blobs', {
          owner: resolvedOrg.login,
          repo,
          content: encoding === 'base64' ? content : Buffer.from(content).toString('base64'),
          encoding: 'base64',
        });

        // Report progress after each blob is created
        completedCount++;
        if (onProgress) {
          onProgress({
            current: completedCount,
            total: totalFiles,
            filename: path.split('/').pop(), // Just the filename
          });
        }

        return { path, sha: data.sha };
      })
    );

    // Git Trees operation wrapped in retry logic for race condition handling
    const gitOperation = async () => {
      // Step 2: Get current commit SHA for the branch (fresh on each attempt)
      const { data: refData } = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        owner: resolvedOrg.login,
        repo,
        ref: `heads/${branch}`,
      });
      const currentCommitSha = refData.object.sha;

      // Optimistic-concurrency check against THIS attempt's base commit —
      // must re-run per retry or a retry would silently clobber the very
      // concurrent commit that caused the ref race.
      if (verifyBaseTree) {
        await verifyBaseTree({
          getFileSha: async (path: string) => {
            try {
              const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner: resolvedOrg.login,
                repo,
                path,
                ref: currentCommitSha,
              });
              return Array.isArray(data) ? null : (data.sha ?? null);
            } catch (error) {
              if ((error as { status?: number }).status === 404) return null;
              throw error;
            }
          },
        });
      }

      // Step 3: Get the tree SHA from the current commit
      const { data: commitData } = await octokit.request(
        'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
        {
          owner: resolvedOrg.login,
          repo,
          commit_sha: currentCommitSha,
        }
      );
      const baseTreeSha = commitData.tree.sha;

      // Step 4: Create a new tree with all blobs
      const { data: treeData } = await octokit.request('POST /repos/{owner}/{repo}/git/trees', {
        owner: resolvedOrg.login,
        repo,
        base_tree: baseTreeSha,
        tree: blobResults.map(({ path, sha }) => ({
          path,
          mode: '100644', // Regular file
          type: 'blob',
          sha,
        })),
      });

      // Step 5: Create a new commit pointing to the new tree
      const { data: newCommit } = await octokit.request('POST /repos/{owner}/{repo}/git/commits', {
        owner: resolvedOrg.login,
        repo,
        message: message || `Upload ${files.length} files`,
        tree: treeData.sha,
        parents: [currentCommitSha],
      });

      // Step 6: Update the branch reference (this is where race condition can occur)
      await octokit.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
        owner: resolvedOrg.login,
        repo,
        ref: `heads/${branch}`,
        sha: newCommit.sha,
      });

      return {
        commit: newCommit.sha,
        filesUploaded: files.length,
        files: blobResults.map(({ path, sha }) => ({ path, sha })),
      };
    };

    const result = await this.#withGitRetry(gitOperation);

    // Invalidate cache for all uploaded files and their parent folders
    for (const file of files) {
      invalidateCache(resolvedOrg.login, repo, file.path);
    }

    // Prime the response cache with the just-written content (default branch
    // only — the cache is keyed org:repo:path for the default branch). Runs
    // AFTER invalidation so the fresh entries survive.
    if (primeCache && branch === 'main') {
      const shaByPath = new Map(result.files.map(f => [f.path, f.sha]));
      for (const file of files) {
        if ((file.encoding ?? 'utf-8') !== 'utf-8' || isImagePath(file.path)) continue;
        const sha = shaByPath.get(file.path);
        if (!sha) continue;
        setCache(getCacheKey(resolvedOrg.login, repo, file.path) + ':content', {
          content: file.content,
          sha,
        });
      }
    }

    return result;
  }

  /**
   * Delete an entire folder and its contents in a single commit
   * Uses Git Trees API for atomic deletion
   * @param {Object} options
   * @param {Object} [options.gitOrganization] - GitOrganization record from database
   * @param {string} [options.orgLogin] - Organization login (fallback, assumes GITHUB)
   * @param {string} options.repo - Repository name
   * @param {string} options.path - Folder path to delete
   * @param {string} [options.branch] - Branch name (default: 'main')
   * @param {string} [options.message] - Commit message
   * @returns {Promise<{ commit: string, filesDeleted: number }>}
   */
  static async deleteFolder({
    gitOrganization,
    orgLogin,
    repo,
    path,
    branch = 'main',
    message,
  }: {
    gitOrganization?: GitOrganizationRecord;
    orgLogin?: string;
    repo: string;
    path: string;
    branch?: string;
    message?: string;
  }): Promise<{ commit: string | null; filesDeleted: number }> {
    const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);
    const octokit = await getOctokit(resolvedOrg);

    // Get all files in the folder recursively (done once, outside retry loop)
    const filesToDelete: string[] = [];

    async function collectFiles(folderPath: string) {
      try {
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
          owner: resolvedOrg.login,
          repo,
          path: folderPath,
        });

        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item.type === 'dir') {
            await collectFiles(item.path);
          } else {
            filesToDelete.push(item.path);
          }
        }
      } catch (error: unknown) {
        if (!hasStatus(error, 404)) throw error;
      }
    }

    await collectFiles(path);

    if (filesToDelete.length === 0) {
      return { commit: null, filesDeleted: 0 };
    }

    // Git Trees operation wrapped in retry logic for race condition handling
    const gitOperation = async () => {
      // Step 1: Get current commit SHA for the branch (fresh on each attempt)
      const { data: refData } = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
        owner: resolvedOrg.login,
        repo,
        ref: `heads/${branch}`,
      });
      const currentCommitSha = refData.object.sha;

      // Step 2: Get the tree SHA from the current commit
      const { data: commitData } = await octokit.request(
        'GET /repos/{owner}/{repo}/git/commits/{commit_sha}',
        {
          owner: resolvedOrg.login,
          repo,
          commit_sha: currentCommitSha,
        }
      );
      const baseTreeSha = commitData.tree.sha;

      // Step 3: Create a new tree with files removed (sha: null deletes the file)
      const { data: treeData } = await octokit.request('POST /repos/{owner}/{repo}/git/trees', {
        owner: resolvedOrg.login,
        repo,
        base_tree: baseTreeSha,
        tree: filesToDelete.map(filePath => ({
          path: filePath,
          mode: '100644',
          type: 'blob',
          sha: null, // null SHA means delete
        })),
      });

      // Step 4: Create a new commit pointing to the new tree
      const { data: newCommit } = await octokit.request('POST /repos/{owner}/{repo}/git/commits', {
        owner: resolvedOrg.login,
        repo,
        message: message || `Delete folder ${path}`,
        tree: treeData.sha,
        parents: [currentCommitSha],
      });

      // Step 5: Update the branch reference (this is where race condition can occur)
      await octokit.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
        owner: resolvedOrg.login,
        repo,
        ref: `heads/${branch}`,
        sha: newCommit.sha,
      });

      return {
        commit: newCommit.sha,
        filesDeleted: filesToDelete.length,
      };
    };

    const result = await this.#withGitRetry(gitOperation);

    // Invalidate cache for all deleted files and the folder itself
    for (const filePath of filesToDelete) {
      invalidateCache(resolvedOrg.login, repo, filePath);
    }
    // Also invalidate the folder path itself
    invalidateCache(resolvedOrg.login, repo, path);

    return result;
  }

  /**
   * Copy contents from one folder to another (for templates)
   * @param {Object} options
   * @param {Object} options.gitOrganization - GitOrganization record from database
   * @param {string} options.repo - Repository name
   * @param {string} options.sourcePath - Source folder path
   * @param {string} options.destPath - Destination folder path
   * @param {string} [options.message] - Commit message
   * @returns {Promise<{ copied: number }>}
   */
  static async copyFolder({
    gitOrganization,
    repo,
    sourcePath,
    destPath,
    message,
  }: {
    gitOrganization: GitOrganizationRecord;
    repo: string;
    sourcePath: string;
    destPath: string;
    message?: string;
  }): Promise<{ copied: number }> {
    const octokit = await getOctokit(gitOrganization);

    // Get all files in source folder
    const sourceFiles = await this.listFolder({ gitOrganization, repo, path: sourcePath });
    let copied = 0;

    for (const item of sourceFiles) {
      if (item.type === 'file') {
        // Fetch file content
        const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
          owner: gitOrganization.login,
          repo,
          path: item.path,
        });

        // Determine new path
        const relativePath = item.path.slice(sourcePath.length).replace(/^\//, '');
        const newPath = `${destPath}/${relativePath}`;

        // Create file at destination
        await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
          owner: gitOrganization.login,
          repo,
          path: newPath,
          message: message || `Copy ${item.name} from template`,
          content: data.content, // Already base64 encoded
        });

        copied++;
      } else if (item.type === 'dir') {
        // Recursively copy subdirectories
        const relativePath = item.path.slice(sourcePath.length).replace(/^\//, '');
        const result = await this.copyFolder({
          gitOrganization,
          repo,
          sourcePath: item.path,
          destPath: `${destPath}/${relativePath}`,
          message,
        });
        copied += result.copied;
      }
    }

    return { copied };
  }

  /**
   * Create a branch (Git ref) pointing at an existing commit
   * Thin wrapper over POST /repos/{owner}/{repo}/git/refs
   * @param {Object} options
   * @param {Object} [options.gitOrganization] - GitOrganization record from database
   * @param {string} [options.orgLogin] - Organization login (fallback, assumes GITHUB)
   * @param {string} options.repo - Repository name
   * @param {string} options.branch - Branch name to create (without refs/heads/ prefix)
   * @param {string} options.fromSha - Commit sha the new branch points at
   * @returns {Promise<{ ref: string, sha: string }>}
   */
  static async createBranch({
    gitOrganization,
    orgLogin,
    repo,
    branch,
    fromSha,
  }: {
    gitOrganization?: GitOrganizationRecord;
    orgLogin?: string;
    repo: string;
    branch: string;
    fromSha: string;
  }): Promise<{ ref: string; sha: string }> {
    const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);
    const octokit = await getOctokit(resolvedOrg);

    const { data } = await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
      owner: resolvedOrg.login,
      repo,
      ref: `refs/heads/${branch}`,
      sha: fromSha,
    });

    return {
      ref: data.ref,
      sha: data.object.sha,
    };
  }

  /**
   * Delete a branch (Git ref)
   * Thin wrapper over DELETE /repos/{owner}/{repo}/git/refs/{ref}
   * @param {Object} options
   * @param {Object} [options.gitOrganization] - GitOrganization record from database
   * @param {string} [options.orgLogin] - Organization login (fallback, assumes GITHUB)
   * @param {string} options.repo - Repository name
   * @param {string} options.branch - Branch name to delete (without refs/heads/ prefix)
   * @returns {Promise<{ deleted: boolean }>}
   */
  static async deleteBranch({
    gitOrganization,
    orgLogin,
    repo,
    branch,
  }: {
    gitOrganization?: GitOrganizationRecord;
    orgLogin?: string;
    repo: string;
    branch: string;
  }): Promise<{ deleted: boolean }> {
    const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);
    const octokit = await getOctokit(resolvedOrg);

    await octokit.request('DELETE /repos/{owner}/{repo}/git/refs/{ref}', {
      owner: resolvedOrg.login,
      repo,
      ref: `heads/${branch}`,
    });

    return { deleted: true };
  }

  /**
   * Merge one branch into another via the GitHub merge API
   * Thin wrapper over POST /repos/{owner}/{repo}/merges
   *
   * Note: after a successful merge into the default branch, cached reads for
   * the merged paths may be stale for up to the cache TTL — sha-bearing reads
   * after a merge should pass skipCache.
   *
   * @param {Object} options
   * @param {Object} [options.gitOrganization] - GitOrganization record from database
   * @param {string} [options.orgLogin] - Organization login (fallback, assumes GITHUB)
   * @param {string} options.repo - Repository name
   * @param {string} options.base - Branch to merge into (e.g. 'main')
   * @param {string} options.head - Branch to merge from
   * @param {string} [options.message] - Commit message for the merge commit
   * @returns {Promise<{ merged: boolean, sha?: string, conflict?: boolean }>}
   *   - `{ merged: true, sha }` — merge commit created
   *   - `{ merged: true }` — base already contains head (nothing to merge, HTTP 204)
   *   - `{ merged: false, conflict: true }` — merge conflict (HTTP 409)
   *   Other errors (missing base/head, permissions, …) are thrown.
   */
  static async mergeBranch({
    gitOrganization,
    orgLogin,
    repo,
    base,
    head,
    message,
  }: {
    gitOrganization?: GitOrganizationRecord;
    orgLogin?: string;
    repo: string;
    base: string;
    head: string;
    message?: string;
  }): Promise<{ merged: boolean; sha?: string; conflict?: boolean }> {
    const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);
    const octokit = await getOctokit(resolvedOrg);

    try {
      const response = await octokit.request('POST /repos/{owner}/{repo}/merges', {
        owner: resolvedOrg.login,
        repo,
        base,
        head,
        ...(message ? { commit_message: message } : {}),
      });

      // 204: base already contains head — nothing to merge
      if (response.status === 204 || !response.data) {
        return { merged: true };
      }

      return { merged: true, sha: response.data.sha };
    } catch (error: unknown) {
      // 409: merge conflict — surfaced distinctly so callers can branch on it
      if (hasStatus(error, 409)) {
        return { merged: false, conflict: true };
      }
      throw error;
    }
  }

  /**
   * Compare two branches (or any two refs)
   * Thin wrapper over GET /repos/{owner}/{repo}/compare/{base}...{head}
   *
   * Returns `null` when the comparison 404s (head — or base — branch does not
   * exist), matching the getMeta/getContent idiom. Callers probing for a
   * preview branch treat `null` as "branch absent".
   *
   * Comparing a branch against itself (base === head) is a cheap way to get
   * that branch's HEAD commit sha (`base_sha`) without a separate refs call.
   *
   * @param {Object} options
   * @param {Object} [options.gitOrganization] - GitOrganization record from database
   * @param {string} [options.orgLogin] - Organization login (fallback, assumes GITHUB)
   * @param {string} options.repo - Repository name
   * @param {string} options.base - Base ref (e.g. 'main')
   * @param {string} options.head - Head ref (e.g. 'preview/pages/syllabus')
   * @returns {Promise<{ ahead_by, behind_by, base_sha, head_sha, merge_base_sha, commits } | null>}
   *   - `ahead_by` / `behind_by` — commit counts head is ahead of / behind base
   *   - `base_sha` / `head_sha` — HEAD commit shas of the two refs
   *   - `merge_base_sha` — the merge-base commit sha (for 3-way content reads)
   *   - `commits` — the commits head has that base lacks, oldest first,
   *     as `{ sha, date }` (committer date, ISO string)
   */
  static async compareBranches({
    gitOrganization,
    orgLogin,
    repo,
    base,
    head,
  }: {
    gitOrganization?: GitOrganizationRecord;
    orgLogin?: string;
    repo: string;
    base: string;
    head: string;
  }): Promise<{
    ahead_by: number;
    behind_by: number;
    base_sha: string;
    head_sha: string;
    merge_base_sha: string | null;
    commits: Array<{ sha: string; date: string | null }>;
  } | null> {
    const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);
    const octokit = await getOctokit(resolvedOrg);

    try {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
        owner: resolvedOrg.login,
        repo,
        basehead: `${base}...${head}`,
      });

      interface CompareCommit {
        sha: string;
        commit?: { committer?: { date?: string }; author?: { date?: string } };
      }

      return {
        ahead_by: data.ahead_by,
        behind_by: data.behind_by,
        base_sha: data.base_commit.sha,
        // The compare payload has no head_commit field: when head is ahead its
        // HEAD is the last listed commit; otherwise (identical or strictly
        // behind) head's HEAD IS the merge base.
        head_sha: data.commits?.length
          ? data.commits[data.commits.length - 1].sha
          : (data.merge_base_commit?.sha ?? data.base_commit.sha),
        merge_base_sha: data.merge_base_commit?.sha ?? null,
        commits: ((data.commits ?? []) as CompareCommit[]).map(item => ({
          sha: item.sha,
          date: item.commit?.committer?.date ?? item.commit?.author?.date ?? null,
        })),
      };
    } catch (error: unknown) {
      if (hasStatus(error, 404)) {
        return null;
      }
      throw error;
    }
  }
}
