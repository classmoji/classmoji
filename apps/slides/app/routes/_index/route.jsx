import { useState, useEffect } from 'react';
import { useLoaderData, Link, useFetcher } from 'react-router';
import { Popconfirm, Modal, Input, Tooltip, Spin, message } from 'antd';
import prisma from '@classmoji/database';
import { getAuthSession } from '@classmoji/auth/server';
import { assertSlideAccess } from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';
import { ContentService } from '@classmoji/content';
import { deleteSlide } from '~/utils/slideService.server';

export const loader = async ({ request }) => {
  // 1. Require authentication
  const authData = await getAuthSession(request);
  if (!authData) {
    throw new Response('Unauthorized', { status: 401 });
  }

  // 2. Get user's classroom memberships with roles
  const memberships = await prisma.classroomMembership.findMany({
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
  const recentSlides = await prisma.slide.findMany({
    where: { OR: whereConditions },
    take: 20,
    orderBy: { updated_at: 'desc' },
    include: {
      classroom: {
        select: {
          slug: true,
          name: true,
        },
      },
      links: {
        include: {
          module: true,
        },
        take: 1,
      },
    },
  });

  return {
    slides: recentSlides,
    webappUrl: process.env.WEBAPP_URL || 'http://localhost:3000',
  };
};

export const action = async ({ request }) => {
  const formData = await request.formData();
  const intent = formData.get('intent');

  // Get auth for actions that need userId
  const authData = await getAuthSession(request);

  if (intent === 'delete') {
    const slideId = formData.get('slideId');

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
    } catch (error) {
      return { error: error.message || 'You do not have permission to delete this slide' };
    }

    // Delete the slide (no theme cleanup for simple deletion)
    try {
      await deleteSlide({ slideId, deleteTheme: false });
      return { success: true, intent: 'delete', deletedSlideId: slideId };
    } catch (error) {
      console.error('Failed to delete slide:', error);
      return { error: error.message || 'Failed to delete slide' };
    }
  }

  if (intent === 'rename') {
    const slideId = formData.get('slideId');
    const newTitle = formData.get('title');

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
    } catch (error) {
      return { error: error.message || 'You do not have permission to rename this slide' };
    }

    try {
      const slide = await prisma.slide.update({
        where: { id: slideId },
        data: { title: newTitle.trim() },
        select: { id: true, title: true, classroom_id: true },
      });

      // Update the content manifest
      await ClassmojiService.contentManifest.saveManifest(slide.classroom_id);

      return { success: true, intent: 'rename', slide };
    } catch (error) {
      console.error('Failed to rename slide:', error);
      return { error: error.message || 'Failed to rename slide' };
    }
  }

  if (intent === 'duplicate') {
    const slideId = formData.get('slideId');

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
    } catch (error) {
      return { error: error.message || 'You do not have permission to duplicate this slide' };
    }

    try {
      // Fetch the slide with classroom and git organization info
      const slide = await prisma.slide.findUnique({
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

      const repo = `content-${gitOrganization.login}-${slide.term}`;
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

      if (indexFile?.content && slide.content_path !== newContentPath) {
        const updatedContent = indexFile.content.replaceAll(
          slide.content_path,
          newContentPath,
        );

        if (updatedContent !== indexFile.content) {
          await ContentService.put({
            gitOrganization,
            repo,
            path: indexPath,
            content: updatedContent,
            message: `Rewrite content paths for duplicated slides: ${slide.title}`,
          });
        }
      }

      // Create new database record
      const newSlide = await prisma.slide.create({
        data: {
          title: `${slide.title} (Copy)`,
          slug: newSlug,
          term: slide.term,
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
            include: { module: true },
            take: 1,
          },
        },
      });

      // Update the content manifest
      await ClassmojiService.contentManifest.saveManifest(slide.classroom_id);

      return { success: true, intent: 'duplicate', newSlide };
    } catch (error) {
      console.error('Failed to duplicate slide:', error);
      return { error: error.message || 'Failed to duplicate slide' };
    }
  }

  return { error: 'Unknown action' };
};

export default function SlidesIndex() {
  const { slides: initialSlides, webappUrl } = useLoaderData();
  const [slides, setSlides] = useState(initialSlides);
  const [renameModal, setRenameModal] = useState({ open: false, slide: null });
  const [renameValue, setRenameValue] = useState('');
  const [progressModal, setProgressModal] = useState({ open: false, action: null, slideTitle: '' });
  const fetcher = useFetcher();

  // Handle action responses
  useEffect(() => {
    if (fetcher.data?.success) {
      if (fetcher.data.intent === 'delete' && fetcher.data.deletedSlideId) {
        message.success('Slide deleted successfully');
        setSlides(prev => prev.filter(s => s.id !== fetcher.data.deletedSlideId));
        setProgressModal({ open: false, action: null, slideTitle: '' });
      } else if (fetcher.data.intent === 'rename' && fetcher.data.slide) {
        message.success('Slide renamed successfully');
        setSlides(prev => prev.map(s =>
          s.id === fetcher.data.slide.id ? { ...s, title: fetcher.data.slide.title } : s
        ));
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

  const handleDelete = (slide) => {
    setProgressModal({ open: true, action: 'delete', slideTitle: slide.title });
    fetcher.submit(
      { intent: 'delete', slideId: slide.id },
      { method: 'post' }
    );
  };

  const handleRename = () => {
    if (!renameModal.slide || !renameValue.trim()) return;
    fetcher.submit(
      { intent: 'rename', slideId: renameModal.slide.id, title: renameValue },
      { method: 'post' }
    );
  };

  const handleDuplicate = (slide) => {
    setProgressModal({ open: true, action: 'duplicate', slideTitle: slide.title });
    fetcher.submit(
      { intent: 'duplicate', slideId: slide.id },
      { method: 'post' }
    );
  };

  const openRenameModal = (slide) => {
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
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                Slides
              </h1>
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
                <Link
                  to={`/${slide.id}?returnUrl=${encodeURIComponent('/')}`}
                  className="block"
                >
                  <div className="aspect-video bg-gray-100 dark:bg-gray-700 overflow-hidden relative">
                    <iframe
                      src={`/${slide.id}?preview=true`}
                      className="w-[500%] h-[500%] origin-top-left scale-[0.2] pointer-events-none border-0"
                      title={`Preview of ${slide.title}`}
                      loading="lazy"
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
                  <Link
                    to={`/${slide.id}?returnUrl=${encodeURIComponent('/')}`}
                    className="block"
                  >
                    <h3 className="font-medium text-gray-900 dark:text-white truncate">
                      {slide.title}
                    </h3>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 truncate">
                      {slide.links?.[0]?.module?.title || '—'}
                    </p>
                    <div className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                      {slide.term}
                    </div>
                  </Link>
                </div>

                {/* Action buttons - shown on hover */}
                <div className="absolute top-2 left-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Tooltip title="Edit">
                    <Link
                      to={`/${slide.id}?mode=edit&returnUrl=${encodeURIComponent('/')}`}
                      className="p-1.5 bg-white/90 dark:bg-gray-800/90 text-gray-600 hover:text-blue-600 dark:text-gray-300 dark:hover:text-blue-400 rounded-md transition-colors shadow-sm"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                    </Link>
                  </Tooltip>
                  <Tooltip title="Rename">
                    <button
                      className="p-1.5 bg-white/90 dark:bg-gray-800/90 text-gray-600 hover:text-blue-600 dark:text-gray-300 dark:hover:text-blue-400 rounded-md transition-colors shadow-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        openRenameModal(slide);
                      }}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
                      </svg>
                    </button>
                  </Tooltip>
                  <Tooltip title="Duplicate">
                    <button
                      className="p-1.5 bg-white/90 dark:bg-gray-800/90 text-gray-600 hover:text-green-600 dark:text-gray-300 dark:hover:text-green-400 rounded-md transition-colors shadow-sm disabled:opacity-50"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        handleDuplicate(slide);
                      }}
                      disabled={progressModal.open}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
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
                        onClick={(e) => e.stopPropagation()}
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
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
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="Enter new title"
            onPressEnter={handleRename}
            autoFocus
          />
        </div>
      </Modal>

      {/* Progress Modal */}
      <Modal
        open={progressModal.open}
        footer={null}
        closable={false}
        centered
        width={320}
      >
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
