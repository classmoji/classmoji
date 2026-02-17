/**
 * MIME type detection utilities
 */

const MIME_TYPES = {
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',

  // Documents
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.txt': 'text/plain',

  // Code
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
};

/**
 * Get MIME type for a file based on extension
 * @param {string} filename - File name or path
 * @returns {string} MIME type or 'application/octet-stream' if unknown
 */
export function getMimeType(filename) {
  const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0];
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Check if a file is a binary file (vs text)
 * @param {string} filename - File name or path
 * @returns {boolean}
 */
export function isBinaryFile(filename) {
  const mimeType = getMimeType(filename);
  return (
    mimeType.startsWith('image/') ||
    mimeType === 'application/pdf' ||
    mimeType === 'application/octet-stream'
  );
}

/**
 * Check if a file is an image
 * @param {string} filename - File name or path
 * @returns {boolean}
 */
export function isImageFile(filename) {
  const mimeType = getMimeType(filename);
  return mimeType.startsWith('image/');
}
