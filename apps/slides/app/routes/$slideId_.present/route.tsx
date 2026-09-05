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

export const loader = async ({
  params,
  request,
}: {
  params: Record<string, string | undefined>;
  request: Request;
}) => {
  const { slideId } = params;
  if (!slideId) throw new Response('Missing slideId', { status: 400 });

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

  // Authorization: require present permission (owner/teacher/assistant)
  const { canPresent, canEdit } = await assertSlideAccess({
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

  // Content repo is STORED and user-editable — never re-derived from the namespace.
  const repo = slide.classroom.content_repo;
  const filePath = `${slide.content_path}/index.html`;

  // Legacy proxy URL, kept as the client-side fallback when the server-side
  // read below fails entirely.
  const contentUrl = `/content/${gitOrgLogin}/${repo}/${filePath}`;

  // Read the deck by SHA through the delivery layer. This route is the reason
  // that matters: the presenter is opened seconds after a save, and the CDN
  // path this replaces lagged a push by minutes — so a deck saved at the
  // lectern showed the version from before the fix.
  let slideContent: string | null = null;
  let contentError: string | null = null;

  const contentResult = await readDeckText(slide, gitOrgLogin, repo, filePath, 'present');

  if (contentResult) {
    // Same read-side delivery pass the deck viewer runs: the stored document
    // holds `/content/...` refs, and a presenter must see the signed ones or a
    // private content repo shows them nothing. `deckAccessFor` deliberately
    // does NOT hand this surface the `edit` tier — see its comment.
    //
    // `canEdit` is passed because `assertSlideAccess` answered it and this
    // route has no business rewriting it; `deckAccessFor` then IGNORES it for
    // this surface and takes the deck's visibility instead. A presentation
    // stays open for hours, and the 4h `edit` bucket would 403 a lazily loaded
    // background mid-lecture.
    const { html } = await resolveDeckDelivery(
      contentResult.content,
      deckDeliveryContext(slide, gitOrgLogin, repo, deckAccessFor('present', { canEdit }, slide))
    );
    slideContent = html;
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
  const { slide, contentUrl, slideContent, contentError, canPresent } =
    useLoaderData<typeof loader>();

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
        multiplexId={slide.multiplex_id ?? undefined}
        multiplexSecret={slide.multiplex_secret ?? undefined}
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
