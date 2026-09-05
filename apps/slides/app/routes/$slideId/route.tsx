import { useState, useCallback, useEffect, useRef } from 'react';
import { useLoaderData, useFetcher, data, redirect } from 'react-router';
import { message, Tooltip, Popconfirm } from 'antd';
import getPrisma from '@classmoji/database';
import { ContentService } from '@classmoji/content';
import { assertSlideAccess } from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';
import {
  DeckConflictError,
  DeckOpsBaseMismatchError,
  DeckParseError,
  PreviewResolutionError,
  acceptDeckPreview,
  deckOpsPayloadSchema,
  discardDeckPreview,
  generateDeckHtml,
  getDeckPreviewStatus,
  loadDeck,
  parseSlidesFragment,
  previewBranchName,
  resolveDeckPreviewConflicts,
  saveDeck,
  saveDeckFromOps,
  saveDeckWithMerge,
  slideService,
  type DeckJson,
  type DeckShaSource,
  type DeckThemeUrls,
  type MergeResolution,
} from '@classmoji/services/slides';
import { SandpackRenderer } from '@classmoji/ui-components/sandpack';
import { useUser } from '~/hooks';
import { diffDeckSnapshots, extractDeckSnapshot, type DeckSnapshot } from '~/utils/deckOpsDiff';
import { getThemeUrls } from '~/utils/themeService.server';
import {
  deckAccessFor,
  deckDeliveryContext,
  readDeckText,
  resolveDeckAssets,
  resolveDeliveryThemeUrls,
  resolveReadThemeUrls,
} from '~/utils/deckDelivery.server';
import RevealSlides, { type RevealSlidesHandle } from '~/components/RevealSlides';
import SlideToolbar from '~/components/SlideToolbar';
import SlideNotesPanel from '~/components/SlideNotesPanel';
import OrphanedImagesModal from '~/components/OrphanedImagesModal';
import { ElementSelectionProvider } from '~/components/properties/ElementSelectionContext';
import PropertiesPanel from '~/components/properties/PropertiesPanel';
import SlideOverview from '~/components/SlideOverview';
import ImageResizeHandles from '~/components/ImageResizeHandles';
import BlockHandles from '~/components/BlockHandles';
import {
  PreviewBar,
  PendingPreviewBanner,
  NoPreviewNotice,
  ConflictPanel,
  MergeProgress,
  type ConflictUnit,
  type OrderConflict,
} from '~/components/preview/PreviewControls';

// Loader to fetch slide metadata and content from database/GitHub
export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const { slideId } = params;
  if (!slideId) throw new Response('Missing slideId', { status: 400 });
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode');
  const returnUrl = url.searchParams.get('returnUrl');

  // Fetch slide from database with classroom and git_organization
  const slide = await getPrisma().slide.findUnique({
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

  // Content repo is STORED and user-editable — never re-derived from the namespace.
  const repo = slide.classroom.content_repo;
  const filePath = `${slide.content_path}/index.html`;

  // Build the content URL using content proxy (CDN-first + API fallback)
  // Used as client-side fallback if server-side fetch fails
  const contentUrl = `/content/${gitOrgLogin}/${repo}/${filePath}`;

  // ── Preview branches (plan §3b) ────────────────────────────────────────────
  // `?preview=1` renders the singleton `preview/<content_path>` branch instead
  // of main. Staff-gated to the EDIT tier (same gate as fetch-latest): viewers
  // without edit access never pay the GitHub status call and the param is
  // silently ignored for them. Edit mode always works on main.
  const wantsPreview = url.searchParams.get('preview') === '1' && mode !== 'edit';
  // DISTINCT param value: `?preview=true` is the landing page's thumbnail
  // iframe render (and the speaker view's mini frames) — NOT the
  // branch-preview gate above (`preview === '1'`). Thumbnails never show the
  // preview banner, so skip the GitHub compare probe entirely: a staff
  // landing page renders ~20 of these at once and must not fire ~20 compares.
  const isThumbnail = url.searchParams.get('preview') === 'true';
  // Post-accept/discard success notice, round-tripped via redirect (staff only).
  const rawNotice = url.searchParams.get('notice');
  const notice =
    canEdit && (rawNotice === 'preview-accepted' || rawNotice === 'preview-discarded')
      ? rawNotice
      : null;
  // Semantic-merge accepts also round-trip how many changes auto-merged
  // (Phase 7) so the success toast can mention them.
  const rawAutoMerged = url.searchParams.get('auto_merged');
  const noticeAutoMerged =
    notice === 'preview-accepted' && rawAutoMerged && /^\d+$/.test(rawAutoMerged)
      ? Number(rawAutoMerged)
      : null;

  let previewStatus: {
    exists: boolean;
    commits_ahead?: number;
    oldest_commit_at?: string;
  } | null = null;
  if (canEdit && !isThumbnail) {
    try {
      previewStatus = await getDeckPreviewStatus(slide);
    } catch (e: unknown) {
      // A GitHub hiccup must not 500 the deck — degrade to "no preview".
      console.error('[slides] Failed to check preview status:', e);
      previewStatus = { exists: false };
    }
  }

  const previewBranch = previewBranchName(slide.content_path);
  const previewActive = Boolean(canEdit && wantsPreview && previewStatus?.exists);
  // Staff asked for a preview but no branch exists → render main with a notice.
  const previewMissing = Boolean(canEdit && wantsPreview && !previewStatus?.exists);

  // Per-VIEWER tier: staff and preview readers get short-lived draft URLs, a
  // public deck's anonymous readers get the long public bucket, everyone else
  // the enrolled one. This is the reason a signed URL cannot live in the deck.
  const deliveryCtx = deckDeliveryContext(
    slide,
    gitOrgLogin,
    repo,
    deckAccessFor('viewer', { canEdit, previewActive }, slide)
  );

  // GitHub's free diff UI for the pending preview (branch segment URL-encoded —
  // preview branch names contain slashes).
  const diffUrl = `https://github.com/${gitOrgLogin}/${repo}/compare/main...${encodeURIComponent(previewBranch)}`;

  // Two reads, and the split is deliberate.
  //
  // EDIT mode keeps the contents API (skipCache), and must: it reads a PREVIEW
  // BRANCH when one is active, and preview branches are not in the asset map at
  // all — nothing there has a sha to sign. It also seeds the save conflict
  // token, which has to be the sha of the file on the branch being written.
  // Staff-only and low volume, so the API call per open is affordable.
  //
  // VIEW mode reads through the delivery layer by sha (see below), which is
  // what makes a save visible the moment it returns instead of whenever GitHub
  // Pages finishes rebuilding.
  let slideContent: string | null = null;
  let contentError: string | null = null;
  let usedApiFallback = false;
  let contentResult: { content: string; source: string } | null = null;

  // Conflict token for the editor (Phase 4b): the sha of the deck's SOURCE OF
  // TRUTH — deck.json once it exists (materialized by the first dual-write
  // save), else the legacy index.html.
  let contentSha: string | null = null;
  let shaSource: DeckShaSource = 'legacy_html';

  if (mode === 'edit') {
    // Phase 4c: deck.json-first read for edit mode. skipCache is REQUIRED —
    // this read both renders the editor and seeds the conflict token; the
    // per-process 60s cache has no cross-instance invalidation, so a cached
    // read on another Fly instance could silently revert an MCP write.
    let deckLoadFailed = false;
    try {
      const loaded = await loadDeck(slide, { skipCache: true });
      if (loaded.sha_source === 'deck') {
        // deck.json exists: render server-side with the SAME generator +
        // theme-URL resolution the save path uses, so this document is
        // identical to the index.html artifact the last save committed.
        // Theme links are signed even in edit mode: they live in <head> and
        // the editor posts back only the <div class="slides"> fragment, so
        // they can never round-trip into a stored document. Image URLs are
        // deliberately NOT signed here for exactly the opposite reason.
        const themeUrls = await resolveDeliveryThemeUrls(
          loaded.deck,
          gitOrgLogin,
          repo,
          deliveryCtx
        );
        contentResult = {
          content: generateDeckHtml(loaded.deck, {
            title: slide.title,
            themeUrls,
            includeNotes: true,
          }),
          source: 'api',
        };
        contentSha = loaded.sha;
        shaSource = 'deck';
      } else {
        // deck.json absent (legacy deck): do NOT serve generate(parse(html)) —
        // a parse-lossy legacy deck must not silently canonicalize on READ; it
        // only converts through a SAVE. Keep loadDeck's sha token (index.html)
        // and serve the raw file below.
        contentSha = loaded.sha;
        shaSource = 'legacy_html';
      }
    } catch (e: unknown) {
      // DeckParseError (malformed deck.json / unparseable legacy html) or a
      // transient API failure — fall back to the raw index.html read below.
      deckLoadFailed = true;
      const message = e instanceof Error ? e.message : String(e);
      console.warn('[Loader] Deck-first read failed, serving raw index.html:', message);
    }

    if (!contentResult) {
      // Raw index.html via API (legacy decks + deck-read failures) — the
      // pre-4c edit path, unchanged. API-first ensures fresh content after saves.
      try {
        const result = await ContentService.getContent({
          orgLogin: gitOrgLogin,
          repo,
          path: filePath,
          skipCache: true,
        });
        if (result) {
          contentResult = { content: result.content, source: 'api' };
          if (!contentSha) contentSha = result.sha;
        }
      } catch (e: unknown) {
        // Fall back to CDN if API fails
        const message = e instanceof Error ? e.message : String(e);
        console.log('[Loader] API fetch failed, falling back to CDN:', message);
      }

      // 4b token logic for the deck-read failure path: deck.json's sha
      // supersedes the index.html sha as the conflict token — a malformed
      // deck.json still yields a 'deck' token (overwriting it on the next
      // save is the recovery path). loadDeck's success branches above have
      // already resolved the deck-first token, so this only runs on failure.
      if (deckLoadFailed) {
        try {
          const deckMeta = await ContentService.getMeta({
            orgLogin: gitOrgLogin,
            repo,
            path: `${slide.content_path}/deck.json`,
            skipCache: true,
          });
          if (deckMeta) {
            contentSha = deckMeta.sha;
            shaSource = 'deck';
          }
        } catch (e: unknown) {
          // Keep the legacy token; a stale token surfaces as a save-time 409, not data loss.
          const message = e instanceof Error ? e.message : String(e);
          console.warn('[Loader] deck.json meta check failed, keeping legacy token:', message);
        }
      }
    }
  }

  // Preview mode: render the preview branch's deck server-side through the
  // SAME generator + theme-URL resolution the save path uses — actual themes,
  // Sandpack, layout. API-path only: the CDN serves main, so students can
  // never reach a preview through it. Notes rules below are unchanged (the
  // canViewSpeakerNotes strip applies to this content too).
  if (previewActive && !contentResult) {
    try {
      const loaded = await loadDeck(slide, { ref: previewBranch, skipCache: true });
      const themeUrls = await resolveDeliveryThemeUrls(loaded.deck, gitOrgLogin, repo, deliveryCtx);
      contentResult = {
        content: generateDeckHtml(loaded.deck, {
          title: slide.title,
          themeUrls,
          includeNotes: true,
        }),
        source: 'api',
      };
    } catch (e: unknown) {
      // Unreadable preview (parse failure / API hiccup): fall through to the
      // live deck below rather than 500ing the viewer.
      const message = e instanceof Error ? e.message : String(e);
      console.warn('[Loader] Preview-branch read failed, serving live deck:', message);
    }
  }

  // Live deck, for everyone: read by SHA through the delivery layer.
  //
  // This replaces a three-way split — staff read the contents API, students
  // read the CDN, thumbnails read the CDN — that existed entirely because
  // GitHub Pages lags a save by minutes and rapid saves can ERROR its builds.
  // Addressing the file by sha makes that question go away, so the split goes
  // with it, and the three surfaces stop being able to disagree about what the
  // current deck is.
  //
  // Cost moves in the right direction on every one of them: no GitHub call for
  // the deck TEXT on any of the three, where staff used to spend an
  // installation-token read per view and students waited out a Pages build.
  // Deck text only — a deck on a shared theme still resolves its theme URLs
  // through `getThemeUrls`, which does reach GitHub (pre-existing, and its own
  // follow-up).
  //
  // THUMBNAILS keep their own rule, and it is the one the CDN pinning was
  // for. A staff landing page renders ~20 at once; when the map answers they
  // all come from the edge, but a map MISS on the default ladder would put
  // twenty authenticated reads against the org installation's shared limit in
  // one page load. So a thumbnail that misses goes to the CDN and stops there:
  // a thumbnail is a picture of a deck, three minutes stale is invisible on
  // one, and a rate limit is not. (The other half of that fan-out — twenty
  // concurrent map refreshes on a stale classroom — is collapsed into one
  // inside `ensureContentAssets`.)
  if (!contentResult) {
    contentResult = await readDeckText(
      slide,
      gitOrgLogin,
      repo,
      filePath,
      isThumbnail ? 'thumbnail' : 'viewer',
      isThumbnail ? { fallback: 'cdn-only' } : {}
    );
  }

  if (contentResult) {
    slideContent = contentResult.content;
    // Kept for the client-side fallback's own bookkeeping. It now means "the
    // delivery layer could not answer and GitHub did", which is a narrower
    // thing than it used to be — `worker` is the ordinary case and `cdn` is
    // the thumbnail one.
    usedApiFallback = contentResult.source === 'api';

    // Sign the deck's image references — but never for the document the editor
    // is about to load. Entering edit mode always re-reads through
    // `fetch-latest` (which does no image pass), so restricting this to
    // non-edit reads is what guarantees a signed URL can never be posted back
    // and committed into deck.json.
    if (mode !== 'edit') {
      slideContent = await resolveDeckAssets(slideContent, deliveryCtx);
    }

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
  let preloadedSharedTheme: {
    id: string;
    name: string;
    libCssUrl?: string;
    customThemeUrl?: string;
    bodyClasses?: string;
  } | null = null;
  if (slideContent) {
    const themeMatch = slideContent.match(/data-theme="shared:([^"]+)"/);
    if (themeMatch) {
      const themeName = themeMatch[1];
      try {
        const themeUrls = await resolveDeliveryThemeUrls(
          { theme: `shared:${themeName}` } as DeckJson,
          gitOrgLogin,
          repo,
          deliveryCtx
        );
        if (!themeUrls) throw new Error(`No theme URLs for ${themeName}`);
        preloadedSharedTheme = {
          id: `shared:${themeName}`,
          name: themeName
            .split('-')
            .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' '),
          libCssUrl: themeUrls.libCssUrl ?? undefined,
          customThemeUrl: themeUrls.customThemeUrl ?? undefined,
          bodyClasses: themeUrls.bodyClasses as string,
        };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`Could not preload shared theme "${themeName}":`, message);
      }
    }
  }

  // Cloudinary video hosting is Pro-only, and the properties panel offers an
  // "Upload to Cloudinary" button. Resolved ONLY for editors: viewers never see
  // that button, and this loader is on the hot path for every student opening
  // every slide, so a tier query for them would be pure cost. The real gate is
  // in api.video.upload-cloudinary, which re-decides per request.
  const isPro = canEdit
    ? (await ClassmojiService.subscription.getProStateForClassroomId(slide.classroom_id)).isPro
    : false;

  return {
    slide,
    isPro,
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
    // Conflict token (edit mode only; null in view mode): sha of the deck's
    // source of truth + which file it came from. The client echoes it back on
    // every save so saveDeck can 409 instead of clobbering a concurrent write.
    content_sha: contentSha,
    sha_source: shaSource,
    // Return URL for back navigation (from webapp query param)
    returnUrl,
    // Authorization flags from assertSlideAccess
    canEdit,
    canPresent,
    canViewSpeakerNotes,
    // User's role in the classroom
    userRole: membership?.role || null,
    // Post-accept/discard notice (staff only; null otherwise)
    notice,
    noticeAutoMerged,
    // Preview state is staff-only; students/anonymous always get null.
    preview: canEdit
      ? {
          active: previewActive,
          missing: previewMissing,
          exists: Boolean(previewStatus?.exists),
          commitsAhead: previewStatus?.commits_ahead ?? 0,
          oldestCommitAt: previewStatus?.oldest_commit_at ?? null,
          diffUrl,
        }
      : null,
  };
};

// Action to save slide content or fetch fresh content from GitHub API
/**
 * Record a just-written `.slidesthemes/` file in the asset map.
 *
 * These four writes used to need nothing: the map only served IMAGES, and a
 * theme's css reached the browser through the `/content/...` proxy, which read
 * GitHub directly. Text goes through the map now, so a snippet or custom theme
 * saved here and not recorded serves its PREVIOUS bytes until the push webhook
 * lands — the author edits a theme, reloads, and sees the old one.
 *
 * `themeService.saveSharedTheme` handles the folder case differently, and has
 * to: a shared theme is addressed by its FOLDER's tree sha, so it runs a full
 * sync. These paths are flat files, so their own blob sha is the whole answer.
 *
 * Never throws — the file is already committed, and the next sync writes the
 * same row.
 */
async function recordThemeFile(
  slide: { classroom_id?: string | null },
  path: string,
  sha: string,
  content: FormDataEntryValue
): Promise<void> {
  if (!slide.classroom_id) return;
  await ClassmojiService.contentAssets.recordContentAsset(slide.classroom_id, {
    path,
    sha,
    size: Buffer.byteLength(String(content)),
  });
}

/**
 * Forget `.slidesthemes/` paths the repo no longer has.
 *
 * The mirror of `recordThemeFile`, and needed for the same reason: blobs are
 * content-addressed and immutable, so a row that outlives its file keeps
 * serving that file's last bytes out of R2. A renamed snippet would answer
 * under BOTH names until the next full sweep, and a deleted theme would go on
 * resolving.
 */
async function forgetThemeFiles(
  slide: { classroom_id?: string | null },
  paths: string[]
): Promise<void> {
  if (!slide.classroom_id) return;
  await ClassmojiService.contentAssets.removeContentAssets(slide.classroom_id, paths);
}

export const action = async ({
  request,
  params,
}: {
  request: Request;
  params: Record<string, string | undefined>;
}) => {
  const { slideId } = params;
  if (!slideId) return { error: 'Missing slideId' };
  const formData = await request.formData();
  const intent = formData.get('intent');

  // Fetch slide to get classroom/git org info
  const slide = await getPrisma().slide.findUnique({
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
  // Content repo is STORED and user-editable — never re-derived from the namespace.
  const repo = slide.classroom.content_repo;
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
      const sharedThemePromises = themeFolders.map(async folder => {
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
          let customThemeUrl: string | null = null;
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
            name: folder.name
              .split('-')
              .map(w => w.charAt(0).toUpperCase() + w.slice(1))
              .join(' '),
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
    } catch (error: unknown) {
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

      const themePromises = cssFiles.map(async f => {
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
    } catch (error: unknown) {
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

      const snippetPromises = htmlFiles.map(async f => {
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
    } catch (error: unknown) {
      console.error('Failed to list snippets:', error);
      return { intent: 'list-snippets', snippets: [] };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────

  // Fetch latest content from GitHub API (bypasses CDN cache)
  // Used when entering edit mode to ensure we're editing the current version
  if (intent === 'fetch-latest') {
    try {
      // Phase 4c: deck.json-first, mirroring the edit-mode loader. skipCache:
      // this read refreshes the editor's conflict token — it must not serve
      // the per-process 60s cache.
      let legacySha: string | null = null;
      let deckLoadFailed = false;
      try {
        const loaded = await loadDeck(slide, { skipCache: true });
        if (loaded.sha_source === 'deck') {
          // Same generator + theme-URL resolution as the save path — the
          // returned document is identical to the saved index.html artifact.
          // Theme only. This document goes straight into the editor and comes
          // back on save; a signed image URL in it would be committed.
          const themeUrls = await resolveDeliveryThemeUrls(
            loaded.deck,
            gitOrgLogin,
            repo,
            deckDeliveryContext(
              slide,
              gitOrgLogin,
              repo,
              deckAccessFor('viewer', { canEdit: true }, slide)
            )
          );
          return {
            intent: 'fetch-latest',
            content: generateDeckHtml(loaded.deck, {
              title: slide.title,
              themeUrls,
              includeNotes: true,
            }),
            content_sha: loaded.sha,
            sha_source: 'deck' as const,
          };
        }
        // Legacy deck: keep loadDeck's index.html sha as the token and serve
        // the raw file below (never generate from a legacy parse on read).
        legacySha = loaded.sha;
      } catch (deckError: unknown) {
        // Parse failures fall back to the raw file; transient API failures
        // surface as errors (same as the pre-4c behavior).
        if (!(deckError instanceof DeckParseError)) throw deckError;
        deckLoadFailed = true;
        console.warn(
          '[fetch-latest] Deck parse failed, serving raw index.html:',
          deckError.message
        );
      }

      // Legacy path: raw index.html exactly as before.
      const result = await ContentService.getContent({
        gitOrganization,
        repo,
        path: filePath,
        skipCache: true,
      });

      if (!result) {
        return { error: 'Content not found' };
      }

      let contentSha = legacySha ?? result.sha;
      let shaSource: DeckShaSource = 'legacy_html';
      if (deckLoadFailed) {
        // 4b token logic for the parse-failure path: a malformed deck.json
        // still exists and its sha must be the conflict token (overwriting it
        // on the next save is the recovery path).
        try {
          const deckMeta = await ContentService.getMeta({
            gitOrganization,
            repo,
            path: `${slide.content_path}/deck.json`,
            skipCache: true,
          });
          if (deckMeta) {
            contentSha = deckMeta.sha;
            shaSource = 'deck';
          }
        } catch (metaError: unknown) {
          // Keep the legacy token; a stale token surfaces as a save-time 409.
          const message = metaError instanceof Error ? metaError.message : String(metaError);
          console.warn(
            '[fetch-latest] deck.json meta check failed, keeping legacy token:',
            message
          );
        }
      }

      return {
        intent: 'fetch-latest',
        content: result.content,
        content_sha: contentSha,
        sha_source: shaSource,
      };
    } catch (error: unknown) {
      console.error('Failed to fetch latest content:', error);
      // Tag the intent so the client can distinguish a fetch-latest failure
      // from a save error and clear its loading state (S8).
      return {
        intent: 'fetch-latest' as const,
        error: error instanceof Error ? error.message : String(error),
      };
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

      // Record the row now rather than waiting for the push webhook: a deck
      // saved right after the upload stores this repo path, and a render that
      // misses the asset map signs a dangling URL. Never throws.
      if (slide.classroom_id) {
        await ClassmojiService.contentAssets.recordContentAsset(slide.classroom_id, {
          path: result.path,
          sha: result.sha,
          size: buffer.length,
        });
      }

      // Return content proxy URL instead of raw.githubusercontent.com
      // Content proxy handles MIME types correctly and has CDN+API fallback
      return {
        intent: 'upload-image',
        success: true,
        url: `/content/${gitOrgLogin}/${repo}/${result.path}`,
        path: result.path,
      };
    } catch (error: unknown) {
      console.error('Failed to upload image:', error);
      return { error: error instanceof Error ? error.message : String(error) };
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
      const filename =
        String(name)
          .toLowerCase()
          .replace(/\s+/g, '-')
          .replace(/[^a-z0-9-]/g, '') + '.html';

      const written = await ContentService.put({
        orgLogin: gitOrgLogin,
        repo,
        path: `.slidesthemes/snippets/${filename}`,
        content: String(content),
        message: `Add snippet: ${name}`,
      });
      await recordThemeFile(slide, `.slidesthemes/snippets/${filename}`, written.sha, content);

      return {
        intent: 'save-snippet',
        success: true,
        snippet: {
          id: filename,
          name: String(name),
          content: String(content),
        },
      };
    } catch (error: unknown) {
      console.error('Failed to save snippet:', error);
      return { error: error instanceof Error ? error.message : String(error) };
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
      const newFilename =
        String(name)
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
        } catch (err: unknown) {
          // Old file might not exist, continue anyway
          console.log(err);
        }
      }

      // Save the updated content
      const written = await ContentService.put({
        orgLogin: gitOrgLogin,
        repo,
        path: newPath,
        content: String(content),
        message: `Update snippet: ${name}`,
      });
      await recordThemeFile(slide, newPath, written.sha, content);
      if (id !== newFilename) await forgetThemeFiles(slide, [oldPath]);

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
    } catch (error: unknown) {
      console.error('Failed to update snippet:', error);
      return { error: error instanceof Error ? error.message : String(error) };
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
      await forgetThemeFiles(slide, [`.slidesthemes/snippets/${id}`]);

      return {
        intent: 'delete-snippet',
        success: true,
        deletedId: String(id),
      };
    } catch (error: unknown) {
      console.error('Failed to delete snippet:', error);
      return { error: error instanceof Error ? error.message : String(error) };
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

      const written = await ContentService.put({
        orgLogin: gitOrgLogin,
        repo,
        path: `.slidesthemes/${filename}`,
        content: String(content),
        message: `Add custom CSS theme: ${name} (${type})`,
      });
      await recordThemeFile(slide, `.slidesthemes/${filename}`, written.sha, content);

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
    } catch (error: unknown) {
      console.error('Failed to save theme:', error);
      return { error: error instanceof Error ? error.message : String(error) };
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
        } catch (err: unknown) {
          // Old file might not exist, continue anyway
          console.log(err);
        }
      }

      // Save the updated content
      const written = await ContentService.put({
        orgLogin: gitOrgLogin,
        repo,
        path: newPath,
        content: String(content),
        message: `Update CSS theme: ${name} (${type})`,
      });
      await recordThemeFile(slide, newPath, written.sha, content);
      if (id !== newFilename) await forgetThemeFiles(slide, [oldPath]);

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
    } catch (error: unknown) {
      console.error('Failed to update theme:', error);
      return { error: error instanceof Error ? error.message : String(error) };
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
      await forgetThemeFiles(slide, [`.slidesthemes/${id}`]);

      return {
        intent: 'delete-theme',
        success: true,
        deletedId: String(id),
      };
    } catch (error: unknown) {
      console.error('Failed to delete theme:', error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  // Delete orphaned images
  if (intent === 'delete-images') {
    try {
      const pathsJson = formData.get('paths') as string;
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

      // Only the ones that actually went. `deleteMultiple` reports per-path
      // errors and keeps going, so forgetting the whole list would drop rows
      // for images still in the repo — which is a dangling URL, the failure
      // this map exists to prevent.
      const failed = new Set(result.errors.map(entry => entry.split(':')[0]));
      await forgetThemeFiles(
        slide,
        (paths as string[]).filter(path => !failed.has(path))
      );

      return {
        intent: 'delete-images',
        success: true,
        deleted: result.deleted,
        errors: result.errors,
      };
    } catch (error: unknown) {
      console.error('Failed to delete images:', error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  // Update slide visibility settings (is_draft, is_public, show_speaker_notes, allow_team_edit)
  if (intent === 'update-visibility') {
    try {
      const updateData: Record<string, boolean> = {};

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

      await getPrisma().slide.update({
        where: { id: slideId },
        data: updateData,
      });

      return {
        intent: 'update-visibility',
        success: true,
        ...updateData,
      };
    } catch (error: unknown) {
      console.error('Failed to update visibility:', error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ── Preview lifecycle (plan §3b) ───────────────────────────────────────────
  // Staff-gated by the shared assertSlideAccess edit check above (same gate as
  // every edit intent). Accept merges the preview branch into main and
  // regenerates the index.html artifact from the merged deck.json; discard
  // deletes the branch without touching main.

  if (intent === 'preview-accept') {
    // Chooser resolutions (Phase 7): when present, this accept is a conflict
    // resolution pass — one {id, choose: 'ours'|'theirs'} per currently
    // conflicted unit; the resolved merge is committed to main. Element-shape
    // validation (non-empty string id, choose ∈ ours|theirs) lives in the
    // service's indexResolutions, so malformed choices throw
    // PreviewResolutionError (→ 400 below) instead of defaulting to a side.
    let resolutions: MergeResolution[] | null = null;
    const rawResolutions = formData.get('resolutions');
    if (typeof rawResolutions === 'string' && rawResolutions) {
      try {
        const parsed = JSON.parse(rawResolutions);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          throw new Error('resolutions must be a non-empty array');
        }
        resolutions = parsed;
      } catch {
        return data(
          { error: 'Malformed resolutions payload — expected [{id, choose}]' },
          { status: 400 }
        );
      }
    }
    // Sha pins (F3): the chooser posts back the shas it rendered its conflict
    // report from, so the resolve fails cleanly (CONTENT_CONFLICT) if the
    // deck moved after the report was reviewed.
    const rawOursSha = formData.get('ours_sha');
    const expectedOursSha = typeof rawOursSha === 'string' && rawOursSha ? rawOursSha : undefined;
    const rawTheirsSha = formData.get('theirs_sha');
    const expectedTheirsSha =
      typeof rawTheirsSha === 'string' && rawTheirsSha ? rawTheirsSha : undefined;

    try {
      const status = await getDeckPreviewStatus(slide);
      if (!status.exists) {
        return { error: 'No pending preview to accept' };
      }
      const resolveThemeUrls = (deck: DeckJson) => resolveReadThemeUrls(deck, gitOrgLogin, repo);
      const result = resolutions
        ? await resolveDeckPreviewConflicts(slide, {
            resolutions,
            resolveThemeUrls,
            ...(expectedOursSha ? { expectedOursSha } : {}),
            ...(expectedTheirsSha ? { expectedTheirsSha } : {}),
          })
        : await acceptDeckPreview(slide, { resolveThemeUrls });
      if (result.merged) {
        // Surface the semantic layer's auto-merged count in the success toast.
        const autoMerged = ('auto_merged' in result && result.auto_merged) || 0;
        const autoParam = autoMerged > 0 ? `&auto_merged=${autoMerged}` : '';
        return redirect(`/${slideId}?notice=preview-accepted${autoParam}`);
      }
      // Merge conflict — nothing merged, branch kept. Surface the per-unit
      // report (plus the auto-merged count and the shas the report was built
      // from — the chooser posts them back with its resolutions) so the
      // chooser can render it.
      return data(
        {
          conflict: true,
          units: result.units,
          orderConflict: result.order_conflict ?? null,
          unitPreviews: result.unit_previews ?? null,
          autoMerged: result.auto_merged,
          oursSha: result.ours_sha,
          theirsSha: result.theirs_sha,
        },
        { status: 409 }
      );
    } catch (error: unknown) {
      if (error instanceof PreviewResolutionError) {
        // Stale report pin: the content moved since the reviewed conflict
        // report — same 409 semantics as a mid-merge CAS loss (re-run accept).
        if (error.code === 'CONTENT_CONFLICT') {
          return data({ error: error.message, code: error.code }, { status: 409 });
        }
        // Bad/stale resolutions (missing ids, unknown ids, duplicates,
        // malformed elements, no preview, main deck deleted) — a clear 400
        // naming the offending ids; the client re-runs accept for a fresh
        // report.
        return data({ error: error.message, code: error.code, ids: error.ids }, { status: 400 });
      }
      // Mid-merge CAS loss: main moved while committing the resolved merge
      // (the service already retried once). Nothing was written.
      if (error instanceof DeckConflictError) {
        return data(
          { error: 'The live deck changed while merging — try accepting again.' },
          { status: 409 }
        );
      }
      console.error('Failed to accept preview:', error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (intent === 'preview-discard') {
    try {
      await discardDeckPreview(slide);
      return redirect(`/${slideId}?notice=preview-discarded`);
    } catch (error: unknown) {
      console.error('Failed to discard preview:', error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ── Save paths ─────────────────────────────────────────────────────────────
  // Conflict token echoed back by the client (loader / fetch-latest / prior save).
  const expectedSha = (formData.get('content_sha') as string | null) || undefined;
  const shaSource: DeckShaSource = formData.get('sha_source') === 'deck' ? 'deck' : 'legacy_html';

  // Phase 7.5: a save-conflict chooser re-submit carries the SAME posted
  // payload (ops or content) plus one {id, choose} per conflict and the
  // report's ours_sha pin.
  let saveResolutions: MergeResolution[] | null = null;
  const rawSaveResolutions = formData.get('resolutions');
  if (typeof rawSaveResolutions === 'string' && rawSaveResolutions) {
    try {
      const parsed = JSON.parse(rawSaveResolutions);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('resolutions must be a non-empty array');
      }
      saveResolutions = parsed;
    } catch {
      return data(
        { error: 'Malformed resolutions payload — expected [{id, choose}]' },
        { status: 400 }
      );
    }
  }
  const rawSaveOursSha = formData.get('ours_sha');
  const saveOursSha =
    typeof rawSaveOursSha === 'string' && rawSaveOursSha ? rawSaveOursSha : undefined;

  // Conflict report → 409 the chooser renders (the client re-submits the
  // same payload + resolutions + the report's ours_sha). Shared by both save
  // shapes.
  const mergeReport = (report: {
    units: unknown;
    order_conflict?: unknown;
    auto_merged: number;
    ours_sha: string;
  }) =>
    data(
      {
        conflict: true,
        units: report.units,
        orderConflict: report.order_conflict ?? null,
        autoMerged: report.auto_merged,
        oursSha: report.ours_sha,
      },
      { status: 409 }
    );

  // ── Ops-shaped save (diff-at-save editor) ──────────────────────────────────
  // The client diffed its DOM against its base snapshot and posted granular
  // ops + the base token instead of the whole document. The server replays
  // them onto the base (theirs = applyDeckOps(base, ops)) and runs the SAME
  // 3-way merge → commit / chooser / resolutions flow as the whole-doc path.
  // Any OPS_BASE_MISMATCH answer makes the client fall back to a whole-doc
  // save ONCE — that path is always available and always correct.
  const rawOps = formData.get('ops');
  if (typeof rawOps === 'string' && rawOps) {
    const opsFallback = (message: string) =>
      data({ error: message, code: 'OPS_BASE_MISMATCH' }, { status: 409 });

    const rawBaseSha = formData.get('base_sha');
    const baseSha = typeof rawBaseSha === 'string' && rawBaseSha ? rawBaseSha : undefined;
    if (!baseSha || shaSource !== 'deck') {
      return opsFallback('Ops saves need a deck-sourced base token — use a full-document save.');
    }

    let ops;
    try {
      ops = deckOpsPayloadSchema.parse(JSON.parse(rawOps));
    } catch {
      return opsFallback('Malformed ops payload — use a full-document save.');
    }

    try {
      const result = await saveDeckFromOps({
        slide,
        ops,
        baseSha,
        ...(saveResolutions ? { resolutions: saveResolutions } : {}),
        ...(saveOursSha ? { expectedOursSha: saveOursSha } : {}),
        // No message override: the service marks the commit '(merged)' only
        // when this save actually folds a concurrent change or applies a
        // chooser resolution — a plain ops save stays 'Update slides: <title>'.
        // Theme URLs must be resolved from the MERGED deck (a concurrent
        // theme change on main may win the per-field meta merge).
        resolveThemeUrls: mergedDeck => resolveReadThemeUrls(mergedDeck, gitOrgLogin, repo),
      });
      if (!result.merged) return mergeReport(result);

      let orphanedImages: Array<{ path: string; name: string; url: string }> = [];
      try {
        orphanedImages = await ContentService.findOrphanedImages({
          orgLogin: gitOrgLogin,
          repo,
          imagesFolder: `${slide.content_path}/images`,
          htmlContent: result.html,
        });
      } catch (err: unknown) {
        console.error('Failed to detect orphaned images:', err);
      }

      // adoption_required gates the live-editor remount on a FULL comparison
      // (committed deck vs base+ops — main-side reorders / cross-stack moves /
      // deck-meta changes fold in with concurrent 0, AND server-minted insert
      // ids the id-less DOM never carried), NOT the unit-content counter.
      // merged_with_concurrent stays purely the toast count.
      return {
        success: true,
        sha: result.sha,
        sha_source: 'deck' as const,
        savedContent: result.html,
        orphanedImages,
        adoption_required: result.adoption_required,
        ...(result.concurrent > 0 ? { merged_with_concurrent: result.concurrent } : {}),
      };
    } catch (error: unknown) {
      if (error instanceof DeckOpsBaseMismatchError) {
        return opsFallback(error.message);
      }
      if (error instanceof PreviewResolutionError) {
        if (error.code === 'CONTENT_CONFLICT') {
          return data({ error: error.message, code: error.code }, { status: 409 });
        }
        return data({ error: error.message, code: error.code, ids: error.ids }, { status: 400 });
      }
      if (
        error instanceof DeckConflictError ||
        (error instanceof Error && error.name === 'DeckConflictError')
      ) {
        return data(
          {
            conflict: true,
            message:
              'This deck changed since you opened it — reload to get the latest version before saving.',
          },
          { status: 409 }
        );
      }
      console.error('Failed to save slide (ops):', error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ── Whole-document save (Phase 4b dual-write; also the ops fallback) ──────
  const htmlContent = formData.get('content') as string;

  try {
    // Parse the editor's posted `<div class="slides">` wrapper into
    // theme/codeTheme + structured slides (mints/keeps data-cm-ids).
    const { theme: postedTheme, codeTheme, slides, warnings } = parseSlidesFragment(htmlContent);
    for (const warning of warnings) {
      console.warn(`[save] ${warning}`);
    }

    // Load the current deck server-side to carry the fields the thin editor
    // wrapper doesn't round-trip: config, customCss, extraCss, dark themes.
    // (deck.json when present, else a one-time parse of legacy index.html.)
    let currentDeck: DeckJson | null = null;
    // Whether ANY committed content exists (deck.json or index.html) — a
    // DeckParseError still means a file is there, only 'not found' means none.
    let contentExists = true;
    try {
      const loaded = await loadDeck(slide, { skipCache: true });
      currentDeck = loaded.deck;
    } catch (loadError: unknown) {
      const loadMessage = loadError instanceof Error ? loadError.message : String(loadError);
      if (
        loadError instanceof DeckParseError ||
        loadMessage.startsWith('Slide content not found')
      ) {
        // Unparseable legacy deck (or nothing committed yet): proceed with no
        // carried fields — exactly what the legacy template-regenerating save
        // did on every write.
        contentExists = !loadMessage.startsWith('Slide content not found');
        console.warn('[save] No current deck to merge from:', loadMessage);
      } else {
        // Transient API failure: fail the save rather than silently dropping
        // the deck's customCss/config on a lossy merge.
        throw loadError;
      }
    }

    // Token-less saves against an existing deck are refused: the editor
    // always round-trips content_sha, so its absence means this client lost
    // its conflict token — writing anyway would clobber the committed deck
    // without any concurrency protection. First writes (nothing committed
    // yet — create/import flows) legitimately carry no token.
    if (!expectedSha && contentExists) {
      return data(
        {
          error:
            'This save is missing its conflict token (content_sha) but the deck already has ' +
            'committed content — reload the editor and try again.',
        },
        { status: 400 }
      );
    }

    // Resolve shared-theme URLs (stays in the action — the engine never calls
    // services; URLs are caller-resolved, plan §2).
    let theme = postedTheme;
    let themeUrls: DeckThemeUrls | undefined;
    if (theme.startsWith('shared:')) {
      const sharedThemeName = theme.replace('shared:', '');
      try {
        const urls = await getThemeUrls(gitOrgLogin, repo, sharedThemeName);
        themeUrls = {
          libCssUrl: urls.libCssUrl,
          customThemeUrl: urls.customThemeUrl,
          bodyClasses: urls.bodyClasses,
        };
      } catch (err: unknown) {
        console.error(`Failed to get shared theme URLs for ${sharedThemeName}:`, err);
        // Fall back to default theme if shared theme lookup fails
        theme = 'white';
      }
    }

    // Merge rules (plan §5.1, review-hardened) live in buildEditorDeck: an
    // explicit theme change clears the paired dark theme (same for codeTheme)
    // and drops starter-recognized customCss; everything else carries over.
    const deck: DeckJson = slideService.buildEditorDeck({ theme, codeTheme, slides, currentDeck });

    // Semantic save-merge eligibility (Phase 7.5): a stale token whose sha
    // came from deck.json is a trustworthy 3-way base. Legacy-html tokens are
    // NOT (deterministic legacy ids can't be trusted across states) — those
    // fall back to the plain 409 reload flow, as do base-fetch failures.
    const canMergeSave = Boolean(expectedSha) && shaSource === 'deck';
    const runMergeSave = () =>
      saveDeckWithMerge({
        slide,
        theirs: deck,
        baseSha: expectedSha as string,
        ...(saveResolutions ? { resolutions: saveResolutions } : {}),
        ...(saveOursSha ? { expectedOursSha: saveOursSha } : {}),
        // No message override on the merge path: the service marks the commit
        // '(merged)' (with a resolution summary) so a semantic-merge / chooser
        // commit is distinguishable from a plain save in the git record.
        // Theme URLs must be resolved from the MERGED deck (a concurrent
        // theme change on main may win the per-field meta merge).
        resolveThemeUrls: mergedDeck => resolveReadThemeUrls(mergedDeck, gitOrgLogin, repo),
      });
    let saved: { sha: string; html: string };
    let mergedWithConcurrent = 0;
    // true when the merge path committed: savedContent is then the MERGED
    // document (not the posted one) and the client must adopt it.
    let mergedSave = false;

    if (saveResolutions && canMergeSave) {
      // Resolution pass: the token is known-stale — go straight to the 3-way.
      const mergeResult = await runMergeSave();
      if (!mergeResult.merged) return mergeReport(mergeResult);
      saved = mergeResult;
      mergedWithConcurrent = mergeResult.concurrent;
      mergedSave = true;
    } else {
      try {
        // Single choke point: conflict check (§3 2×2 table) → generateDeckHtml
        // → one atomic commit (deck.json + index.html) → updated_at bump.
        saved = await saveDeck({
          slide,
          deck,
          expectedSha,
          shaSource,
          message: `Update slides: ${slide.title}`,
          themeUrls,
        });
      } catch (error: unknown) {
        if (!(error instanceof DeckConflictError) || !canMergeSave) throw error;
        // Stale token → the semantic 3-way merge instead of a blank refusal.
        const mergeResult = await runMergeSave();
        if (!mergeResult.merged) return mergeReport(mergeResult);
        saved = mergeResult;
        mergedWithConcurrent = mergeResult.concurrent;
        mergedSave = true;
      }
    }

    // Check for orphaned images after save
    let orphanedImages: Array<{ path: string; name: string; url: string }> = [];
    try {
      orphanedImages = await ContentService.findOrphanedImages({
        orgLogin: gitOrgLogin,
        repo,
        imagesFolder: `${slide.content_path}/images`,
        htmlContent: saved.html,
      });
    } catch (err: unknown) {
      // Don't fail the save if orphan detection fails
      console.error('Failed to detect orphaned images:', err);
    }

    // Return the full HTML so UI can update without waiting for CDN.
    // sha is the DECK sha (+ sha_source 'deck') — deck.json now exists, so the
    // client's conflict token must point at it for the next save.
    // merged_with_concurrent (present iff the merge path committed) → the
    // savedContent is the MERGED document: the client adopts it and toasts
    // the concurrent count.
    return {
      success: true,
      sha: saved.sha,
      sha_source: 'deck' as const,
      savedContent: saved.html,
      orphanedImages,
      ...(mergedSave ? { merged_with_concurrent: mergedWithConcurrent } : {}),
    };
  } catch (error: unknown) {
    if (error instanceof PreviewResolutionError) {
      // Stale resolution pin (main moved after the reviewed report) → 409;
      // bad/stale resolutions → 400 naming the ids. Either way the client
      // re-runs the plain save for a fresh report.
      if (error.code === 'CONTENT_CONFLICT') {
        return data({ error: error.message, code: error.code }, { status: 409 });
      }
      return data({ error: error.message, code: error.code, ids: error.ids }, { status: 400 });
    }
    if (
      error instanceof DeckConflictError ||
      (error instanceof Error && error.name === 'DeckConflictError')
    ) {
      // Surfaced by the fetcher as data with a 409 status — the client shows
      // the "deck changed, reload" prompt instead of a generic save error.
      // Reached only when the semantic merge is unavailable (legacy token,
      // unreadable base, main deck gone) or lost its CAS retry.
      return data(
        {
          conflict: true,
          message:
            'This deck changed since you opened it — reload to get the latest version before saving.',
        },
        { status: 409 }
      );
    }
    console.error('Failed to save slide:', error);
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

export default function SlideViewer() {
  const {
    slide,
    isPro,
    contentUrl,
    slideContent,
    contentError,
    snippets: initialSnippets,
    cssThemes: initialCssThemes,
    customThemes: initialCustomThemes,
    sharedThemes: initialSharedThemes,
    webappUrl,
    autoEdit,
    returnUrl,
    canEdit,
    canPresent,
    canViewSpeakerNotes,
    userRole: _userRole,
    content_sha: loaderContentSha,
    sha_source: loaderShaSource,
    preview,
    notice,
    noticeAutoMerged,
  } = useLoaderData<typeof loader>();
  // Preview mode is strictly read-only — editing chrome is suppressed while
  // rendering the pending preview branch (plan §3b).
  const previewActive = Boolean(preview?.active);
  const effectiveCanEdit = canEdit && !previewActive;
  const [snippets, setSnippets] = useState<Array<{ id: string; name: string; content: string }>>(
    initialSnippets || []
  );
  const [cssThemes, setCssThemes] = useState<
    Array<{ id: string; name: string; type: string; content: string }>
  >(initialCssThemes || []);
  // Themes are now lazy-loaded when entering edit mode
  const [customThemes, setCustomThemes] = useState(initialCustomThemes || []);
  const [sharedThemes, setSharedThemes] = useState(initialSharedThemes || []);
  const [themesLoaded, setThemesLoaded] = useState(false);
  const { user: _user } = useUser();

  const [isEditing, setIsEditing] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [isLoadingLatest, setIsLoadingLatest] = useState(false);
  // Save-in-flight hold (fixes the stale-view flash): a Save / auto-save keeps
  // edit mode locked behind a read-only scrim + a 'Saving…' strip until the
  // response confirms, instead of exiting to view optimistically — which
  // flashed the PRE-save content for the 1-3s round-trip, then swapped in the
  // committed content. `savingInFlight` drives that UI; `saveInFlightRef` gates
  // the fetcher effect (a ref, so it stays out of the effect's dep array);
  // `exitAfterSaveRef` records whether success drops to view mode (handleSave →
  // true) or stays in edit (handleSaveContent → false). The exit intent
  // persists through a conflict chooser so resolving a Save-initiated conflict
  // still ends in view, an auto-save-initiated one still ends in edit.
  const [savingInFlight, setSavingInFlight] = useState(false);
  const saveInFlightRef = useRef(false);
  const exitAfterSaveRef = useRef(false);
  // Conflict token (Phase 4b): sha of the deck's source of truth + which file
  // it came from. Seeded by the loader, refreshed by fetch-latest and every
  // successful save; echoed back with each save submit.
  const [contentToken, setContentToken] = useState<{
    content_sha: string | null;
    sha_source: 'deck' | 'legacy_html';
  }>({ content_sha: loaderContentSha, sha_source: loaderShaSource });
  // Non-null when the last save 409'd (deck changed under this session).
  const [saveConflict, setSaveConflict] = useState<string | null>(null);
  // Phase 7.5: non-null when a stale save's 3-way merge hit true collisions —
  // the per-unit report the save-variant conflict chooser renders.
  const [saveMergeReport, setSaveMergeReport] = useState<{
    units: ConflictUnit[];
    orderConflict: OrderConflict | null;
    autoMerged: number;
    oursSha: string | null;
  } | null>(null);
  // The exact content string the last save posted — preserved so a chooser
  // re-submit (or auto re-run) can carry the SAME document even though the
  // editor DOM was torn down when edit mode exited.
  const lastPostedContentRef = useRef<string | null>(null);
  // Diff-at-save baseline: the canonical section snapshot of the document the
  // editor is editing, paired with the deck sha it was read at. Captured at
  // edit entry (fetch-latest) and refreshed after every successful save
  // (merged-save adoption included — the adopted merged doc becomes the new
  // baseline). null → no ops path; saves post the whole document.
  const baselineRef = useRef<{ snapshot: DeckSnapshot; baseSha: string } | null>(null);
  // The ops JSON the last save posted (when it was an ops save) — a chooser
  // re-submit must carry the SAME ops so the server re-derives the SAME
  // conflict report the choices answer.
  const lastPostedOpsRef = useRef<{ ops: string; baseSha: string } | null>(null);
  /** Capture/refresh the diff baseline from a server-rendered document. */
  const captureBaseline = useCallback((content: unknown, sha: unknown, source: unknown): void => {
    if (
      typeof content === 'string' &&
      content &&
      typeof sha === 'string' &&
      sha &&
      source === 'deck' &&
      typeof DOMParser !== 'undefined'
    ) {
      const snapshot = extractDeckSnapshot(content, html =>
        new DOMParser().parseFromString(html, 'text/html')
      );
      baselineRef.current = snapshot ? { snapshot, baseSha: sha } : null;
    } else {
      baselineRef.current = null;
    }
  }, []);
  // Bumped when a merged save lands while editing: the committed document is
  // the MERGE (not what the DOM holds), so a live editor must remount from
  // the merged savedContent — otherwise the next save, carrying the fresh
  // token over the stale DOM, would clobber the folded-in concurrent changes.
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [autoEditTriggered, setAutoEditTriggered] = useState(false);
  // Track editable content separately from CDN content
  const [editableContent, setEditableContent] = useState<string | null>(null);
  // Orphaned images cleanup
  const [orphanedImages, setOrphanedImages] = useState<
    Array<{ path: string; name: string; url: string }>
  >([]);
  const [showOrphanedModal, setShowOrphanedModal] = useState(false);
  const [isDeletingImages, setIsDeletingImages] = useState(false);
  const [showOverview, setShowOverview] = useState(false);
  const [notesCollapsed, setNotesCollapsed] = useState(true);
  const [backUrl, setBackUrl] = useState(webappUrl);
  const fetcher = useFetcher();
  const themeFetcher = useFetcher(); // For lazy-loading themes
  const snippetFetcher = useFetcher(); // For lazy-loading snippets
  const revealRef = useRef<RevealSlidesHandle>(null);
  const [revealInstance, setRevealInstance] = useState<RevealApi | null>(null);
  const [currentSlideTheme, setCurrentSlideTheme] = useState('white'); // For Sandpack auto-theme

  // Lazy-load themes when entering edit mode
  useEffect(() => {
    if (isEditing && !themesLoaded && themeFetcher.state === 'idle') {
      // Load themes and snippets when entering edit mode
      themeFetcher.submit({ intent: 'list-themes' }, { method: 'POST' });
      snippetFetcher.submit({ intent: 'list-snippets' }, { method: 'POST' });
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
        setRevealInstance(revealRef.current?.getRevealInstance?.() ?? null);
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
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Warn on live unsaved edits, OR when a save 409 parked the ONLY copy of
      // the work in the chooser / conflict banner. handleSave now HOLDS edit
      // mode until the response confirms (hasChanges stays true through an
      // in-flight save — S6), so `isEditing && hasChanges` already covers the
      // saving and chooser-open states; the report/banner guards remain as
      // belt-and-suspenders in case hasChanges was cleared elsewhere.
      if ((isEditing && hasChanges) || saveMergeReport || saveConflict) {
        e.preventDefault();
        // Modern browsers ignore this, but it's required for the dialog to show
        e.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isEditing, hasChanges, saveMergeReport, saveConflict]);

  // canEdit, canPresent, canViewSpeakerNotes now come from loader data (computed by assertSlideAccess)

  // Post-accept/discard success notice (round-tripped via redirect param)
  useEffect(() => {
    if (!notice) return;
    if (notice === 'preview-accepted') {
      message.success(
        noticeAutoMerged
          ? `Preview merged —${noticeAutoMerged} change${noticeAutoMerged === 1 ? '' : 's'} merged automatically; changes are now live.`
          : 'Preview merged —changes are now live.'
      );
    } else if (notice === 'preview-discarded') {
      message.success('Preview discarded.');
    }
    // Strip the params so a refresh doesn't re-toast
    const url = new URL(window.location.href);
    url.searchParams.delete('notice');
    url.searchParams.delete('auto_merged');
    window.history.replaceState({}, '', url);
  }, [notice, noticeAutoMerged]);

  // Auto-enter edit mode if ?mode=edit was in URL (for new slides where CDN hasn't caught up)
  // Only triggers once on mount, and only if user has permission to edit
  useEffect(() => {
    if (autoEdit && effectiveCanEdit && !autoEditTriggered && !isEditing) {
      setAutoEditTriggered(true);
      // Trigger the same flow as clicking "Edit" button - fetch latest from API
      setIsLoadingLatest(true);
      fetcher.submit({ intent: 'fetch-latest' }, { method: 'post' });
    }
  }, [autoEdit, effectiveCanEdit, autoEditTriggered, isEditing, fetcher]);

  const isSaving = fetcher.state === 'submitting' && !fetcher.formData?.get('intent');
  const isFetchingLatest =
    fetcher.state === 'submitting' && fetcher.formData?.get('intent') === 'fetch-latest';
  const saveSuccess = fetcher.data?.success;
  const saveError = fetcher.data?.error;

  // Handle fetcher responses
  useEffect(() => {
    if (fetcher.data?.intent === 'fetch-latest' && fetcher.data?.content) {
      // Got fresh content from GitHub API - enter edit mode with it
      setEditableContent(fetcher.data.content);
      // Refresh the conflict token (also the recovery path after a 409:
      // fresh content + fresh token, unsaved changes discarded)
      if (fetcher.data.content_sha) {
        setContentToken({
          content_sha: fetcher.data.content_sha,
          sha_source: fetcher.data.sha_source === 'deck' ? 'deck' : 'legacy_html',
        });
      }
      // Diff-at-save baseline: this document + sha is what save-time ops
      // will be diffed against (deck-sourced tokens only).
      captureBaseline(fetcher.data.content, fetcher.data.content_sha, fetcher.data.sha_source);
      setSaveConflict(null);
      setSaveMergeReport(null);
      lastPostedOpsRef.current = null;
      setHasChanges(false);
      setIsEditing(true);
      setIsLoadingLatest(false);
    } else if (fetcher.data?.intent === 'fetch-latest' && fetcher.data?.error) {
      // Fetch-latest failed (e.g. a transient GitHub error). Clear the loading
      // flag so the Edit / Reload buttons re-enable, surface a retryable
      // message, and KEEP any open chooser / conflict banner (they hold the
      // only recovery path — do not strand the user, S8).
      setIsLoadingLatest(false);
      message.error(`Couldn't load the latest version: ${fetcher.data.error}. Please try again.`);
    } else if (fetcher.data?.intent === 'delete-images') {
      // Images were deleted
      setIsDeletingImages(false);
      if (fetcher.data.success) {
        message.success(
          `Deleted ${fetcher.data.deleted} unused image${fetcher.data.deleted !== 1 ? 's' : ''}`
        );
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
        setSnippets((prev: Array<{ id: string; name: string; content: string }>) => [
          ...prev,
          fetcher.data.snippet,
        ]);
      } else if (fetcher.data.error) {
        message.error(`Failed to save snippet: ${fetcher.data.error}`);
      }
    } else if (fetcher.data?.intent === 'update-snippet') {
      // Snippet was updated
      if (fetcher.data.success && fetcher.data.snippet) {
        message.success(`Snippet "${fetcher.data.snippet.name}" updated!`);
        // Replace the old snippet with the updated one
        setSnippets((prev: Array<{ id: string; name: string; content: string }>) =>
          prev.map(s => (s.id === fetcher.data.oldId ? fetcher.data.snippet : s))
        );
      } else if (fetcher.data.error) {
        message.error(`Failed to update snippet: ${fetcher.data.error}`);
      }
    } else if (fetcher.data?.intent === 'delete-snippet') {
      // Snippet was deleted
      if (fetcher.data.success) {
        message.success('Snippet deleted');
        // Remove the snippet from the list
        setSnippets((prev: Array<{ id: string; name: string; content: string }>) =>
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
        setCssThemes((prev: Array<{ id: string; name: string; type: string; content: string }>) => [
          ...prev,
          fetcher.data.theme,
        ]);
      } else if (fetcher.data.error) {
        message.error(`Failed to save theme: ${fetcher.data.error}`);
      }
    } else if (fetcher.data?.intent === 'update-theme') {
      // CSS theme was updated
      if (fetcher.data.success && fetcher.data.theme) {
        message.success(`CSS theme "${fetcher.data.theme.name}" updated!`);
        // Replace the old theme with the updated one
        setCssThemes((prev: Array<{ id: string; name: string; type: string; content: string }>) =>
          prev.map(t => (t.id === fetcher.data.oldId ? fetcher.data.theme : t))
        );
      } else if (fetcher.data.error) {
        message.error(`Failed to update theme: ${fetcher.data.error}`);
      }
    } else if (fetcher.data?.intent === 'delete-theme') {
      // CSS theme was deleted
      if (fetcher.data.success) {
        message.success('CSS theme deleted');
        // Remove the theme from the list
        setCssThemes((prev: Array<{ id: string; name: string; type: string; content: string }>) =>
          prev.filter(t => t.id !== fetcher.data.deletedId)
        );
      } else if (fetcher.data.error) {
        message.error(`Failed to delete theme: ${fetcher.data.error}`);
      }
    } else if (fetcher.data?.conflict && fetcher.data?.units) {
      // Save-merge collision report (Phase 7.5): true same-unit conflicts the
      // semantic merge could not decide — mount the save-variant chooser.
      // Everything else already auto-merged server-side (nothing committed).
      setSaveMergeReport({
        units: fetcher.data.units,
        orderConflict: fetcher.data.orderConflict ?? null,
        autoMerged: fetcher.data.autoMerged ?? 0,
        oursSha: fetcher.data.oursSha ?? null,
      });
      setSaveConflict(null);
      // Stay in the edit context (no view switch). The chooser owns the
      // read-only scrim now, so drop the saving-hold scrim/strip. Keep
      // exitAfterSaveRef intact — resolving the conflict honors the original
      // Save-vs-auto-save exit intent.
      saveInFlightRef.current = false;
      setSavingInFlight(false);
    } else if (fetcher.data?.conflict) {
      // Save 409'd with no mergeable report (legacy token, unreadable base,
      // or a double CAS loss). Show the reload prompt.
      setSaveConflict(
        fetcher.data.message ||
          'This deck changed since you opened it — reload to get the latest version before saving.'
      );
      setSaveMergeReport(null);
      // Stay in edit mode with the reload banner (no view switch); drop the
      // saving-hold scrim/strip. The exit intent is moot — reloading discards
      // this session's edits — so reset it.
      saveInFlightRef.current = false;
      exitAfterSaveRef.current = false;
      setSavingInFlight(false);
    } else if (fetcher.data?.code && lastPostedContentRef.current) {
      // A chooser re-submit was refused (stale ours_sha pin, conflict set
      // changed) OR an ops save answered OPS_BASE_MISMATCH. Re-run the plain
      // WHOLE-DOCUMENT save with the SAME posted content — it either lands
      // (possibly merged) or produces a FRESH report. Bounded: a plain
      // whole-doc save never answers with `code`, so this runs at most once
      // per save/Apply click.
      setSaveMergeReport(null);
      lastPostedOpsRef.current = null;
      // Keep the saving-hold armed across the auto-retry (an ops→whole-doc
      // fallback stays armed; a refused-chooser re-submit re-arms it) so the
      // scrim/strip stays continuous until this fresh save resolves.
      saveInFlightRef.current = true;
      setSavingInFlight(true);
      const payload: Record<string, string> = { content: lastPostedContentRef.current };
      if (contentToken.content_sha) {
        payload.content_sha = contentToken.content_sha;
        payload.sha_source = contentToken.sha_source;
      }
      fetcher.submit(payload, { method: 'post' });
    } else if (fetcher.data?.savedContent) {
      // After save, update our local content to match what was saved
      // This prevents stale content when CDN hasn't updated yet
      setEditableContent(fetcher.data.savedContent);
      // The save materialized deck.json — future saves must key on ITS sha
      if (fetcher.data.sha) {
        setContentToken({
          content_sha: fetcher.data.sha,
          sha_source: fetcher.data.sha_source === 'deck' ? 'deck' : 'legacy_html',
        });
      }
      // The committed document becomes the next diff-at-save baseline
      // (merged-save adoption included).
      captureBaseline(fetcher.data.savedContent, fetcher.data.sha, fetcher.data.sha_source);
      lastPostedOpsRef.current = null;
      setSaveConflict(null);
      setSaveMergeReport(null);
      // Remount the live editor whenever the committed savedContent must
      // REPLACE what the DOM holds — otherwise the next save diffs a stale DOM
      // against the fresh baseline and reverts the folded-in change (or churns
      // a server-minted insert id). The ops path signals this with
      // adoption_required (a FULL compare: concurrent reorders/cross-stack
      // moves/deck-meta folds AND minted insert ids the id-less DOM never had);
      // the whole-doc merge path still signals it with merged_with_concurrent.
      // The toast is purely the concurrent count.
      if (
        fetcher.data.adoption_required === true ||
        typeof fetcher.data.merged_with_concurrent === 'number'
      ) {
        setEditorEpoch(epoch => epoch + 1);
      }
      if (typeof fetcher.data.merged_with_concurrent === 'number') {
        const n = fetcher.data.merged_with_concurrent;
        if (n > 0) {
          message.success(`Saved — merged with ${n} concurrent change${n === 1 ? '' : 's'}`);
        }
      }
      // Check if there are orphaned images to clean up
      if (fetcher.data.orphanedImages?.length > 0) {
        setOrphanedImages(fetcher.data.orphanedImages);
        setShowOrphanedModal(true);
      }
      // The committed content is now applied (editableContent + adoption
      // remount above). ONLY now clear the unsaved flags and, for a Save-&-exit
      // (handleSave), drop to view mode — its first render shows the committed
      // document (merged concurrent changes included), so there's no stale-view
      // flash. Auto-saves (handleSaveContent) set exitAfterSave=false and stay
      // in edit. Clearing the saving-hold last removes the scrim/strip in the
      // same transition.
      setHasChanges(false);
      if (exitAfterSaveRef.current) {
        setIsEditing(false);
      }
      exitAfterSaveRef.current = false;
      saveInFlightRef.current = false;
      setSavingInFlight(false);
    } else if (saveInFlightRef.current && fetcher.data?.error) {
      // Plain save failure (non-conflict): drop the saving-hold scrim/strip but
      // STAY in edit mode so the user can retry from the intact editor. Keep
      // hasChanges true (honest — S6: still unsaved) and surface a retryable
      // toast. Gated on the ref so an unrelated error (e.g. a failed image
      // upload, which never arms the hold) can't trip this branch.
      saveInFlightRef.current = false;
      exitAfterSaveRef.current = false;
      setSavingInFlight(false);
      message.error(
        `Couldn't save: ${fetcher.data.error}. Your changes are still here — please try again.`
      );
    }
  }, [fetcher.data]);

  // Handle image upload - returns a promise that resolves with the image URL
  const handleImageUpload = useCallback(
    async (file: File): Promise<string> => {
      return new Promise<string>((resolve, reject) => {
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
    },
    [fetcher]
  );

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
    fetcher.submit({ intent: 'fetch-latest' }, { method: 'post' });
  }, [fetcher]);

  // Build the save request from the current editor content. Diff-at-save:
  // when a baseline snapshot matches the conflict token, the DOM is diffed
  // against it and the delta posts as granular OPS + the base token —
  // untouched slides never ride in the request. Any anomaly (no baseline,
  // theme change, structure the op vocabulary can't express, zero delta)
  // falls back to the existing whole-document save unchanged. The posted
  // content string is ALWAYS preserved for the chooser / the server's
  // OPS_BASE_MISMATCH whole-doc fallback re-submit.
  const buildSavePayload = useCallback(
    (content: string): Record<string, string> => {
      lastPostedContentRef.current = content;
      lastPostedOpsRef.current = null;

      const baseline = baselineRef.current;
      if (
        baseline &&
        contentToken.sha_source === 'deck' &&
        contentToken.content_sha === baseline.baseSha &&
        typeof DOMParser !== 'undefined'
      ) {
        const currSnapshot = extractDeckSnapshot(content, html =>
          new DOMParser().parseFromString(html, 'text/html')
        );
        const ops = currSnapshot ? diffDeckSnapshots(baseline.snapshot, currSnapshot) : null;
        if (ops && ops.length > 0) {
          const opsJson = JSON.stringify(ops);
          lastPostedOpsRef.current = { ops: opsJson, baseSha: baseline.baseSha };
          return {
            ops: opsJson,
            base_sha: baseline.baseSha,
            content_sha: contentToken.content_sha,
            sha_source: 'deck',
          };
        }
      }

      // Whole-document save (7.5 path — also covers ops-ineligible states).
      const payload: Record<string, string> = { content };
      if (contentToken.content_sha) {
        payload.content_sha = contentToken.content_sha;
        payload.sha_source = contentToken.sha_source;
      }
      return payload;
    },
    [contentToken]
  );

  // Save the current slide content and, once the committed content is ready,
  // exit edit mode. We do NOT exit optimistically: doing so flashed the
  // pre-save content in view mode for the save round-trip. Instead arm the
  // saving-hold (read-only scrim + 'Saving…' strip), keep hasChanges honest
  // (S6: beforeunload stays armed until the response), and let the fetcher
  // effect apply the committed document THEN drop to view in one transition.
  const handleSave = useCallback(() => {
    const content = revealRef.current?.getCurrentContent();
    if (!content) return;

    exitAfterSaveRef.current = true;
    saveInFlightRef.current = true;
    setSavingInFlight(true);
    fetcher.submit(buildSavePayload(content), { method: 'post' });
  }, [fetcher, buildSavePayload]);

  // Save content without exiting edit mode (used for auto-save after destructive
  // operations — uploads / orphan cleanup). Same saving-hold, but success stays
  // in edit (exitAfterSave=false).
  const handleSaveContent = useCallback(() => {
    const content = revealRef.current?.getCurrentContent();
    if (!content) return;

    exitAfterSaveRef.current = false;
    saveInFlightRef.current = true;
    setSavingInFlight(true);
    fetcher.submit(buildSavePayload(content), { method: 'post' });
  }, [fetcher, buildSavePayload]);

  // Recover from a save conflict: re-fetch the latest content + token
  // (the existing fetch-latest flow), discarding this session's unsaved changes
  const handleReloadLatest = useCallback(() => {
    // Keep the chooser / conflict banner (and the posted ops) mounted until the
    // reload actually SUCCEEDS — a failed fetch-latest must not clear the only
    // recovery UI and leave the user stranded (S8). The fetch-latest success
    // branch clears saveConflict/saveMergeReport/lastPostedOpsRef; a failure
    // just re-enables the buttons.
    setIsLoadingLatest(true);
    fetcher.submit({ intent: 'fetch-latest' }, { method: 'post' });
  }, [fetcher]);

  // Apply the save-merge chooser's decisions (Phase 7.5): re-submit the SAME
  // posted payload with one {id, choose} per conflict and the report's
  // ours_sha pin. An ops save re-submits the SAME ops (the report was derived
  // from them — recomputing could change the conflict set under the reviewed
  // choices). Whole-doc saves keep the pre-ops behavior: if the user is still
  // in edit mode (auto-save conflicts), the live DOM is fresher than the
  // preserved post — use it; the server re-validates the conflict set either
  // way.
  const handleApplySaveResolutions = useCallback(
    (resolutions: Array<{ id: string; choose: 'ours' | 'theirs' }>) => {
      if (!saveMergeReport) return;

      const shared: Record<string, string> = {
        resolutions: JSON.stringify(resolutions),
        ...(saveMergeReport.oursSha ? { ours_sha: saveMergeReport.oursSha } : {}),
      };

      const postedOps = lastPostedOpsRef.current;
      if (postedOps) {
        fetcher.submit(
          {
            ops: postedOps.ops,
            base_sha: postedOps.baseSha,
            content_sha: postedOps.baseSha,
            sha_source: 'deck',
            ...shared,
          },
          { method: 'post' }
        );
        return;
      }

      const content =
        (isEditing ? revealRef.current?.getCurrentContent() : null) || lastPostedContentRef.current;
      if (!content) return;
      lastPostedContentRef.current = content;
      const payload: Record<string, string> = { content, ...shared };
      if (contentToken.content_sha) {
        payload.content_sha = contentToken.content_sha;
        payload.sha_source = contentToken.sha_source;
      }
      fetcher.submit(payload, { method: 'post' });
    },
    [fetcher, contentToken, isEditing, saveMergeReport]
  );

  // Exit editing mode (discards unsaved changes)
  const handleDoneEditing = useCallback(() => {
    setIsEditing(false);
    setHasChanges(false);
    // Keep editableContent for next edit session (it's the latest we know of)
  }, []);

  // Delete selected orphaned images
  const handleDeleteOrphanedImages = useCallback(
    (paths: string[]) => {
      setIsDeletingImages(true);
      fetcher.submit(
        {
          intent: 'delete-images',
          paths: JSON.stringify(paths),
        },
        { method: 'post' }
      );
    },
    [fetcher]
  );

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
  const handleNavigateToSlide = useCallback((h: number, v: number) => {
    const instance = revealRef.current?.getRevealInstance?.();
    if (instance) {
      instance.slide(h, v);
    }
  }, []);

  // Determine which content to show
  // - When editing: use editableContent (fresh from API or after save)
  // - When viewing: use CDN content (slideContent) or editableContent if we have it
  const displayContent = isEditing ? editableContent : editableContent || slideContent;

  // Save a new snippet
  const handleSaveSnippet = useCallback(
    (name: string, content: string) => {
      fetcher.submit({ intent: 'save-snippet', name, content }, { method: 'post' });
    },
    [fetcher]
  );

  // Update an existing snippet
  const handleUpdateSnippet = useCallback(
    (id: string, name: string, content: string) => {
      fetcher.submit({ intent: 'update-snippet', id, name, content }, { method: 'post' });
    },
    [fetcher]
  );

  // Delete a snippet
  const handleDeleteSnippet = useCallback(
    (id: string) => {
      fetcher.submit({ intent: 'delete-snippet', id }, { method: 'post' });
    },
    [fetcher]
  );

  // Save a new CSS theme
  const handleSaveTheme = useCallback(
    (name: string, type: string, content: string) => {
      fetcher.submit({ intent: 'save-theme', name, type, content }, { method: 'post' });
    },
    [fetcher]
  );

  // Update an existing CSS theme
  const handleUpdateTheme = useCallback(
    (id: string, name: string, type: string, content: string) => {
      fetcher.submit({ intent: 'update-theme', id, name, type, content }, { method: 'post' });
    },
    [fetcher]
  );

  // Delete a CSS theme
  const handleDeleteTheme = useCallback(
    (id: string) => {
      fetcher.submit({ intent: 'delete-theme', id }, { method: 'post' });
    },
    [fetcher]
  );

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
      isPro={isPro}
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
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z"
                  clipRule="evenodd"
                />
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
                {savingInFlight ? 'Saving…' : hasChanges ? 'Unsaved' : 'Editing'}
              </span>
            )}
            {saveSuccess && !hasChanges && !isEditing && (
              <span className="px-2 py-0.5 text-xs bg-green-100 text-green-800 rounded-full">
                Saved
              </span>
            )}
            {saveError && (
              <span
                className="px-2 py-0.5 text-xs bg-red-100 text-red-800 rounded-full"
                title={saveError}
              >
                Error
              </span>
            )}

            {/* Action buttons */}
            {canEdit &&
              isEditing &&
              (hasChanges ? (
                <Popconfirm
                  title="Discard changes?"
                  description="You have unsaved changes. Discard them?"
                  onConfirm={handleDoneEditing}
                  okText="Discard"
                  cancelText="Keep editing"
                  okButtonProps={{ danger: true }}
                >
                  <Tooltip title="Cancel editing">
                    <button className="p-2 text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600">
                      <svg
                        className="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M6 18L18 6M6 6l12 12"
                        />
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
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </Tooltip>
              ))}
            {canEdit && isEditing && (
              <Tooltip title={isSaving ? 'Saving...' : 'Save changes'}>
                <button
                  onClick={handleSave}
                  disabled={isSaving}
                  className="save-button p-2 rounded-md disabled:opacity-50"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                </button>
              </Tooltip>
            )}
            {effectiveCanEdit && !isEditing && (
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
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                    />
                  </svg>
                </a>
              </Tooltip>
            )}
          </div>
        </nav>

        {/* Preview-branch chrome (staff only — `preview` is null otherwise) */}
        {preview?.active && <PreviewBar preview={preview} />}
        {preview?.missing && <NoPreviewNotice />}
        {preview && !preview.active && preview.exists && !isEditing && (
          <PendingPreviewBanner preview={preview} />
        )}

        {/* Saving-hold (fixes the stale-view flash): while a Save / auto-save
            commits, freeze the editor behind the SAME read-only scrim the
            chooser uses (prevents mid-save edits racing the posted snapshot)
            and show a 'Saving…' strip. Holding edit mode here — instead of
            exiting to view optimistically — is what keeps the pre-save content
            from flashing: the fetcher effect applies the committed document,
            then drops to view in one transition. Hidden once the chooser /
            reload banner takes over (they own the scrim then). Scrim below the
            strip (z-1050 < z-1100), both above the navbar (z-50). */}
        {savingInFlight && !saveMergeReport && !saveConflict && (
          <>
            <div
              className="fixed inset-0 z-[1050] bg-black/5 dark:bg-black/20 cursor-progress"
              aria-hidden="true"
              data-testid="saving-editing-block"
            />
            <div className="fixed top-14 left-0 right-0 z-[1100] shadow-lg">
              <MergeProgress label="Saving your changes…" />
            </div>
          </>
        )}

        {/* Read-only scrim while the save-merge chooser is open (S5). An
            auto-save (handleSaveContent) keeps edit mode, so without this the
            user could keep typing into the live editor while resolving — and
            Apply re-submits the ORIGINAL posted ops, then adoption remounts the
            editor from the committed document, silently discarding those edits.
            Preserving post-conflict edits across the innerHTML rebuild is not
            reliably feasible, so we take the honest fix: BLOCK editing while the
            chooser is open. The scrim sits below the chooser (z-1100) and above
            the editor; the already-posted work is safe in the ops/content refs. */}
        {saveMergeReport && !saveConflict && (
          <div
            className="fixed inset-0 z-[1050] bg-black/5 dark:bg-black/20 cursor-not-allowed"
            aria-hidden="true"
            data-testid="save-merge-editing-block"
          />
        )}

        {/* Save-merge chooser (Phase 7.5): a stale save hit true collisions —
            pick a side per slide, then re-submit the same content with the
            choices. The posted document is preserved in lastPostedContentRef
            until the resolution completes. */}
        {saveMergeReport && !saveConflict && (
          <div className="fixed top-14 left-0 right-0 z-[1100] shadow-lg">
            <ConflictPanel
              variant="save"
              units={saveMergeReport.units}
              orderConflict={saveMergeReport.orderConflict}
              autoMerged={saveMergeReport.autoMerged}
              oursSha={saveMergeReport.oursSha}
              busy={fetcher.state !== 'idle'}
              onApply={handleApplySaveResolutions}
              onDiscard={handleReloadLatest}
            />
          </div>
        )}

        {/* Save-conflict banner (Phase 4b): the deck changed under this session */}
        {saveConflict && (
          <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[1100] w-[calc(100%-2rem)] max-w-xl">
            <div
              role="alert"
              className="flex items-start gap-3 rounded-lg border border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-950 px-4 py-3 shadow-lg"
            >
              <div className="flex-1 text-sm text-amber-900 dark:text-amber-100">
                <div className="font-semibold">Deck changed since you opened it</div>
                <div className="mt-0.5">
                  Someone else saved a newer version. Reload to get the latest — your unsaved
                  changes here will be discarded.
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleReloadLatest}
                  disabled={isLoadingLatest || isFetchingLatest}
                  className="px-3 py-1.5 text-sm font-medium rounded-md bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-500 dark:text-amber-950 dark:hover:bg-amber-400 disabled:opacity-50"
                >
                  {isLoadingLatest || isFetchingLatest ? 'Reloading...' : 'Reload latest'}
                </button>
                <button
                  onClick={() => setSaveConflict(null)}
                  aria-label="Dismiss"
                  className="p-1 text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        )}

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
                key={isEditing ? `editing-${editorEpoch}` : 'viewing'}
                contentUrl={contentUrl}
                initialContent={displayContent}
                initialError={contentError}
                canEdit={effectiveCanEdit}
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
