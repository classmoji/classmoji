/**
 * Slides.com Import Utility
 *
 * Imports slides.com ZIP exports into the Classmoji slides platform,
 * preserving the sl-block structure for editing with the block editor.
 */

import JSZip from 'jszip';
import * as cheerio from 'cheerio';
import prisma from '@classmoji/database';
import { ContentService } from '@classmoji/content';
import { GitHubProvider } from '@classmoji/services';
import { getContentRepoName } from '@classmoji/utils';
import { getThemeUrls, saveTheme, generateThemeSlug } from './themeService.server.js';
import { uploadVideoBuffer, isCloudinaryConfigured, deleteSlideVideos } from './cloudinaryService.server.js';

// Built-in Reveal.js themes
const BUILTIN_THEMES = ['black', 'white', 'league', 'beige', 'night', 'serif', 'simple', 'solarized', 'moon', 'dracula', 'sky', 'blood'];

/**
 * Generate theme stylesheet URL
 * @param {string} theme
 */
function getThemeUrl(theme) {
  if (BUILTIN_THEMES.includes(theme)) {
    return `https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/${theme}.css`;
  }
  return theme;
}

/**
 * Generate a complete reveal.js HTML document
 * @param {string} slidesContent - The <section> elements
 * @param {string} title - Slide title
 * @param {Object} options - Theme options
 */
function generateSlideHtml(slidesContent, title, options = {}) {
  const {
    // slides.com theme options (when importTheme is true)
    libCssUrl = null,
    customThemeUrl = null,
    bodyClasses = '',
    // Shared theme name (e.g., "cs52-slides-theme") - used to set data-theme attribute
    sharedThemeName = null,
    // fallback to reveal.js themes (when importTheme is false)
    lightTheme = 'white',
    darkTheme = 'black',
    codeThemeLight = 'github',
    codeThemeDark = 'github-dark',
  } = options;

  // If we have slides.com lib CSS, use that instead of reveal.js themes
  const useSlidesCom = !!libCssUrl;

  const lightThemeUrl = getThemeUrl(lightTheme);
  const darkThemeUrl = getThemeUrl(darkTheme);

  // CSS links for slides.com theme
  const slidesComCss = useSlidesCom ? `
  <!-- slides.com full CSS (includes fonts, themes, sl-block styles) -->
  <link rel="stylesheet" href="${libCssUrl}">
  ${customThemeUrl ? `<!-- Custom theme CSS (user customizations from slides.com) -->\n  <link rel="stylesheet" href="${customThemeUrl}">` : ''}` : '';

  // CSS links for reveal.js themes (fallback when not using slides.com theme)
  const revealThemeCss = !useSlidesCom ? `
  <!-- Light mode slide theme -->
  <link rel="stylesheet" href="${lightThemeUrl}" media="(prefers-color-scheme: light)">
  <!-- Dark mode slide theme -->
  <link rel="stylesheet" href="${darkThemeUrl}" media="(prefers-color-scheme: dark)">
  <!-- Fallback for browsers without prefers-color-scheme support -->
  <link rel="stylesheet" href="${lightThemeUrl}" media="not all and (prefers-color-scheme)">
  <!-- Light mode code syntax highlighting -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/${codeThemeLight}.min.css" media="(prefers-color-scheme: light)">
  <!-- Dark mode code syntax highlighting -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/${codeThemeDark}.min.css" media="(prefers-color-scheme: dark)">
  <!-- Fallback code theme for browsers without prefers-color-scheme support -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/${codeThemeLight}.min.css" media="not all and (prefers-color-scheme)">` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <!-- Reveal.js core CSS -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">${slidesComCss}${revealThemeCss}
  <style>
    /* Override slides.com animation system - make all elements fully visible */
    .sl-block-content,
    .sl-block-content[data-animation-type],
    .sl-block-content[data-animation-type="fade-in"],
    .sl-block-content[data-animation-type="fade-out"] {
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
    }
  </style>
</head>
<body class="${bodyClasses}">
  <div class="reveal"${useSlidesCom && sharedThemeName ? ` data-theme="shared:${sharedThemeName}"` : ''}${!useSlidesCom ? ` data-theme="${lightTheme}" data-code-theme="${codeThemeLight}"` : ''}>
    <div class="slides">
${slidesContent}
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/plugin/highlight/highlight.js"></script>
  <script>
    Reveal.initialize({
      hash: true,
      controls: true,
      progress: true,
      center: false,
      transition: 'slide',
      width: 960,
      height: 700,
      plugins: [RevealHighlight]
    });
  </script>
</body>
</html>`;
}

/**
 * Process a slides.com ZIP export and create a slide in the system
 * @param {Object} options
 * @param {File|Blob} options.zipFile - The ZIP file to import
 * @param {string} options.title - Title for the slide
 * @param {string} [options.moduleId] - Module UUID for optional linking
 * @param {boolean} options.importTheme - Whether to import custom theme CSS (ignored if useSavedTheme is set)
 * @param {string} [options.useSavedTheme] - Name of saved theme to use (skips lib/ extraction)
 * @param {string} [options.saveThemeAs] - Save extracted theme with this name to .slidesthemes/
 * @param {string} options.org - Git organization login (for GitHub API calls)
 * @param {string} [options.classroomSlug] - Classroom slug (for database reference)
 * @param {string} options.classroomId - Classroom UUID (for database reference)
 * @param {string} options.term - Term string (e.g., "25w")
 * @param {string} options.userId - User ID who is importing
 * @param {string[]} [options.cloudinaryVideoPaths] - Paths of videos to upload to Cloudinary instead of GitHub
 * @param {Function} [options.onProgress] - Callback for progress updates ({ type: 'step'|'done'|'error', step?: string, current?: number, total?: number, filename?: string })
 * @returns {Promise<{slideId: string, slideCount: number, imageCount: number, themeSaved?: string, cloudinaryUploads?: number}>}
 */
export async function processZipImport({ zipFile, title, moduleId, importTheme, useSavedTheme, saveThemeAs, org, classroomSlug, classroomId, term, userId, cloudinaryVideoPaths = [], onProgress = () => {} }) {
  // 1. Extract ZIP
  onProgress({ type: 'step', step: 'extracting_zip' });
  const arrayBuffer = await zipFile.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  // 2. Parse index.html with Cheerio
  onProgress({ type: 'step', step: 'parsing_html' });
  const indexHtml = await zip.file('index.html')?.async('string');
  if (!indexHtml) {
    throw new Error('No index.html found in ZIP. Please ensure this is a valid slides.com export.');
  }
  const $ = cheerio.load(indexHtml);

  // 3. Extract title from HTML if not provided
  const slideTitle = title || $('title').text() || 'Imported Slides';
  const slug = slideTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

  // 4. Get classroom from database (org param is git org login for GitHub API)
  const classroom = await prisma.classroom.findUnique({
    where: { id: classroomId },
    include: { git_organization: true },
  });

  if (!classroom) {
    throw new Error(`Classroom not found: ${classroomId}`);
  }

  if (!classroom.git_organization) {
    throw new Error(`Git organization not configured for classroom: ${classroomId}`);
  }

  // Create GitHub provider instance for this organization
  const gitProvider = new GitHubProvider(classroom.git_organization.github_installation_id, org);

  // 5. Flat content path: slides/{slug}-{timestamp}
  const timestamp = Date.now();
  const contentPath = `slides/${slug}-${timestamp}`;
  // Build organization-like object for getContentRepoName (adapts new classroom schema)
  const repoName = getContentRepoName({
    login: classroom.git_organization.login,
    term: classroom.term,
    year: classroom.year,
  });

  // 6. Ensure content repo exists (org is git org login for GitHub API)
  const repoExists = await gitProvider.repositoryExists(org, repoName);
  if (!repoExists) {
    console.log(`Creating content repository: ${repoName}`);
    await gitProvider.createPublicRepository(
      org,
      repoName,
      `Course content for ${classroom.name || org} - ${term}`
    );
    // Give GitHub a moment to initialize the repo
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Try to enable GitHub Pages (idempotent)
  try {
    await gitProvider.enableGitHubPages(org, repoName);
  } catch (pagesError) {
    console.warn(`Could not auto-enable GitHub Pages: ${pagesError.message}`);
  }

  // 7. Collect files for batch upload
  /** @type {Array<{path: string, content: string, encoding: 'utf-8' | 'base64'}>} */
  const files = [];
  /** @type {Map<string, string>} Maps old image path to new absolute URL */
  const imageMap = new Map();

  // Use content proxy URLs for all assets - CDN-first + API fallback
  // This ensures assets load immediately after import (via API fallback)
  // and switch to faster CDN delivery once GitHub Pages propagates
  const baseUrl = `/content/${org}/${repoName}/${contentPath}`;
  const imageBaseUrl = `${baseUrl}/images`;

  // 7a. Extract body classes for theme variants
  const bodyClasses = $('body').attr('class') || '';
  const themeFont = bodyClasses.match(/theme-font-[a-z-]+/)?.[0] || '';
  const themeColor = bodyClasses.match(/theme-color-[a-z-]+/)?.[0] || '';

  // 7b. Extract images and videos - find the media folders
  const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
  const videoExtensions = ['mp4', 'webm', 'mov', 'ogg', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'flac'];
  /** @type {Map<string, string>} Maps old video path to new absolute URL */
  const videoMap = new Map();
  const videoBaseUrl = `${baseUrl}/videos`;

  // Track videos for Cloudinary upload (uploaded after slide is created)
  /** @type {Array<{filePath: string, filename: string, buffer: Buffer}>} */
  const cloudinaryVideoQueue = [];
  let cloudinaryUploads = 0;

  // Convert cloudinaryVideoPaths to a Set for fast lookup
  const cloudinaryVideoSet = new Set(cloudinaryVideoPaths);

  // 7c. First pass: identify images and videos for progress tracking
  /** @type {Array<{filePath: string, file: JSZip.JSZipObject, filename: string, type: 'image' | 'video', ext: string}>} */
  const mediaFiles = [];

  for (const [filePath, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    if (filePath.startsWith('lib/') || filePath === 'index.html') continue;

    const ext = filePath.split('.').pop()?.toLowerCase();
    const filename = filePath.split('/').pop();
    if (!filename) continue;

    const isInImageFolder = filePath.includes('/') && !filePath.startsWith('lib/');
    const isVideo = videoExtensions.includes(ext);
    // Check for image: either has image extension, OR is in a media folder but NOT a video/css/js file
    const isImage = imageExtensions.includes(ext) || (isInImageFolder && !isVideo && !filePath.endsWith('.css') && !filePath.endsWith('.js'));

    if (isImage) {
      mediaFiles.push({ filePath, file, filename, type: 'image', ext });
    } else if (isVideo) {
      mediaFiles.push({ filePath, file, filename, type: 'video', ext });
    }
  }

  // Count by type for progress
  const imageFiles = mediaFiles.filter(f => f.type === 'image');
  const videoFiles = mediaFiles.filter(f => f.type === 'video');

  // 7d. Process images with progress
  if (imageFiles.length > 0) {
    onProgress({ type: 'step', step: 'processing_images', current: 0, total: imageFiles.length });
  }

  for (let i = 0; i < imageFiles.length; i++) {
    const { filePath, file, filename } = imageFiles[i];
    onProgress({ type: 'step', step: 'processing_images', current: i + 1, total: imageFiles.length, filename });

    const content = await file.async('base64');
    const newPath = `${contentPath}/images/${filename}`;

    files.push({
      path: newPath,
      content,
      encoding: 'base64',
    });

    // Map the old path (as it appears in HTML) to new ABSOLUTE URL
    // This is necessary because the slides viewer renders HTML in a different context
    // where relative paths would resolve to the viewer URL, not GitHub Pages
    const absoluteUrl = `${imageBaseUrl}/${filename}`;
    imageMap.set(filePath, absoluteUrl);
    // Also map just the filename for fallback matching
    imageMap.set(filename, absoluteUrl);
  }

  // 7e. Process videos with progress
  if (videoFiles.length > 0) {
    onProgress({ type: 'step', step: 'processing_videos', current: 0, total: videoFiles.length });
  }

  for (let i = 0; i < videoFiles.length; i++) {
    const { filePath, file, filename } = videoFiles[i];
    onProgress({ type: 'step', step: 'processing_videos', current: i + 1, total: videoFiles.length, filename });

    // Check if this video should go to Cloudinary
    if (cloudinaryVideoSet.has(filePath) && isCloudinaryConfigured()) {
      // Queue for Cloudinary upload (needs slideId, which we get after creating slide record)
      const buffer = await file.async('nodebuffer');
      cloudinaryVideoQueue.push({ filePath, filename, buffer });
      // We'll add to videoMap after upload
    } else {
      // Upload to GitHub as before
      const content = await file.async('base64');
      const newPath = `${contentPath}/videos/${filename}`;

      files.push({
        path: newPath,
        content,
        encoding: 'base64',
      });

      // Map old path to new absolute URL
      const absoluteUrl = `${videoBaseUrl}/${filename}`;
      videoMap.set(filePath, absoluteUrl);
      videoMap.set(filename, absoluteUrl);
    }
  }

  // 8. Handle theme - either use saved theme or extract from ZIP
  let libCssUrl = null;
  let customThemeUrl = null;
  let finalBodyClasses = `reveal-viewport ${themeFont} ${themeColor}`.trim();
  let themeSaved = null;
  let sharedThemeName = null; // Track the shared theme name for data-theme attribute

  if (useSavedTheme) {
    // 8a. Use existing saved theme - no lib/ extraction needed
    console.log(`Using saved theme: ${useSavedTheme}`);
    sharedThemeName = useSavedTheme;
    const themeUrls = await getThemeUrls(org, repoName, useSavedTheme);
    libCssUrl = themeUrls.libCssUrl;
    customThemeUrl = themeUrls.customThemeUrl;
    finalBodyClasses = themeUrls.bodyClasses;
  } else if (importTheme) {
    // 8b. Extract theme from ZIP
    const customThemeCss = $('#theme-css-output').text();

    // Collect lib files for potential saving
    /** @type {Array<{path: string, content: string, encoding: string}>} */
    const libFiles = [];
    for (const [filePath, file] of Object.entries(zip.files)) {
      if (filePath.startsWith('lib/') && !file.dir) {
        const content = await file.async('base64');
        libFiles.push({ path: filePath, content, encoding: 'base64' });
      }
    }

    if (saveThemeAs && libFiles.length > 0) {
      // 8b-i. Save theme to .slidesthemes/ and reference from there
      const themeSlug = generateThemeSlug(saveThemeAs);
      sharedThemeName = themeSlug;
      console.log(`Saving theme as: ${themeSlug} (${libFiles.length} lib files)`);

      // Count total files: libFiles + theme.json + optional custom-theme.css
      const themeFileCount = libFiles.length + 1 + (customThemeCss?.trim() ? 1 : 0);
      onProgress({ type: 'step', step: 'saving_theme', current: 0, total: themeFileCount });

      await saveTheme({
        org,
        repoName,
        themeName: themeSlug,
        bodyClasses: finalBodyClasses,
        customThemeCss: customThemeCss?.trim() || undefined,
        libFiles,
        onProgress: ({ current, total, filename }) => {
          onProgress({ type: 'step', step: 'saving_theme', current, total, filename });
        },
      });

      // Get URLs from the saved theme
      const themeUrls = await getThemeUrls(org, repoName, themeSlug);
      libCssUrl = themeUrls.libCssUrl;
      customThemeUrl = themeUrls.customThemeUrl;
      themeSaved = themeSlug;
    } else if (libFiles.length > 0) {
      // 8b-ii. Extract lib/ to slide folder (original behavior)
      for (const libFile of libFiles) {
        files.push({
          path: `${contentPath}/${libFile.path}`,
          content: libFile.content,
          encoding: 'base64',
        });
      }

      // Set lib CSS URL
      if (zip.file('lib/offline-v2.css')) {
        libCssUrl = `${baseUrl}/lib/offline-v2.css`;
      } else if (zip.file('lib/offline-v1.css')) {
        libCssUrl = `${baseUrl}/lib/offline-v1.css`;
      }
      console.log(`Extracted ${libFiles.length} lib files to slide folder`);

      // Add custom theme CSS to slide folder
      if (customThemeCss?.trim()) {
        files.push({
          path: `${contentPath}/custom-theme.css`,
          content: customThemeCss,
          encoding: 'utf-8',
        });
        customThemeUrl = `${baseUrl}/custom-theme.css`;
      }
    }
  }

  // 9. Rewrite image paths in HTML
  const $slides = $('.reveal .slides');

  // Process all elements with image-related attributes
  // Includes: src, data-src, data-background-image, data-video-thumb (slides.com video thumbnails), poster (HTML5 video)
  $slides.find('[src], [data-src], [data-background-image], [data-video-thumb], [poster]').each((_, el) => {
    const $el = $(el);

    ['src', 'data-src', 'data-background-image', 'data-video-thumb', 'poster'].forEach(attr => {
      const val = $el.attr(attr);
      if (!val) return;

      // Try to match the path in our image map
      for (const [oldPath, newPath] of imageMap) {
        // Match full path or just filename
        if (val === oldPath || val.endsWith('/' + oldPath.split('/').pop()) || val.includes(oldPath)) {
          // Convert data-src to src for compatibility with our viewer
          if (attr === 'data-src') {
            $el.attr('src', newPath);
            $el.removeAttr('data-src');
            $el.removeAttr('data-lazy-loaded');
          } else {
            $el.attr(attr, newPath);
          }
          break;
        }
      }
    });
  });

  // Also handle background images on sections
  $slides.find('section[data-background-image]').each((_, el) => {
    const $el = $(el);
    const val = $el.attr('data-background-image');
    if (!val) return;

    for (const [oldPath, newPath] of imageMap) {
      if (val === oldPath || val.endsWith('/' + oldPath.split('/').pop()) || val.includes(oldPath)) {
        $el.attr('data-background-image', newPath);
        break;
      }
    }
  });

  // 9b. Extract and inject speaker notes from SLConfig
  // slides.com stores notes in a JavaScript object: SLConfig.deck.notes = { "slide-id": "note text", ... }
  // We need to extract this and convert to Reveal.js format: <aside class="notes">...</aside>
  let notesInjected = 0;
  const scriptTags = $('script').filter((_, el) => {
    const text = $(el).html() || '';
    return text.includes('SLConfig');
  });

  if (scriptTags.length > 0) {
    const configScript = $(scriptTags[0]).html() || '';
    // Extract the SLConfig JSON - it's assigned as: var SLConfig = {...};
    const configMatch = configScript.match(/var\s+SLConfig\s*=\s*(\{[\s\S]*?\});/);
    if (configMatch) {
      try {
        const slConfig = JSON.parse(configMatch[1]);
        const notes = slConfig.deck?.notes || {};

        // Inject notes into slides by matching data-id
        for (const [slideId, noteText] of Object.entries(notes)) {
          if (!noteText || typeof noteText !== 'string' || !noteText.trim()) continue;

          // Find the section with this data-id
          const $section = $slides.find(`section[data-id="${slideId}"]`);
          if ($section.length > 0) {
            // Check if section already has notes (shouldn't, but be safe)
            if ($section.find('aside.notes').length === 0) {
              // Keep notes as plain text - the editor textarea expects plain text
              // Reveal.js speaker view handles plain text just fine
              // Escape HTML entities to prevent XSS and preserve formatting
              const escapedNotes = noteText
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');

              $section.append(`<aside class="notes">${escapedNotes}</aside>`);
              notesInjected++;
            }
          }
        }
        console.log(`Injected ${notesInjected} speaker notes from SLConfig`);
      } catch (parseErr) {
        console.warn('Could not parse SLConfig for speaker notes:', parseErr instanceof Error ? parseErr.message : parseErr);
      }
    }
  }

  // 9c. Process sl-blocks - ensure all have data-block-type for the editor
  // slides.com exports sl-blocks but without explicit type attributes
  $slides.find('.sl-block').each((_, el) => {
    const $block = $(el);

    // Skip if already has a block type
    if ($block.attr('data-block-type')) return;

    // Detect block type from content
    const $content = $block.find('.sl-block-content').first();

    if ($content.find('iframe').length > 0) {
      $block.attr('data-block-type', 'iframe');
    } else if ($content.find('video').length > 0) {
      $block.attr('data-block-type', 'video');
    } else if ($content.find('img').length > 0) {
      $block.attr('data-block-type', 'image');
    } else if ($content.find('pre').length > 0 || $content.find('code').length > 0) {
      $block.attr('data-block-type', 'code');
    } else {
      $block.attr('data-block-type', 'text');
    }
  });

  // 9d. Video URL rewriting moved to step 11b (after Cloudinary uploads populate videoMap)

  // 9e. Process iframes - wrap any not already in sl-blocks
  // Some slides.com exports may have iframes outside sl-block structure
  $slides.find('iframe').each((_, el) => {
    const $iframe = $(el);

    // Skip if already inside an sl-block
    if ($iframe.closest('.sl-block').length > 0) return;

    // Get the parent element to understand context
    const $parent = $iframe.parent();

    // Try to extract position from inline styles (slides.com often uses these)
    const iframeStyle = $iframe.attr('style') || '';
    const parentStyle = $parent.attr('style') || '';

    // Parse position from styles (look for left, top, width, height)
    /** @param {string} style @param {string} prop */
    const parseStyleValue = (style, prop) => {
      const match = style.match(new RegExp(`${prop}\\s*:\\s*([\\d.]+)px`));
      return match ? parseFloat(match[1]) : null;
    };

    // Try iframe styles first, fall back to parent, then to attribute, then default
    const widthAttr = $iframe.attr('width');
    const heightAttr = $iframe.attr('height');
    let left = parseStyleValue(iframeStyle, 'left') ?? parseStyleValue(parentStyle, 'left') ?? 100;
    let top = parseStyleValue(iframeStyle, 'top') ?? parseStyleValue(parentStyle, 'top') ?? 100;
    let width = parseStyleValue(iframeStyle, 'width') ?? (widthAttr ? parseFloat(widthAttr) : null) ?? 560;
    let height = parseStyleValue(iframeStyle, 'height') ?? (heightAttr ? parseFloat(heightAttr) : null) ?? 315;

    // Create sl-block wrapper
    const blockHtml = `
      <div class="sl-block" data-block-type="iframe" style="left: ${left}px; top: ${top}px; width: ${width}px; height: ${height}px; z-index: 1;">
        <div class="sl-block-content" style="width: 100%; height: 100%;">
        </div>
      </div>
    `;

    const $block = $(blockHtml);

    // Clone the iframe and add to block content
    const $iframeClone = $iframe.clone();
    // Ensure iframe fills its container
    $iframeClone.css({
      width: '100%',
      height: '100%',
      border: 'none',
    });
    $iframeClone.removeAttr('style'); // Remove inline positioning, use container
    $iframeClone.attr('style', 'width: 100%; height: 100%; border: none;');

    $block.find('.sl-block-content').append($iframeClone);

    // Insert block at the same level as the section content
    const $section = $iframe.closest('section');
    if ($section.length > 0) {
      $section.append($block);
    }

    // Remove original iframe (and its wrapper if it was in one)
    if ($parent.children().length === 1 && !$parent.is('section')) {
      $parent.remove();
    } else {
      $iframe.remove();
    }
  });

  // 10. Create the slide database record first (needed for Cloudinary folder path)
  const slide = await prisma.slide.create({
    data: {
      title: slideTitle,
      slug,
      term,
      content_path: contentPath,
      classroom_id: classroom.id,
      created_by: userId,
    },
  });

  // Link slide to module
  if (moduleId) {
    await prisma.slideLink.create({
      data: {
        slide_id: slide.id,
        module_id: moduleId,
      },
    });
  }

  // 11. Upload Cloudinary videos (now that we have slideId)
  if (cloudinaryVideoQueue.length > 0) {
    console.log(`Uploading ${cloudinaryVideoQueue.length} videos to Cloudinary...`);
    onProgress({ type: 'step', step: 'uploading_cloudinary', current: 0, total: cloudinaryVideoQueue.length });

    for (let i = 0; i < cloudinaryVideoQueue.length; i++) {
      const { filePath, filename, buffer } = cloudinaryVideoQueue[i];
      onProgress({ type: 'step', step: 'uploading_cloudinary', current: i + 1, total: cloudinaryVideoQueue.length, filename });

      try {
        const result = await uploadVideoBuffer(buffer, slide.id, filename);
        cloudinaryUploads++;

        // Map old path to Cloudinary URL
        videoMap.set(filePath, result.optimizedUrl);
        videoMap.set(filename, result.optimizedUrl);

        console.log(`Uploaded ${filename} to Cloudinary (${(result.bytes / 1024 / 1024).toFixed(1)} MB)`);
      } catch (cloudErr) {
        // If Cloudinary fails, fall back to GitHub
        console.error(`Cloudinary upload failed for ${filename}, falling back to GitHub:`, cloudErr.message);

        const content = buffer.toString('base64');
        const newPath = `${contentPath}/videos/${filename}`;

        files.push({
          path: newPath,
          content,
          encoding: 'base64',
        });

        const absoluteUrl = `${videoBaseUrl}/${filename}`;
        videoMap.set(filePath, absoluteUrl);
        videoMap.set(filename, absoluteUrl);
      }
    }
  }

  // 11b. Rewrite video URLs in HTML (now that videoMap has all URLs including Cloudinary)
  $slides.find('video').each((_, el) => {
    const $video = $(el);

    ['src', 'data-src'].forEach(attr => {
      const val = $video.attr(attr);
      if (!val) return;

      // Skip external URLs - keep them as-is
      if (val.startsWith('http://') || val.startsWith('https://')) {
        return;
      }

      // Try to match local path in our video map
      for (const [oldPath, newPath] of videoMap) {
        if (val === oldPath || val.endsWith('/' + oldPath.split('/').pop()) || val.includes(oldPath)) {
          // Convert data-src to src for compatibility
          if (attr === 'data-src') {
            $video.attr('src', newPath);
            $video.removeAttr('data-src');
            $video.removeAttr('data-lazy-loaded');
          } else {
            $video.attr(attr, newPath);
          }
          break;
        }
      }
    });

    // Also handle <source> children
    $video.find('source').each((_, sourceEl) => {
      const $source = $(sourceEl);
      const srcVal = $source.attr('src');
      if (!srcVal) return;

      // Skip external URLs
      if (srcVal.startsWith('http://') || srcVal.startsWith('https://')) {
        return;
      }

      // Try to match in video map
      for (const [oldPath, newPath] of videoMap) {
        if (srcVal === oldPath || srcVal.includes(oldPath.split('/').pop())) {
          $source.attr('src', newPath);
          break;
        }
      }
    });
  });

  // 12. Generate full HTML and add to files
  onProgress({ type: 'step', step: 'generating_html' });
  // Get the modified slides content (just the section elements)
  const slidesHtml = $slides.html();

  // Build theme options based on whether we're using slides.com theme or fallback
  const themeOptions = libCssUrl ? {
    // slides.com full theme import (from saved theme or extracted)
    libCssUrl,
    customThemeUrl,
    bodyClasses: finalBodyClasses,
    sharedThemeName, // For data-theme attribute
  } : {
    // Fallback to reveal.js themes
    lightTheme: 'white',
  };

  const fullHtml = generateSlideHtml(slidesHtml, slideTitle, themeOptions);
  files.push({
    path: `${contentPath}/index.html`,
    content: fullHtml,
    encoding: 'utf-8',
  });

  // 13. Batch upload all files in single commit
  onProgress({ type: 'step', step: 'uploading_github', current: 0, total: files.length });
  try {
    await ContentService.uploadBatch({
      orgLogin: org,
      repo: repoName,
      files,
      message: `Import slides from slides.com: ${slideTitle}`,
      onProgress: ({ current, total, filename }) => {
        onProgress({ type: 'step', step: 'uploading_github', current, total, filename });
      },
    });
  } catch (uploadError) {
    console.log(uploadError);
    // If upload fails, clean up slide record and Cloudinary videos
    await prisma.slide.delete({ where: { id: slide.id } });

    // Also clean up any Cloudinary videos we uploaded
    if (cloudinaryUploads > 0) {
      try {
        await deleteSlideVideos(slide.id);
        console.log(`Cleaned up ${cloudinaryUploads} Cloudinary videos after failed import`);
      } catch (cleanupErr) {
        console.error('Failed to clean up Cloudinary videos:', cleanupErr.message);
      }
    }

    throw new Error(`Failed to upload files: ${uploadError.message}`);
  }

  // Count slides (top-level sections, not nested vertical stacks)
  const slideCount = $slides.find('> section').length;

  // Signal completion
  onProgress({ type: 'done', slideId: slide.id });

  return {
    slideId: slide.id,
    slideCount,
    imageCount: imageMap.size / 2, // Divide by 2 because we added each image twice (full path and filename)
    themeSaved, // Name of saved theme if saveThemeAs was used
    cloudinaryUploads: cloudinaryUploads > 0 ? cloudinaryUploads : undefined,
  };
}
