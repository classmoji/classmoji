/**
 * Slides.com Import Utility
 *
 * Imports slides.com ZIP exports into the Classmoji slides platform,
 * preserving the sl-block structure for editing with the block editor.
 */

import JSZip from 'jszip';
import * as cheerio from 'cheerio';
import getPrisma from '@classmoji/database';
import { ContentService } from '@classmoji/content';
import { GitHubProvider, ClassmojiService } from '@classmoji/services';
import {
  generateDeckHtml,
  parseSlidesFragment,
  type DeckExtraCss,
  type DeckJson,
} from '@classmoji/services/slides';
import { getContentRepoName } from '@classmoji/utils';
import { getThemeUrls, saveTheme, generateThemeSlug } from './themeService.server.ts';
import { loadUploadCapability } from './uploadCapability.server.ts';
import {
  RepoEntryGate,
  declaredUncompressedSize,
  inflateAtMost,
  resolveMediaRef,
  slideNumberLabel,
} from './zipRepoEntries.ts';
import {
  ImportLimits,
  importAssetType,
  importMediaOptions,
  placeImportEntry,
} from './importVideoMedia.ts';

/**
 * Seeded into deck.json's customCss at import time: overrides slides.com's
 * animation system so all elements are fully visible. The canonical deck
 * generator emits NO implicit styles (content-tools plan §2), so this rule
 * must live in the deck's customCss to survive regeneration.
 */
const SL_BLOCK_VISIBILITY_CSS = `
    /* Override slides.com animation system - make all elements fully visible */
    .sl-block-content,
    .sl-block-content[data-animation-type],
    .sl-block-content[data-animation-type="fade-in"],
    .sl-block-content[data-animation-type="fade-out"] {
      opacity: 1 !important;
      visibility: visible !important;
      pointer-events: auto !important;
    }
  `;

/**
 * Process a slides.com ZIP export and create a slide in the system
 * @param {Object} options
 * @param {File|Blob} options.zipFile - The ZIP file to import
 * @param {string} options.title - Title for the slide
 * @param {string} [options.repositoryId] - Repository UUID for optional linking
 * @param {boolean} options.importTheme - Whether to import custom theme CSS (ignored if useSavedTheme is set)
 * @param {string} [options.useSavedTheme] - Name of saved theme to use (skips lib/ extraction)
 * @param {string} [options.saveThemeAs] - Save extracted theme with this name to .slidesthemes/
 * @param {string} options.org - Git organization login (for GitHub API calls)
 * @param {string} [options.classroomSlug] - Classroom slug (for database reference)
 * @param {string} options.classroomId - Classroom UUID (for database reference)
 * @param {string} options.contentNamespace - Classroom content namespace (e.g., "25w" or a slug)
 * @param {string} options.userId - User ID who is importing
 * @param {Function} [options.onProgress] - Callback for progress updates ({ type: 'step'|'done'|'error', step?: string, current?: number, total?: number, filename?: string, warnings?: string[] })
 * @returns {Promise<{slideId: string, slideCount: number, imageCount: number, themeSaved?: string, mediaVideos?: number, warnings: string[]}>}
 *
 * ## Files too large for the course repository
 *
 * Everything the import keeps goes to GitHub in ONE commit, and GitHub refuses
 * a single file over the REST ceiling by refusing the whole commit. So every
 * entry is measured against `REPO_REST_MAX_BYTES` as it is read, and one over
 * it is left out with a warning naming it and the slides that used it
 * (`warnings`, also on the `done` event) — the deck imports without it rather
 * than not at all. An entry is measured by the size its ZIP header declares
 * before it is decompressed, and again after. The deck's references to a file
 * left out are removed rather than left pointing at nothing.
 *
 * ## Assets on a classroom with media storage
 *
 * Where the classroom has media, the storage router sends every video there
 * (and anything over the repository's cap, an image included), exactly as it
 * does for the editor's own uploads. Those files are not repository files: each
 * is written with `putMediaObject` and the deck references it as
 * `media://{id}`. A write that fails leaves that one file out, with a warning
 * through the same channel as the size skips — never the whole import. A
 * classroom without media keeps every asset on the repository path above.
 *
 * ## Memory
 *
 * A ZIP under the upload cap can hold entries that inflate to gigabytes. Each
 * entry is judged by its declared size BEFORE it is inflated (too large for
 * anywhere it could go → left out, never read) and inflated as a stream that
 * stops past that size, since the header is the uploader's word. Entries are
 * placed one at a time (a media file is stored and its bytes dropped before the
 * next is read).
 * The files kept for the repository ARE held until the one commit, so their
 * total has a limit, and the import has a total inflated-bytes budget; an entry
 * past either is left out with a warning. See `importVideoMedia.ts`.
 */
export async function processZipImport({
  zipFile,
  title,
  repositoryId,
  importTheme,
  useSavedTheme,
  saveThemeAs,
  org,
  classroomSlug: _classroomSlug,
  classroomId,
  contentNamespace,
  userId,
  onProgress = () => {},
}: {
  zipFile: File | Blob;
  title: string;
  repositoryId?: string | null;
  importTheme: boolean;
  useSavedTheme?: string | null;
  saveThemeAs?: string | null;
  org: string;
  classroomSlug?: string;
  classroomId: string;
  contentNamespace: string;
  userId: string;
  onProgress?: (event: {
    type: string;
    step?: string;
    current?: number;
    total?: number;
    filename?: string;
    slideId?: string;
    message?: string;
    warnings?: string[];
  }) => void;
}) {
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
  const slug = slideTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);

  // 4. Get classroom from database (org param is git org login for GitHub API)
  const classroom = await getPrisma().classroom.findUnique({
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
  const gitProvider = new GitHubProvider(
    classroom.git_organization.github_installation_id as string,
    org
  );

  // 5. Flat content path: slides/{slug}-{timestamp}
  const timestamp = Date.now();
  const contentPath = `slides/${slug}-${timestamp}`;
  // Content repo is STORED and user-editable — never re-derived. Legacy
  // classrooms without one fall back to the ORG-level content repo.
  const repoName = classroom.content_repo
    ? classroom.content_repo
    : getContentRepoName({ login: classroom.git_organization.login });

  // 6. Ensure content repo exists (org is git org login for GitHub API)
  const repoExists = await gitProvider.repositoryExists(org, repoName);
  if (!repoExists) {
    console.log(`Creating content repository: ${repoName}`);
    await gitProvider.createContentRepository(
      org,
      repoName,
      `Course content for ${classroom.name || org} - ${contentNamespace}`,
      ClassmojiService.contentDelivery.shouldCreatePrivateContentRepo(classroom)
    );
    // Give GitHub a moment to initialize the repo
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // No GitHub Pages, ever — same rule as page.service.ensureContentRepoExists.
  // The delivery layer serves gated classrooms; legacy ones read through the
  // authenticated proxy.

  // Where this classroom's uploads can go — the same capability the editors
  // route against, re-derived here from the classroom row. Media on it means
  // the router sends videos to media storage instead of the repository. A
  // lookup that fails degrades to null — every asset takes the repository path
  // within its cap — rather than failing the import.
  const uploadCapability = await loadUploadCapability(classroom, 'slides.com import');

  // 7. Collect files for batch upload
  const files: Array<{ path: string; content: string; encoding: 'utf-8' | 'base64' }> = [];

  // Entries left out for being over the course repository's per-file ceiling —
  // see "Files too large for the course repository" above.
  const repoGate = new RepoEntryGate();
  // The slides that referenced each file left out — `3`, or `3.2` in a stack —
  // so its warning can say where the gap is.
  const skippedOnSlides = new Map<string, string[]>();
  /** @type {Map<string, string>} Maps old image path to new absolute URL */
  const imageMap = new Map();

  // Use content proxy URLs for all assets. The proxy reads them through
  // authenticated GitHub calls, so they load as soon as the import commits — a
  // repo created here has no GitHub Pages site for its CDN leg to hit.
  const baseUrl = `/content/${org}/${repoName}/${contentPath}`;
  const imageBaseUrl = `${baseUrl}/images`;

  // The slide row, before any asset is placed: a file bound for media is
  // written as soon as it is read (one at a time, so the ZIP's contents are
  // never all in memory), and everything from here to the commit is covered
  // by ONE cleanup — the media written, then the row.
  const slide = await getPrisma().slide.create({
    data: {
      title: slideTitle,
      slug,
      content_path: contentPath,
      classroom_id: classroom.id,
      created_by: userId,
    },
  });

  /** Media objects this import wrote, deleted again if the import fails. */
  const storedMediaIds: string[] = [];
  let cleanedUp = false;

  /**
   * Delete the media objects this import wrote, then the slide record, after a
   * failed import. Nothing references those objects once the commit is gone,
   * and they would otherwise count against the class's quota.
   *
   * Media FIRST, and each step on its own: a slide delete that fails must not
   * leave billed media behind, and a media delete that fails must not keep the
   * rest from going. Every failure is logged and swallowed, so the import's own
   * error is the one the uploader sees. Runs once, however many catches reach it.
   */
  const cleanupFailedImport = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const mediaId of storedMediaIds) {
      try {
        await ClassmojiService.media.deleteMedia({ classroom, mediaId });
      } catch (cleanupErr: unknown) {
        const message = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
        console.error(`Failed to delete media ${mediaId} after a failed import:`, message);
      }
    }

    try {
      await getPrisma().slide.delete({ where: { id: slide.id } });
    } catch (cleanupErr: unknown) {
      const message = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.error(`Failed to delete slide ${slide.id} after a failed import:`, message);
    }
  };

  // Filled inside the guarded block below, read after it.
  let warnings: string[] = [];
  let themeSaved: string | null = null;
  const $slides = $('.reveal .slides');

  try {
    // Link slide to repository
    if (repositoryId) {
      await getPrisma().slideLink.create({
        data: {
          slide_id: slide.id,
          repository_id: repositoryId,
        },
      });
    }

    // 7a. Extract body classes for theme variants
    const bodyClasses = $('body').attr('class') || '';
    const themeFont = bodyClasses.match(/theme-font-[a-z-]+/)?.[0] || '';
    const themeColor = bodyClasses.match(/theme-color-[a-z-]+/)?.[0] || '';

    // 7b. The ZIP's images and videos, each routed by the storage router — the
    // same one the editors ask. On a classroom with media every video goes there,
    // and so does anything over the repository's cap (an image included); the
    // rest go to the repository, through its per-file gate.
    /** @type {Map<string, string>} Maps old video path to new absolute URL */
    const videoMap = new Map();
    const videoBaseUrl = `${baseUrl}/videos`;
    // What this import has inflated (repository and media alike) and what it
    // holds for the commit (assets and theme files) — one set, every entry.
    const limits = new ImportLimits();

    // 7c. First pass: identify images and videos for progress tracking
    const mediaFiles: Array<{
      filePath: string;
      file: JSZip.JSZipObject;
      filename: string;
      type: 'image' | 'video';
    }> = [];

    for (const [filePath, file] of Object.entries(zip.files)) {
      if (file.dir) continue;
      if (filePath.startsWith('lib/') || filePath === 'index.html') continue;

      const filename = filePath.split('/').pop();
      if (!filename) continue;

      const type = importAssetType(filePath);
      if (type) mediaFiles.push({ filePath, file, filename, type });
    }

    // Count by type for progress
    const imageFiles = mediaFiles.filter(f => f.type === 'image');
    const videoFiles = mediaFiles.filter(f => f.type === 'video');

    /**
     * Place each entry of one type, ONE AT A TIME: inflate it, store it (media
     * now, the repository at the commit), and let its bytes go before the next.
     * The size the ZIP declares is checked before anything is inflated.
     */
    const placeEntries = async (
      entries: typeof mediaFiles,
      step: 'processing_images' | 'processing_videos',
      map: Map<string, string>,
      folder: 'images' | 'videos',
      folderUrl: string
    ) => {
      if (entries.length > 0) onProgress({ type: 'step', step, current: 0, total: entries.length });

      for (let i = 0; i < entries.length; i++) {
        const { filePath, file, filename } = entries[i];
        onProgress({ type: 'step', step, current: i + 1, total: entries.length, filename });

        const placed = await placeImportEntry({
          entry: {
            filePath,
            filename,
            declared: declaredUncompressedSize(file),
            inflate: limit => inflateAtMost(file, limit),
          },
          capability: uploadCapability,
          gate: repoGate,
          limits,
          put: bytes =>
            ClassmojiService.media.putMediaObject({
              classroom,
              userId,
              filename,
              bytes,
              options: importMediaOptions(filename),
            }),
          onError: (name, error) =>
            console.error(
              `[slides.com import] Media storage refused ${name}:`,
              error instanceof Error ? error.message : error
            ),
        });
        if (placed.kind === 'skipped') continue;

        let url: string;
        if (placed.kind === 'media') {
          storedMediaIds.push(placed.mediaId);
          url = placed.ref;
        } else {
          files.push({
            path: `${contentPath}/${folder}/${filename}`,
            content: placed.buffer.toString('base64'),
            encoding: 'base64',
          });
          // An ABSOLUTE url: the viewer renders the deck in a different context,
          // where a relative path would resolve against the viewer's own URL.
          url = `${folderUrl}/${filename}`;
        }
        // Under its zip path, and its bare filename for fallback matching.
        map.set(filePath, url);
        map.set(filename, url);
      }
    };

    // 7d. Images
    await placeEntries(imageFiles, 'processing_images', imageMap, 'images', imageBaseUrl);

    // Images left out, for the reference pass in step 9.
    const skippedImages = repoGate.skippedPaths();

    // 7e. Videos (and audio)
    await placeEntries(videoFiles, 'processing_videos', videoMap, 'videos', videoBaseUrl);

    // 8. Handle theme - either use saved theme or extract from ZIP
    let libCssUrl: string | null = null;
    let customThemeUrl: string | null = null;
    let finalBodyClasses = `reveal-viewport ${themeFont} ${themeColor}`.trim();
    let sharedThemeName: string | null = null; // Track the shared theme name for data-theme attribute

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
      const libFiles: Array<{ path: string; content: string; encoding: 'utf-8' | 'base64' }> = [];
      for (const [filePath, file] of Object.entries(zip.files)) {
        if (filePath.startsWith('lib/') && !file.dir) {
          // The repository only (no capability, so never media), through the
          // same gate and the same limits as every other entry.
          const placed = await placeImportEntry({
            entry: {
              filePath,
              filename: filePath.split('/').pop() || filePath,
              declared: declaredUncompressedSize(file),
              inflate: limit => inflateAtMost(file, limit),
            },
            capability: null,
            gate: repoGate,
            limits,
            put: async () => {
              throw new Error('Theme files are never stored in media.');
            },
          });
          if (placed.kind !== 'repo') continue;
          libFiles.push({
            path: filePath,
            content: placed.buffer.toString('base64'),
            encoding: 'base64',
          });
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
          classroomId: classroom.id,
          onProgress: ({
            current,
            total,
            filename,
          }: {
            current: number;
            total: number;
            filename?: string;
          }) => {
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

    /** Reveal's number for the slide holding `el` (`3`, or `3.2` in a stack). */
    const slideOf = (el: Parameters<typeof $>[0]): string | null => {
      const indexes: number[] = [];
      let $section = $(el).closest('section');
      while ($section.length > 0) {
        indexes.push($section.parent().children('section').index($section));
        $section = $section.parent().closest('section');
      }
      return slideNumberLabel(indexes);
    };

    /** Remember that the slide holding `el` referenced a file left out. */
    const noteSkipped = (path: string, el: Parameters<typeof $>[0]) => {
      const label = slideOf(el);
      if (!label) return;
      const labels = skippedOnSlides.get(path) ?? [];
      if (!labels.includes(label)) labels.push(label);
      skippedOnSlides.set(path, labels);
    };

    // Process all elements with image-related attributes
    // Includes: src, data-src, data-background-image, data-video-thumb (slides.com video thumbnails), poster (HTML5 video)
    //
    // A reference to an image the import left out is REMOVED, not kept: left in
    // place it is a relative path into the ZIP, which resolves to nothing once
    // the deck is served from the repository.
    $slides
      .find('[src], [data-src], [data-background-image], [data-video-thumb], [poster]')
      .each((_, el) => {
        const $el = $(el);

        ['src', 'data-src', 'data-background-image', 'data-video-thumb', 'poster'].forEach(attr => {
          const val = $el.attr(attr);
          if (!val) return;

          const ref = resolveMediaRef(val, imageMap, skippedImages);
          if (ref?.kind === 'kept') {
            // Convert data-src to src for compatibility with our viewer
            if (attr === 'data-src') {
              $el.attr('src', ref.url);
              $el.removeAttr('data-src');
              $el.removeAttr('data-lazy-loaded');
            } else {
              $el.attr(attr, ref.url);
            }
          } else if (ref?.kind === 'skipped') {
            $el.removeAttr(attr);
            if (attr === 'data-src') $el.removeAttr('data-lazy-loaded');
            noteSkipped(ref.path, el);
          }
        });
      });

    // Also handle background images on sections
    $slides.find('section[data-background-image]').each((_, el) => {
      const $el = $(el);
      const val = $el.attr('data-background-image');
      if (!val) return;

      const ref = resolveMediaRef(val, imageMap, skippedImages);
      if (ref?.kind === 'kept') {
        $el.attr('data-background-image', ref.url);
      } else if (ref?.kind === 'skipped') {
        $el.removeAttr('data-background-image');
        noteSkipped(ref.path, el);
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
        } catch (parseErr: unknown) {
          console.warn(
            'Could not parse SLConfig for speaker notes:',
            parseErr instanceof Error ? parseErr.message : parseErr
          );
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

    // 9d. Video URL rewriting moved to step 11b (after the media writes populate videoMap)

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
      const parseStyleValue = (style: string, prop: string) => {
        const match = style.match(new RegExp(`${prop}\\s*:\\s*([\\d.]+)px`));
        return match ? parseFloat(match[1]) : null;
      };

      // Try iframe styles first, fall back to parent, then to attribute, then default
      const widthAttr = $iframe.attr('width');
      const heightAttr = $iframe.attr('height');
      const left =
        parseStyleValue(iframeStyle, 'left') ?? parseStyleValue(parentStyle, 'left') ?? 100;
      const top = parseStyleValue(iframeStyle, 'top') ?? parseStyleValue(parentStyle, 'top') ?? 100;
      const width =
        parseStyleValue(iframeStyle, 'width') ?? (widthAttr ? parseFloat(widthAttr) : null) ?? 560;
      const height =
        parseStyleValue(iframeStyle, 'height') ??
        (heightAttr ? parseFloat(heightAttr) : null) ??
        315;

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

    // 11b. Rewrite video URLs in HTML (now that videoMap has every URL, media
    // references included)
    //
    // As with images, a reference to a video the import left out — skipped on
    // the way in, or refused by media storage — is removed rather than left
    // pointing into the ZIP.
    const videoPaths = new Set(videoFiles.map(f => f.filePath));
    const skippedVideos = new Set([...repoGate.skippedPaths()].filter(p => videoPaths.has(p)));

    $slides.find('video').each((_, el) => {
      const $video = $(el);

      ['src', 'data-src'].forEach(attr => {
        const val = $video.attr(attr);
        if (!val) return;

        // Skip external URLs - keep them as-is
        if (val.startsWith('http://') || val.startsWith('https://')) {
          return;
        }

        const ref = resolveMediaRef(val, videoMap, skippedVideos);
        if (ref?.kind === 'kept') {
          // Convert data-src to src for compatibility
          if (attr === 'data-src') {
            $video.attr('src', ref.url);
            $video.removeAttr('data-src');
            $video.removeAttr('data-lazy-loaded');
          } else {
            $video.attr(attr, ref.url);
          }
        } else if (ref?.kind === 'skipped') {
          $video.removeAttr(attr);
          if (attr === 'data-src') $video.removeAttr('data-lazy-loaded');
          noteSkipped(ref.path, el);
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

        const ref = resolveMediaRef(srcVal, videoMap, skippedVideos);
        if (ref?.kind === 'kept') {
          $source.attr('src', ref.url);
        } else if (ref?.kind === 'skipped') {
          noteSkipped(ref.path, sourceEl);
          $source.remove();
        }
      });
    });

    // Section background videos: rewritten like any other video reference, and
    // removed when the video was left out.
    $slides.find('section[data-background-video]').each((_, el) => {
      const $el = $(el);
      const val = $el.attr('data-background-video');
      if (!val || val.startsWith('http://') || val.startsWith('https://')) return;

      const ref = resolveMediaRef(val, videoMap, skippedVideos);
      if (ref?.kind === 'kept') {
        $el.attr('data-background-video', ref.url);
      } else if (ref?.kind === 'skipped') {
        $el.removeAttr('data-background-video');
        noteSkipped(ref.path, el);
      }
    });

    // Every file left out, named, with the slides that used it.
    warnings = repoGate.warnings(skippedOnSlides);

    // 12. Build deck.json (source of truth) and generate index.html (build
    // artifact) via the canonical deck engine — both land in the SAME commit.
    onProgress({ type: 'step', step: 'generating_html' });
    try {
      // Parse the transformed sections into DeckSlides (mints stable data-cm-ids,
      // extracts <aside class="notes"> into per-slide notes fields).
      const slidesHtml = $slides.html() || '';
      const { slides: deckSlides, warnings: parseWarnings } = parseSlidesFragment(
        `<div class="slides">\n${slidesHtml}\n</div>`
      );
      for (const warning of parseWarnings) {
        console.warn(`[slides.com import] ${warning}`);
      }

      // Theme fields mirror the legacy generator's three modes.
      let theme = 'white';
      let themeDark: string | undefined;
      let codeThemeDark: string | undefined;
      let extraCss: DeckExtraCss[] | undefined;
      let deckThemeUrls:
        | { libCssUrl?: string | null; customThemeUrl?: string | null; bodyClasses?: string }
        | undefined;

      if (libCssUrl && sharedThemeName) {
        // slides.com theme saved to (or reused from) .slidesthemes/ — first-class
        // shared theme; asset URLs re-resolved from the theme on every save.
        theme = `shared:${sharedThemeName}`;
        deckThemeUrls = { libCssUrl, customThemeUrl, bodyClasses: finalBodyClasses };
      } else if (libCssUrl) {
        // Theme lib extracted into the slide folder (importTheme without
        // saveThemeAs): no shared: name exists, so the copied assets are
        // referenced verbatim via extraCss.
        extraCss = [{ href: libCssUrl }];
        if (customThemeUrl) {
          extraCss.push({ href: customThemeUrl });
        }
        deckThemeUrls = { bodyClasses: finalBodyClasses };
      } else {
        // Fallback reveal.js themes — the light/dark media pair, first-class.
        themeDark = 'black';
        codeThemeDark = 'github-dark';
      }

      const deck: DeckJson = {
        version: 1,
        theme,
        codeTheme: 'github',
        ...(themeDark ? { themeDark } : {}),
        ...(codeThemeDark ? { codeThemeDark } : {}),
        // Importer canonical Reveal config (canonical defaults are not stored).
        config: { width: 960, height: 700, center: false },
        // The generator emits no implicit styles — seed the sl-block override.
        customCss: SL_BLOCK_VISIBILITY_CSS,
        ...(extraCss ? { extraCss } : {}),
        slides: deckSlides,
      };

      files.push({
        path: `${contentPath}/deck.json`,
        content: JSON.stringify(deck, null, 2) + '\n',
        encoding: 'utf-8',
      });
      files.push({
        path: `${contentPath}/index.html`,
        content: generateDeckHtml(deck, { title: slideTitle, themeUrls: deckThemeUrls }),
        encoding: 'utf-8',
      });
    } catch (genError: unknown) {
      // Same cleanup as a failed upload: the slide row exists but no content
      // was committed.
      await cleanupFailedImport();
      const message = genError instanceof Error ? genError.message : String(genError);
      throw new Error(`Failed to generate slide deck: ${message}`);
    }

    // 13. Batch upload all files in single commit
    onProgress({ type: 'step', step: 'uploading_github', current: 0, total: files.length });
    try {
      const result = await ContentService.uploadBatch({
        orgLogin: org,
        repo: repoName,
        files,
        message: `Import slides from slides.com: ${slideTitle}`,
        onProgress: ({ current, total, filename }) => {
          onProgress({ type: 'step', step: 'uploading_github', current, total, filename });
        },
      });
      // Write-through: an imported deck is opened the moment the import finishes,
      // and its index.html is read through the asset map. Without this the first
      // views fall back to the contents API until the push webhook lands.
      await ClassmojiService.contentAssets.recordContentAssets(classroom.id, result.files);
    } catch (uploadError: unknown) {
      console.log(uploadError);
      // If upload fails, clean up the slide record and the media it wrote
      await cleanupFailedImport();

      const message = uploadError instanceof Error ? uploadError.message : String(uploadError);
      throw new Error(`Failed to upload files: ${message}`);
    }
  } catch (importError: unknown) {
    // Anything that fails between the slide row and the commit: the media
    // written so far and the row go (a no-op if a step above already ran it).
    await cleanupFailedImport();
    throw importError;
  }

  // And a card for it. A slides.com import commits its own `index.html` rather
  // than going through `saveDeck`, so `recordDeckFiles`' enqueue never fires for
  // it — this is the only place the deck becomes visible.
  //
  // OUTSIDE the rollback block above, deliberately. `void` only detaches a
  // returned promise; anything that throws SYNCHRONOUSLY on the way to that
  // promise — a module that failed to initialise, so the property access itself
  // throws — is a plain exception at the call site. Inside the try, that
  // exception would be caught as an "upload failure", run
  // `cleanupFailedImport()`, and DELETE a deck whose files are already committed
  // in GitHub, over a card image. Out here the worst case is an unhandled
  // rejection nobody is waiting on.
  void ClassmojiService.deckThumbnail.enqueueDeckThumbnail(slide.id, classroom.id);

  // 14. Refresh the classroom content manifest so the imported deck shows up
  // (content-tools plan §5.4 — imports previously never refreshed the
  // manifest). Non-fatal: the import itself succeeded.
  try {
    await ClassmojiService.contentManifest.saveManifest(classroom.id);
  } catch (manifestError: unknown) {
    console.error('Failed to update manifest after slide import:', manifestError);
  }

  // Count slides (top-level sections, not nested vertical stacks)
  const slideCount = $slides.find('> section').length;

  // Signal completion
  for (const warning of warnings) console.warn(`[slides.com import] ${warning}`);
  onProgress({ type: 'done', slideId: slide.id, ...(warnings.length ? { warnings } : {}) });

  return {
    slideId: slide.id,
    slideCount,
    imageCount: imageMap.size / 2, // Divide by 2 because we added each image twice (full path and filename)
    themeSaved, // Name of saved theme if saveThemeAs was used
    mediaVideos: storedMediaIds.length > 0 ? storedMediaIds.length : undefined,
    warnings, // Entries left out for being over the course repository's per-file ceiling
  };
}
