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

  // Load content from GitHub (page includes classroom.git_organization via
  // includeClassroom). Staff loads bypass the 60s per-process cache: for
  // canEdit users this read IS the edit surface (the editor mounts inline) and
  // seeds the save conflict token, so a cached read on another Fly instance
  // could silently revert an MCP write (4b parity with slides). It also keeps
  // the post-accept redirect (`?notice=preview-accepted`, staff-only) from
  // showing pre-accept cached content under the success toast.
  const {
    format,
    content,
    coverImage: jsonCoverImage,
    sha: contentFileSha,
  } = await loadPageContent(
    pageForContent,
    previewActive ? { ref: previewBranch, skipCache: true } : { skipCache: canEdit }
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

  // Build GitHub repo info for link
  const gitOrg = (page.classroom as Record<string, unknown>).git_organization as {
    login?: string;
    avatar_url?: string;
  } | null;
  const contentNamespace = page.classroom.content_namespace;
  const repoName =
    contentNamespace && gitOrg?.login ? `content-${gitOrg.login}-${contentNamespace}` : null;

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
    try {
      const blocks = JSON.parse(data.content as string);

      // F2 (4b parity with slides): optimistic-lock the write on the
      // content.json sha the editor loaded (loader / previous save response).
      const expectedSha =
        typeof data.content_sha === 'string' && data.content_sha ? data.content_sha : null;

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

      const { sha } = await savePageContent(actionPage, blocks, {
        ...(expectedSha ? { expectedSha } : {}),
      });
      await ClassmojiService.page.quickUpdate(pageId, {
        updated_at: new Date(),
      });
      // Return the new sha — the editor's conflict token for its next save.
      return Response.json({ success: true, sha });
    } catch (error: unknown) {
      if ((error as { status?: number } | null)?.status === 409) {
        // Someone (another editor, an MCP apply) changed content.json since
        // this editor loaded it. Nothing was written.
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
      const coverImage = data.url
        ? {
            url: data.url as string,
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
      const { url } = await uploadPageAsset(actionPage, file);
      const { sha } = await savePageCoverImage(actionPage, { url, position: 50 });
      await ClassmojiService.page.quickUpdate(pageId, {
        updated_at: new Date(),
      });
      return Response.json({ success: true, url, sha });
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
