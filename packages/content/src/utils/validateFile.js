/**
 * File validation utilities for content uploads
 */

// Maximum file size: 5 MB
export const MAX_FILE_SIZE = 5 * 1024 * 1024;

// Allowed file extensions for uploads
export const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf'];

/**
 * Validate a file for upload
 * @param {Object} options
 * @param {string} options.filename - Original filename
 * @param {number} options.size - File size in bytes
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateFile({ filename, size }) {
  // Check file size
  if (size > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024} MB`,
    };
  }

  // Check extension
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (!ext || !ALLOWED_EXTENSIONS.includes(ext)) {
    return {
      valid: false,
      error: `Invalid file type. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
    };
  }

  return { valid: true };
}

/**
 * Sanitize a filename for safe storage
 * Removes special characters, preserves extension
 * @param {string} filename - Original filename
 * @returns {string} Sanitized filename with timestamp prefix
 */
export function sanitizeFilename(filename) {
  // Extract extension
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';

  // Get base name without extension
  const baseName = filename.slice(0, filename.length - ext.length);

  // Sanitize: lowercase, replace spaces and special chars with dashes
  const sanitized = baseName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50); // Limit length

  // Add timestamp prefix for uniqueness
  const timestamp = Date.now();

  return `${timestamp}-${sanitized}${ext}`;
}
