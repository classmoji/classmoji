/**
 * @classmoji/content - Content management for GitHub-backed storage
 *
 * Reads go directly to GitHub Pages CDN (fast, cached)
 * Writes go through GitHub API via ContentService
 */

// URL builders for reading content from GitHub Pages
export { getContentUrl, getSlideContentUrl, getRawContentUrl } from './urls.ts';

// Write operations via GitHub API
export { ContentService } from './ContentService.ts';

// Validation utilities
export {
  validateFile,
  sanitizeFilename,
  MAX_FILE_SIZE,
  ALLOWED_EXTENSIONS,
} from './utils/validateFile.ts';

// Content type utilities
export { getMimeType, isBinaryFile, isImageFile } from './utils/contentType.ts';
