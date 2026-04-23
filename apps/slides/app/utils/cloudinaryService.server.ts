/**
 * Cloudinary Service
 *
 * Centralized utilities for Cloudinary video operations:
 * - Upload video buffers with transcoding
 * - Delete slide videos on cleanup
 * - Generate optimized URLs
 */

import { v2 as cloudinary } from 'cloudinary';

/**
 * Configure Cloudinary with environment credentials
 */
export function configureCloudinary(): typeof cloudinary {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary credentials not configured');
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
  });

  return cloudinary;
}

/**
 * Check if Cloudinary is configured
 */
export function isCloudinaryConfigured(): boolean {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

/**
 * Upload a video buffer to Cloudinary with transcoding
 */
export async function uploadVideoBuffer(
  buffer: Buffer,
  slideId: string,
  filename: string
): Promise<{ optimizedUrl: string; publicId: string; bytes: number }> {
  const cld = configureCloudinary();

  // Convert buffer to base64 data URI
  // Cloudinary accepts data URIs for upload
  const base64 = buffer.toString('base64');
  const ext = filename.split('.').pop()?.toLowerCase() || 'mp4';
  const mimeType = getMimeType(ext);
  const dataUri = `data:${mimeType};base64,${base64}`;

  // Remove extension from filename for public_id
  const publicIdBase = filename.replace(/\.[^.]+$/, '');

  const result = await cld.uploader.upload(dataUri, {
    resource_type: 'video',
    folder: `classmoji/slides/${slideId}`,
    public_id: publicIdBase,
    // Auto-generate MP4 with H.264 for browser compatibility
    eager: [{ format: 'mp4', video_codec: 'h264' }],
    eager_async: true,
  });

  // Build optimized URL with auto quality and format
  const optimizedUrl = cld.url(result.public_id, {
    resource_type: 'video',
    secure: true,
    transformation: [{ quality: 'auto', fetch_format: 'auto' }],
  });

  return {
    optimizedUrl,
    publicId: result.public_id,
    bytes: result.bytes,
  };
}

/**
 * Delete all Cloudinary videos associated with a slide
 *
 * Uses folder-based deletion since videos are stored in `classmoji/slides/{slideId}/`
 */
export async function deleteSlideVideos(
  slideId: string
): Promise<{ deleted: boolean; error?: string }> {
  if (!isCloudinaryConfigured()) {
    return { deleted: false, error: 'Cloudinary not configured' };
  }

  try {
    const cld = configureCloudinary();
    const folder = `classmoji/slides/${slideId}`;

    // Delete all video resources with this prefix
    await cld.api.delete_resources_by_prefix(folder, { resource_type: 'video' });

    // Delete the empty folder
    try {
      await cld.api.delete_folder(folder);
    } catch (folderError: unknown) {
      // Folder might not exist or be already empty - that's OK
      const message = folderError instanceof Error ? folderError.message : String(folderError);
      if (!message.includes('not found')) {
        console.warn('Could not delete Cloudinary folder:', message);
      }
    }

    console.log(`Deleted Cloudinary folder: ${folder}`);
    return { deleted: true };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Cloudinary cleanup failed:', message);
    return { deleted: false, error: message };
  }
}

/**
 * Get MIME type for video extension
 */
function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    ogg: 'video/ogg',
    m4v: 'video/x-m4v',
  };
  return mimeTypes[ext] || 'video/mp4';
}
