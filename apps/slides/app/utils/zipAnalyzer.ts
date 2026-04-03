/**
 * ZIP Analyzer - Client-side utility for analyzing ZIP files
 *
 * Analyzes ZIP files in the browser to detect videos without extracting
 * the full contents. This is fast because ZIP files have a central directory
 * at the end that lists all files with their metadata.
 *
 * Used during import to let users choose which videos to upload to Cloudinary.
 */

import JSZip from 'jszip';

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'ogg', 'm4v'];
const SIZE_THRESHOLD = 5 * 1024 * 1024; // 5MB

export interface VideoInfo {
  path: string;
  filename: string;
  size: number;
  ext: string;
  suggestCloudinary: boolean;
}

/**
 * Analyze a ZIP file for video content without extracting
 */
export async function analyzeZipForVideos(file: File): Promise<VideoInfo[]> {
  // loadAsync reads the ZIP central directory (at end of file)
  // This does NOT decompress file contents - just parses the file listing
  const zip = await JSZip.loadAsync(file);

  const videos: VideoInfo[] = [];

  for (const [path, zipEntry] of Object.entries(zip.files)) {
    // Skip directories
    if (zipEntry.dir) continue;

    // Check if it's a video file
    const ext = path.split('.').pop()?.toLowerCase() || '';
    if (!VIDEO_EXTENSIONS.includes(ext)) continue;

    // Get uncompressed size from ZIP metadata
    // _data.uncompressedSize is available without decompressing the file
    const size = (zipEntry as any)._data?.uncompressedSize || 0; // eslint-disable-line @typescript-eslint/no-explicit-any -- JSZip internal _data property
    const filename = path.split('/').pop() || path;

    // Suggest Cloudinary for large files or .mov (needs transcoding)
    const suggestCloudinary = size > SIZE_THRESHOLD || ext === 'mov';

    videos.push({
      path,
      filename,
      size,
      ext,
      suggestCloudinary,
    });
  }

  // Sort by size (largest first) so user sees the biggest files at top
  videos.sort((a, b) => b.size - a.size);

  return videos;
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / Math.pow(k, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

/**
 * Get total size of selected videos
 */
export function getTotalSelectedSize(videos: VideoInfo[], selectedPaths: Set<string>): number {
  return videos.filter(v => selectedPaths.has(v.path)).reduce((sum, v) => sum + v.size, 0);
}
