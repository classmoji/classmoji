import { useMemo } from 'react';
import { useLoaderData } from 'react-router';
import prisma from '@classmoji/database';
import { assertSlideAccess } from '@classmoji/auth/server';
import { SandpackRenderer } from '@classmoji/ui-components/sandpack';
import RevealPresenter from '~/components/RevealPresenter';
import { fetchContent } from '~/utils/contentProxy';

export const loader = async ({ params, request }) => {
  const { slideId } = params;

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

  // Authorization: require present permission (owner/teacher/assistant)
  const { canPresent } = await assertSlideAccess({
    request,
    slideId,
    slide,
    accessType: 'present',
  });

  // Get git org login for content URLs
  const gitOrgLogin = slide.classroom?.git_organization?.login;
  if (!gitOrgLogin) {
    throw new Response('Git organization not configured', { status: 400 });
  }

  // Get content repo name and file path
  const repo = `content-${gitOrgLogin}-${slide.term}`;
  const filePath = `${slide.content_path}/index.html`;

  // Build the content URL using content proxy (CDN-first + API fallback)
  // Used as client-side fallback if server-side fetch fails
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
  } else {
    contentError = 'Failed to load slide content';
  }

  return {
    slide,
    contentUrl,
    slideContent,
    contentError,
    canPresent,
  };
};

export default function SlidePresenter() {
  const { slide, contentUrl, slideContent, contentError, canPresent } = useLoaderData();

  // Extract theme from slideContent for Sandpack auto-theme detection
  // This is computed once since the content doesn't change during presentation
  const currentSlideTheme = useMemo(() => {
    if (slideContent) {
      const themeMatch = slideContent.match(/data-theme="([^"]+)"/);
      if (themeMatch) {
        return themeMatch[1];
      }
    }
    return 'white';
  }, [slideContent]);

  // canPresent is computed by assertSlideAccess in the loader (owner/teacher/assistant)
  const isPresenter = canPresent;

  return (
    <>
      <RevealPresenter
        contentUrl={contentUrl}
        initialContent={slideContent}
        initialError={contentError}
        slideId={slide.id}
        isPresenter={isPresenter}
        multiplexId={slide.multiplex_id}
        multiplexSecret={slide.multiplex_secret}
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
