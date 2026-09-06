import { useCallback, useEffect, useRef, useState } from 'react';
import { useLoaderData, Link, useFetcher } from 'react-router';
import { Popconfirm, Modal, Input, Tooltip, Spin, message } from 'antd';
import getPrisma from '@classmoji/database';
import { getAuthSession, assertSlideAccess } from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';
import { ContentService } from '@classmoji/content';
import { slideService } from '@classmoji/services/slides';
import { deleteSlideVideos } from '~/utils/cloudinaryService.server';
import { resolveDeckThumbnailUrls } from '~/utils/deckDelivery.server';
import { enqueueDeckThumbnail } from '~/utils/deckThumbnailEnqueue.server';

export const loader = async ({ request }: { request: Request }) => {
  // 1. Require authentication
  const authData = await getAuthSession(request);
  if (!authData) {
    throw new Response('Unauthorized', { status: 401 });
  }

  // 2. Get user's classroom memberships with roles
  const memberships = await getPrisma().classroomMembership.findMany({
    where: { user_id: authData.userId },
    select: { classroom_id: true, role: true },
  });

  // 3. Separate classrooms by role - staff can see drafts, students cannot
  const staffRoles = ['OWNER', 'TEACHER', 'ASSISTANT'];
  const staffClassroomIds = memberships
    .filter(m => staffRoles.includes(m.role))
    .map(m => m.classroom_id);
  const studentClassroomIds = memberships
    .filter(m => !staffRoles.includes(m.role))
    .map(m => m.classroom_id);

  // 4. Build query: staff sees all slides, students see only published
  const whereConditions = [];
  if (staffClassroomIds.length > 0) {
    // Staff can see all slides (including drafts)
    whereConditions.push({ classroom_id: { in: staffClassroomIds } });
  }
  if (studentClassroomIds.length > 0) {
    // Students can only see published slides
    whereConditions.push({
      classroom_id: { in: studentClassroomIds },
      is_draft: false,
    });
  }

  // If user has no classroom memberships, return empty
  if (whereConditions.length === 0) {
    return {
      slides: [],
      webappUrl: process.env.WEBAPP_URL || 'http://localhost:3000',
    };
  }

  // 5. Fetch slides with role-based filtering
  //
  // The classroom now carries what a THUMBNAIL URL is resolved from as well as
  // what the card prints: the repo the image lives in, the key version its
  // signature is derived under, and whether the delivery layer is on for this
  // classroom at all. None of that reaches the client — it is stripped below,
  // so the shape the component sees is exactly what it was.
  const recentSlides = await getPrisma().slide.findMany({
    where: { OR: whereConditions },
    take: 20,
    orderBy: { updated_at: 'desc' },
    include: {
      classroom: {
        select: {
          id: true,
          slug: true,
          name: true,
          content_namespace: true,
          content_repo: true,
          content_key_version: true,
          content_delivery_enabled: true,
          git_organization: { select: { login: true } },
        },
      },
      links: {
        include: {
          repository: true,
        },
        take: 1,
      },
    },
  });

  // ONE delivery call per classroom and tier — not one per deck, and none at
  // all for a deck that has never been rendered. This is the whole of the
  // per-deck work the index does now: it used to do none here and all of it
  // twenty times over, once inside each iframe's own `$slideId` loader.
  const thumbnails = await resolveDeckThumbnailUrls(recentSlides);

  return {
    slides: recentSlides.map(({ classroom, ...slide }) => ({
      ...slide,
      classroom: classroom
        ? {
            slug: classroom.slug,
            name: classroom.name,
            content_namespace: classroom.content_namespace,
          }
        : null,
      thumbnailUrl: thumbnails.get(slide.id) ?? null,
    })),
    webappUrl: process.env.WEBAPP_URL || 'http://localhost:3000',
  };
};

export const action = async ({ request }: { request: Request }) => {
  const formData = await request.formData();
  const intent = formData.get('intent');

  // Get auth for actions that need userId
  const authData = await getAuthSession(request);

  if (intent === 'delete') {
    const slideId = formData.get('slideId') as string | null;

    if (!slideId) {
      return { error: 'Slide ID is required' };
    }

    // Authorization: require edit permission to delete slides
    try {
      await assertSlideAccess({
        request,
        slideId,
        accessType: 'edit',
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'You do not have permission to delete this slide';
      return { error: message };
    }

    // Delete the slide (no theme cleanup for simple deletion). Cloudinary
    // video cleanup stays app-local — supplied as the service's callback.
    try {
      await slideService.deleteSlide({
        slideId,
        deleteTheme: false,
        onDeleteVideos: deleteSlideVideos,
      });
      return { success: true, intent: 'delete', deletedSlideId: slideId };
    } catch (error: unknown) {
      console.error('Failed to delete slide:', error);
      const message = error instanceof Error ? error.message : 'Failed to delete slide';
      return { error: message };
    }
  }

  // A card scrolled into view with no stored thumbnail. Nobody is waiting on
  // the answer and nothing is shown either way — the placeholder stays until a
  // render lands and the next load picks it up.
  if (intent === 'thumbnail') {
    const slideId = formData.get('slideId') as string | null;
    if (!slideId) return { intent: 'thumbnail', outcome: 'invalid' };

    // The same gate the card's own link is behind: a viewer may ask for a
    // picture of a deck they may open, and nothing else. A refusal answers the
    // same shape as a rate-limited request — this endpoint tells a caller
    // nothing about decks it cannot see.
    try {
      await assertSlideAccess({ request, slideId, accessType: 'view' });
    } catch {
      return { intent: 'thumbnail', outcome: 'rate-limited' };
    }

    const slide = await getPrisma().slide.findUnique({
      where: { id: slideId },
      select: {
        id: true,
        classroom_id: true,
        thumbnail_path: true,
        thumbnail_rendered_at: true,
      },
    });
    // Already has one: the client's copy of the loader data is simply behind.
    if (!slide || slide.thumbnail_path) return { intent: 'thumbnail', outcome: 'rate-limited' };

    return { intent: 'thumbnail', outcome: await enqueueDeckThumbnail(slide) };
  }

  if (intent === 'rename') {
    const slideId = formData.get('slideId') as string | null;
    const newTitle = formData.get('title') as string | null;

    if (!slideId || !newTitle) {
      return { error: 'Slide ID and title are required' };
    }

    // Authorization: require edit permission to rename slides
    try {
      await assertSlideAccess({
        request,
        slideId,
        accessType: 'edit',
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'You do not have permission to rename this slide';
      return { error: message };
    }

    try {
      const slide = await getPrisma().slide.update({
        where: { id: slideId },
        data: { title: newTitle.trim() },
        select: { id: true, title: true, classroom_id: true },
      });

      // Update the content manifest
      await ClassmojiService.contentManifest.saveManifest(slide.classroom_id);

      return { success: true, intent: 'rename', slide };
    } catch (error: unknown) {
      console.error('Failed to rename slide:', error);
      const message = error instanceof Error ? error.message : 'Failed to rename slide';
      return { error: message };
    }
  }

  if (intent === 'duplicate') {
    const slideId = formData.get('slideId') as string | null;

    if (!slideId) {
      return { error: 'Slide ID is required' };
    }

    // Authorization: require edit permission to duplicate slides
    try {
      await assertSlideAccess({
        request,
        slideId,
        accessType: 'edit',
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : 'You do not have permission to duplicate this slide';
      return { error: message };
    }

    try {
      // Fetch the slide with classroom and git organization info
      const slide = await getPrisma().slide.findUnique({
        where: { id: slideId },
        include: {
          classroom: {
            include: { git_organization: true },
          },
        },
      });

      if (!slide) {
        return { error: 'Slide not found' };
      }

      const gitOrganization = slide.classroom?.git_organization;
      if (!gitOrganization?.login) {
        return { error: 'Git organization not configured for this classroom' };
      }

      // Content repo is STORED and user-editable — never re-derived from the namespace.
      const repo = slide.classroom.content_repo;
      const newSlug = `${slide.slug}-copy-${Date.now()}`;
      const newContentPath = `slides/${newSlug}`;

      // Copy content folder in GitHub
      await ContentService.copyFolder({
        gitOrganization,
        repo,
        sourcePath: slide.content_path,
        destPath: newContentPath,
        message: `Duplicate slides: ${slide.title}`,
      });

      // Rewrite content paths in the copied index.html
      // Images and other assets reference the old content_path in their URLs
      // e.g., /content/{org}/{repo}/{old_content_path}/images/...
      const indexPath = `${newContentPath}/index.html`;
      const indexFile = await ContentService.getContent({
        gitOrganization,
        repo,
        path: indexPath,
        skipCache: true,
      });

      // Both rewrites below record what they wrote. index.html and deck.json
      // are READ through the asset map now (fetchContentText), and the copy's
      // paths are new, so the map has no row for them until the push webhook
      // lands.
      //
      // Only what the REWRITES write, though: `copyFolder` above is what puts
      // the files there, and it reports no shas, so a deck whose content had no
      // self-referencing paths to rewrite gets no rows here. That is a missing
      // row, not a wrong one — the read falls back to the contents API and
      // serves the right bytes — so it costs one GitHub call per view until the
      // webhook arrives rather than showing the wrong deck.
      const written: Array<{ path: string; sha: string }> = [];

      if (indexFile?.content && slide.content_path !== newContentPath) {
        const updatedContent = indexFile.content.replaceAll(slide.content_path, newContentPath);

        if (updatedContent !== indexFile.content) {
          const result = await ContentService.put({
            gitOrganization,
            repo,
            path: indexPath,
            content: updatedContent,
            message: `Rewrite content paths for duplicated slides: ${slide.title}`,
          });
          written.push({ path: indexPath, sha: result.sha });
        }
      }

      // Apply the same content-path rewrite to the copied deck.json (the
      // source of truth for deck-first slides). 404-tolerant: legacy decks
      // have no deck.json yet — getContent returns null and we skip.
      const deckPath = `${newContentPath}/deck.json`;
      const deckFile = await ContentService.getContent({
        gitOrganization,
        repo,
        path: deckPath,
        skipCache: true,
      });

      if (deckFile?.content && slide.content_path !== newContentPath) {
        const updatedDeck = deckFile.content.replaceAll(slide.content_path, newContentPath);

        if (updatedDeck !== deckFile.content) {
          const result = await ContentService.put({
            gitOrganization,
            repo,
            path: deckPath,
            content: updatedDeck,
            message: `Rewrite content paths for duplicated slides: ${slide.title}`,
          });
          written.push({ path: deckPath, sha: result.sha });
        }
      }

      // Never throws: the copy is already committed, and the next sync writes
      // the same rows.
      if (slide.classroom_id) {
        await ClassmojiService.contentAssets.recordContentAssets(slide.classroom_id, written);
      }

      // Create new database record
      const newSlide = await getPrisma().slide.create({
        data: {
          title: `${slide.title} (Copy)`,
          slug: newSlug,
          content_path: newContentPath,
          classroom_id: slide.classroom_id,
          created_by: authData?.userId || slide.created_by,
          is_draft: slide.is_draft,
          is_public: slide.is_public,
          allow_team_edit: slide.allow_team_edit,
          show_speaker_notes: slide.show_speaker_notes,
        },
        include: {
          classroom: {
            select: { slug: true, name: true },
          },
          links: {
            include: { repository: true },
            take: 1,
          },
        },
      });

      // Update the content manifest
      await ClassmojiService.contentManifest.saveManifest(slide.classroom_id);

      return { success: true, intent: 'duplicate', newSlide };
    } catch (error: unknown) {
      console.error('Failed to duplicate slide:', error);
      const message = error instanceof Error ? error.message : 'Failed to duplicate slide';
      return { error: message };
    }
  }

  return { error: 'Unknown action' };
};

/**
 * How many missing thumbnails ONE page load may ask to have rendered.
 *
 * The per-deck window in `deckThumbnailEnqueue.server` is the real cap; this is
 * the blast radius of a single load, so a staff index full of decks nobody has
 * saved since this shipped trickles rather than firing twenty at once. The
 * backfill script is the tool for "render all of them".
 */
const MAX_THUMBNAIL_ENQUEUES = 5;

/**
 * The placeholder's colour, from the classroom rather than the deck.
 *
 * A card with no image still has to be TELLABLE from its neighbours at a glance,
 * and the useful grouping on this page is by course — the badge already prints
 * the classroom slug. Deterministic, so the same class is the same colour on
 * every load and between users; there is no stored accent colour to read.
 */
const PLACEHOLDER_ACCENTS = [
  'bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200',
  'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
  'bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200',
  'bg-cyan-100 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200',
];

function placeholderAccent(seed: string | null | undefined): string {
  if (!seed) return PLACEHOLDER_ACCENTS[0];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return PLACEHOLDER_ACCENTS[hash % PLACEHOLDER_ACCENTS.length];
}

/**
 * One card's picture: the stored image, or a placeholder that asks for one.
 *
 * This used to be a live `<iframe src="/{id}?preview=true">` — a full
 * authenticated document request per deck, booting Reveal.js inside a
 * 0.2-scaled frame, twenty of them on a staff index. The real cost was never
 * the deck text: it was the unguarded shared-theme preload behind each one
 * (a Prisma read, an installation-token mint and three authenticated GitHub
 * calls per frame) plus a subscription-tier query per card. A stored image
 * deletes both without either code path being touched.
 *
 * The observer exists only for decks with NO image. It fires once, disconnects,
 * and asks the server; the answer changes nothing on screen, because a render
 * takes seconds and commits to git. The next load has the picture.
 */
function DeckThumbnail({
  slide,
  accentSeed,
  onNeedsRender,
}: {
  slide: { id: string; title: string; thumbnailUrl?: string | null };
  accentSeed: string | null | undefined;
  onNeedsRender: (slideId: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const accent = placeholderAccent(accentSeed);

  useEffect(() => {
    if (slide.thumbnailUrl) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.disconnect();
          onNeedsRender(slide.id);
        }
      },
      // A little ahead of the fold: the picture is for the NEXT load either
      // way, so asking slightly early costs nothing and asking late wastes the
      // scroll that would have justified it.
      { rootMargin: '200px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [slide.id, slide.thumbnailUrl, onNeedsRender]);

  if (slide.thumbnailUrl) {
    return (
      <img
        src={slide.thumbnailUrl}
        alt={slide.title}
        loading="lazy"
        decoding="async"
        className="w-full h-full object-cover"
      />
    );
  }

  return (
    <div
      ref={ref}
      className={`w-full h-full flex items-center justify-center px-6 text-center ${accent}`}
    >
      <span className="text-sm font-medium line-clamp-3">{slide.title}</span>
    </div>
  );
}

export default function SlidesIndex() {
  const { slides: initialSlides, webappUrl } = useLoaderData<typeof loader>();
  const [slides, setSlides] = useState(initialSlides);
  const [renameModal, setRenameModal] = useState<{
    open: boolean;
    slide: { id: string; title: string } | null;
  }>({ open: false, slide: null });
  const [renameValue, setRenameValue] = useState('');
  const [progressModal, setProgressModal] = useState<{
    open: boolean;
    action: string | null;
    slideTitle: string;
  }>({ open: false, action: null, slideTitle: '' });
  const fetcher = useFetcher();

  /**
   * Thumbnail requests go out as a bare `fetch`, NOT through a fetcher.
   *
   * Two reasons, both about not disturbing the page. A fetcher submission
   * revalidates the loader when it settles, and five of those would re-run the
   * whole index query for a result that cannot have changed yet. And a single
   * fetcher aborts its own in-flight request when it is submitted again, so
   * five enqueues down one fetcher would be one enqueue and four cancellations.
   *
   * `?index` because this posts to the INDEX route's action, not the root
   * layout's.
   */
  const requestedThumbnails = useRef<Set<string>>(new Set());
  const thumbnailBudget = useRef(MAX_THUMBNAIL_ENQUEUES);
  const requestThumbnail = useCallback((slideId: string) => {
    if (requestedThumbnails.current.has(slideId)) return;
    if (thumbnailBudget.current <= 0) return;
    requestedThumbnails.current.add(slideId);
    thumbnailBudget.current -= 1;

    const body = new FormData();
    body.append('intent', 'thumbnail');
    body.append('slideId', slideId);
    // Nothing is awaited and nothing is shown: the render lands in git seconds
    // from now, and the next load of this page is what picks it up.
    void fetch('/?index', { method: 'POST', body }).catch(() => {});
  }, []);

  // Handle action responses
  useEffect(() => {
    if (fetcher.data?.success) {
      if (fetcher.data.intent === 'delete' && fetcher.data.deletedSlideId) {
        message.success('Slide deleted successfully');
        setSlides(prev => prev.filter(s => s.id !== fetcher.data.deletedSlideId));
        setProgressModal({ open: false, action: null, slideTitle: '' });
      } else if (fetcher.data.intent === 'rename' && fetcher.data.slide) {
        message.success('Slide renamed successfully');
        setSlides(prev =>
          prev.map(s =>
            s.id === fetcher.data.slide.id ? { ...s, title: fetcher.data.slide.title } : s
          )
        );
        setRenameModal({ open: false, slide: null });
        setRenameValue('');
      } else if (fetcher.data.intent === 'duplicate' && fetcher.data.newSlide) {
        message.success('Slide duplicated successfully');
        setSlides(prev => [fetcher.data.newSlide, ...prev]);
        setProgressModal({ open: false, action: null, slideTitle: '' });
      }
    } else if (fetcher.data?.error) {
      message.error(fetcher.data.error);
      setProgressModal({ open: false, action: null, slideTitle: '' });
    }
  }, [fetcher.data]);

  const handleDelete = (slide: { id: string; title: string }) => {
    setProgressModal({ open: true, action: 'delete', slideTitle: slide.title });
    fetcher.submit({ intent: 'delete', slideId: slide.id }, { method: 'post' });
  };

  const handleRename = () => {
    if (!renameModal.slide || !renameValue.trim()) return;
    fetcher.submit(
      { intent: 'rename', slideId: renameModal.slide.id, title: renameValue },
      { method: 'post' }
    );
  };

  const handleDuplicate = (slide: { id: string; title: string }) => {
    setProgressModal({ open: true, action: 'duplicate', slideTitle: slide.title });
    fetcher.submit({ intent: 'duplicate', slideId: slide.id }, { method: 'post' });
  };

  const openRenameModal = (slide: { id: string; title: string }) => {
    setRenameModal({ open: true, slide });
    setRenameValue(slide.title);
  };

  const isSubmitting = fetcher.state === 'submitting';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <header className="border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
        <div className="max-w-7xl mx-auto px-4 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Slides</h1>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                View and present your course slides
              </p>
            </div>
            <a
              href={webappUrl}
              className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              ← Back to Classmoji
            </a>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-7xl mx-auto px-4 py-8">
        {slides.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-4xl mb-4">📊</div>
            <h2 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
              No slides yet
            </h2>
            <p className="text-gray-500 dark:text-gray-400">
              Slides will appear here once they&apos;re created in your courses.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {slides.map(slide => (
              <div
                key={slide.id}
                className="relative group bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 transition-colors overflow-hidden"
              >
                {/* Slide Preview */}
                <Link to={`/${slide.id}?returnUrl=${encodeURIComponent('/')}`} className="block">
                  <div className="aspect-video bg-gray-100 dark:bg-gray-700 overflow-hidden relative">
                    <DeckThumbnail
                      slide={slide}
                      accentSeed={slide.classroom?.slug || slide.classroom?.name}
                      onNeedsRender={requestThumbnail}
                    />
                    {/* Badges overlay */}
                    <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
                      <span className="text-xs px-2 py-1 bg-white/90 dark:bg-gray-800/90 text-gray-600 dark:text-gray-300 rounded-sm shadow-sm">
                        {slide.classroom?.slug || slide.classroom?.name}
                      </span>
                      {slide.is_draft && (
                        <span className="text-xs px-2 py-0.5 bg-amber-100/90 dark:bg-amber-900/90 text-amber-700 dark:text-amber-400 rounded-sm shadow-sm">
                          Draft
                        </span>
                      )}
                    </div>
                  </div>
                </Link>

                {/* Card Content */}
                <div className="p-4">
                  <Link to={`/${slide.id}?returnUrl=${encodeURIComponent('/')}`} className="block">
                    <h3 className="font-medium text-gray-900 dark:text-white truncate">
                      {slide.title}
                    </h3>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 truncate">
                      {slide.links?.[0]?.repository?.title || '—'}
                    </p>
                    <div className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                      {slide.classroom?.content_namespace}
                    </div>
                  </Link>
                </div>

                {/* Action buttons - shown on hover */}
                <div className="absolute top-2 left-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Tooltip title="Edit">
                    <Link
                      to={`/${slide.id}?mode=edit&returnUrl=${encodeURIComponent('/')}`}
                      className="p-1.5 bg-white/90 dark:bg-gray-800/90 text-gray-600 hover:text-blue-600 dark:text-gray-300 dark:hover:text-blue-400 rounded-md transition-colors shadow-sm"
                      onClick={e => e.stopPropagation()}
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                        />
                      </svg>
                    </Link>
                  </Tooltip>
                  <Tooltip title="Rename">
                    <button
                      className="p-1.5 bg-white/90 dark:bg-gray-800/90 text-gray-600 hover:text-blue-600 dark:text-gray-300 dark:hover:text-blue-400 rounded-md transition-colors shadow-sm"
                      onClick={e => {
                        e.stopPropagation();
                        e.preventDefault();
                        openRenameModal(slide);
                      }}
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z"
                        />
                      </svg>
                    </button>
                  </Tooltip>
                  <Tooltip title="Duplicate">
                    <button
                      className="p-1.5 bg-white/90 dark:bg-gray-800/90 text-gray-600 hover:text-green-600 dark:text-gray-300 dark:hover:text-green-400 rounded-md transition-colors shadow-sm disabled:opacity-50"
                      onClick={e => {
                        e.stopPropagation();
                        e.preventDefault();
                        handleDuplicate(slide);
                      }}
                      disabled={progressModal.open}
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                        />
                      </svg>
                    </button>
                  </Tooltip>
                  <Popconfirm
                    title="Delete slide"
                    description={`Are you sure you want to delete "${slide.title}"?`}
                    onConfirm={() => handleDelete(slide)}
                    okText="Yes, delete"
                    cancelText="No"
                    okButtonProps={{ danger: true }}
                    disabled={progressModal.open}
                  >
                    <Tooltip title="Delete">
                      <button
                        className="p-1.5 bg-white/90 dark:bg-gray-800/90 text-gray-600 hover:text-red-600 dark:text-gray-300 dark:hover:text-red-400 rounded-md transition-colors shadow-sm"
                        onClick={e => e.stopPropagation()}
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                          />
                        </svg>
                      </button>
                    </Tooltip>
                  </Popconfirm>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* Rename Modal */}
      <Modal
        title="Rename Slide"
        open={renameModal.open}
        onOk={handleRename}
        onCancel={() => {
          setRenameModal({ open: false, slide: null });
          setRenameValue('');
        }}
        okText="Rename"
        confirmLoading={isSubmitting}
      >
        <div className="py-4">
          <Input
            value={renameValue}
            onChange={e => setRenameValue((e.target as HTMLInputElement).value)}
            placeholder="Enter new title"
            onPressEnter={handleRename}
            autoFocus
          />
        </div>
      </Modal>

      {/* Progress Modal */}
      <Modal open={progressModal.open} footer={null} closable={false} centered width={320}>
        <div className="flex flex-col items-center py-6">
          <Spin size="large" />
          <p className="mt-4 text-gray-700 dark:text-gray-300 text-center">
            {progressModal.action === 'duplicate' ? 'Duplicating' : 'Deleting'}
            <br />
            <span className="font-medium">{progressModal.slideTitle}</span>
          </p>
          {progressModal.action === 'duplicate' && (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400 text-center">
              Copying content to GitHub...
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
