import { redirect } from 'react-router';
import { ClassmojiService, getAuthSession } from '~/utils/db.server.ts';
import { pageMutationBlocked } from '~/utils/auth.server.ts';
import {
  loadPageContent,
  savePageContent,
  savePageCoverImage,
  uploadPageAsset,
} from '~/utils/content.server.ts';
import { migrateHtmlToBlockNote } from '~/utils/migration.server.ts';
import { schema } from '~/components/editor/blocks/index.tsx';
import type { PageForContent } from '~/types/pages.ts';
import {
  assetResolveContext,
  canonicalizeAssetRef,
  canonicalizeDocumentAssets,
  canonicalizeOpsAssets,
  resolveDocumentAssets,
} from '~/utils/assetRefs.server.ts';

/**
 * Public page viewer route - read-only view for students and public access.
 *
 * GET /:classroomSlug/:pageId — Public/Student viewer (no edit mode)
 */
export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
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
  const authData = await getAuthSession(request).catch(() => null);
  let userRole: string | null = null;
  let canEdit = false;

  if (authData?.userId) {
    const membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
      page.classroom.id,
      authData.userId
    );
    if (membership) {
      userRole = membership.role;
      canEdit = ['OWNER', 'TEACHER'].includes(userRole);
    }
  }

  // Block access to draft pages (teaching team can view drafts)
  const canViewDrafts = ['OWNER', 'TEACHER', 'ASSISTANT'].includes(userRole as string);
  if (page.is_draft && !canViewDrafts) {
    throw new Response('This page is not yet published', { status: 403 });
  }

  // For non-public pages, check if user is enrolled in the classroom
  if (!page.is_public && !userRole) {
    throw new Response('Page is not public', { status: 403 });
  }

  const pageForContent = page as unknown as PageForContent;

  // ── Preview branches (plan §3b) ────────────────────────────────────────────
  // `?preview=1` renders the singleton `preview/<content_path>` branch instead
  // of main. Staff-gated: non-staff viewers never pay the GitHub status call
  // and the param is silently ignored for them.
  const url = new URL(request.url);
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
  const {
    format,
    content,
    coverImage: jsonCoverImage,
    sha: contentFileSha,
  } = await loadPageContent(
    pageForContent,
    previewActive
      ? { ref: previewBranch, skipCache: true }
      : canEdit
        ? { skipCache: true }
        : { viaWorker: true }
  );

  let viewerContent: unknown;

  if (format === 'json') {
    viewerContent = content;
  } else if (format === 'html') {
    // Migrate HTML to BlockNote JSON for viewing
    viewerContent = await migrateHtmlToBlockNote(content as string, schema);
  } else {
    // Empty page
    viewerContent = [{ type: 'paragraph', content: [] }];
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
  const assetCtx = assetResolveContext(
    page.classroom as unknown as Parameters<typeof assetResolveContext>[0],
    resolveTier
  );
  // ONE pass for both. Two sequential resolves read the clock twice, and an
  // expiry that moves between the two reads mints a different `src` for the
  // same file — at which point every candidate list is thrown away, because the
  // pairing is by string equality. On `edit` the expiry is an exact `now + 4h`,
  // so it moves on EVERY tick; on `week` and `month` it only moves across a
  // bucket boundary (or the roll-forward near one). Rare on a reader, constant
  // for an editor, and wrong in both cases. The cover is in the
  // ref list for its display URL; it does not need candidates, because
  // `HeaderImage` renders it as a CSS background, where `srcset` means nothing.
  const { assets: resolvedAssets, srcSets: resolvedSrcSets } = await resolveDocumentAssets(
    assetCtx,
    viewerContent,
    [coverImage?.url]
  );

  // Build GitHub repo info for link
  const gitOrg = (page.classroom as Record<string, unknown>).git_organization as {
    login?: string;
    avatar_url?: string;
  } | null;
  // Content repo is STORED and user-editable — never re-derived from the namespace.
  const contentRepo = page.classroom.content_repo;
  const repoName = contentRepo && gitOrg?.login ? contentRepo : null;

  // GitHub's free diff UI for the pending preview (branch segment URL-encoded —
  // preview branch names contain slashes).
  const diffUrl =
    gitOrg?.login && repoName
      ? `https://github.com/${gitOrg.login}/${repoName}/compare/main...${encodeURIComponent(previewBranch)}`
      : null;

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
          }
        : null,
    },
    content: viewerContent,
    coverImage,
    // Display-only: `{ storedRef: signedUrl }`. Absent keys mean "use the ref
    // as-is" (an external image, or the delivery layer switched off).
    resolvedAssets,
    // Also display-only, and keyed the SAME way — `{ storedRef: srcset }` —
    // because the consumer is the image block, which holds the stored reference
    // and would otherwise have to reproduce a signature to find its own entry.
    // An absent key means "one size only", which is the right answer for a gif,
    // an svg, and anything that is not an image.
    resolvedSrcSets,
    userRole,
    canEdit,
    notice,
    noticeAutoMerged,
    // Conflict token (F2, 4b parity with slides): content.json's blob sha,
    // echoed back by the editor on every save so the action can 409 instead
    // of clobbering a concurrent write. null = no content.json yet (fresh or
    // legacy-HTML page) → the first save creates it without a precondition.
    // Editor-only: null for non-editors and in read-only preview mode.
    contentSha: canEdit && !previewActive && format === 'json' ? contentFileSha : null,
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

/**
 * Actions for page mutations (edit mode only).
 */
export const action = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
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
  const authData = await getAuthSession(request).catch(() => null);
  if (!authData?.userId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
    page.classroom.id,
    authData.userId
  );

  if (!membership || !['OWNER', 'TEACHER'].includes(membership.role)) {
    return Response.json({ error: 'Unauthorized' }, { status: 403 });
  }

  // SEC4: every intent this action handles mutates (GitHub content, preview
  // branches, or page rows) — enforce the platform-wide classroom status gate
  // (owners always may mutate; LOCKED/UNPUBLISHED are read-only for others).
  const blocked = pageMutationBlocked(page.classroom, membership.role);
  if (blocked) return blocked;

  // Support both JSON and multipart form data (for file uploads)
  const contentType = request.headers.get('content-type') || '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- form/JSON data has dynamic shape
  let data: Record<string, any>, formData: FormData | undefined;
  if (contentType.includes('multipart/form-data')) {
    formData = await request.formData();
    data = { intent: formData!.get('intent') };
  } else {
    data = await request.json();
  }
  const { intent } = data;

  if (intent === 'save') {
    // Phase 7.5: a save-conflict chooser re-submit carries the SAME posted
    // content plus one {id, choose} per conflict and the report's ours_sha pin.
    let saveResolutions: { id: string; choose: 'ours' | 'theirs' }[] | null = null;
    if (data.resolutions != null) {
      try {
        const parsed =
          typeof data.resolutions === 'string' ? JSON.parse(data.resolutions) : data.resolutions;
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
    // transmit). Presence of `ops` selects the path. The op vocabulary is
    // validated against the service's single-source zod schema (op cap 400) so
    // a structurally malformed payload is a typed 400 the client recovers from
    // by falling back to a full-document save — never a raw TypeError → 500
    // (plan §7 P8).
    let saveOps: unknown[] | null = null;
    if (data.ops != null) {
      let rawOps: unknown;
      try {
        rawOps = typeof data.ops === 'string' ? JSON.parse(data.ops) : data.ops;
      } catch {
        rawOps = undefined; // invalid JSON → schema rejects → typed 400 below
      }
      const parsed = ClassmojiService.pageContent.pageBlockOpsPayloadSchema.safeParse(rawOps);
      if (!parsed.success) {
        // `code` makes the client auto-fall-back to ONE whole-document save
        // (its code-keyed fallback effect), which needs no base to replay.
        return Response.json(
          {
            error: 'Malformed ops payload — retrying as a full-document save',
            code: 'OPS_MALFORMED',
          },
          { status: 400 }
        );
      }
      // Defense in depth: strip any signed URL back to its repo path BEFORE it
      // can be committed. An ops save carries only the blocks that changed —
      // which is exactly where a just-uploaded image's display URL would be.
      saveOps = await canonicalizeOpsAssets(actionAssetCtx, parsed.data);
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
        // ── Whole-document save (7.5 path, unchanged) ─────────────────────
        const blocks = await canonicalizeDocumentAssets(
          actionAssetCtx,
          JSON.parse(data.content as string)
        );

        if (!expectedSha) {
          // Token-less save. Legit only when content.json doesn't exist yet
          // (fresh or legacy-HTML page — the loader handed out a null token).
          // If the file EXISTS, this is a stale pre-token client bundle (or the
          // file appeared since the editor loaded, e.g. an MCP apply): reject
          // rather than silently clobber. Fresh existence check — the 60s cache
          // must not vouch for absence.
          const existing = await loadPageContent(actionPage, { skipCache: true });
          if (existing.format === 'json') {
            return Response.json(
              { conflict: true, message: 'This page changed since you opened it.' },
              { status: 409 }
            );
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
          typeof data.resolutions === 'string' ? JSON.parse(data.resolutions) : data.resolutions;
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
            const fresh = await ClassmojiService.pageContent.loadPageContent(actionPage, {
              skipCache: true,
            });
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
      return Response.json(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      );
    }
  }

  if (intent === 'preview-discard') {
    try {
      await ClassmojiService.pageContent.discardPreview(actionPage);
      return redirect(`/${page.classroom.slug}/${pageId}?notice=preview-discarded`);
    } catch (error: unknown) {
      console.error('Failed to discard preview:', error);
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
      return Response.json({ success: true });
    } catch (error: unknown) {
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
      return Response.json({ success: true });
    } catch (error: unknown) {
      return Response.json(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      );
    }
  }

  if (intent === 'set-header-image') {
    try {
      const coverUrl = await canonicalizeAssetRef(actionAssetCtx, data.url as string | null);
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
      if ((error as { status?: number } | null)?.status === 409) {
        // F5: savePageCoverImage's CAS write lost to a concurrent content
        // edit — nothing was written, and retrying re-reads fresh content.
        return Response.json(
          { error: 'This page changed while updating the cover image — please try again.' },
          { status: 409 }
        );
      }
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
      // `url` is the repo path (what gets stored); `displayUrl` is the signed
      // URL for showing it right now — the two are never the same string.
      const { url, displayUrl } = await uploadPageAsset(actionPage, file);
      const { sha } = await savePageCoverImage(actionPage, { url, position: 50 });
      await ClassmojiService.page.quickUpdate(pageId, {
        updated_at: new Date(),
      });
      return Response.json({ success: true, url, displayUrl, sha });
    } catch (error: unknown) {
      if ((error as { status?: number } | null)?.status === 409) {
        // F5: the asset uploaded fine, but the cover-image metadata write
        // lost to a concurrent content edit. Retrying is safe and cheap.
        return Response.json(
          { error: 'This page changed while updating the cover image — please try again.' },
          { status: 409 }
        );
      }
      console.error('Failed to upload header image:', error);
      return Response.json(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        { status: 500 }
      );
    }
  }

  return Response.json({ error: 'Invalid action' }, { status: 400 });
};
