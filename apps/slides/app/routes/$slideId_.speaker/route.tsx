import { useLoaderData } from 'react-router';
import getPrisma from '@classmoji/database';
import { assertSlideAccess } from '@classmoji/auth/server';
import SpeakerView from '~/components/SpeakerView';
import {
  deckAccessFor,
  deckDeliveryContext,
  readDeckText,
  resolveDeckAssets,
} from '~/utils/deckDelivery.server';

/**
 * Speaker route - Remote speaker notes view
 *
 * Allows presenters to view speaker notes on a separate device (phone/tablet)
 * while presenting from their laptop. Syncs bidirectionally with the main
 * presenter view.
 *
 * Requires speakerNotes access (staff, or viewers when show_speaker_notes=true).
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

  // Authorization: require speakerNotes access (staff, or viewers when show_speaker_notes=true)
  const { canEdit } = await assertSlideAccess({
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

  // Content repo is STORED and user-editable — never re-derived from the namespace.
  const repo = slide.classroom.content_repo;
  const filePath = `${slide.content_path}/index.html`;

  // Read the deck by SHA through the delivery layer — the same read the
  // presenter makes, and for the same reason: this view is opened alongside a
  // live presentation, where showing the pre-save deck is worse than useless.
  let slideContent: string | null = null;
  let contentError: string | null = null;

  const contentResult = await readDeckText(slide, gitOrgLogin, repo, filePath, 'speaker');

  if (contentResult) {
    // Sign the deck's references BEFORE the fragment is cut out: the speaker
    // view renders these slides too, and a raw `/content/...` ref is dead the
    // moment the content repo goes private. Assets only — this view keeps the
    // `.slides` fragment and throws the document's <head> away, so resolving a
    // theme base here would be a lookup for an answer nobody reads.
    const html = await resolveDeckAssets(
      contentResult.content,
      deckDeliveryContext(slide, gitOrgLogin, repo, deckAccessFor('speaker', { canEdit }, slide))
    );

    // Parse the HTML to extract just the slides content
    const parser = await import('cheerio');
    const $ = parser.load(html ?? '');
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
  const { slide, slideContent, contentError } = useLoaderData<typeof loader>();

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

  return <SpeakerView slideId={slide.id} initialContent={slideContent ?? ''} />;
}
