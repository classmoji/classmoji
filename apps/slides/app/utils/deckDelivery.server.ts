/**
 * deckDelivery.server.ts — the ONE read-side content-delivery pass for decks.
 *
 * A deck is stored with plain repo references — `/content/{org}/{repo}/{path}`
 * for its images, and the same shape for the `<link>`s of a shared theme. The
 * delivery layer turns those into signed `content-*.classmoji.io` URLs at READ
 * time, per viewer, and never stores the result (a signature expires, a sha
 * moves, and the tier is per-viewer — see contentDelivery.service).
 *
 * Every surface that renders a stored deck goes through here: the deck viewer
 * (`$slideId`), the presenter (`$slideId_.present`), the audience follow view
 * (`$slideId_.follow`) and the remote speaker view (`$slideId_.speaker`). This
 * module exists because they did NOT: the rewrite lived inside the viewer
 * route, so the other three served raw `/content/...` URLs and broke the moment
 * a content repo went private.
 *
 * READ ONLY. None of this may reach a document on its way INTO the editor: the
 * editor posts its document back on save, and a signed URL that made that round
 * trip would be committed into deck.json, freezing one viewer's expiring
 * signature into the deck forever.
 *
 * Every failure degrades to the stored URLs, which still work through the
 * content proxy. Nothing here is allowed to break a deck read.
 */

import { ClassmojiService } from '@classmoji/services';
import {
  rewriteDeckAssetUrls,
  type DeckJson,
  type DeckThemeUrls,
} from '@classmoji/services/slides';
import { getThemeUrls } from '~/utils/themeService.server';

/** Where shared slide themes live in a content repo. Mirrors contentDelivery. */
const THEMES_FOLDER = '.slidesthemes';

/** The slide fields a delivery context needs. Narrow on purpose. */
interface DeliverySlide {
  classroom?: {
    id?: string;
    content_key_version?: number;
    content_repo?: string;
    content_delivery_enabled?: boolean | null;
  } | null;
}

/** What the viewer's tier decision is made of. Passed straight to `tierFor`. */
export interface DeliveryAccess {
  canEdit: boolean;
  /** The staff-only preview BRANCH read — not a thumbnail render. */
  preview?: boolean;
  isPublicSite?: boolean;
}

/** The deck surfaces that resolve content. Each has its own tier posture. */
export type DeckSurface = 'viewer' | 'present' | 'speaker' | 'follow';

/** The slice of `assertSlideAccess`'s result a tier decision may look at. */
export interface SlideAccessResultLike {
  canEdit: boolean;
  /** The viewer's `previewActive` — a staff read of the preview BRANCH. */
  previewActive?: boolean;
}

/**
 * `assertSlideAccess`'s answer + the deck's flags → the tier inputs, per surface.
 *
 * A function rather than four inline object literals because the surfaces do
 * NOT agree, and the places they disagree are the places this went wrong
 * before:
 *
 *   - `present` and `speaker` pin `canEdit: false` on purpose. Both stay open
 *     for hours, and `draft` is an exact `now + 4h` with five minutes of grace,
 *     so an instructor who opens the presenter in the morning and reaches slide
 *     40 after lunch would get a 403 on a lazily-loaded Reveal background.
 *     Content is sha-addressed and immutable, so the longer bucket shows the
 *     same bytes; `draft` exists for the editor's 403-and-revalidate flow, not
 *     for presenting.
 *   - only `viewer` honours `previewActive`. `follow` has a `?preview=true`
 *     query param of its own that means "thumbnail render", and letting that
 *     reach `tierFor` would mint draft URLs for a hall full of students.
 */
export function deckAccessFor(
  surface: DeckSurface,
  access: SlideAccessResultLike,
  slide: { is_public?: boolean | null }
): DeliveryAccess {
  const isPublicSite = Boolean(slide.is_public);
  if (surface === 'present' || surface === 'speaker') {
    return { canEdit: false, isPublicSite };
  }
  return {
    canEdit: access.canEdit,
    preview: surface === 'viewer' ? Boolean(access.previewActive) : false,
    isPublicSite,
  };
}

/**
 * The classroom shape the content resolver needs, or null when this deck's
 * classroom cannot be served by the delivery layer at all.
 *
 * The tier is decided HERE, by `ClassmojiService.contentDelivery.tierFor`, so
 * the four deck surfaces cannot drift into four different answers to "which
 * bucket is this viewer in". Staff and preview readers get short-lived draft
 * URLs, a public deck's anonymous readers the long public bucket, everyone else
 * the enrolled one. This is the reason a signed URL cannot live in the deck.
 */
export function deckDeliveryContext(
  slide: DeliverySlide,
  gitOrgLogin: string | undefined,
  repo: string | undefined,
  access: DeliveryAccess
) {
  // A deployment with no signing secret or no origin can never rewrite
  // anything, and every pass below would be a cheerio parse and re-serialize
  // for a byte-identical result. Refusing the context here is what keeps that
  // off the read path entirely.
  if (!ClassmojiService.contentDelivery.isContentDeliveryConfigured()) return null;

  const classroom = slide.classroom;
  if (!classroom?.id || !repo || !gitOrgLogin) return null;
  // The classroom's own switch, checked here rather than left to the resolvers:
  // refusing the context is what keeps a cheerio parse-and-reserialize off the
  // read path of every deck in a classroom that has not been opted in.
  if (!ClassmojiService.contentDelivery.isContentDeliveryEnabled(classroom)) return null;
  return {
    classroom: {
      id: classroom.id,
      content_key_version: classroom.content_key_version ?? 0,
      content_repo: repo,
      content_delivery_enabled: true,
      git_organization: { login: gitOrgLogin },
    },
    tier: ClassmojiService.contentDelivery.tierFor(access),
  };
}

export type DeliveryContext = ReturnType<typeof deckDeliveryContext>;

/** The `shared:` theme a rendered deck declares, or null. */
export function sharedThemeName(html: string | null | undefined): string | null {
  if (!html) return null;
  const match = html.match(/data-theme="shared:([^"]+)"/);
  return match ? match[1] : null;
}

/** True for a reference that points inside a shared theme folder. */
export function isThemeRef(ref: string): boolean {
  return ref.includes(`${THEMES_FOLDER}/`);
}

/**
 * `/content/{org}/{repo}/.slidesthemes/{theme}/lib/offline-v2.css` →
 * `{signedBase}lib/offline-v2.css`, or null when the ref is not in this theme.
 *
 * A theme is signed as a FOLDER (so the CSS's own relative `url()` references
 * inherit the signature), which is why this keeps the filename the resolver
 * already worked out rather than deriving one.
 */
export function rebaseThemeRef(
  ref: string | null | undefined,
  themeName: string,
  signedBase: string
): string | null {
  if (!ref) return null;
  const marker = `/${THEMES_FOLDER}/${themeName}/`;
  const at = ref.indexOf(marker);
  if (at === -1) return null;
  return `${signedBase}${ref.slice(at + marker.length)}`;
}

/**
 * The two content-delivery calls this module makes.
 *
 * A parameter rather than a hard import so the composition below — which refs
 * reach the blob resolver, which are rebased onto the theme folder, what
 * happens to the ones nobody claims — is testable without a database behind
 * the asset map. Production always uses the default.
 */
export interface DeckDeliveryResolvers {
  /**
   * URLs and responsive candidates in ONE pass.
   *
   * One call, not two, because two would pay two asset-map reads per deck read
   * and — the part that actually breaks — read the clock twice: expiries are
   * bucketed, and a pass that straddles a boundary mints a different `src` for
   * the same file than the one its candidate list was built beside.
   */
  resolveDelivery(
    ctx: NonNullable<DeliveryContext>,
    refs: string[]
  ): Promise<{
    urls: Map<string, string>;
    srcSets: Map<string, { src: string; srcset: string }>;
  }>;
  resolveThemeBase(ctx: NonNullable<DeliveryContext>, themeName: string): Promise<string | null>;
}

const defaultResolvers: DeckDeliveryResolvers = {
  resolveDelivery: (ctx, refs) =>
    ClassmojiService.contentDelivery.resolveDelivery(ctx, refs, { srcSets: true }),
  resolveThemeBase: (ctx, themeName) =>
    ClassmojiService.contentDelivery.resolveThemeBase(ctx, themeName),
};

/**
 * Sign the asset — and optionally the shared-theme — references inside an
 * already-rendered deck document.
 *
 * `themeName` defaults to whatever the document declares; pass `null` to skip
 * the theme pass entirely (the deck viewer does, because it resolves its theme
 * links through `resolveDeliveryThemeUrls` on the generated document instead).
 *
 * The returned `themeBase` is the signed folder the theme now hangs off, so a
 * caller that also needs it (a preload hint, a client-side link) does not pay a
 * second lookup.
 */
export async function resolveDeckDelivery(
  html: string | null,
  ctx: DeliveryContext,
  opts: { themeName?: string | null; resolvers?: DeckDeliveryResolvers } = {}
): Promise<{ html: string | null; themeBase: string | null }> {
  if (!ctx || !html) return { html, themeBase: null };

  const resolvers = opts.resolvers ?? defaultResolvers;

  const themeName = opts.themeName === undefined ? sharedThemeName(html) : opts.themeName;

  let themeBase: string | null = null;
  if (themeName) {
    try {
      themeBase = await resolvers.resolveThemeBase(ctx, themeName);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[slides] Theme base resolution failed for "${themeName}":`, message);
    }
  }

  // Filled by the resolve below and read by the srcset step after it — the
  // rewrite calls them in that order, and says so. One pass, one clock.
  let candidates = new Map<string, { src: string; srcset: string }>();

  try {
    const rewritten = await rewriteDeckAssetUrls(
      html,
      async refs => {
        // Theme assets never go through the blob resolver: a theme is signed as
        // a folder, and rewriting one of its files to a standalone blob URL
        // would break precisely the relative `url()` references the folder
        // exists for.
        const { urls, srcSets } = await resolvers.resolveDelivery(
          ctx,
          refs.filter(ref => !isThemeRef(ref))
        );
        candidates = srcSets;
        if (themeName && themeBase) {
          for (const ref of refs) {
            const rebased = rebaseThemeRef(ref, themeName, themeBase);
            if (rebased) urls.set(ref, rebased);
          }
        }
        return urls;
      },
      {
        // Keyed by the STORED reference, which is what the emit step looks up.
        // Theme files never appear here: they were filtered out above, and a
        // per-blob transform URL would leave the signed folder they live in.
        srcSets: async () => new Map([...candidates].map(([ref, set]) => [ref, set.srcset])),
        sizes: ClassmojiService.contentDelivery.IMAGE_SIZES,
      }
    );
    return { html: rewritten, themeBase };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[slides] Asset resolution failed, serving stored URLs:', message);
    return { html, themeBase };
  }
}

/**
 * The image-only pass, for callers whose theme links are resolved elsewhere.
 *
 * The deck viewer's edit-mode read is the reason this exists as its own entry
 * point: it renders the deck through `generateDeckHtml` with theme URLs already
 * signed by `resolveDeliveryThemeUrls`, and re-deriving them here would be a
 * second lookup for the same answer.
 */
export async function resolveDeckAssets(
  html: string | null,
  ctx: DeliveryContext,
  opts: { resolvers?: DeckDeliveryResolvers } = {}
): Promise<string | null> {
  const { html: next } = await resolveDeckDelivery(html, ctx, { ...opts, themeName: null });
  return next;
}

/**
 * Resolve shared-theme URLs for read-side deck rendering (Phase 4c). Same
 * resolution the save path uses (getThemeUrls with identical args), so the
 * generated document matches the saved index.html artifact byte-for-byte.
 * Unlike the save path (which is about to persist and falls back to theme
 * 'white'), a resolve failure on a READ must not mutate the deck — we just
 * render without theme links (generateDeckHtml warns).
 */
export async function resolveReadThemeUrls(
  deck: DeckJson,
  gitOrgLogin: string,
  repo: string
): Promise<DeckThemeUrls | undefined> {
  if (!deck.theme.startsWith('shared:')) return undefined;
  const themeName = deck.theme.replace('shared:', '');
  try {
    const urls = await getThemeUrls(gitOrgLogin, repo, themeName);
    return {
      libCssUrl: urls.libCssUrl,
      customThemeUrl: urls.customThemeUrl,
      bodyClasses: urls.bodyClasses,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Could not resolve shared theme URLs for "${themeName}":`, message);
    return undefined;
  }
}

/**
 * Read-side theme URLs, signed when the delivery layer is on.
 *
 * `getThemeUrls` still does the work that needs GitHub — which lib CSS variant
 * exists, whether there is a custom-theme.css, what the manifest's bodyClasses
 * are. This only swaps the BASE those files hang off, from the content proxy to
 * the signed theme folder, keeping the exact filenames it resolved. Deriving
 * the filenames independently would silently downgrade a deck on `offline-v1`
 * to a 404, and would invent a custom-theme.css for themes that have none.
 */
export async function resolveDeliveryThemeUrls(
  deck: DeckJson,
  gitOrgLogin: string,
  repo: string,
  ctx: DeliveryContext
): Promise<DeckThemeUrls | undefined> {
  const base = await resolveReadThemeUrls(deck, gitOrgLogin, repo);
  if (!base || !ctx || !deck.theme.startsWith('shared:')) return base;

  const themeName = deck.theme.replace('shared:', '');
  const signedBase = await ClassmojiService.contentDelivery.resolveThemeBase(ctx, themeName);
  if (!signedBase) return base;

  const rebase = (url: string | null | undefined): string | null | undefined =>
    rebaseThemeRef(url, themeName, signedBase) ?? url;

  return {
    ...base,
    libCssUrl: rebase(base.libCssUrl),
    customThemeUrl: rebase(base.customThemeUrl),
  };
}
