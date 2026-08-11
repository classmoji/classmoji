/**
 * @classmoji/content - Content management for GitHub-backed storage
 *
 * Thin re-export shim: the implementation moved into @classmoji/services
 * (packages/services/src/content/). Existing `import { ContentService } from
 * '@classmoji/content'` sites keep working unchanged; new code should import
 * from '@classmoji/services' directly.
 */

export {
  // Write operations via GitHub API
  ContentService,
  // URL builders for reading content from GitHub Pages
  getContentUrl,
  getSlideContentUrl,
  getRawContentUrl,
  // Validation utilities
  validateFile,
  sanitizeFilename,
  MAX_FILE_SIZE,
  ALLOWED_EXTENSIONS,
  // Content type utilities
  getMimeType,
  isBinaryFile,
  isImageFile,
} from '@classmoji/services';
