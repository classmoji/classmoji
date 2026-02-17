/**
 * API: Upload Video to Cloudinary
 *
 * POST /api/video/upload-cloudinary
 * Body: { videoUrl, slideId }
 *
 * Uploads a video from the current URL (local or external) to Cloudinary
 * for optimized CDN delivery and automatic transcoding (e.g., .mov → .mp4).
 *
 * For local content URLs (/content/...), we fetch the video ourselves first
 * since Cloudinary can't access localhost. External URLs are passed directly.
 *
 * Returns the Cloudinary secure URL which can replace the original video src.
 */

import { v2 as cloudinary } from 'cloudinary';
import prisma from '@classmoji/database';
import { ContentService } from '@classmoji/content';
import { assertSlideAccess } from '@classmoji/auth/server';
import { fetchContent, getMimeType } from '~/utils/contentProxy';

export const action = async ({ request }) => {
  const formData = await request.formData();
  const videoUrl = formData.get('videoUrl');
  const slideId = formData.get('slideId');

  // Validate required fields
  if (!videoUrl || !slideId) {
    return new Response(
      JSON.stringify({ error: 'videoUrl and slideId are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    // Fetch slide to verify it exists and get org info
    const slide = await prisma.slide.findUnique({
      where: { id: slideId },
      include: {
        classroom: {
          include: {
            git_organization: true,
          },
        },
      },
    });

    if (!slide) {
      return new Response(
        JSON.stringify({ error: 'Slide not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Authorization: require edit permission
    await assertSlideAccess({
      request,
      slideId,
      slide,
      accessType: 'edit',
    });

    // Configure Cloudinary from environment variables
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      console.error('Cloudinary credentials not configured');
      return new Response(
        JSON.stringify({ error: 'Video hosting service not configured' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
    });

    // Determine upload source based on URL type
    let uploadSource;

    // Check if it's a local content URL (either relative /content/... or full http://localhost.../content/...)
    const isLocalContentUrl = videoUrl.startsWith('/content/') ||
      (videoUrl.includes('/content/') && videoUrl.includes('localhost'));

    // Store these for deletion after successful upload
    let contentOrg = null;
    let contentRepo = null;
    let contentPath = null;

    if (isLocalContentUrl) {
      // Local content URL - fetch the video ourselves since Cloudinary can't access localhost
      // Parse the content path: /content/{org}/{repo}/{...path}
      // Handle both "/content/..." and "http://localhost:6500/content/..."
      const parsedPath = videoUrl.includes('/content/')
        ? videoUrl.substring(videoUrl.indexOf('/content/') + '/content/'.length)
        : videoUrl.replace('/content/', '');
      const pathParts = parsedPath.split('/');
      contentOrg = pathParts[0];
      contentRepo = pathParts[1];
      contentPath = pathParts.slice(2).join('/');

      const org = contentOrg;
      const repo = contentRepo;
      const path = contentPath;

      console.log(`Fetching video from GitHub: org=${org}, repo=${repo}, path=${path}`);

      const result = await fetchContent({ org, repo, path, binary: true });

      if (!result?.content) {
        return new Response(
          JSON.stringify({ error: 'Failed to fetch video content from repository' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Convert Buffer to base64 data URI for Cloudinary upload
      const mimeType = getMimeType(path);
      const base64Content = result.content.toString('base64');
      uploadSource = `data:${mimeType};base64,${base64Content}`;

      console.log(`Video fetched successfully: ${result.content.length} bytes, MIME: ${mimeType}`);
    } else {
      // External URL - Cloudinary can fetch it directly
      uploadSource = videoUrl;
    }

    // Upload video to Cloudinary
    // Cloudinary automatically transcodes to web-optimized format
    const uploadResult = await cloudinary.uploader.upload(uploadSource, {
      resource_type: 'video',
      folder: `classmoji/slides/${slideId}`,
      // Auto-generate optimized versions
      eager: [
        { format: 'mp4', video_codec: 'h264' }
      ],
      eager_async: true, // Process transformations asynchronously
    });

    // Build optimized URL with auto-format transformation
    // This serves the best format for each browser (webm for Chrome, mp4 for Safari, etc.)
    const optimizedUrl = cloudinary.url(uploadResult.public_id, {
      resource_type: 'video',
      secure: true,
      transformation: [
        { quality: 'auto', fetch_format: 'auto' }
      ]
    });

    // Delete the original file from GitHub after successful Cloudinary upload
    let deletedOriginal = false;
    if (isLocalContentUrl && contentOrg && contentRepo && contentPath) {
      try {
        console.log(`Deleting original video from GitHub: ${contentOrg}/${contentRepo}/${contentPath}`);
        await ContentService.delete({
          orgLogin: contentOrg,
          repo: contentRepo,
          path: contentPath,
          message: `Moved video to Cloudinary CDN: ${slide.title}`,
        });
        deletedOriginal = true;
        console.log('Original video deleted successfully');
      } catch (deleteError) {
        // Don't fail the whole operation if deletion fails
        // The video is already on Cloudinary, user can manually clean up
        console.error('Failed to delete original video:', deleteError.message);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        cloudinaryUrl: optimizedUrl,
        originalUrl: uploadResult.secure_url,
        publicId: uploadResult.public_id,
        format: uploadResult.format,
        duration: uploadResult.duration,
        width: uploadResult.width,
        height: uploadResult.height,
        bytes: uploadResult.bytes,
        deletedOriginal,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Cloudinary upload failed:', error);

    // Handle specific Cloudinary errors
    if (error.message?.includes('Invalid image file')) {
      return new Response(
        JSON.stringify({ error: 'Video format not supported or URL not accessible' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: error.message || 'Upload failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
