import { useState, useCallback, useEffect, useRef } from 'react';
import { useLoaderData, useFetcher } from 'react-router';
import { message, Tooltip, Popconfirm } from 'antd';
import prisma from '@classmoji/database';
import { ContentService } from '@classmoji/content';
import { assertSlideAccess } from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';
import { SandpackRenderer } from '@classmoji/ui-components/sandpack';
import { useUser } from '~/hooks';
import { fetchContent } from '~/utils/contentProxy';
import { getThemeUrls } from '~/utils/themeService.server';
import RevealSlides from '~/components/RevealSlides';
import SlideToolbar from '~/components/SlideToolbar';
import SlideNotesPanel from '~/components/SlideNotesPanel';
import OrphanedImagesModal from '~/components/OrphanedImagesModal';
import { ElementSelectionProvider } from '~/components/properties/ElementSelectionContext';
import PropertiesPanel from '~/components/properties/PropertiesPanel';
import SlideOverview from '~/components/SlideOverview';
import ImageResizeHandles from '~/components/ImageResizeHandles';
import BlockHandles from '~/components/BlockHandles';

// Loader to fetch slide metadata and content from database/GitHub
export const loader = async ({ params, request }) => {
  const { slideId } = params;
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode');
  const returnUrl = url.searchParams.get('returnUrl');

  // Fetch slide from database with classroom and git_organization
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
    throw new Response('Slide not found', { status: 404 });
  }

  // Authorization: check view access (supports public, private, and draft slides)
  const { canEdit, canPresent, canViewSpeakerNotes, membership, userId } = await assertSlideAccess({
    request,
    slideId,
    slide,
    accessType: 'view',
  });

  // Fire-and-forget: record the slide view for presence tracking
  // Use the user's actual membership role (OWNER, STUDENT, etc.)
  if (userId && slide.classroom_id) {
    Promise.resolve().then(() => {
      ClassmojiService.resourceView.recordView({
        resourcePath: `slides/${slideId}`,
        userId,
        classroomId: slide.classroom_id,
        viewedAsRole: membership?.role || null,
      });
    });
  }

  // Get git org login for GitHub API and content URLs
  const gitOrgLogin = slide.classroom?.git_organization?.login;
  if (!gitOrgLogin) {
    throw new Response('Git organization not configured for this classroom', { status: 400 });
  }

  // Get content repo name and file path
  const repo = `content-${gitOrgLogin}-${slide.term}`;
  const filePath = `${slide.content_path}/index.html`;

  // Build the content URL using content proxy (CDN-first + API fallback)
  // Used as client-side fallback if server-side fetch fails
  const contentUrl = `/content/${gitOrgLogin}/${repo}/${filePath}`;

  // Fetch content: API-first for edit mode (freshness), CDN-first for view mode (speed)
  // CDN has ~3 minute propagation delay after saves, so edit mode needs fresh API data
  let slideContent = null;
  let contentError = null;
  let usedApiFallback = false;
  let contentResult = null;

  if (mode === 'edit') {
    // API-first for edit mode - ensures fresh content after saves
    try {
      const result = await ContentService.getContent({
        orgLogin: gitOrgLogin,
        repo,
        path: filePath,
      });
      if (result) {
        contentResult = { content: result.content, source: 'api' };
      }
    } catch (e) {
      // Fall back to CDN if API fails
      console.log('[Loader] API fetch failed, falling back to CDN:', e.message);
    }
  }

  // CDN-first for view mode, or as fallback if API failed
  if (!contentResult) {
    contentResult = await fetchContent({
      org: gitOrgLogin,
      repo,
      path: filePath,
    });
  }

  if (contentResult) {
    slideContent = contentResult.content;
    usedApiFallback = contentResult.source === 'api';

    // Strip speaker notes from content if user doesn't have permission to view them
    // Notes are in <aside class="notes"> elements within each slide section
    if (!canViewSpeakerNotes && slideContent) {
      // Remove all <aside class="notes">...</aside> blocks
      // Using regex since we're dealing with simple HTML structure
      slideContent = slideContent.replace(/<aside\s+class="notes"[^>]*>[\s\S]*?<\/aside>/gi, '');
    }
  } else {
    contentError = 'Failed to load slide content';
  }

  // PERFORMANCE: Themes and snippets are now loaded on-demand via action
  // This reduces initial page load from 15-25 API calls to just 1-2
  // See action handlers: 'list-themes', 'list-snippets', 'get-theme-content'
  // The component uses useFetcher to load these when the user opens the theme picker
  //
  // EXCEPTION: If the slide uses a shared theme, we pre-load just that one theme
  // so that view mode displays correctly (lazy-loading only triggers in edit mode)
  let preloadedSharedTheme = null;
  if (slideContent) {
    const themeMatch = slideContent.match(/data-theme="shared:([^"]+)"/);
    if (themeMatch) {
      const themeName = themeMatch[1];
      try {
        const themeUrls = await getThemeUrls(gitOrgLogin, repo, themeName);
        preloadedSharedTheme = {
          id: `shared:${themeName}`,
          name: themeName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
          ...themeUrls,
        };
      } catch (e) {
        console.warn(`Could not preload shared theme "${themeName}":`, e.message);
      }
    }
  }

  return {
    slide,
    contentUrl,
    slideContent,
    contentError,
    repo,
    gitOrgLogin, // Needed for lazy-loading themes/snippets
    // Pre-load the specific shared theme this slide uses (if any)
    // Full theme list is still lazy-loaded when entering edit mode
    customThemes: [],
    sharedThemes: preloadedSharedTheme ? [preloadedSharedTheme] : [],
    snippets: [],
    cssThemes: [],
    webappUrl: process.env.WEBAPP_URL || 'http://localhost:3000',
    // Auto-enter edit mode if ?mode=edit is in URL (useful for new slides where CDN hasn't caught up)
    autoEdit: mode === 'edit',
    // Indicate if we fell back to API (CDN wasn't available yet)
    usedApiFallback,
    // Return URL for back navigation (from webapp query param)
    returnUrl,
    // Authorization flags from assertSlideAccess
    canEdit,
    canPresent,
    canViewSpeakerNotes,
    // User's role in the classroom
    userRole: membership?.role || null,
  };
};

// Action to save slide content or fetch fresh content from GitHub API
export const action = async ({ request, params }) => {
  const { slideId } = params;
  const formData = await request.formData();
  const intent = formData.get('intent');

  // Fetch slide to get classroom/git org info
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
    return { error: 'Slide not found' };
  }

  // Authorization: require edit permission (owner/teacher/assistant with team_edit)
  await assertSlideAccess({
    request,
    slideId,
    slide,
    accessType: 'edit',
  });

  // Get git organization for GitHub API and content URLs
  const gitOrganization = slide.classroom?.git_organization;
  if (!gitOrganization?.login) {
    return { error: 'Git organization not configured for this classroom' };
  }

  // Used for content URLs and fallback orgLogin param
  const gitOrgLogin = gitOrganization.login;
  const repo = `content-${gitOrgLogin}-${slide.term}`;
  const filePath = `${slide.content_path}/index.html`;

  // ─────────────────────────────────────────────────────────────────────────
  // LAZY-LOAD HANDLERS: Load themes/snippets on-demand to reduce API calls
  // ─────────────────────────────────────────────────────────────────────────

  // List all available themes (CSS themes + shared themes)
  if (intent === 'list-themes') {
    try {
      const themeFiles = await ContentService.listFolder({
        orgLogin: gitOrgLogin,
        repo,
        path: '.slidesthemes',
      });

      // Parse CSS theme filenames: {name}-{light|dark}.css
      const themePattern = /^(.+)-(light|dark)\.css$/;
      const cssFiles = themeFiles.filter(f => f.type === 'file' && themePattern.test(f.name));

      const customThemes = cssFiles.map(f => {
        const match = f.name.match(themePattern);
        const themeName = match?.[1] ?? 'custom';
        const themeType = match?.[2] ?? 'light';
        return {
          id: `custom:${f.name}`,
          name: themeName.charAt(0).toUpperCase() + themeName.slice(1),
          type: themeType,
          cssPath: `.slidesthemes/${f.name}`,
          cssUrl: `/content/${gitOrgLogin}/${repo}/.slidesthemes/${f.name}`,
        };
      });

      // Detect folder-based shared themes (from slides.com imports)
      const themeFolders = themeFiles.filter(f => f.type === 'dir');
      const sharedThemePromises = themeFolders.map(async (folder) => {
        try {
          const manifestResult = await ContentService.getContent({
            orgLogin: gitOrgLogin,
            repo,
            path: `.slidesthemes/${folder.name}/theme.json`,
          });
          if (!manifestResult?.content) return null;

          const manifest = JSON.parse(manifestResult.content);
          const baseUrl = `/content/${gitOrgLogin}/${repo}/.slidesthemes/${folder.name}`;

          // Check if custom-theme.css exists (uses cached response)
          let customThemeUrl = null;
          const customThemeResult = await ContentService.getContent({
            orgLogin: gitOrgLogin,
            repo,
            path: `.slidesthemes/${folder.name}/custom-theme.css`,
          });
          if (customThemeResult) {
            customThemeUrl = `${baseUrl}/custom-theme.css`;
          }

          return {
            id: `shared:${folder.name}`,
            name: folder.name.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
            bodyClasses: manifest.bodyClasses || '',
            libCssUrl: `${baseUrl}/lib/offline-v2.css`,
            customThemeUrl,
          };
        } catch {
          return null;
        }
      });

      const sharedThemes = (await Promise.all(sharedThemePromises)).filter(Boolean);

      return {
        intent: 'list-themes',
        customThemes,
        sharedThemes,
      };
    } catch (error) {
      console.error('Failed to list themes:', error);
      return { intent: 'list-themes', customThemes: [], sharedThemes: [] };
    }
  }

  // Get content for CSS themes (for theme editor)
  if (intent === 'get-theme-content') {
    try {
      const themeFiles = await ContentService.listFolder({
        orgLogin: gitOrgLogin,
        repo,
        path: '.slidesthemes',
      });

      const themePattern = /^(.+)-(light|dark)\.css$/;
      const cssFiles = themeFiles.filter(f => f.type === 'file' && themePattern.test(f.name));

      const themePromises = cssFiles.map(async (f) => {
        try {
          const result = await ContentService.getContent({
            orgLogin: gitOrgLogin,
            repo,
            path: `.slidesthemes/${f.name}`,
          });
          const match = f.name.match(themePattern);
          const themeName = match?.[1] ?? 'custom';
          const themeType = match?.[2] ?? 'light';
          return {
            id: f.name,
            name: themeName.charAt(0).toUpperCase() + themeName.slice(1).replace(/-/g, ' '),
            type: themeType,
            content: result?.content || '',
          };
        } catch {
          return null;
        }
      });

      const cssThemes = (await Promise.all(themePromises)).filter(Boolean);

      return {
        intent: 'get-theme-content',
        cssThemes,
      };
    } catch (error) {
      console.error('Failed to get theme content:', error);
      return { intent: 'get-theme-content', cssThemes: [] };
    }
  }

  // List all snippets
  if (intent === 'list-snippets') {
    try {
      const snippetFiles = await ContentService.listFolder({
        orgLogin: gitOrgLogin,
        repo,
        path: '.slidesthemes/snippets',
      });

      const htmlFiles = snippetFiles.filter(f => f.type === 'file' && f.name.endsWith('.html'));

      const snippetPromises = htmlFiles.map(async (f) => {
        try {
          const result = await ContentService.getContent({
            orgLogin: gitOrgLogin,
            repo,
            path: `.slidesthemes/snippets/${f.name}`,
          });
          const name = f.name.replace(/\.html$/, '');
          return {
            id: f.name,
            name: name.charAt(0).toUpperCase() + name.slice(1).replace(/-/g, ' '),
            content: result?.content || '',
          };
        } catch {
          return null;
        }
      });

      const snippets = (await Promise.all(snippetPromises)).filter(Boolean);

      return {
        intent: 'list-snippets',
        snippets,
      };
    } catch (error) {
      console.error('Failed to list snippets:', error);
      return { intent: 'list-snippets', snippets: [] };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────

  // Fetch latest content from GitHub API (bypasses CDN cache)
  // Used when entering edit mode to ensure we're editing the current version
  if (intent === 'fetch-latest') {
    try {
      const result = await ContentService.getContent({
        gitOrganization,
        repo,
        path: filePath,
      });

      if (!result) {
        return { error: 'Content not found' };
      }

      return {
        intent: 'fetch-latest',
        content: result.content,
        sha: result.sha,
      };
    } catch (error) {
      console.error('Failed to fetch latest content:', error);
      return { error: error.message };
    }
  }

  // Upload an image to the slide's images folder
  if (intent === 'upload-image') {
    try {
      const file = formData.get('file');
      if (!file || !(file instanceof File)) {
        return { error: 'No file provided' };
      }

      // Convert File to Buffer for ContentService
      const arrayBuffer = await file.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Upload to images folder alongside the slide content
      const result = await ContentService.upload({
        orgLogin: gitOrgLogin,
        repo,
        file: buffer,
        filename: file.name,
        folder: `${slide.content_path}/images`,
        message: `Upload image for slides: ${slide.title}`,
      });

      // Return content proxy URL instead of raw.githubusercontent.com
      // Content proxy handles MIME types correctly and has CDN+API fallback
      return {
        intent: 'upload-image',
        success: true,
        url: `/content/${gitOrgLogin}/${repo}/${result.path}`,
        path: result.path,
      };
    } catch (error) {
      console.error('Failed to upload image:', error);
      return { error: error.message };
    }
  }

  // Save a snippet to .slidesthemes/snippets/
  if (intent === 'save-snippet') {
    try {
      const name = formData.get('name');
      const content = formData.get('content');

      if (!name || !content) {
        return { error: 'Name and content are required' };
      }

      // Sanitize filename: lowercase, replace spaces with hyphens, remove special chars
      const filename = String(name)
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '') + '.html';

      await ContentService.put({
        orgLogin: gitOrgLogin,
        repo,
        path: `.slidesthemes/snippets/${filename}`,
        content: String(content),
        message: `Add snippet: ${name}`,
      });

      return {
        intent: 'save-snippet',
        success: true,
        snippet: {
          id: filename,
          name: String(name),
          content: String(content),
        },
      };
    } catch (error) {
      console.error('Failed to save snippet:', error);
      return { error: error.message };
    }
  }

  // Update an existing snippet
  if (intent === 'update-snippet') {
    try {
      const id = formData.get('id'); // Original filename
      const name = formData.get('name');
      const content = formData.get('content');

      if (!id || !name || !content) {
        return { error: 'ID, name, and content are required' };
      }

      // Generate new filename from name
      const newFilename = String(name)
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '') + '.html';

      const oldPath = `.slidesthemes/snippets/${id}`;
      const newPath = `.slidesthemes/snippets/${newFilename}`;

      // If filename changed, delete old file first
      if (id !== newFilename) {
        try {
          await ContentService.delete({
            orgLogin: gitOrgLogin,
            repo,
            path: oldPath,
            message: `Rename snippet: ${id} → ${newFilename}`,
          });
        } catch (err) {
          // Old file might not exist, continue anyway
          console.log(err);
        }
      }

      // Save the updated content
      await ContentService.put({
        orgLogin: gitOrgLogin,
        repo,
        path: newPath,
        content: String(content),
        message: `Update snippet: ${name}`,
      });

      return {
        intent: 'update-snippet',
        success: true,
        oldId: String(id),
        snippet: {
          id: newFilename,
          name: String(name),
          content: String(content),
        },
      };
    } catch (error) {
      console.error('Failed to update snippet:', error);
      return { error: error.message };
    }
  }

  // Delete a snippet
  if (intent === 'delete-snippet') {
    try {
      const id = formData.get('id');

      if (!id) {
        return { error: 'Snippet ID is required' };
      }

      await ContentService.delete({
        orgLogin: gitOrgLogin,
        repo,
        path: `.slidesthemes/snippets/${id}`,
        message: `Delete snippet: ${id}`,
      });

      return {
        intent: 'delete-snippet',
        success: true,
        deletedId: String(id),
      };
    } catch (error) {
      console.error('Failed to delete snippet:', error);
      return { error: error.message };
    }
  }

  // Save a new CSS theme to .slidesthemes/
  if (intent === 'save-theme') {
    try {
      const name = formData.get('name');
      const type = formData.get('type'); // 'light' or 'dark'
      const content = formData.get('content');

      if (!name || !type || !content) {
        return { error: 'Name, type, and content are required' };
      }

      // Sanitize filename: lowercase, replace spaces with hyphens, remove special chars
      const baseName = String(name)
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '');
      const filename = `${baseName}-${type}.css`;

      await ContentService.put({
        orgLogin: gitOrgLogin,
        repo,
        path: `.slidesthemes/${filename}`,
        content: String(content),
        message: `Add custom CSS theme: ${name} (${type})`,
      });

      return {
        intent: 'save-theme',
        success: true,
        theme: {
          id: filename,
          name: String(name),
          type: String(type),
          content: String(content),
        },
      };
    } catch (error) {
      console.error('Failed to save theme:', error);
      return { error: error.message };
    }
  }

  // Update an existing CSS theme
  if (intent === 'update-theme') {
    try {
      const id = formData.get('id'); // Original filename
      const name = formData.get('name');
      const type = formData.get('type');
      const content = formData.get('content');

      if (!id || !name || !type || !content) {
        return { error: 'ID, name, type, and content are required' };
      }

      // Generate new filename from name
      const baseName = String(name)
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '');
      const newFilename = `${baseName}-${type}.css`;

      const oldPath = `.slidesthemes/${id}`;
      const newPath = `.slidesthemes/${newFilename}`;

      // If filename changed, delete old file first
      if (id !== newFilename) {
        try {
          await ContentService.delete({
            orgLogin: gitOrgLogin,
            repo,
            path: oldPath,
            message: `Rename CSS theme: ${id} → ${newFilename}`,
          });
        } catch (err) {
          // Old file might not exist, continue anyway
          console.log(err);
        }
      }

      // Save the updated content
      await ContentService.put({
        orgLogin: gitOrgLogin,
        repo,
        path: newPath,
        content: String(content),
        message: `Update CSS theme: ${name} (${type})`,
      });

      return {
        intent: 'update-theme',
        success: true,
        oldId: String(id),
        theme: {
          id: newFilename,
          name: String(name),
          type: String(type),
          content: String(content),
        },
      };
    } catch (error) {
      console.error('Failed to update theme:', error);
      return { error: error.message };
    }
  }

  // Delete a CSS theme
  if (intent === 'delete-theme') {
    try {
      const id = formData.get('id');

      if (!id) {
        return { error: 'Theme ID is required' };
      }

      await ContentService.delete({
        orgLogin: gitOrgLogin,
        repo,
        path: `.slidesthemes/${id}`,
        message: `Delete CSS theme: ${id}`,
      });

      return {
        intent: 'delete-theme',
        success: true,
        deletedId: String(id),
      };
    } catch (error) {
      console.error('Failed to delete theme:', error);
      return { error: error.message };
    }
  }

  // Delete orphaned images
  if (intent === 'delete-images') {
    try {
      const pathsJson = formData.get('paths');
      const paths = JSON.parse(pathsJson);

      if (!Array.isArray(paths) || paths.length === 0) {
        return { error: 'No images to delete' };
      }

      const result = await ContentService.deleteMultiple({
        orgLogin: gitOrgLogin,
        repo,
        paths,
        message: `Clean up unused images from slides: ${slide.title}`,
      });

      return {
        intent: 'delete-images',
        success: true,
        deleted: result.deleted,
        errors: result.errors,
      };
    } catch (error) {
      console.error('Failed to delete images:', error);
      return { error: error.message };
    }
  }

  // Update slide visibility settings (is_draft, is_public, show_speaker_notes, allow_team_edit)
  if (intent === 'update-visibility') {
    try {
      const updateData = {};

      // Parse visibility setting
      const visibility = formData.get('visibility');
      if (visibility) {
        if (visibility === 'draft') {
          updateData.is_draft = true;
          updateData.is_public = false;
        } else if (visibility === 'private') {
          updateData.is_draft = false;
          updateData.is_public = false;
        } else if (visibility === 'public') {
          updateData.is_draft = false;
          updateData.is_public = true;
        }
      }

      // Parse boolean flags
      const showSpeakerNotes = formData.get('show_speaker_notes');
      if (showSpeakerNotes !== null) {
        updateData.show_speaker_notes = showSpeakerNotes === 'true';
      }

      const allowTeamEdit = formData.get('allow_team_edit');
      if (allowTeamEdit !== null) {
        updateData.allow_team_edit = allowTeamEdit === 'true';
      }

      if (Object.keys(updateData).length === 0) {
        return { error: 'No visibility settings to update' };
      }

      await prisma.slide.update({
        where: { id: slideId },
        data: updateData,
      });

      return {
        intent: 'update-visibility',
        success: true,
        ...updateData,
      };
    } catch (error) {
      console.error('Failed to update visibility:', error);
      return { error: error.message };
    }
  }

  // Save content to GitHub
  const htmlContent = formData.get('content');

  try {
    // Check if content uses a shared theme (format: shared:theme-name)
    const themeMatch = htmlContent.match(/data-theme="([^"]+)"/);
    const theme = themeMatch ? themeMatch[1] : 'white';
    const codeThemeMatch = htmlContent.match(/data-code-theme="([^"]+)"/);
    const codeTheme = codeThemeMatch ? codeThemeMatch[1] : 'github';

    // Look up shared theme URLs if needed
    /** @type {{ theme: string, codeTheme: string, libCssUrl?: string, customThemeUrl?: string | null, bodyClasses?: string }} */
    let themeOptions = { theme, codeTheme };
    if (theme.startsWith('shared:')) {
      const sharedThemeName = theme.replace('shared:', '');
      try {
        const themeUrls = await getThemeUrls(gitOrgLogin, repo, sharedThemeName);
        themeOptions = {
          theme,
          codeTheme,
          libCssUrl: themeUrls.libCssUrl,
          customThemeUrl: themeUrls.customThemeUrl,
          bodyClasses: themeUrls.bodyClasses,
        };
      } catch (err) {
        console.error(`Failed to get shared theme URLs for ${sharedThemeName}:`, err);
        // Fall back to default theme if shared theme lookup fails
        themeOptions = { theme: 'white', codeTheme };
      }
    }

    // Wrap the slides content in a reveal.js HTML template
    const fullHtml = generateSlideHtml(htmlContent, slide.title, themeOptions);

    // Save to GitHub via ContentService
    const result = await ContentService.put({
      orgLogin: gitOrgLogin,
      repo,
      path: filePath,
      content: fullHtml,
      message: `Update slides: ${slide.title}`,
    });

    // Update the slide's updated_at timestamp
    await prisma.slide.update({
      where: { id: slideId },
      data: { updated_at: new Date() },
    });

    // Check for orphaned images after save
    let orphanedImages = [];
    try {
      orphanedImages = await ContentService.findOrphanedImages({
        orgLogin: gitOrgLogin,
        repo,
        imagesFolder: `${slide.content_path}/images`,
        htmlContent: fullHtml,
      });
    } catch (err) {
      // Don't fail the save if orphan detection fails
      console.error('Failed to detect orphaned images:', err);
    }

    // Return the full HTML so UI can update without waiting for CDN
    return {
      success: true,
      sha: result.sha,
      savedContent: fullHtml,
      orphanedImages,
    };
  } catch (error) {
    console.error('Failed to save slide:', error);
    return { error: error.message };
  }
};

// Built-in Reveal.js themes
const BUILTIN_THEMES = ['black', 'white', 'league', 'beige', 'night', 'serif', 'simple', 'solarized', 'moon', 'dracula', 'sky', 'blood'];

// Generate theme stylesheet URL for built-in themes
/** @param {string} theme */
function getBuiltinThemeUrl(theme) {
  if (BUILTIN_THEMES.includes(theme)) {
    return `https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/${theme}.css`;
  }
  // Custom CSS themes are relative paths
  if (theme.startsWith('custom:')) {
    return null; // Custom themes loaded dynamically by RevealSlides
  }
  // Default fallback
  return `https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/theme/white.css`;
}

/**
 * Generate a complete reveal.js HTML document
 * @param {string} slidesContent - The slides content with data attributes
 * @param {string} title - The slide title
 * @param {Object} [options] - Theme options
 * @param {string} [options.theme] - Theme name (e.g., 'white', 'shared:my-theme')
 * @param {string} [options.codeTheme] - Code syntax theme (e.g., 'github-dark')
 * @param {string} [options.libCssUrl] - Shared theme lib CSS URL
 * @param {string | null} [options.customThemeUrl] - Shared theme custom CSS URL
 * @param {string} [options.bodyClasses] - Body classes for shared theme
 */
function generateSlideHtml(slidesContent, title, options = {}) {
  const {
    theme = 'white',
    codeTheme = 'github',
    libCssUrl = null,
    customThemeUrl = null,
    bodyClasses = '',
  } = options;

  // Determine if using shared theme
  const isSharedTheme = theme.startsWith('shared:');
  const sharedThemeName = isSharedTheme ? theme.replace('shared:', '') : null;

  // Strip any wrapper div (e.g., <div class="slides"...> or <div class="reveal"...>)
  let cleanContent = slidesContent;
  cleanContent = cleanContent.replace(/^<div class="slides"[^>]*>\n?/, '').replace(/\n?<\/div>$/, '');
  cleanContent = cleanContent.replace(/^<div class="reveal"[^>]*><div class="slides"[^>]*>\n?/, '').replace(/\n?<\/div><\/div>$/, '');

  // Build theme CSS links
  let themeCssLinks = '';
  if (isSharedTheme && libCssUrl) {
    // Shared theme from slides.com import
    themeCssLinks = `
  <!-- Shared theme lib CSS (fonts, base styles) -->
  <link rel="stylesheet" href="${libCssUrl}">`;
    if (customThemeUrl) {
      themeCssLinks += `
  <!-- Shared theme custom CSS -->
  <link rel="stylesheet" href="${customThemeUrl}">`;
    }
    // Add override styles for sl-block visibility
    themeCssLinks += `
  <style>
    /* Override slides.com animation system - make all elements visible */
    .sl-block-content,
    .sl-block-content[data-animation-type],
    .sl-block-content[data-animation-type="fade-in"],
    .sl-block-content[data-animation-type="fade-out"] {
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
    }
  </style>`;
  } else {
    // Built-in reveal.js theme
    const themeUrl = getBuiltinThemeUrl(theme);
    if (themeUrl) {
      themeCssLinks = `
  <!-- Reveal.js theme -->
  <link rel="stylesheet" href="${themeUrl}">`;
    }
  }

  // Code syntax highlighting
  const codeThemeCss = `
  <!-- Code syntax highlighting -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/${codeTheme}.min.css">`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.css">${themeCssLinks}${codeThemeCss}
</head>
<body class="${bodyClasses}">
  <div class="reveal"${isSharedTheme ? ` data-theme="shared:${sharedThemeName}"` : ` data-theme="${theme}"`} data-code-theme="${codeTheme}">
    <div class="slides">
${cleanContent}
    </div>
  </div>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/dist/reveal.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/reveal.js@5.1.0/plugin/highlight/highlight.js"></script>
  <script>
    Reveal.initialize({
      hash: true,
      controls: true,
      progress: true,
      center: true,
      transition: 'slide',
      plugins: [RevealHighlight]
    });
  </script>
</body>
</html>`;
}

export default function SlideViewer() {
  const { slide, contentUrl, slideContent, contentError, snippets: initialSnippets, cssThemes: initialCssThemes, customThemes: initialCustomThemes, sharedThemes: initialSharedThemes, webappUrl, autoEdit, returnUrl, canEdit, canPresent, canViewSpeakerNotes, userRole } = useLoaderData();
  const [snippets, setSnippets] = useState(initialSnippets || []);
  const [cssThemes, setCssThemes] = useState(initialCssThemes || []);
  // Themes are now lazy-loaded when entering edit mode
  const [customThemes, setCustomThemes] = useState(initialCustomThemes || []);
  const [sharedThemes, setSharedThemes] = useState(initialSharedThemes || []);
  const [themesLoaded, setThemesLoaded] = useState(false);
  const { user } = useUser();

  const [isEditing, setIsEditing] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [isLoadingLatest, setIsLoadingLatest] = useState(false);
  const [autoEditTriggered, setAutoEditTriggered] = useState(false);
  // Track editable content separately from CDN content
  const [editableContent, setEditableContent] = useState(null);
  // Orphaned images cleanup
  const [orphanedImages, setOrphanedImages] = useState([]);
  const [showOrphanedModal, setShowOrphanedModal] = useState(false);
  const [isDeletingImages, setIsDeletingImages] = useState(false);
  const [showOverview, setShowOverview] = useState(false);
  const [notesCollapsed, setNotesCollapsed] = useState(true);
  const [backUrl, setBackUrl] = useState(webappUrl);
  const fetcher = useFetcher();
  const themeFetcher = useFetcher(); // For lazy-loading themes
  const snippetFetcher = useFetcher(); // For lazy-loading snippets
  const revealRef = useRef(null);
  const [revealInstance, setRevealInstance] = useState(null);
  const [currentSlideTheme, setCurrentSlideTheme] = useState('white'); // For Sandpack auto-theme

  // Lazy-load themes when entering edit mode
  useEffect(() => {
    if (isEditing && !themesLoaded && themeFetcher.state === 'idle') {
      // Load themes and snippets when entering edit mode
      themeFetcher.submit(
        { intent: 'list-themes' },
        { method: 'POST' }
      );
      snippetFetcher.submit(
        { intent: 'list-snippets' },
        { method: 'POST' }
      );
    }
  }, [isEditing, themesLoaded]);

  // Update state when themes are loaded
  useEffect(() => {
    if (themeFetcher.data?.intent === 'list-themes') {
      setCustomThemes(themeFetcher.data.customThemes || []);
      setSharedThemes(themeFetcher.data.sharedThemes || []);
      setThemesLoaded(true);
    }
  }, [themeFetcher.data]);

  // Update state when snippets are loaded
  useEffect(() => {
    if (snippetFetcher.data?.intent === 'list-snippets') {
      setSnippets(snippetFetcher.data.snippets || []);
    }
  }, [snippetFetcher.data]);

  // Store returnUrl in sessionStorage and clean the URL on mount
  useEffect(() => {
    // Check if we have a returnUrl from query params
    if (returnUrl) {
      sessionStorage.setItem('slidesReturnUrl', returnUrl);
      // Clean the URL by removing the returnUrl param
      const url = new URL(window.location.href);
      url.searchParams.delete('returnUrl');
      window.history.replaceState({}, '', url.toString());
    }
    // Set backUrl from sessionStorage (or fall back to webappUrl)
    const storedUrl = sessionStorage.getItem('slidesReturnUrl');
    if (storedUrl) {
      setBackUrl(storedUrl);
    }
  }, [returnUrl]);

  // Update revealInstance when RevealSlides mounts/updates
  // Needed for both edit mode (notes editing) and view mode (notes preview)
  useEffect(() => {
    if (revealRef.current) {
      // Small delay to ensure Reveal.js has initialized
      const timer = setTimeout(() => {
        setRevealInstance(revealRef.current?.getRevealInstance?.());
        // Update current theme for Sandpack auto-theme detection
        const themes = revealRef.current?.getThemes?.();
        if (themes?.theme) {
          setCurrentSlideTheme(themes.theme);
        }
      }, 100);
      return () => clearTimeout(timer);
    } else {
      setRevealInstance(null);
    }
  }, [isEditing, editableContent, slideContent]); // Re-run when editing state or content changes

  // Trigger Reveal.js layout recalculation when entering edit mode
  // This fixes centering issues caused by CSS changes (like min-height on columns)
  // Reveal.js needs to recalculate its transform-based scaling after DOM changes
  useEffect(() => {
    if (isEditing && revealInstance) {
      // Small delay to ensure CSS changes (contenteditable, min-height) have been applied
      const timer = setTimeout(() => {
        revealInstance.layout();
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [isEditing, revealInstance]);

  // Warn user before closing tab/refreshing if there are unsaved changes
  // Note: Modern browsers ignore custom messages and show their own generic dialog
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (isEditing && hasChanges) {
        e.preventDefault();
        // Modern browsers ignore this, but it's required for the dialog to show
        e.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isEditing, hasChanges]);

  // canEdit, canPresent, canViewSpeakerNotes now come from loader data (computed by assertSlideAccess)

  // Auto-enter edit mode if ?mode=edit was in URL (for new slides where CDN hasn't caught up)
  // Only triggers once on mount, and only if user has permission to edit
  useEffect(() => {
    if (autoEdit && canEdit && !autoEditTriggered && !isEditing) {
      setAutoEditTriggered(true);
      // Trigger the same flow as clicking "Edit" button - fetch latest from API
      setIsLoadingLatest(true);
      fetcher.submit(
        { intent: 'fetch-latest' },
        { method: 'post' }
      );
    }
  }, [autoEdit, canEdit, autoEditTriggered, isEditing, fetcher]);

  const isSaving = fetcher.state === 'submitting' && !fetcher.formData?.get('intent');
  const isFetchingLatest = fetcher.state === 'submitting' && fetcher.formData?.get('intent') === 'fetch-latest';
  const saveSuccess = fetcher.data?.success;
  const saveError = fetcher.data?.error;

  // Handle fetcher responses
  useEffect(() => {
    if (fetcher.data?.intent === 'fetch-latest' && fetcher.data?.content) {
      // Got fresh content from GitHub API - enter edit mode with it
      setEditableContent(fetcher.data.content);
      setIsEditing(true);
      setIsLoadingLatest(false);
    } else if (fetcher.data?.intent === 'delete-images') {
      // Images were deleted
      setIsDeletingImages(false);
      if (fetcher.data.success) {
        message.success(`Deleted ${fetcher.data.deleted} unused image${fetcher.data.deleted !== 1 ? 's' : ''}`);
        setShowOrphanedModal(false);
        setOrphanedImages([]);
      } else if (fetcher.data.error) {
        message.error(`Failed to delete images: ${fetcher.data.error}`);
      }
    } else if (fetcher.data?.intent === 'save-snippet') {
      // Snippet was saved
      if (fetcher.data.success && fetcher.data.snippet) {
        message.success(`Snippet "${fetcher.data.snippet.name}" saved!`);
        // Add the new snippet to the list
        setSnippets((/** @type {Array<{id: string, name: string, content: string}>} */ prev) => [...prev, fetcher.data.snippet]);
      } else if (fetcher.data.error) {
        message.error(`Failed to save snippet: ${fetcher.data.error}`);
      }
    } else if (fetcher.data?.intent === 'update-snippet') {
      // Snippet was updated
      if (fetcher.data.success && fetcher.data.snippet) {
        message.success(`Snippet "${fetcher.data.snippet.name}" updated!`);
        // Replace the old snippet with the updated one
        setSnippets((/** @type {Array<{id: string, name: string, content: string}>} */ prev) =>
          prev.map(s => s.id === fetcher.data.oldId ? fetcher.data.snippet : s)
        );
      } else if (fetcher.data.error) {
        message.error(`Failed to update snippet: ${fetcher.data.error}`);
      }
    } else if (fetcher.data?.intent === 'delete-snippet') {
      // Snippet was deleted
      if (fetcher.data.success) {
        message.success('Snippet deleted');
        // Remove the snippet from the list
        setSnippets((/** @type {Array<{id: string, name: string, content: string}>} */ prev) =>
          prev.filter(s => s.id !== fetcher.data.deletedId)
        );
      } else if (fetcher.data.error) {
        message.error(`Failed to delete snippet: ${fetcher.data.error}`);
      }
    } else if (fetcher.data?.intent === 'save-theme') {
      // CSS theme was saved
      if (fetcher.data.success && fetcher.data.theme) {
        message.success(`CSS theme "${fetcher.data.theme.name}" saved!`);
        // Add the new theme to the list
        setCssThemes((/** @type {Array<{id: string, name: string, type: string, content: string}>} */ prev) => [...prev, fetcher.data.theme]);
      } else if (fetcher.data.error) {
        message.error(`Failed to save theme: ${fetcher.data.error}`);
      }
    } else if (fetcher.data?.intent === 'update-theme') {
      // CSS theme was updated
      if (fetcher.data.success && fetcher.data.theme) {
        message.success(`CSS theme "${fetcher.data.theme.name}" updated!`);
        // Replace the old theme with the updated one
        setCssThemes((/** @type {Array<{id: string, name: string, type: string, content: string}>} */ prev) =>
          prev.map(t => t.id === fetcher.data.oldId ? fetcher.data.theme : t)
        );
      } else if (fetcher.data.error) {
        message.error(`Failed to update theme: ${fetcher.data.error}`);
      }
    } else if (fetcher.data?.intent === 'delete-theme') {
      // CSS theme was deleted
      if (fetcher.data.success) {
        message.success('CSS theme deleted');
        // Remove the theme from the list
        setCssThemes((/** @type {Array<{id: string, name: string, type: string, content: string}>} */ prev) =>
          prev.filter(t => t.id !== fetcher.data.deletedId)
        );
      } else if (fetcher.data.error) {
        message.error(`Failed to delete theme: ${fetcher.data.error}`);
      }
    } else if (fetcher.data?.savedContent) {
      // After save, update our local content to match what was saved
      // This prevents stale content when CDN hasn't updated yet
      setEditableContent(fetcher.data.savedContent);
      // Check if there are orphaned images to clean up
      if (fetcher.data.orphanedImages?.length > 0) {
        setOrphanedImages(fetcher.data.orphanedImages);
        setShowOrphanedModal(true);
      }
    }
  }, [fetcher.data]);

  // Handle image upload - returns a promise that resolves with the image URL
  const handleImageUpload = useCallback(async (file) => {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      formData.append('intent', 'upload-image');
      formData.append('file', file);

      fetcher.submit(formData, {
        method: 'post',
        encType: 'multipart/form-data',
      });

      // We'll resolve this in the useEffect when we get the response
      // Store the resolve/reject for later
      window.__imageUploadResolve = resolve;
      window.__imageUploadReject = reject;
    });
  }, [fetcher]);

  // Handle image upload response
  useEffect(() => {
    if (fetcher.data?.intent === 'upload-image') {
      if (fetcher.data.success && fetcher.data.url) {
        window.__imageUploadResolve?.(fetcher.data.url);
      } else if (fetcher.data.error) {
        window.__imageUploadReject?.(new Error(fetcher.data.error));
      }
      // Clean up
      delete window.__imageUploadResolve;
      delete window.__imageUploadReject;
    }
  }, [fetcher.data]);

  // Handle content changes from the editor
  // Also triggers Reveal.js layout recalculation to maintain vertical centering
  const handleContentChange = useCallback(() => {
    setHasChanges(true);

    // Recalculate Reveal.js layout to update vertical centering
    // Use requestAnimationFrame to batch multiple rapid changes
    // Query the instance fresh from the ref to avoid stale closure issues
    const instance = revealRef.current?.getRevealInstance?.();
    if (instance) {
      requestAnimationFrame(() => {
        instance.layout();
      });
    }
  }, []);

  // Enter edit mode - first fetch latest content from GitHub API
  const handleStartEditing = useCallback(() => {
    setIsLoadingLatest(true);
    fetcher.submit(
      { intent: 'fetch-latest' },
      { method: 'post' }
    );
  }, [fetcher]);

  // Save the current slide content and exit edit mode
  const handleSave = useCallback(() => {
    const content = revealRef.current?.getCurrentContent();
    if (!content) return;

    fetcher.submit(
      { content },
      { method: 'post' }
    );
    setHasChanges(false);
    setIsEditing(false);
  }, [fetcher]);

  // Save content without exiting edit mode (used for auto-save after destructive operations)
  const handleSaveContent = useCallback(() => {
    const content = revealRef.current?.getCurrentContent();
    if (!content) return;

    fetcher.submit(
      { content },
      { method: 'post' }
    );
    setHasChanges(false);
    // Don't exit edit mode - user is still editing
  }, [fetcher]);

  // Exit editing mode (discards unsaved changes)
  const handleDoneEditing = useCallback(() => {
    setIsEditing(false);
    setHasChanges(false);
    // Keep editableContent for next edit session (it's the latest we know of)
  }, []);

  // Delete selected orphaned images
  const handleDeleteOrphanedImages = useCallback((paths) => {
    setIsDeletingImages(true);
    fetcher.submit(
      {
        intent: 'delete-images',
        paths: JSON.stringify(paths),
      },
      { method: 'post' }
    );
  }, [fetcher]);

  // Close orphaned images modal without deleting
  const handleCloseOrphanedModal = useCallback(() => {
    setShowOrphanedModal(false);
    setOrphanedImages([]);
  }, []);

  // Open slide overview
  const handleOpenOverview = useCallback(() => {
    setShowOverview(true);
  }, []);

  // Close slide overview
  const handleCloseOverview = useCallback(() => {
    setShowOverview(false);
  }, []);

  // Navigate to a specific slide (from overview)
  const handleNavigateToSlide = useCallback((h, v) => {
    const instance = revealRef.current?.getRevealInstance?.();
    if (instance) {
      instance.slide(h, v);
    }
  }, []);

  // Determine which content to show
  // - When editing: use editableContent (fresh from API or after save)
  // - When viewing: use CDN content (slideContent) or editableContent if we have it
  const displayContent = isEditing ? editableContent : (editableContent || slideContent);

  // Save a new snippet
  const handleSaveSnippet = useCallback((/** @type {string} */ name, /** @type {string} */ content) => {
    fetcher.submit(
      { intent: 'save-snippet', name, content },
      { method: 'post' }
    );
  }, [fetcher]);

  // Update an existing snippet
  const handleUpdateSnippet = useCallback((/** @type {string} */ id, /** @type {string} */ name, /** @type {string} */ content) => {
    fetcher.submit(
      { intent: 'update-snippet', id, name, content },
      { method: 'post' }
    );
  }, [fetcher]);

  // Delete a snippet
  const handleDeleteSnippet = useCallback((/** @type {string} */ id) => {
    fetcher.submit(
      { intent: 'delete-snippet', id },
      { method: 'post' }
    );
  }, [fetcher]);

  // Save a new CSS theme
  const handleSaveTheme = useCallback((/** @type {string} */ name, /** @type {string} */ type, /** @type {string} */ content) => {
    fetcher.submit(
      { intent: 'save-theme', name, type, content },
      { method: 'post' }
    );
  }, [fetcher]);

  // Update an existing CSS theme
  const handleUpdateTheme = useCallback((/** @type {string} */ id, /** @type {string} */ name, /** @type {string} */ type, /** @type {string} */ content) => {
    fetcher.submit(
      { intent: 'update-theme', id, name, type, content },
      { method: 'post' }
    );
  }, [fetcher]);

  // Delete a CSS theme
  const handleDeleteTheme = useCallback((/** @type {string} */ id) => {
    fetcher.submit(
      { intent: 'delete-theme', id },
      { method: 'post' }
    );
  }, [fetcher]);

  return (
    <ElementSelectionProvider
      editorRef={revealRef}
      isEditing={isEditing}
      onContentChange={handleContentChange}
      onSaveContent={handleSaveContent}
      snippets={snippets}
      onSaveSnippet={handleSaveSnippet}
      onUpdateSnippet={handleUpdateSnippet}
      onDeleteSnippet={handleDeleteSnippet}
      cssThemes={cssThemes}
      onSaveTheme={handleSaveTheme}
      onUpdateTheme={handleUpdateTheme}
      onDeleteTheme={handleDeleteTheme}
      customThemes={customThemes}
      sharedThemes={sharedThemes}
    >
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Navbar - uses grid layout to center toolbar when editing */}
      <nav className={`slides-navbar ${isEditing ? 'slides-navbar-editing' : ''}`}>
        {/* Left section: back button + title */}
        <div className="flex items-center gap-3 min-w-0">
          <a
            href={backUrl}
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 shrink-0"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clipRule="evenodd" />
            </svg>
          </a>
          <h1 className="text-lg font-semibold text-gray-900 dark:text-white truncate">
            {slide.title}
          </h1>
        </div>

        {/* Center section: toolbar (only when editing) */}
        {isEditing && (
          <div className="flex items-center justify-center">
            <SlideToolbar
              revealInstance={revealInstance}
              onContentChange={handleContentChange}
              onImageUpload={handleImageUpload}
              onOpenOverview={handleOpenOverview}
            />
          </div>
        )}

        {/* Right section: status + actions */}
        <div className="flex items-center gap-2 justify-end">
          {/* Status badges */}
          {isEditing && (
            <span className="px-2 py-0.5 text-xs bg-yellow-100 text-yellow-800 rounded-full">
              {hasChanges ? 'Unsaved' : 'Editing'}
            </span>
          )}
          {saveSuccess && !hasChanges && !isEditing && (
            <span className="px-2 py-0.5 text-xs bg-green-100 text-green-800 rounded-full">
              Saved
            </span>
          )}
          {saveError && (
            <span className="px-2 py-0.5 text-xs bg-red-100 text-red-800 rounded-full" title={saveError}>
              Error
            </span>
          )}

          {/* Action buttons */}
          {canEdit && isEditing && (
            hasChanges ? (
              <Popconfirm
                title="Discard changes?"
                description="You have unsaved changes. Discard them?"
                onConfirm={handleDoneEditing}
                okText="Discard"
                cancelText="Keep editing"
                okButtonProps={{ danger: true }}
              >
                <Tooltip title="Cancel editing">
                  <button
                    className="p-2 text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </Tooltip>
              </Popconfirm>
            ) : (
              <Tooltip title="Cancel editing">
                <button
                  onClick={handleDoneEditing}
                  className="p-2 text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </Tooltip>
            )
          )}
          {canEdit && isEditing && (
            <Tooltip title={isSaving ? 'Saving...' : 'Save changes'}>
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="save-button p-2 rounded-md disabled:opacity-50"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </button>
            </Tooltip>
          )}
          {canEdit && !isEditing && (
            <button
              onClick={handleStartEditing}
              disabled={isLoadingLatest || isFetchingLatest}
              className="px-3 py-1.5 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600"
            >
              {isLoadingLatest || isFetchingLatest ? 'Loading...' : 'Edit'}
            </button>
          )}
          {/* Present button - only shown if user can present (staff only) */}
          {canPresent && (
            <Tooltip title="Present slideshow">
              <a
                href={`/${slide.id}/present`}
                className="p-2 bg-black text-white rounded-md hover:bg-gray-800 flex items-center justify-center"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </a>
            </Tooltip>
          )}
        </div>
      </nav>

      {/* Main content area with optional properties sidebar */}
        <div className={`reveal-container ${isEditing ? 'reveal-container-with-sidebar' : ''}`}>
          {/* Flex layout for slide + notes panel */}
          <div className="reveal-editor-layout">
            {/* Slide preview area */}
            <div className="reveal-slide-area">
              {/* Key changes when entering/exiting edit mode to force full remount
                  This ensures Reveal.js reinitializes with the correct content source */}
              <RevealSlides
                ref={revealRef}
                key={isEditing ? 'editing' : 'viewing'}
                contentUrl={contentUrl}
                initialContent={displayContent}
                initialError={contentError}
                canEdit={canEdit}
                isEditing={isEditing}
                onContentChange={handleContentChange}
                customThemes={customThemes}
                sharedThemes={sharedThemes}
              />
              {/* Mount Sandpack components into .sandpack-embed elements */}
              <SandpackRenderer
                containerSelector=".reveal .slides"
                slideTheme={currentSlideTheme}
                onContentChange={isEditing ? handleContentChange : undefined}
                isEditing={isEditing}
              />
            </div>

            {/* Speaker notes panel - only shown if user has permission */}
            {/* Staff always have access; viewers (students/public) only if show_speaker_notes=true */}
            {canViewSpeakerNotes && (
              <SlideNotesPanel
                revealInstance={revealInstance}
                isCollapsed={notesCollapsed}
                onToggle={() => setNotesCollapsed(!notesCollapsed)}
                onContentChange={isEditing ? handleContentChange : undefined}
                readOnly={!isEditing}
              />
            )}
          </div>
        </div>

        {/* Properties sidebar (only when editing) */}
        {isEditing && (
          <div className="properties-sidebar">
            <PropertiesPanel />
          </div>
        )}

        {/* Image resize handles (only when editing) */}
        {isEditing && <ImageResizeHandles />}

        {/* Block resize/move handles (only when editing) */}
        {isEditing && <BlockHandles />}

        {/* Orphaned Images Cleanup Modal */}
        <OrphanedImagesModal
          open={showOrphanedModal}
          images={orphanedImages}
          onClose={handleCloseOrphanedModal}
          onDelete={handleDeleteOrphanedImages}
          isDeleting={isDeletingImages}
        />

        {/* Slide Overview */}
        {showOverview && (
          <SlideOverview
            revealInstance={revealInstance}
            onClose={handleCloseOverview}
            onContentChange={handleContentChange}
            onNavigate={handleNavigateToSlide}
          />
        )}
      </div>
    </ElementSelectionProvider>
  );
}
