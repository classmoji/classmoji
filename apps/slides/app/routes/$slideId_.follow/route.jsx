import { useMemo } from 'react';
import { useLoaderData } from 'react-router';
import prisma from '@classmoji/database';
import { assertSlideAccess } from '@classmoji/auth/server';
import { SandpackRenderer } from '@classmoji/ui-components/sandpack';
import RevealPresenter from '~/components/RevealPresenter';
import { fetchContent } from '~/utils/contentProxy';

/**
 * Follow route - Audience sync view
 *
 * Supports multiple authentication modes:
 * 1. Public slides (is_public=true) - anyone can follow
 * 2. Authenticated classroom members - can follow without shareCode
 * 3. Public links via shareCode - anyone with valid shareCode can follow
 */
export const loader = async ({ params, request }) => {
  const { slideId } = params;
  const url = new URL(request.url);
  const shareCode = url.searchParams.get('shareCode');
  const preview = url.searchParams.get('preview') === 'true';

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

  // Authorization: check view access (supports public slides, membership, and shareCode)
  const { accessGrantedVia, canViewSpeakerNotes } = await assertSlideAccess({
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

  // Get content repo name and file path
  const repo = `content-${gitOrgLogin}-${slide.term}`;
  const filePath = `${slide.content_path}/index.html`;

  // Build the content URL using content proxy (CDN-first + API fallback)
  const contentUrl = `/content/${gitOrgLogin}/${repo}/${filePath}`;

  // Fetch content using shared utility (CDN first, API fallback)
  let slideContent = null;
  let contentError = null;

  const contentResult = await fetchContent({
    org: gitOrgLogin,
    repo,
    path: filePath,
  });

  if (contentResult) {
    slideContent = contentResult.content;

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
  const { slide, contentUrl, slideContent, contentError, shareCode, preview } = useLoaderData();

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
        multiplexId={slide.multiplex_id}
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
