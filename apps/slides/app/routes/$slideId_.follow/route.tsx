import { useMemo } from 'react';
import { useLoaderData } from 'react-router';
import getPrisma from '@classmoji/database';
import { assertSlideAccess } from '@classmoji/auth/server';
import { SandpackRenderer } from '@classmoji/ui-components/sandpack';
import RevealPresenter from '~/components/RevealPresenter';
import {
  deckAccessFor,
  deckDeliveryContext,
  readDeckText,
  resolveDeckDelivery,
} from '~/utils/deckDelivery.server';

/**
 * Follow route - Audience sync view
 *
 * Supports multiple authentication modes:
 * 1. Public slides (is_public=true) - anyone can follow
 * 2. Authenticated classroom members - can follow without shareCode
 * 3. Public links via shareCode - anyone with valid shareCode can follow
 */
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
  const shareCode = url.searchParams.get('shareCode');
  const preview = url.searchParams.get('preview') === 'true';

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

  // Authorization: check view access (supports public slides, membership, and shareCode)
  const { accessGrantedVia, canEdit, canViewSpeakerNotes } = await assertSlideAccess({
    request,
    slideId,
    slide,
    accessType: 'view',
    shareCode,
  });

  // Determine if this is public access (shareCode or public slide)
  const isPublicAccess = accessGrantedVia === 'public' || accessGrantedVia === 'shareCode';

  // Get git org login for content URLs
  const gitOrgLogin = slide.classroom?.git_organization?.login;
  if (!gitOrgLogin) {
    throw new Response('Git organization not configured', { status: 400 });
  }

  // Content repo is STORED and user-editable — never re-derived from the namespace.
  const repo = slide.classroom.content_repo;
  const filePath = `${slide.content_path}/index.html`;

  // Legacy proxy URL, kept as the client-side fallback when the server-side
  // read below fails entirely.
  const contentUrl = `/content/${gitOrgLogin}/${repo}/${filePath}`;

  // Read the deck by SHA through the delivery layer. This is the highest-fanout
  // deck read in the app — a lecture hall opens it at once — and it is now the
  // cheapest: one signed URL per sha, served from the edge, and zero GitHub
  // calls per viewer.
  let slideContent: string | null = null;
  let contentError: string | null = null;

  const contentResult = await readDeckText(slide, gitOrgLogin, repo, filePath, 'follow');

  if (contentResult) {
    // Same read-side delivery pass the deck viewer runs. A follower is usually
    // a student or a shareCode guest, so the tier lands on `enrolled`/`public`
    // rather than the staff `draft` bucket — `tierFor` decides, not this route.
    // The `preview` local above is this route's THUMBNAIL flag, and it reaches
    // `deckAccessFor` as `thumbnail` — never as the viewer's preview-BRANCH
    // flag. It marks the read-only iframe form (the speaker view's panes), so
    // staff get the long-lived tier there instead of a 4h `draft` signature
    // that expires part-way through a long lecture.
    const { html } = await resolveDeckDelivery(
      contentResult.content,
      deckDeliveryContext(
        slide,
        gitOrgLogin,
        repo,
        deckAccessFor('follow', { canEdit }, slide, { thumbnail: preview })
      )
    );
    slideContent = html;

    // Strip speaker notes from content if user doesn't have permission to view them
    // Followers are typically students/public who shouldn't see notes unless show_speaker_notes is enabled
    if (!canViewSpeakerNotes && slideContent) {
      slideContent = slideContent.replace(/<aside\s+class="notes"[^>]*>[\s\S]*?<\/aside>/gi, '');
    }
  } else {
    contentError = 'Failed to load slide content';
  }

  return {
    slide,
    contentUrl,
    slideContent,
    contentError,
    shareCode,
    isPublicAccess,
    preview,
  };
};

export default function SlideFollow() {
  const { slide, contentUrl, slideContent, contentError, shareCode, preview } =
    useLoaderData<typeof loader>();

  // Extract theme from slideContent for Sandpack auto-theme detection
  const currentSlideTheme = useMemo(() => {
    if (slideContent) {
      const themeMatch = slideContent.match(/data-theme="([^"]+)"/);
      if (themeMatch) {
        return themeMatch[1];
      }
    }
    return 'white';
  }, [slideContent]);

  // Authorization is handled by assertSlideAccess in the loader
  // If we reach here, user has view access (via public slide, membership, or shareCode)

  return (
    <>
      <RevealPresenter
        contentUrl={contentUrl}
        initialContent={slideContent}
        initialError={contentError}
        slideId={slide.id}
        isPresenter={false}
        shareCode={shareCode}
        previewMode={preview}
        multiplexId={slide.multiplex_id ?? undefined}
        // Note: multiplexSecret intentionally NOT passed to followers
        // Only presenters (in $slideId_.present) should have the secret
      />
      {/* Mount Sandpack components into .sandpack-embed elements */}
      <SandpackRenderer
        containerSelector=".reveal .slides"
        slideTheme={currentSlideTheme}
        isEditing={false}
      />
    </>
  );
}
