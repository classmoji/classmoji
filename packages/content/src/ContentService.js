/**
 * ContentService - Write operations via GitHub API
 *
 * Reads go directly to GitHub Pages CDN (see urls.js)
 * Writes go through this service using the GitHub API
 */

import prisma from '@classmoji/database';
import { getGitProvider } from '@classmoji/services';
import { validateFile, sanitizeFilename } from './utils/validateFile.js';

// ─────────────────────────────────────────────────────────────────────────────
// Response Cache for GitHub Content API
// Prevents redundant API calls during rapid operations (e.g., tests)
// TTL: 60 seconds - short enough to avoid stale data, long enough to help tests
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Map<string, { data: any, expiresAt: number }>} */
const responseCache = new Map();
const CACHE_TTL = 60 * 1000; // 60 seconds

/**
 * Generate cache key from org, repo, and path
 * @param {string} org - Organization login
 * @param {string} repo - Repository name
 * @param {string} path - File/folder path
 * @returns {string}
 */
function getCacheKey(org, repo, path) {
  return `${org}:${repo}:${path}`;
}

/**
 * Get cached response if not expired
 * @param {string} key - Cache key
 * @returns {any | null}
 */
function getCache(key) {
  const cached = responseCache.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }
  responseCache.delete(key);
  return null;
}

/**
 * Store response in cache
 * @param {string} key - Cache key
 * @param {any} data - Data to cache
 */
function setCache(key, data) {
  responseCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL });
}

/**
 * Invalidate cache for a path and its parent folder
 * Called after write operations to ensure fresh reads
 * @param {string} org - Organization login
 * @param {string} repo - Repository name
 * @param {string} path - File/folder path that was modified
 */
function invalidateCache(org, repo, path) {
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
function isImagePath(path) {
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
async function resolveGitOrganization(gitOrganization, orgLogin) {
  // If gitOrganization is a valid object with provider, use it directly
  if (gitOrganization?.provider) {
    return gitOrganization;
  }

  // Fall back to looking up by orgLogin (assumes GITHUB provider)
  if (orgLogin) {
    const org = await prisma.gitOrganization.findFirst({
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
async function getOctokit(gitOrganization) {
  const provider = getGitProvider(gitOrganization);
  return provider.getOctokit();
}

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
  static async #withGitRetry(operation, { maxRetries = 5, baseDelay = 200 } = {}) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const isRaceCondition = error.status === 422 &&
          error.message?.includes('not a fast forward');

        if (!isRaceCondition || attempt === maxRetries) {
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
  }

  /**
   * Get file metadata (SHA) for optimistic locking
   * @param {Object} options
   * @param {Object} [options.gitOrganization] - GitOrganization record from database
   * @param {string} [options.orgLogin] - Organization login (fallback, assumes GITHUB)
   * @param {string} options.repo - Repository name
   * @param {string} options.path - File path
   * @param {boolean} [options.skipCache=false] - Skip cache (for write operations)
   * @returns {Promise<{ sha: string, size: number } | null>}
   */
  static async getMeta({ gitOrganization, orgLogin, repo, path, skipCache = false }) {
    try {
      const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);

      // Check cache first (unless explicitly skipped or is an image)
      const cacheKey = getCacheKey(resolvedOrg.login, repo, path);
      if (!skipCache && !isImagePath(path)) {
        const cached = getCache(cacheKey + ':meta');
        if (cached !== null) {
          return cached;
        }
      }

      const octokit = await getOctokit(resolvedOrg);
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: resolvedOrg.login,
        repo,
        path,
      });

      const result = {
        sha: data.sha,
        size: data.size,
      };

      // Cache the result (unless it's an image)
      if (!isImagePath(path)) {
        setCache(cacheKey + ':meta', result);
      }

      return result;
    } catch (error) {
      if (error.status === 404) {
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
   * @param {boolean} [options.raw=false] - If true, returns raw base64 string (for binary files)
   * @param {boolean} [options.skipCache=false] - Skip cache (for fetching latest content)
   * @returns {Promise<{ content: string, sha: string } | null>}
   */
  static async getContent({ gitOrganization, orgLogin, repo, path, raw = false, skipCache = false }) {
    try {
      const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);

      // Check cache first (unless explicitly skipped or is an image)
      // Images are excluded because they're large and rarely refetched
      const cacheKey = getCacheKey(resolvedOrg.login, repo, path);
      const cacheKeyWithRaw = raw ? cacheKey + ':content:raw' : cacheKey + ':content';
      if (!skipCache && !isImagePath(path)) {
        const cached = getCache(cacheKeyWithRaw);
        if (cached !== null) {
          return cached;
        }
      }

      const octokit = await getOctokit(resolvedOrg);
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: resolvedOrg.login,
        repo,
        path,
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

      // Cache the result (unless it's an image)
      if (!isImagePath(path)) {
        setCache(cacheKeyWithRaw, result);
      }

      return result;
    } catch (error) {
      if (error.status === 404) {
        return null;
      }
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
  static async getLargeContent({ gitOrganization, orgLogin, repo, path }) {
    try {
      const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);
      const octokit = await getOctokit(resolvedOrg);

      // Step 1: Get the file SHA from Contents API (metadata only, works for any size)
      const { data: fileData } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: resolvedOrg.login,
        repo,
        path,
      });

      // Step 2: Use Git Blobs API to fetch the actual content (supports up to 100MB)
      const { data: blobData } = await octokit.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', {
        owner: resolvedOrg.login,
        repo,
        file_sha: fileData.sha,
      });

      // Blobs API returns base64-encoded content
      return {
        content: blobData.content.replace(/\n/g, ''), // Strip newlines from base64
        sha: fileData.sha,
      };
    } catch (error) {
      if (error.status === 404) {
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
   * @param {string} [options.expectedSha] - Expected SHA for optimistic locking
   * @param {string} [options.message] - Commit message
   * @returns {Promise<{ sha: string, commit: string }>}
   * @throws {Error} 409 Conflict if expectedSha doesn't match
   */
  static async put({ gitOrganization, orgLogin, repo, path, content, expectedSha, message }) {
    const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);
    const octokit = await getOctokit(resolvedOrg);

    // Check current SHA if optimistic locking is requested
    if (expectedSha) {
      const current = await this.getMeta({ gitOrganization: resolvedOrg, repo, path });
      if (current && current.sha !== expectedSha) {
        const error = new Error('File was modified by someone else');
        error.status = 409;
        throw error;
      }
    }

    // Get current SHA for update (required by GitHub API)
    const existing = await this.getMeta({ gitOrganization: resolvedOrg, repo, path });

    const { data } = await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
      owner: resolvedOrg.login,
      repo,
      path,
      message: message || `Update ${path}`,
      content: Buffer.from(content).toString('base64'),
      sha: existing?.sha, // Required for updates, undefined for creates
    });

    // Invalidate cache for this path (and parent folder)
    invalidateCache(resolvedOrg.login, repo, path);

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
  static async upload({ gitOrganization, orgLogin, repo, file, filename, folder, branch = 'main', message }) {
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
  static async uploadLarge({ gitOrganization, repo, file, filePath, branch = 'main', message }) {
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
  static async delete({ gitOrganization, orgLogin, repo, path, message }) {
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
  static async exists({ gitOrganization, repo, path }) {
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
   * @param {boolean} [options.skipCache=false] - Skip cache
   * @returns {Promise<Array<{ name: string, path: string, type: 'file' | 'dir', sha: string }>>}
   */
  static async listFolder({ gitOrganization, orgLogin, repo, path, skipCache = false }) {
    try {
      const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);

      // Check cache first
      const cacheKey = getCacheKey(resolvedOrg.login, repo, path) + ':list';
      if (!skipCache) {
        const cached = getCache(cacheKey);
        if (cached !== null) {
          return cached;
        }
      }

      const octokit = await getOctokit(resolvedOrg);
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner: resolvedOrg.login,
        repo,
        path,
      });

      // GitHub returns array for directories, object for files
      if (!Array.isArray(data)) {
        return [];
      }

      const result = data.map(item => ({
        name: item.name,
        path: item.path,
        type: item.type === 'dir' ? 'dir' : 'file',
        sha: item.sha,
      }));

      // Cache the result
      setCache(cacheKey, result);

      return result;
    } catch (error) {
      if (error.status === 404) {
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
  static async findOrphanedImages({ gitOrganization, orgLogin, repo, imagesFolder, htmlContent, branch = 'main' }) {
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
  static async deleteMultiple({ gitOrganization, orgLogin, repo, paths, message }) {
    const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);
    let deleted = 0;
    const errors = [];

    for (const path of paths) {
      try {
        await this.delete({
          gitOrganization: resolvedOrg,
          repo,
          path,
          message: message || `Delete ${path}`,
        });
        deleted++;
      } catch (error) {
        errors.push(`${path}: ${error.message}`);
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
   * @returns {Promise<{ commit: string, filesUploaded: number }>}
   */
  static async uploadBatch({ gitOrganization, orgLogin, repo, files, branch = 'main', message, onProgress }) {
    if (!files || files.length === 0) {
      throw new Error('No files to upload');
    }

    const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);
    const octokit = await getOctokit(resolvedOrg);

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

      // Step 3: Get the tree SHA from the current commit
      const { data: commitData } = await octokit.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
        owner: resolvedOrg.login,
        repo,
        commit_sha: currentCommitSha,
      });
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
      };
    };

    const result = await this.#withGitRetry(gitOperation);

    // Invalidate cache for all uploaded files and their parent folders
    for (const file of files) {
      invalidateCache(resolvedOrg.login, repo, file.path);
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
  static async deleteFolder({ gitOrganization, orgLogin, repo, path, branch = 'main', message }) {
    const resolvedOrg = await resolveGitOrganization(gitOrganization, orgLogin);
    const octokit = await getOctokit(resolvedOrg);

    // Get all files in the folder recursively (done once, outside retry loop)
    const filesToDelete = [];

    async function collectFiles(folderPath) {
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
      } catch (error) {
        if (error.status !== 404) throw error;
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
      const { data: commitData } = await octokit.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
        owner: resolvedOrg.login,
        repo,
        commit_sha: currentCommitSha,
      });
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
  static async copyFolder({ gitOrganization, repo, sourcePath, destPath, message }) {
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
}
