import { useLoaderData } from 'react-router';
import prisma from '@classmoji/database';
import { assertSlideAccess } from '@classmoji/auth/server';
import SpeakerView from '~/components/SpeakerView';
import { fetchContent } from '~/utils/contentProxy';

/**
 * Speaker route - Remote speaker notes view
 *
 * Allows presenters to view speaker notes on a separate device (phone/tablet)
 * while presenting from their laptop. Syncs bidirectionally with the main
 * presenter view.
 *
 * Requires speakerNotes access (staff, or viewers when show_speaker_notes=true).
 */
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

  // Authorization: require speakerNotes access (staff, or viewers when show_speaker_notes=true)
  await assertSlideAccess({
    request,
    slideId,
    slide,
    accessType: 'speakerNotes',
  });

  // Get git org login for content URLs
  const gitOrgLogin = slide.classroom?.git_organization?.login;
  if (!gitOrgLogin) {
    throw new Response('Git organization not configured', { status: 400 });
  }

  // Get content repo name and file path
  const repo = `content-${gitOrgLogin}-${slide.term}`;
  const filePath = `${slide.content_path}/index.html`;

  // Fetch content using shared utility (CDN first, API fallback)
  let slideContent = null;
  let contentError = null;

  const contentResult = await fetchContent({
    org: gitOrgLogin,
    repo,
    path: filePath,
  });

  if (contentResult) {
    // Parse the HTML to extract just the slides content
    const parser = await import('cheerio');
    const $ = parser.load(contentResult.content);
    slideContent = $('.slides').html();
  } else {
    contentError = 'Failed to load slide content';
  }

  return {
    slide,
    slideContent,
    contentError,
  };
};

export default function SlideSpeaker() {
  const { slide, slideContent, contentError } = useLoaderData();

  // Authorization is handled by assertSlideAccess in the loader
  // If we reach here, user has speakerNotes access

  if (contentError) {
    return (
      <div className="fixed inset-0 bg-gray-900 flex items-center justify-center">
        <div className="text-center text-white">
          <div className="text-red-400 text-lg mb-2">Failed to load presentation</div>
          <p className="text-white/60">{contentError}</p>
        </div>
      </div>
    );
  }

  return (
    <SpeakerView
      slideId={slide.id}
      initialContent={slideContent}
    />
  );
}
