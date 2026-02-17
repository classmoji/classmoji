/**
 * Content Proxy Utility
 *
 * Unified system for fetching content from GitHub repositories.
 * Uses a three-tier fallback strategy:
 * 1. GitHub Pages CDN (fast, but may get ECONNRESET from some cloud providers)
 * 2. GitHub Contents API (authenticated, immediate, but 1MB file size limit)
 * 3. GitHub Git Blobs API (authenticated, supports files up to 100MB)
 *
 * Note: raw.githubusercontent.com is blocked/rate-limited from Fly.io IPs,
 * so we use the authenticated Git Blobs API for large files instead.
 *
 * Used by:
 * - HTML slide content (loader)
 * - CSS/font assets (content proxy route)
 */

import { ContentService } from '@classmoji/content';

/**
 * Fetch content from GitHub with CDN-first strategy
 *
 * @param {Object} options
 * @param {string} options.org - GitHub organization login
 * @param {string} options.repo - Repository name
 * @param {string} options.path - File path within the repo
 * @param {boolean} [options.binary=false] - If true, returns Buffer instead of string
 * @returns {Promise<{content: string | Buffer, source: 'cdn' | 'api' | 'blob'} | null>}
 */
export async function fetchContent({ org, repo, path, binary = false }) {
  // Try GitHub Pages CDN first (may fail from some cloud providers due to IP blocking)
  const cdnUrl = `https://${org}.github.io/${repo}/${path}`;

  try {
    const response = await fetch(cdnUrl);
    if (response.ok) {
      const content = binary
        ? Buffer.from(await response.arrayBuffer())
        : await response.text();
      return { content, source: 'cdn' };
    }
    // CDN returned error (404, 500, etc.) - fall through to API
  } catch (err) {
    // Network error (likely ECONNRESET from Fly.io) - fall through to API
    console.log(`CDN fetch failed for ${path}: ${err.message}`);
  }

  // Fallback to GitHub API
  try {
    const result = await ContentService.getContent({
      orgLogin: org,
      repo,
      path,
      raw: binary, // For binary files, get raw base64 string without UTF-8 decoding
    });

    if (result?.content) {
      // For binary files: ContentService returns raw base64, decode to Buffer
      // For text files: ContentService returns decoded UTF-8 string
      const content = binary
        ? Buffer.from(result.content, 'base64')
        : result.content;
      return { content, source: 'api' };
    }
  } catch (apiErr) {
    console.error(`API fallback failed for ${path}:`, apiErr.message);
  }

  // Try Git Blobs API for large binary files (> 1MB Contents API limit)
  // Uses authenticated GitHub API which works from Fly.io (unlike raw.githubusercontent.com)
  // Git Blobs API supports files up to 100MB
  if (binary) {
    try {
      const result = await ContentService.getLargeContent({
        orgLogin: org,
        repo,
        path,
      });

      if (result?.content) {
        const content = Buffer.from(result.content, 'base64');
        return { content, source: 'blob' };
      }
    } catch (blobErr) {
      console.log(`Git Blob fetch failed for ${path}: ${blobErr.message}`);
    }
  }

  return null;
}

/**
 * Detect MIME type from binary content using magic bytes
 * @param {Buffer} content - The binary content to analyze
 * @returns {string | null} MIME type if detected, null otherwise
 */
export function detectMimeFromMagicBytes(content) {
  if (!content || content.length < 4) return null;

  // Check magic bytes for common image formats
  // JPEG: FF D8 FF
  if (content[0] === 0xFF && content[1] === 0xD8 && content[2] === 0xFF) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 (‰PNG)
  if (content[0] === 0x89 && content[1] === 0x50 && content[2] === 0x4E && content[3] === 0x47) {
    return 'image/png';
  }

  // GIF: 47 49 46 38 (GIF8)
  if (content[0] === 0x47 && content[1] === 0x49 && content[2] === 0x46 && content[3] === 0x38) {
    return 'image/gif';
  }

  // WebP: 52 49 46 46 ... 57 45 42 50 (RIFF...WEBP)
  if (content[0] === 0x52 && content[1] === 0x49 && content[2] === 0x46 && content[3] === 0x46 &&
      content.length >= 12 && content[8] === 0x57 && content[9] === 0x45 && content[10] === 0x42 && content[11] === 0x50) {
    return 'image/webp';
  }

  return null;
}

/**
 * Get the MIME type for a file based on extension
 * @param {string} path - File path
 * @param {Buffer} [content] - Optional content for magic byte detection (for extensionless files)
 * @returns {string} MIME type
 */
export function getMimeType(path, content) {
  const filename = path.split('/').pop() || '';
  // Get extension: only if filename contains a dot, take the part after the last dot
  const hasExtension = filename.includes('.');
  const ext = hasExtension ? filename.split('.').pop()?.toLowerCase() : null;

  const mimeTypes = {
    // Web content
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',

    // Fonts
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject',

    // Images
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',

    // Videos
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    ogg: 'video/ogg',
    m4v: 'video/x-m4v',

    // Audio
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    flac: 'audio/flac',
  };

  // If extension maps to a known type, use it
  if (ext && mimeTypes[ext]) {
    return mimeTypes[ext];
  }

  // For extensionless files in image folders, try magic byte detection
  if (content && path.includes('/images/') && !hasExtension) {
    const detectedMime = detectMimeFromMagicBytes(content);
    if (detectedMime) {
      return detectedMime;
    }
  }

  return 'application/octet-stream';
}

/**
 * Check if a file type should be treated as binary
 * @param {string} path - File path
 * @returns {boolean}
 */
export function isBinaryFile(path) {
  const filename = path.split('/').pop() || '';
  // Get extension: only if filename contains a dot, take the part after the last dot
  const hasExtension = filename.includes('.');
  const ext = hasExtension ? filename.split('.').pop()?.toLowerCase() : null;

  const binaryExtensions = [
    'woff', 'woff2', 'ttf', 'otf', 'eot',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico',
    'pdf', 'zip',
    'mp4', 'webm', 'mov', 'ogg', 'm4v',  // Videos
    'mp3', 'wav', 'm4a', 'aac', 'flac',  // Audio
  ];

  // Files with known binary extensions
  if (ext && binaryExtensions.includes(ext)) {
    return true;
  }

  // Extensionless files in /images/ folders are likely binary images
  // (slides.com exports sometimes have images without extensions)
  if (path.includes('/images/') && !hasExtension) {
    return true;
  }

  return false;
}

/**
 * Build the internal content proxy URL for a file
 * This is the URL that browsers will use to fetch assets
 *
 * @param {string} org - Organization login
 * @param {string} repo - Repository name
 * @param {string} path - File path within repo
 * @returns {string} URL path (relative to slides service origin)
 */
export function getContentProxyUrl(org, repo, path) {
  return `/content/${org}/${repo}/${path}`;
}

/**
 * Build theme CSS URLs using the content proxy
 * Replaces jsDelivr URLs with our internal proxy
 *
 * @param {string} org - Organization login
 * @param {string} repo - Repository name
 * @param {string} themePath - Path to theme folder (e.g., ".slidesthemes/my-theme")
 * @returns {{libCssUrl: string, customThemeUrl: string | null}}
 */
export function getThemeProxyUrls(org, repo, themePath) {
  return {
    libCssUrl: getContentProxyUrl(org, repo, `${themePath}/lib/offline-v2.css`),
    // customThemeUrl will be set by caller if it exists
  };
}
