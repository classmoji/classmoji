import { redirect } from 'react-router';
import { gitWeb } from '@classmoji/utils';
import {
  DOCUMENT_SAVE_MAX_BYTES,
  DOCUMENT_SAVE_MAX_LABEL,
  REPO_REST_MAX_BYTES,
  repoFileTooLargeMessage,
} from '@classmoji/utils/repo-limits';
import {
  ID_LIST_MAX_BYTES,
  MULTIPART_FORM,
  MULTIPART_OVERHEAD_BYTES,
  UploadTooLargeError,
  declaredBodyTooLarge,
  formMediaType,
  parseJsonWithin,
  readLimitedBody,
  readLimitedFormData,
  textOverBytes,
  uploadBodyLimit,
} from '@classmoji/utils/upload-limit';
import { OPS_MALFORMED_ANSWER, readCanonicalSaveOps } from '~/utils/saveOps.server.ts';
import { uploadRefusalStatus } from '@classmoji/services';
import { ClassmojiService, getAuthSession } from '~/utils/db.server.ts';
import { sessionReadFailed } from '~/utils/sessionRead.server.ts';
import { parseClientJson } from '~/utils/clientJson.server.ts';
import { markReported, reportError } from '@classmoji/utils/error-report';
import { recordAudit } from '~/utils/audit.server.ts';
import { pageMutationBlocked } from '~/utils/auth.server.ts';
import { findClassroomRole } from '~/utils/classroomRole.server.ts';
import {
  loadPageContent,
  savePageContent,
  savePageCoverImage,
  uploadPageAsset,
} from '~/utils/content.server.ts';
import {
  LEGACY_PAGE_WRITE_REFUSAL,
  LegacyPageFormatError,
  emptyPageDocument,
  legacyPageRule,
} from '~/utils/legacyPage.ts';
import { pageIsLegacyInGit } from '~/utils/legacyPage.server.ts';
import {
  UPLOAD_BUSY_MESSAGE,
  UPLOAD_RETRY_AFTER_SECONDS,
  acquireUploadSlot,
  releaseUploadSlot,
} from '@classmoji/utils/upload-concurrency';
import type { PageForContent } from '~/types/pages.ts';
import type { UploadCapability } from '@classmoji/services/media/router';
import {
  NO_SECTION_VIEWER,
  SECTION_NO_STORE_HEADERS,
  classroomOpenFor,
  documentForReader,
  impersonatorOf,
  isImpersonatedSession,
  readerSectionsFor,
  sectionStatsFor,
  signInUrlFor,
  type SectionReaderState,
} from '~/utils/pageSections.server.ts';
import {
  appLinkPolicy,
  buildReaderPayload,
  type ReaderClassroom,
  type ReaderViewer,
} from '~/utils/readerPayload.server.ts';
import type { ReaderPayload } from '~/utils/readerPayload.ts';
import { appScheduleHref, readerPayloadDeps } from '~/utils/readerDeps.server.ts';
import { ownFrameHosts } from '~/utils/frameHosts.server.ts';
import {
  assetResolveContext,
  canonicalizeAssetRef,
  canonicalizeDocumentAssets,
  canonicalizeOpsAssets,
  resolveDocumentAssets,
} from '~/utils/assetRefs.server.ts';
import type { CollabLoaderData } from '@classmoji/collab';
import { initialCheckpoint, isSaveVersionRequestId, type LiveCheckpoint } from '~/utils/collab.ts';
import {
  collabEditorData,
  fetchLiveSnapshot,
  liveEditingBlockedFor,
  readPageBookkeeping,
  liveEditingEnv,
  notifyPageMeta,
  notifyPreviewChanged,
  readEditorName,
  requestCheckpoint,
} from '~/utils/collab.server.ts';
import {
  acceptPreviewLive,
  normalizePageBlocks,
  previewBaseContent,
} from '~/utils/collabPreview.server.ts';
import {
  joinsLiveRoom,
  liveIntentRefusal,
  previewReviewedAsPage,
  versionNote,
} from '~/utils/liveGates.ts';
import {
  coverDiffers,
  previewBlockChanges,
  type PreviewChanges,
} from '~/components/preview/previewHighlight.ts';

/**
 * The most a JSON request to the page action may send.
 *
 * The largest one is a save, which carries the page's `content.json` (or the
 * ops that change it) — at most `DOCUMENT_SAVE_MAX_BYTES` — as a STRING inside
 * the JSON body. Escaping that string adds a backslash before every quote, and
 * BlockNote JSON is mostly quotes and short values, so the body is allowed
 * twice the document plus slack for the other fields.
 */
const PAGE_JSON_BODY_MAX_BYTES = 2 * DOCUMENT_SAVE_MAX_BYTES + MULTIPART_OVERHEAD_BYTES;

/**
 * What a person reads when a save is over that, or its document is. It is
 * sent with `tooLarge: true`, which is how the editor knows to show it.
 */
const PAGE_TOO_LARGE_MESSAGE = `This page is larger than the ${DOCUMENT_SAVE_MAX_LABEL} a page can hold.`;

/**
 * The JSON body, read through the byte-counting reader. Throws
 * `UploadTooLargeError` when it is over `PAGE_JSON_BODY_MAX_BYTES`, and the
 * parser's own error for anything that is not JSON.
 */
async function readPageJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (declaredBodyTooLarge(request.headers, PAGE_JSON_BODY_MAX_BYTES)) {
    throw new UploadTooLargeError(PAGE_JSON_BODY_MAX_BYTES);
  }
  if (!request.body) return (await request.json()) as Record<string, unknown>;
  const bytes = await readLimitedBody(request.body, PAGE_JSON_BODY_MAX_BYTES);
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

/**
 * The upload capability, or null when it cannot be worked out.
 *
 * Null is safe rather than silent: the editor then routes every file the way it
 * always has (to the repository, within its cap), and a file that belongs in
 * media is still redirected there by the repository route's own 409
 * `USE_MEDIA`. A lookup failure must not take the editor down with it.
 */
async function loadUploadCapability(page: {
  classroom: { id: string };
}): Promise<UploadCapability | null> {
  try {
    return await ClassmojiService.media.uploadCapabilityFor(
      page.classroom as Parameters<typeof ClassmojiService.media.uploadCapabilityFor>[0]
    );
  } catch (error) {
    console.warn('[pages] upload capability unavailable:', error);
    return null;
  }
}

/**
 * `Cache-Control: private, no-store` and `Vary: Cookie` on every response of
 * the page route, document and `.data` alike: the payload is per reader
 * (which locked bodies it holds, what they checked) behind a URL the whole
 * course shares. The action's own headers (a 503's `Retry-After`) are kept.
 */
export const headers = ({ actionHeaders }: { actionHeaders: Headers }) => {
  const merged = new Headers(actionHeaders);
  for (const [key, value] of Object.entries(SECTION_NO_STORE_HEADERS)) merged.set(key, value);
  return merged;
};

/** Extensions a page cover may have — the image half of the upload allowlist. */
const COVER_IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg)$/i;

/**
 * Public page viewer route - read-only view for students and public access.
 *
 * GET /:classroomSlug/:pageId — Public/Student viewer (no edit mode)
 */
export const loader = async ({
  params,
  request,
  url,
}: {
  params: Record<string, string | undefined>;
  request: Request;
  url: URL;
}) => {
  const classroomSlug = params.classroomSlug!;
  const pageId = params.pageId!;

  // Fetch page with classroom
  const page = await ClassmojiService.page.findById(pageId, {
    includeClassroom: true,
  });

  if (!page) {
    throw new Response('Page not found', { status: 404 });
  }

  // Verify classroom slug matches
  if (page.classroom.slug !== classroomSlug) {
    throw new Response('Page not found', { status: 404 });
  }

  // Check user auth and membership
  const authData = await getAuthSession(request).catch(sessionReadFailed);

  // ── Who this reader is (page sections included) ──────────────────────────
  // ONE membership read, the reader rule every surface shares
  // (`pageSections.sectionViewer`; the MCP tools read the same one), run
  // alongside this reader's OWN section state (page + user scoped; dropped
  // below unless they are an accepted member).
  //   - `role`: the highest of their roles here in any invite state, so an
  //     owner also enrolled as a student edits;
  //   - `canEditAnyState` (OWNER/TEACHER, any invite state) is `canEdit`, and
  //     with the accepted teaching team it is `revealAll`: every locked body.
  //     An editor must never receive a redacted document, or saving it would
  //     delete the bodies. Everyone else gets each body removed unless they
  //     unlocked it themselves.
  const [sectionViewer, sectionState] = authData?.userId
    ? await Promise.all([
        ClassmojiService.pageSections.sectionViewer({
          userId: authData.userId,
          classroomId: page.classroom.id,
        }),
        ClassmojiService.pageSections.readerState({
          pageId: page.id,
          userId: authData.userId,
        }) as Promise<SectionReaderState | null>,
      ])
    : [NO_SECTION_VIEWER, null];
  const userRole: string | null = sectionViewer.role;
  const canEdit = sectionViewer.canEditAnyState;
  const revealAll = sectionViewer.revealAll;

  // Draft pages: the teaching team in any invite state (the same rule as
  // `/api/page-sections` and the MCP tools). Locked bodies still follow revealAll.
  if (page.is_draft && !sectionViewer.canViewDrafts) {
    throw new Response('This page is not yet published', { status: 403 });
  }

  // For non-public pages, check if user is enrolled in the classroom
  if (!page.is_public && !userRole) {
    throw new Response('Page is not public', { status: 403 });
  }

  // Reader state follows the classroom ENTRY rule (archived keeps it, an
  // UNPUBLISHED classroom keeps it for its owner only), like the POST.
  const classroomOpen = classroomOpenFor({ status: page.classroom.status, viewer: sectionViewer });
  const readerSections = readerSectionsFor({
    signedIn: Boolean(authData?.userId),
    viewer: sectionViewer,
    impersonated: isImpersonatedSession(authData),
    classroomOpen,
    state: sectionState,
  });

  const pageForContent = page as unknown as PageForContent;

  // ── Preview branches (plan §3b) ────────────────────────────────────────────
  // `?preview=1` renders the singleton `preview/<content_path>` branch instead
  // of main. Staff-gated: non-staff viewers never pay the GitHub status call
  // and the param is silently ignored for them.
  const wantsPreview = url.searchParams.get('preview') === '1';
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
  // A live accept whose merge landed but whose preview branch could not be
  // deleted: still a success, with a note that the preview is still there.
  const noticePreviewKept =
    notice === 'preview-accepted' && url.searchParams.get('preview_kept') === '1';

  let previewStatus: {
    exists: boolean;
    commits_ahead?: number;
    oldest_commit_at?: string;
  } | null = null;
  if (canEdit) {
    try {
      previewStatus = await ClassmojiService.pageContent.getPreviewStatus(pageForContent);
    } catch (err) {
      // A GitHub hiccup must not 500 the page — degrade to "no preview".
      console.error('[pages] Failed to check preview status:', err);
      previewStatus = { exists: false };
    }
  }

  const previewBranch = ClassmojiService.pageContent.previewBranchName(page.content_path);
  const previewActive = Boolean(canEdit && wantsPreview && previewStatus?.exists);
  // Staff asked for a preview but no branch exists → render main with a notice.
  const previewMissing = Boolean(canEdit && wantsPreview && !previewStatus?.exists);

  // ── Live editing ─────────────────────────────────────────────────────────
  // A classroom with `collab_enabled` edits pages live: an editor joins the
  // page's room on the collab server and the document comes from there, not
  // from content.json. Only for someone who edits, not while a preview branch
  // is shown (a read-only render of git), and not while the classroom's
  // status makes this role read-only (`joinsLiveRoom`).
  //
  // Not for a page git holds as legacy HTML (utils/legacyPage.ts): collab
  // refuses its room, so the editor would only show that refusal. Whether it
  // is one is asked here first (the asset map, `pageIsLegacyInGit`) so such a
  // page never asks the room for a snapshot; it is decided below by git's own
  // read, which also catches a page the probe missed (the room refuses it, the
  // snapshot fails, and git is read instead).
  const liveEnv = canEdit ? liveEditingEnv(page.classroom) : null;
  const liveUserId =
    liveEnv &&
    authData?.userId &&
    joinsLiveRoom({
      canEdit,
      liveClassroom: true,
      signedIn: true,
      previewActive,
      mutationBlocked: Boolean(userRole && pageMutationBlocked(page.classroom, userRole)),
    })
      ? authData.userId
      : null;
  const [liveCollab, legacyProbe]: [CollabLoaderData | null, boolean] =
    liveEnv && liveUserId
      ? await Promise.all([
          collabEditorData({
            env: liveEnv,
            pageId: page.id,
            userId: liveUserId,
            userLogin: authData?.userLogin,
          }),
          pageIsLegacyInGit(page),
        ])
      : [null, false];

  // Live editing switched on but unreachable, with live edits not yet saved to
  // GitHub: the page opens read-only rather than in the git editor, whose
  // saves would fork the page from those edits.
  const liveUnavailable = canEdit && !liveEnv ? await liveEditingBlockedFor(page) : false;

  // Load content. This loader serves two surfaces, and they read differently.
  //
  // The EDITOR (canEdit, and any preview-branch read) goes to GitHub: this read
  // IS the edit surface — the editor mounts inline — and it seeds the save
  // conflict token, which must be the sha of the file on the branch being
  // written. `skipCache` for the same reason: the 60s per-process cache has no
  // cross-instance invalidation, so a cached read on another Fly instance could
  // silently revert an MCP write (4b parity with slides). It also keeps the
  // post-accept redirect (`?notice=preview-accepted`) from showing pre-accept
  // content under the success toast. Preview branches have no map rows at all,
  // which is the other reason this side cannot use the layer.
  //
  // The VIEWER reads by sha through the delivery layer, so a student sees a
  // save the moment it returns rather than up to a minute later, and a page
  // view costs no GitHub call.
  //
  // A LIVE editor gets its document from the room. The blocks are still read
  // here — from the live document, through the collab server — to sign the
  // URLs of the assets they reference and to render the page read-only until
  // the room has synced. If the collab server does not answer, git's copy
  // serves that purpose instead (the editor itself then shows it is offline).
  // A page the probe above takes for legacy HTML is read from git only.
  // The last checkpoint covering the page, for the header's "saved to GitHub"
  // line until the room's own messages take over.
  let liveCheckpoint: LiveCheckpoint | null = null;
  const readContent = async () => {
    if (liveCollab && liveEnv && !legacyProbe) {
      try {
        // Short: a collab server that does not answer must not hold up the
        // page; git's copy is good enough for resolving assets.
        const snapshot = await fetchLiveSnapshot(liveEnv, page.id, { timeoutMs: 3000 });
        const { lastCheckpointAt, lastCheckpointError } = snapshot as {
          lastCheckpointAt?: unknown;
          lastCheckpointError?: unknown;
        };
        // Read after the snapshot, which creates the buffer row on first open.
        liveCheckpoint = initialCheckpoint({
          lastCheckpointAt,
          lastCheckpointError,
          row: await readPageBookkeeping(page.id),
        });
        return {
          format: 'json' as const,
          content: Array.isArray(snapshot.content?.blocks) ? snapshot.content.blocks : [],
          coverImage: snapshot.content?.coverImage ?? null,
          sha: null,
          fromLiveRoom: true,
        };
      } catch (error) {
        console.warn('[pages] Live snapshot unavailable; resolving assets from git:', error);
      }
    }
    return loadPageContent(
      pageForContent,
      previewActive
        ? { ref: previewBranch, skipCache: true }
        : canEdit
          ? { skipCache: true }
          : { viaWorker: true }
    );
  };
  const read: Awaited<ReturnType<typeof loadPageContent>> & { fromLiveRoom?: boolean } =
    await readContent();
  const { format, content, coverImage: jsonCoverImage, sha: contentFileSha } = read;

  let viewerContent: unknown;

  if (format === 'json') {
    viewerContent = content;
  } else {
    // 'none': an empty page — and only that: 'none' means both files 404'd,
    // so an unreadable content repo rejects out of the loader to the error
    // boundary instead of rendering (and handing the editor) a live page as
    // blank. 'html': a legacy page git still holds as `index.html` only. It
    // is NOT converted here (utils/legacyPage.ts): the document is empty.
    viewerContent = emptyPageDocument();
  }

  // Legacy in git: decided by a read of git that returned the page as
  // `index.html` only, never by the probe alone (a probe that says legacy
  // while git has content.json keeps the live editor). Collab refuses such a
  // page's room, so a live room's answer always means content.json.
  const staff = canEdit || sectionViewer.canViewDrafts;
  const legacyInGit = staff && !read.fromLiveRoom && format === 'html';
  // One rule for the notice and the editor (utils/legacyPage.ts): staff get
  // "can't be shown", and nobody gets an editor, live or git: the live room is
  // refused and a git save would write the empty document over the page.
  const { notice: legacyNotice, readOnly: legacyReadOnly } = legacyPageRule({
    legacyInGit,
    staff,
    canEdit,
  });
  const collab: CollabLoaderData | null = legacyReadOnly ? null : liveCollab;

  // The shared reader (`PageReader`) or an editor: exactly the client's split
  // (route.tsx's `canEdit` is `canEdit && !preview && !liveUnavailable &&
  // !legacyReadOnly`). Every path that renders the reader gets its payload
  // from `buildReaderPayload`; the editors keep the document below, which is
  // NEVER link-redacted (a save would drop the links it removed).
  const readerShown = !canEdit || previewActive || liveUnavailable || legacyReadOnly;

  // Locked bodies this reader may not see leave the document HERE, before
  // anything is derived from it: the editor's asset maps, the staff chip
  // counts and the preview highlights all read `viewerContent` from now on.
  // Non-mutating (the content read may be a shared cache entry). Editors
  // (canEdit: live, git and preview paths alike) and the teaching team keep
  // the whole document. The reader payload runs the same rule itself.
  viewerContent = documentForReader(viewerContent, {
    revealAll,
    unlocked: readerSections.unlocked,
  });

  // Staff chip counts: accepted OWNER/TEACHER (`canSeeActivity`, the people
  // the staff lists answer), current students only: unlocks when the document
  // has a locked section, ticks when it has a checkable heading (each read
  // only when needed, in parallel). The page row is already verified, so the
  // service does not re-read it. Started here, awaited with the payload.
  const statsPage = { id: page.id, classroom_id: page.classroom_id };
  const sectionStatsPending =
    sectionViewer.canSeeActivity && classroomOpen
      ? sectionStatsFor(viewerContent, {
          unlockCounts: () => ClassmojiService.pageSections.unlockCounts({ page: statsPage }),
          checkCounts: () => ClassmojiService.pageSections.checkCounts({ page: statsPage }),
        })
      : null;
  // Its failure surfaces where it is awaited, never as an unhandled rejection
  // if something in between throws first.
  sectionStatsPending?.catch(() => {});

  // The viewer the reader payload is built for: exactly the reader rule read
  // above (any invite state, as this loader has always read it), with this
  // reader's own section state. Null for a signed-out visitor.
  const readerViewer: ReaderViewer | null = authData?.userId
    ? {
        userId: authData.userId,
        access: sectionViewer,
        readerSections,
        impersonated: isImpersonatedSession(authData),
      }
    : null;

  // Page comments in an EDITOR (`readerComments`): open-thread counts for a
  // signed-in accepted member who may read this page's comments (the
  // service's `commentAccess`). The reader's come with its payload, from the
  // same function. Read from the stored blocks (the service redacts them for
  // this reader), the document `/api/page-comments` anchors against: a legacy
  // HTML page has no stored block ids, so it counts page-level only. Absent
  // for everyone else; a failed count leaves the key out. Started here,
  // awaited with the payload.
  const editorCommentsPending =
    !readerShown && readerViewer && sectionViewer.acceptedRole !== null && !previewActive
      ? readerPayloadDeps
          .readerComments({
            userId: readerViewer.userId,
            viewer: sectionViewer,
            page,
            classroom: page.classroom,
            blocks: format === 'json' && Array.isArray(content) ? content : [],
            unlockedSectionIds: Object.keys(readerSections.unlocked),
            impersonated: readerViewer.impersonated,
          })
          .catch(error => {
            console.warn('[pages] comment counts unavailable:', error);
            return undefined;
          })
      : undefined;

  // Which blocks the pending preview adds or edits — the changes the preview
  // makes, against the page as it was when the preview started (its
  // merge-base). The rendered preview highlights them; there is no diff view.
  // Live-edited classrooms only (`reviewPreviewAsPage`, the same predicate
  // that drops the diff link below): everyone else's preview renders as before.
  const reviewPreviewAsPage = previewReviewedAsPage(page.classroom);
  let previewChanges: PreviewChanges | null = null;
  if (previewActive && Array.isArray(viewerContent) && reviewPreviewAsPage) {
    const base = await previewBaseContent({ ...pageForContent, id: page.id });
    if (base) {
      previewChanges = {
        ...previewBlockChanges(base.blocks, normalizePageBlocks(viewerContent)),
        coverChanged: coverDiffers(base.coverImage, jsonCoverImage ?? null),
      };
    }
  }

  // Cover image: prefer JSON metadata, fall back to DB columns (legacy pages)
  const coverImage =
    jsonCoverImage ||
    (page.header_image_url
      ? { url: page.header_image_url, position: page.header_image_position ?? 50 }
      : null);

  // Render-time URL resolution: the blocks keep their stored references and the
  // client gets a parallel `ref → signed URL` map. The lifetime is per-VIEWER
  // and per-PAGE — an editor (or an explicit preview) gets short-lived `edit`
  // URLs, a reader gets `month` on a public page and `week` otherwise — which
  // is exactly why the URL cannot live in the block.
  //
  // `page.is_public` is passed because visibility, not surface, decides the
  // lifetime: this same page rendered on the class site is the same file with
  // the same readers, and used to be minted on a different bucket purely
  // because it came through a different door.
  //
  // `previewActive`, not `wantsPreview`: the raw query param is attacker-supplied
  // and is only honoured for staff. Passing it straight through would let an
  // anonymous visitor mint `edit`-tier URLs by appending `?preview=1`.
  const resolveTier = ClassmojiService.contentDelivery.tierFor({
    canEdit,
    preview: previewActive,
    isPublic: page.is_public,
  });

  // The reader: its document, URL maps, download map, links, section state and
  // comments, all from the document as it ships (readerPayload.server.ts).
  //
  // Download buttons only where this view drew them before: the viewer of a
  // reader, or staff on a preview — the editor draws none, and a staff member
  // shown the page read-only for another reason (live editing unreachable, a
  // legacy page) gets none either (`viewerShown`).
  const viewerShown = !canEdit || previewActive;
  // Our own hosts for the frame rule: the reader's payload and the editors'
  // blocks read the same list.
  const frameHosts = ownFrameHosts();
  const reader: ReaderPayload | null = readerShown
    ? await buildReaderPayload(
        {
          // The read itself: the builder strips locked bodies on its own.
          content: { blocks: content, cover: jsonCoverImage, format },
          page,
          classroom: page.classroom as unknown as ReaderClassroom,
          viewer: readerViewer,
          frameHosts,
          options: {
            tier: resolveTier,
            previewActive,
            surface: 'app',
            offerDownloads: viewerShown,
          },
          // A signed-out reader's way in: each locked section links here.
          signInUrl: () => signInUrlFor(url.href),
          links: appLinkPolicy(page.classroom.slug),
          scheduleHref: () => appScheduleHref(page.classroom),
        },
        readerPayloadDeps
      )
    : null;

  // The editors' URL maps. ONE pass for both. Two sequential resolves read the
  // clock twice, and an expiry that moves between the two reads mints a
  // different `src` for the same file — at which point every candidate list is
  // thrown away, because the pairing is by string equality. On `edit` the
  // expiry is an exact `now + 4h`, so it moves on EVERY tick. The cover is in
  // the ref list for its display URL; it does not need candidates, because
  // `HeaderImage` renders it as a CSS background, where `srcset` means nothing.
  const assetCtx = assetResolveContext(
    page.classroom as unknown as Parameters<typeof assetResolveContext>[0],
    resolveTier
  );
  const { assets: resolvedAssets, srcSets: resolvedSrcSets } = reader
    ? { assets: {}, srcSets: {} }
    : await resolveDocumentAssets(assetCtx, viewerContent, [coverImage?.url]);

  // Where this editor's uploads go (`storageTargetFor` on the client): the
  // repository, media, or a refusal it can state before a byte is sent. Staff
  // who can edit only — a reader never uploads, and the capability carries the
  // classroom's remaining media quota. Not in read-only preview either.
  const uploadCapability = canEdit && !previewActive ? await loadUploadCapability(page) : null;

  // Build GitHub repo info for link
  const gitOrg = (page.classroom as Record<string, unknown>).git_organization as {
    login?: string;
    avatar_url?: string;
    provider?: string;
    base_url?: string | null;
  } | null;
  // Content repo is STORED and user-editable — never re-derived from the namespace.
  const contentRepo = page.classroom.content_repo;
  const repoName = contentRepo && gitOrg?.login ? contentRepo : null;

  // The provider's own diff UI for the pending preview (branch segment
  // URL-encoded — preview branch names contain slashes).
  //
  // Not for a live-edited classroom: a preview there is reviewed as the
  // rendered page with its changes highlighted, never as a diff.
  const diffUrl =
    !reviewPreviewAsPage && gitOrg?.login && repoName
      ? gitWeb({
          provider: gitOrg.provider,
          login: gitOrg.login,
          base_url: gitOrg.base_url,
          git_namespace: (page.classroom as { git_namespace?: string | null }).git_namespace,
        }).contentCompare(repoName, 'main', previewBranch)
      : null;

  const readerComments = editorCommentsPending ? await editorCommentsPending : undefined;

  // "View as": a platform admin reading another user's state on this page
  // (their ticks and unlocks ship with it whenever that user is an accepted
  // member). One VIEW row per load that got this far (a document load, and
  // each revalidation, which loads the state again), as `/api/page-reader`
  // writes on the class site; a user loading their own page writes nothing.
  // A HEAD shows no one anything. A failed log line must not fail the page:
  // it is reported (`audit_miss`) and the page loads.
  const viewingAsUserId = isImpersonatedSession(authData) ? authData?.userId : null;
  if (viewingAsUserId && readerSections.member && request.method !== 'HEAD') {
    await recordAudit(
      {
        user_id: viewingAsUserId,
        classroom_id: page.classroom.id,
        role: sectionViewer.acceptedRole as string,
        resource_type: 'PAGES',
        resource_id: page.id,
        action: 'VIEW',
        data: { tool: 'page_reader', via: 'web', page_id: page.id },
      },
      { impersonatedBy: impersonatorOf(authData) }
    );
  }

  return {
    page: {
      id: page.id,
      title: page.title,
      slug: page.slug,
      width: page.width,
      is_draft: page.is_draft,
      is_public: page.is_public,
      content_path: page.content_path,
    },
    classroom: {
      id: page.classroom.id,
      name: page.classroom.name,
      slug: page.classroom.slug,
      avatar_url: (page.classroom as Record<string, unknown>).avatar_url as string | undefined,
      git_organization: gitOrg
        ? {
            login: gitOrg.login,
            repo: repoName,
            avatar_url: gitOrg.avatar_url,
            provider: gitOrg.provider ?? 'GITHUB',
            // The raw content.json holds every locked body: only for readers
            // who see them all anyway.
            source_url:
              revealAll && repoName
                ? gitWeb({
                    provider: gitOrg.provider,
                    login: gitOrg.login,
                    base_url: gitOrg.base_url,
                    git_namespace: (page.classroom as { git_namespace?: string | null })
                      .git_namespace,
                  }).contentFile(repoName, 'main', `${page.content_path}/content.json`)
                : null,
          }
        : null,
    },
    // The shared reader's payload (`buildReaderPayload`) on every path that
    // renders `PageReader`; null for the editors.
    reader,
    // Our own hosts, for the EDITORS' embed and video blocks (the reader's
    // are in its payload): the same frame rule as readers get.
    frameHosts,
    // The EDITORS' document (never link-redacted: a save would drop what
    // redaction removed). A live editor renders it read-only until its room
    // has synced; the editable document then comes from the room, never from
    // here. Null when the reader is shown (its document is `reader.content`).
    content: reader ? null : viewerContent,
    coverImage: reader ? null : coverImage,
    // Live editing: the room to join, or null for the git editor / a reader.
    collab,
    // Assigned inside `readContent`, which TypeScript's narrowing does not follow.
    liveCheckpoint: liveCheckpoint as LiveCheckpoint | null,
    liveUnavailable,
    // On a page git still holds as legacy HTML (utils/legacyPage.ts): whether
    // this viewer (staff) gets the "can't be shown" notice, and whether the
    // editor (live or git) is withheld. False for everyone else.
    legacyNotice,
    legacyReadOnly,
    // The preview's added/edited block ids and removed count (preview only).
    previewChanges,
    // The editors' display map: `{ storedRef: signedUrl }`. Absent keys mean
    // "use the ref as-is" (an external image, or the delivery layer switched
    // off). The reader's is `reader.assets`.
    resolvedAssets,
    // Also display-only, and keyed the SAME way — `{ storedRef: srcset }` —
    // because the consumer is the image block, which holds the stored reference
    // and would otherwise have to reproduce a signature to find its own entry.
    // An absent key means "one size only", which is the right answer for a gif,
    // an svg, and anything that is not an image.
    resolvedSrcSets,
    // This reader's own checks and unlocks, and what they may do (see
    // `readerSectionsFor`); the same object the reader payload carries.
    // Never anyone else's rows.
    readerSections,
    // `{ students, unlocks: { blockId: count }, checks: { blockId: count } }`
    // for the staff chips; accepted OWNER/TEACHER only (the same readers the
    // staff lists answer). Null for everyone else, and for a page with no
    // locked section and no checkable heading.
    sectionStats: sectionStatsPending ? await sectionStatsPending : null,
    // The EDITORS' comments: `{ counts, pageLevel, open, canWrite, canResolve,
    // frozen }` for a signed-in accepted member (`readerCommentsFor`); the key
    // is ABSENT for everyone else, never null (the reader's are in
    // `reader.readerComments`, under the same rule). Threads load lazily from
    // `/api/page-comments`.
    ...(readerComments ? { readerComments } : {}),
    userRole,
    canEdit,
    uploadCapability,
    notice,
    noticeAutoMerged,
    noticePreviewKept,
    // Conflict token (F2, 4b parity with slides): content.json's blob sha,
    // echoed back by the editor on every save so the action can 409 instead
    // of clobbering a concurrent write. null = no content.json yet (fresh or
    // legacy-HTML page) → the first save creates it without a precondition.
    // Editor-only: null for non-editors and in read-only preview mode.
    contentSha: canEdit && !previewActive && !collab && format === 'json' ? contentFileSha : null,
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

interface PageActionArgs {
  params: Record<string, string | undefined>;
  request: Request;
}

/**
 * Actions for page mutations (edit mode only).
 *
 * The cover upload takes an upload slot partway through `pageAction` — after
 * the gates, before its body is read — and this is where it is given back,
 * whichever way the action ends.
 */
export const action = async (args: PageActionArgs) => {
  const slot = { held: false };
  try {
    return await pageAction(args, slot);
  } finally {
    if (slot.held) releaseUploadSlot();
  }
};

/**
 * Report an editor action that failed for a reason the editor cannot fix (the
 * generic 5xx below each intent), beside its log line. `intent` is one of the
 * names this action handles, never the posted value.
 */
const reportActionFailure = (error: unknown, intent: string, pageId: string) =>
  reportError(error, { surface: 'pages.page_action', tags: { intent, page_id: pageId } });

async function pageAction({ params, request }: PageActionArgs, slot: { held: boolean }) {
  const pageId = params.pageId!;

  const page = await ClassmojiService.page.findById(pageId, {
    includeClassroom: true,
  });

  if (!page) {
    return Response.json({ error: 'Page not found' }, { status: 404 });
  }

  const actionPage = page as unknown as PageForContent;

  // Save-side asset context. The tier is irrelevant to canonicalization (it
  // only ever turns a signed URL back into a path) but the context type carries
  // one; 'edit' names the only tier a writer can be in.
  const actionAssetCtx = assetResolveContext(
    page.classroom as unknown as Parameters<typeof assetResolveContext>[0],
    'edit'
  );

  // Check if user can edit
  const authData = await getAuthSession(request).catch(sessionReadFailed);
  if (!authData?.userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // The same role the loader read, so a page it opened for editing saves.
  const role = await findClassroomRole({
    userId: authData.userId,
    classroomId: page.classroom.id,
  });

  if (!role || !['OWNER', 'TEACHER'].includes(role)) {
    return Response.json({ error: 'Unauthorized' }, { status: 403 });
  }

  // SEC4: every intent this action handles mutates (GitHub content, preview
  // branches, or page rows) — enforce the platform-wide classroom status gate
  // (owners always may mutate; LOCKED/UNPUBLISHED are read-only for others).
  const blocked = pageMutationBlocked(page.classroom, role);
  if (blocked) return blocked;

  // Support both JSON and multipart form data (for file uploads). The media
  // type is read the way `readLimitedFormData` reads it, so the upload limit
  // goes only to a body that is parsed as multipart.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- form/JSON data has dynamic shape
  let data: Record<string, any>, formData: FormData | undefined;
  if (formMediaType(request.headers.get('content-type')) === MULTIPART_FORM) {
    // The one multipart intent is the cover upload: it takes an upload slot
    // like every other file upload in this app (released by `action`).
    if (!acquireUploadSlot()) {
      return Response.json(
        { error: UPLOAD_BUSY_MESSAGE },
        { status: 503, headers: { 'Retry-After': String(UPLOAD_RETRY_AFTER_SECONDS) } }
      );
    }
    slot.held = true;

    // Read only now — after the session, the membership and the status gate
    // above — and through a byte-counting reader: the one multipart intent is
    // the cover upload, which carries one repository-sized file at most.
    try {
      formData = await readLimitedFormData(request, uploadBodyLimit(REPO_REST_MAX_BYTES));
    } catch (error: unknown) {
      if (error instanceof UploadTooLargeError) {
        return Response.json({ error: repoFileTooLargeMessage() }, { status: 413 });
      }
      throw error;
    }
    data = { intent: formData.get('intent') };
  } else {
    // Read capped, and only now, after the same gates. See PAGE_JSON_BODY_MAX_BYTES.
    try {
      data = await readPageJsonBody(request);
    } catch (error: unknown) {
      if (error instanceof UploadTooLargeError) {
        return Response.json({ error: PAGE_TOO_LARGE_MESSAGE, tooLarge: true }, { status: 413 });
      }
      // A body that is not JSON is the client's, not a fault (and its message
      // quotes what was sent): thrown as before, never reported.
      if (error instanceof SyntaxError) markReported(error);
      throw error;
    }
  }
  const { intent } = data;

  // ── Live editing ───────────────────────────────────────────────────────────
  // In a live-edited classroom the git worker is the only writer of
  // content.json. Every intent that would write it from here is refused —
  // the loader never hands out these paths for such a page, so this only
  // meets a tab opened before the classroom switched over (or a stray post).
  const liveEnv = liveEditingEnv(page.classroom);
  const refusal = liveIntentRefusal(
    intent,
    Boolean(liveEnv),
    !liveEnv && (await liveEditingBlockedFor(page))
  );
  if (refusal) return Response.json(refusal.body, { status: refusal.status });

  if (intent === 'save-version') {
    if (!liveEnv) return Response.json({ error: 'Invalid action' }, { status: 400 });
    try {
      const name = await readEditorName(authData.userId, authData.userLogin);
      const requestId = isSaveVersionRequestId(data.requestId) ? data.requestId : undefined;
      const answer = await requestCheckpoint(
        liveEnv,
        pageId,
        { userId: authData.userId, name },
        versionNote(data.message),
        requestId
      );
      // Only the id this browser sent is echoed: the page settles the request
      // on the checkpoint message naming it.
      const echoed = requestId && answer?.requestId === requestId ? requestId : undefined;
      return Response.json({
        success: true,
        savedVersion: true,
        ...(echoed ? { requestId: echoed } : {}),
        ...(echoed && answer?.alreadySaved === true ? { alreadySaved: true } : {}),
      });
    } catch (error: unknown) {
      console.error('[pages] Save version failed:', error);
      reportActionFailure(error, 'save-version', page.id);
      return Response.json(
        { error: 'The version could not be saved. Try again.' },
        { status: 502 }
      );
    }
  }

  if (liveEnv && intent === 'preview-accept') {
    try {
      const name = await readEditorName(authData.userId, authData.userLogin);
      let resolutions: Array<{ id?: unknown; choose?: unknown }> | null = null;
      if (data.resolutions != null) {
        try {
          const parsed =
            typeof data.resolutions === 'string'
              ? parseJsonWithin(data.resolutions, ID_LIST_MAX_BYTES)
              : data.resolutions;
          if (Array.isArray(parsed)) resolutions = parsed;
        } catch {
          return Response.json(
            { error: 'Malformed resolutions payload — expected [{id, choose}]' },
            { status: 400 }
          );
        }
      }
      const result = await acceptPreviewLive({
        page: { ...actionPage, id: page.id },
        env: liveEnv,
        actor: { userId: authData.userId, name },
        resolutions,
      });
      if (result.merged) {
        // Every other open editor drops its "pending preview" banner.
        await notifyPreviewChanged(liveEnv, pageId);
        const keptParam = result.previewKept ? '&preview_kept=1' : '';
        return redirect(`/${page.classroom.slug}/${pageId}?notice=preview-accepted${keptParam}`);
      }
      if (result.conflict) {
        // The chooser's shape; its picks come back as `resolutions` and are
        // matched against a fresh merge on the collab server.
        return Response.json(
          {
            conflict: true,
            units: result.units,
            unitPreviews: result.unitPreviews,
            autoMerged: 0,
          },
          { status: 409 }
        );
      }
      return Response.json({ error: result.error }, { status: result.status });
    } catch (error: unknown) {
      console.error('[pages] Live preview accept failed:', error);
      reportActionFailure(error, 'preview-accept', page.id);
      return Response.json(
        { error: 'The preview could not be merged into the live page. Try again.' },
        { status: 502 }
      );
    }
  }

  if (intent === 'save') {
    // Phase 7.5: a save-conflict chooser re-submit carries the SAME posted
    // content plus one {id, choose} per conflict and the report's ours_sha pin.
    let saveResolutions: { id: string; choose: 'ours' | 'theirs' }[] | null = null;
    if (data.resolutions != null) {
      try {
        const parsed =
          typeof data.resolutions === 'string'
            ? parseJsonWithin(data.resolutions, ID_LIST_MAX_BYTES)
            : data.resolutions;
        if (!Array.isArray(parsed) || parsed.length === 0) {
          throw new Error('resolutions must be a non-empty array');
        }
        saveResolutions = parsed;
      } catch {
        return Response.json(
          { error: 'Malformed resolutions payload — expected [{id, choose}]' },
          { status: 400 }
        );
      }
    }
    const saveOursSha =
      typeof data.ours_sha === 'string' && data.ours_sha ? data.ours_sha : undefined;

    // Ops save: the client posts a block-op diff against the document at
    // base_sha instead of the whole document (untouched blocks never
    // transmit). Presence of `ops` selects the path. The ops are counted
    // before they are parsed, then validated against the service's
    // single-source zod schema (op cap 400), so ops that are too large or
    // malformed (or a check that throws) are a typed 400 the client recovers
    // from by falling back to a full-document save — never a raw TypeError →
    // 500 (plan §7 P8).
    //
    // Defense in depth: the same read strips any signed URL back to its repo
    // path BEFORE it can be committed. An ops save carries only the blocks
    // that changed — which is exactly where a just-uploaded image's display
    // URL would be. A pass that throws takes the same 400.
    let saveOps: unknown[] | null = null;
    if (data.ops != null) {
      saveOps = await readCanonicalSaveOps(
        data.ops,
        ClassmojiService.pageContent.pageBlockOpsPayloadSchema,
        ops => canonicalizeOpsAssets(actionAssetCtx, ops)
      );
      if (!saveOps) return Response.json(OPS_MALFORMED_ANSWER, { status: 400 });
    }

    try {
      // F2 (4b parity with slides): optimistic-lock the write on the
      // content.json sha the editor loaded (loader / previous save response).
      const expectedSha =
        typeof data.content_sha === 'string' && data.content_sha ? data.content_sha : null;

      // Conflict report → 409 the chooser renders (the client re-submits the
      // same content/ops + resolutions + the report's ours_sha).
      const mergeReport = (report: { units: unknown; auto_merged: number; ours_sha: string }) =>
        Response.json(
          {
            conflict: true,
            units: report.units,
            autoMerged: report.auto_merged,
            oursSha: report.ours_sha,
          },
          { status: 409 }
        );

      let sha: string;
      let mergedWithConcurrent = 0;
      // The merged blocks as committed. The editor must adopt this document —
      // its local copy lacks the folded-in concurrent changes, and a fresh
      // token over a stale document would clobber them on the NEXT save.
      let mergedDocument: unknown[] | null = null;

      if (saveOps) {
        // ── Ops save ──────────────────────────────────────────────────────
        // base = the document at base_sha (the conflict token the diff was
        // computed against); the service materializes theirs = base + ops and
        // runs the SAME merge/report/resolutions machinery as the whole-doc
        // path. `document` is null when the commit is exactly base + ops —
        // no adoption/remount needed for a clean save.
        const baseSha =
          typeof data.base_sha === 'string' && data.base_sha ? data.base_sha : expectedSha;
        if (!baseSha) {
          // No base to replay against (fresh/legacy page has no token) — the
          // OPS_BASE_MISMATCH code tells the client to fall back to one
          // whole-document save.
          return Response.json(
            { error: 'An ops save requires base_sha', code: 'OPS_BASE_MISMATCH' },
            { status: 409 }
          );
        }
        const mergeResult = await ClassmojiService.pageContent.savePageContentFromOps(actionPage, {
          ops: saveOps as Parameters<
            typeof ClassmojiService.pageContent.savePageContentFromOps
          >[1]['ops'],
          baseSha,
          ...(saveResolutions ? { resolutions: saveResolutions } : {}),
          ...(saveOursSha ? { expectedOursSha: saveOursSha } : {}),
          // No message override: a genuine fold-in or a resolution pass is
          // recorded distinctly by the service ("(merged)" / resolution
          // summary); a clean ops save keeps the plain message (plan
          // "commit-message" finding).
        });
        if (!mergeResult.merged) return mergeReport(mergeResult);
        sha = mergeResult.sha;
        mergedWithConcurrent = mergeResult.concurrent;
        mergedDocument = mergeResult.document;
      } else {
        // ── Whole-document save (7.5 path) ────────────────────────────────
        // The document is counted before it is parsed.
        if (
          typeof data.content === 'string' &&
          textOverBytes(data.content, DOCUMENT_SAVE_MAX_BYTES)
        ) {
          return Response.json({ error: PAGE_TOO_LARGE_MESSAGE, tooLarge: true }, { status: 413 });
        }
        const blocks = await canonicalizeDocumentAssets(
          actionAssetCtx,
          parseClientJson(data.content as string)
        );

        if (!expectedSha) {
          // Token-less save. Legit only when content.json doesn't exist yet
          // (fresh or legacy-HTML page — the loader handed out a null token).
          // If the file EXISTS, this is a stale pre-token client bundle (or the
          // file appeared since the editor loaded, e.g. an MCP apply): reject
          // rather than silently clobber. Fresh existence check — the 60s cache
          // must not vouch for absence, and neither may an unreadable repo: a
          // read that fails rejects here and the save never runs.
          const existing = await loadPageContent(actionPage, { skipCache: true });
          if (existing.format === 'json') {
            return Response.json(
              { conflict: true, message: 'This page changed since you opened it.' },
              { status: 409 }
            );
          }
          // A legacy page (index.html only): the editor was handed an EMPTY
          // document for it (it is no longer converted on read), so saving
          // would write that over the page's content. Never, whatever the
          // client posted (utils/legacyPage.ts).
          if (existing.format === 'html') {
            return Response.json({ error: LEGACY_PAGE_WRITE_REFUSAL }, { status: 422 });
          }
        }

        // Semantic save-merge (Phase 7.5): the token IS the 3-way base — a
        // stale save merges against fresh main instead of refusing outright.
        const runMergeSave = () =>
          ClassmojiService.pageContent.savePageContentWithMerge(actionPage, blocks, {
            baseSha: expectedSha as string,
            ...(saveResolutions ? { resolutions: saveResolutions } : {}),
            ...(saveOursSha ? { expectedOursSha: saveOursSha } : {}),
            // No message override — the service records a merged/resolution
            // commit distinctly; a clean save keeps the plain message (plan
            // "commit-message" finding).
          });

        if (saveResolutions && expectedSha) {
          // Resolution pass: the token is known-stale — go straight to the 3-way.
          const mergeResult = await runMergeSave();
          if (!mergeResult.merged) return mergeReport(mergeResult);
          sha = mergeResult.sha;
          mergedWithConcurrent = mergeResult.concurrent;
          mergedDocument = mergeResult.document;
        } else {
          try {
            const saved = await savePageContent(actionPage, blocks, {
              ...(expectedSha ? { expectedSha } : {}),
            });
            sha = saved.sha;
          } catch (error: unknown) {
            if ((error as { status?: number } | null)?.status !== 409 || !expectedSha) throw error;
            // Stale token → the semantic 3-way merge instead of a blank refusal.
            const mergeResult = await runMergeSave();
            if (!mergeResult.merged) return mergeReport(mergeResult);
            sha = mergeResult.sha;
            mergedWithConcurrent = mergeResult.concurrent;
            mergedDocument = mergeResult.document;
          }
        }
      }

      await ClassmojiService.page.quickUpdate(pageId, {
        updated_at: new Date(),
      });
      // Return the new sha — the editor's conflict token for its next save.
      // A merged save also returns the committed document + the concurrent
      // count (the editor adopts the document and toasts the count).
      // A merged document is one the editor has never seen — it carries stored
      // refs for blocks folded in from main, and the client's display map has
      // no entry for them. Resolve alongside it or those images render broken.
      const merged = mergedDocument
        ? await resolveDocumentAssets(actionAssetCtx, mergedDocument)
        : null;

      return Response.json({
        success: true,
        sha,
        ...(mergedDocument
          ? {
              merged_with_concurrent: mergedWithConcurrent,
              merged_content: mergedDocument,
              resolved_assets: merged?.assets ?? null,
              // The folded-in blocks need candidates too, or every image the
              // merge brought in paints at full size until the next load.
              resolved_src_sets: merged?.srcSets ?? null,
            }
          : {}),
      });
    } catch (error: unknown) {
      if (error instanceof ClassmojiService.pageContent.PageOpsBaseMismatchError) {
        // The posted ops don't apply to the document at base_sha (the client
        // diffed against something else, or sent a malformed op). The code
        // tells the client to auto-fall-back to ONE whole-document save of
        // its current content. Checked BEFORE the generic 409 handler — this
        // error carries status 409 but must not render the reload banner.
        return Response.json({ error: error.message, code: error.code }, { status: 409 });
      }
      if (error instanceof ClassmojiService.pageContent.PreviewResolutionError) {
        // Stale resolution pin (main moved after the reviewed report) → 409;
        // bad/stale resolutions → 400 naming the ids. Either way the client
        // re-runs the plain save for a fresh report.
        if (error.code === 'CONTENT_CONFLICT') {
          return Response.json({ error: error.message, code: error.code }, { status: 409 });
        }
        return Response.json(
          { error: error.message, code: error.code, ids: error.ids },
          { status: 400 }
        );
      }
      if ((error as { status?: number } | null)?.status === 409) {
        // No mergeable path (token-less over existing content, unreadable
        // base, main's file gone, or a double CAS loss). Nothing was written.
        return Response.json(
          { conflict: true, message: 'This page changed since you opened it.' },
          { status: 409 }
        );
      }
      console.error('Failed to save page:', error);
      reportActionFailure(error, 'save', page.id);
      return Response.json(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      );
    }
  }

  // ── Preview lifecycle (plan §3b) ───────────────────────────────────────────
  // Staff-gated by the shared canEdit check above (same gate as every edit
  // intent). Accept merges the preview branch into main; discard deletes it.

  if (intent === 'preview-accept') {
    // Chooser resolutions (Phase 7): when present, this accept is a conflict
    // resolution pass — one {id, choose: 'ours'|'theirs'} per currently
    // conflicted unit; the resolved merge is committed to main. Element-shape
    // validation (non-empty string id, choose ∈ ours|theirs) lives in the
    // service's indexResolutions, so malformed choices throw
    // PreviewResolutionError (→ 400 below) instead of defaulting to a side.
    let resolutions: { id: string; choose: 'ours' | 'theirs' }[] | null = null;
    if (data.resolutions != null) {
      try {
        const parsed =
          typeof data.resolutions === 'string'
            ? parseJsonWithin(data.resolutions, ID_LIST_MAX_BYTES)
            : data.resolutions;
        if (!Array.isArray(parsed) || parsed.length === 0) {
          throw new Error('resolutions must be a non-empty array');
        }
        resolutions = parsed;
      } catch {
        return Response.json(
          { error: 'Malformed resolutions payload — expected [{id, choose}]' },
          { status: 400 }
        );
      }
    }
    // Sha pins (F3): the chooser posts back the ours_sha it rendered its
    // conflict report from, so the resolve fails cleanly (CONTENT_CONFLICT)
    // if the live page moved after the report was reviewed.
    const expectedOursSha =
      typeof data.ours_sha === 'string' && data.ours_sha ? data.ours_sha : undefined;
    const expectedTheirsSha =
      typeof data.theirs_sha === 'string' && data.theirs_sha ? data.theirs_sha : undefined;

    try {
      const result = resolutions
        ? await ClassmojiService.pageContent.resolvePreviewConflicts(actionPage, {
            resolutions,
            ...(expectedOursSha ? { expectedOursSha } : {}),
            ...(expectedTheirsSha ? { expectedTheirsSha } : {}),
          })
        : await ClassmojiService.pageContent.acceptPreview(actionPage);
      if (result.merged) {
        // Settle guard: GitHub's Contents API lags a merge by ~1-2s, so an
        // immediate redirect can render pre-accept content under an
        // "accepted" toast (with a stale pending-preview banner to match).
        // We know the merged sha — wait (bounded) until reads serve it.
        if (result.sha) {
          for (let attempt = 0; attempt < 5; attempt++) {
            let fresh;
            try {
              fresh = await ClassmojiService.pageContent.loadPageContent(actionPage, {
                skipCache: true,
              });
            } catch (err) {
              // The merge is already committed and this read only decides how
              // long to wait before redirecting. A repo we cannot read here
              // must not turn an accept that SUCCEEDED into an error response.
              console.error('[pages] Settle check failed after preview accept:', err);
              reportError(err, { surface: 'pages.preview_settle', tags: { page_id: page.id } });
              break;
            }
            if (fresh.sha === result.sha) break;
            await new Promise(r => setTimeout(r, 700));
          }
        }
        // Surface the semantic layer's auto-merged count in the success toast.
        const autoMerged = ('auto_merged' in result && result.auto_merged) || 0;
        const autoParam = autoMerged > 0 ? `&auto_merged=${autoMerged}` : '';
        return redirect(`/${page.classroom.slug}/${pageId}?notice=preview-accepted${autoParam}`);
      }
      // Merge conflict — nothing merged, branch kept. Surface the per-unit
      // report (plus the auto-merged count and the shas the report was built
      // from — the chooser posts them back with its resolutions) so the
      // chooser can render it.
      return Response.json(
        {
          conflict: true,
          units: result.units,
          unitPreviews: result.unit_previews ?? null,
          autoMerged: result.auto_merged,
          oursSha: result.ours_sha,
          theirsSha: result.theirs_sha,
        },
        { status: 409 }
      );
    } catch (error: unknown) {
      if (error instanceof ClassmojiService.pageContent.PreviewResolutionError) {
        // Stale report pin: the content moved since the reviewed conflict
        // report — same 409 semantics as a mid-merge CAS loss (re-run accept).
        if (error.code === 'CONTENT_CONFLICT') {
          return Response.json({ error: error.message, code: error.code }, { status: 409 });
        }
        // Bad/stale resolutions (missing ids, unknown ids, duplicates,
        // malformed elements, no preview, main content deleted) — a clear 400
        // naming the offending ids; the client re-runs accept for a fresh
        // report.
        return Response.json(
          { error: error.message, code: error.code, ids: error.ids },
          { status: 400 }
        );
      }
      // Mid-merge CAS loss: main moved while committing the resolved merge
      // (the service already retried once). Nothing was written.
      if ((error as { status?: number } | null)?.status === 409) {
        return Response.json(
          { error: 'The live page changed while merging — try accepting again.' },
          { status: 409 }
        );
      }
      console.error('Failed to accept preview:', error);
      reportActionFailure(error, 'preview-accept', page.id);
      return Response.json(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      );
    }
  }

  if (intent === 'preview-discard') {
    try {
      await ClassmojiService.pageContent.discardPreview(actionPage);
      if (liveEnv) await notifyPreviewChanged(liveEnv, pageId);
      return redirect(`/${page.classroom.slug}/${pageId}?notice=preview-discarded`);
    } catch (error: unknown) {
      console.error('Failed to discard preview:', error);
      reportActionFailure(error, 'preview-discard', page.id);
      return Response.json(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      );
    }
  }

  if (intent === 'update-title') {
    try {
      await ClassmojiService.page.quickUpdate(pageId, {
        title: data.title as string,
        updated_at: new Date(),
      });
      if (liveEnv) await notifyPageMeta(liveEnv, pageId, { title: data.title as string });
      return Response.json({ success: true });
    } catch (error: unknown) {
      reportActionFailure(error, 'update-title', page.id);
      return Response.json(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      );
    }
  }

  if (intent === 'update-width') {
    try {
      await ClassmojiService.page.quickUpdate(pageId, {
        width: data.width as number,
        updated_at: new Date(),
      });
      if (liveEnv) await notifyPageMeta(liveEnv, pageId, { width: data.width as number });
      return Response.json({ success: true });
    } catch (error: unknown) {
      reportActionFailure(error, 'update-width', page.id);
      return Response.json(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      );
    }
  }

  if (intent === 'set-header-image') {
    try {
      const coverUrl = await canonicalizeAssetRef(actionAssetCtx, data.url as string | null);
      // The media half of the cover rule, judged on the CANONICAL form (a signed
      // media URL has just become its `media://` reference). A `media://` cover
      // must name a ready IMAGE of this page's own classroom; a video, a deleted
      // object or another classroom's id is answered like an asset that is not
      // there. Repo paths and URLs pass through untouched — this editor keeps
      // its own policy for those.
      if (!(await ClassmojiService.pageContent.coverMediaRefAllowed(actionPage, coverUrl))) {
        return Response.json({ error: 'Image not found' }, { status: 404 });
      }
      const coverImage = coverUrl
        ? {
            url: coverUrl,
            position: typeof data.position === 'number' ? data.position : 50,
          }
        : null;
      const { sha } = await savePageCoverImage(actionPage, coverImage);
      await ClassmojiService.page.quickUpdate(pageId, {
        updated_at: new Date(),
      });
      return Response.json({ success: true, sha });
    } catch (error: unknown) {
      if (error instanceof LegacyPageFormatError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      if ((error as { status?: number } | null)?.status === 409) {
        // F5: savePageCoverImage's CAS write lost to a concurrent content
        // edit — nothing was written, and retrying re-reads fresh content.
        return Response.json(
          { error: 'This page changed while updating the cover image — please try again.' },
          { status: 409 }
        );
      }
      reportActionFailure(error, 'set-header-image', page.id);
      return Response.json(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      );
    }
  }

  if (intent === 'upload-header-image') {
    try {
      const file = formData?.get('file');
      if (!file || typeof file === 'string') {
        return Response.json({ error: 'No file provided' }, { status: 400 });
      }
      // A cover is rendered as an image. Page assets may be any file type where
      // the delivery layer serves the classroom; a cover may not.
      if (!COVER_IMAGE_EXTENSION.test(file.name)) {
        return Response.json(
          { error: 'A cover must be an image (PNG, JPG, GIF, WebP or SVG).' },
          { status: 400 }
        );
      }
      // `url` is the repo path (what gets stored); `displayUrl` is the signed
      // URL for showing it right now — the two are never the same string.
      const { url, displayUrl } = await uploadPageAsset(actionPage, file);
      const { sha } = await savePageCoverImage(actionPage, { url, position: 50 });
      await ClassmojiService.page.quickUpdate(pageId, {
        updated_at: new Date(),
      });
      return Response.json({ success: true, url, displayUrl, sha });
    } catch (error: unknown) {
      // A cover the storage router sends to media (over the repository's cap on
      // a classroom with media): 409 `USE_MEDIA`. Checked before the 409 below,
      // which means something else entirely.
      const routed = ClassmojiService.media.mediaRoutingResponse(error);
      if (routed) return routed;
      // A legacy page: the upload went through, the cover was refused.
      if (error instanceof LegacyPageFormatError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      // Too large, a type this classroom does not take, a bad name: the
      // uploader's to fix, so a 4xx with the service's sentence (413/415/400).
      const refused = uploadRefusalStatus(error);
      if (refused) {
        return Response.json({ error: (error as Error).message }, { status: refused });
      }
      if ((error as { status?: number } | null)?.status === 409) {
        // F5: the asset uploaded fine, but the cover-image metadata write
        // lost to a concurrent content edit. Retrying is safe and cheap.
        return Response.json(
          { error: 'This page changed while updating the cover image — please try again.' },
          { status: 409 }
        );
      }
      console.error('Failed to upload header image:', error);
      reportActionFailure(error, 'upload-header-image', page.id);
      return Response.json(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      );
    }
  }

  return Response.json({ error: 'Invalid action' }, { status: 400 });
}
