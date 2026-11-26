import { useState, useEffect } from 'react';
import { useNavigate, useFetcher, useLocation, data } from 'react-router';
import { Form, Button, Alert, Modal, Tabs } from 'antd';
import { FileTextOutlined, UploadOutlined } from '@ant-design/icons';
import {
  addClassroomAuditLog,
  assertClassroomAccess,
  assertClassroomMutationAllowed,
} from '~/utils/helpers';
import { ClassmojiService } from '@classmoji/services';
import { useCallout } from '@classmoji/ui-components';
import {
  PAGE_CREATE_FORM_TOO_LARGE_MESSAGE,
  PAGE_IMPORT_TOO_LARGE_MESSAGE,
  oversizedImportFileMessage,
  readPageCreateForm,
  readPageImportForm,
} from '~/utils/pageImportBody.server';
import { markdownImportFiles, type PageImportFile } from '~/utils/pageImportFiles.server';
import {
  UPLOAD_BUSY_MESSAGE,
  UPLOAD_RETRY_AFTER_SECONDS,
  acquireUploadSlot,
  releaseUploadSlot,
} from '@classmoji/utils/upload-concurrency';
import { batchImportSummary, type BatchImportFailure } from './utils';
import ImportTab from './ImportTab';
import CreateBlankTab from './CreateBlankTab';
import BatchImportTab from './BatchImportTab';
import { useRouteDrawer } from '~/hooks';
import type { Route } from './+types/route';
import { classroomForClient } from '~/utils/classroomForClient';
import ContentLimitModal from '~/components/features/plan/ContentLimitModal';

export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  const { classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug!,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'PAGES',
    attemptedAction: 'create_page',
  });

  // At the Free plan's page limit the form is not shown at all: the page says
  // so up front instead of refusing after it was filled in.
  const { limit, remaining } = await ClassmojiService.planLimits.contentAllowance(
    classroom.id,
    'pages'
  );
  const limitMessage =
    limit !== null && remaining === 0
      ? ClassmojiService.planLimits.contentLimitMessage('pages', limit)
      : null;

  // Include slug for navigation and gitOrgLogin for API calls
  return {
    limitMessage,
    canUpgrade: membership?.role === 'OWNER',
    // Import and Batch Import convert on Trigger.dev; where it is not
    // configured only Create Blank is offered.
    importAvailable: ClassmojiService.pageImport.isPageImportAvailable(),
    classroom: {
      ...classroomForClient(classroom),
      slug: classroom.slug, // For navigation URLs
      gitOrgLogin: classroom.git_organization?.login, // For GitHub API calls via batch endpoint
    },
  };
};

/**
 * An import takes an upload slot partway through `createPage` — after the
 * gate, before the body is read — and this gives it back however that ends.
 * A blank create takes none.
 */
export const action = async (args: Route.ActionArgs) => {
  const slot = { held: false };
  try {
    return await createPage(args, slot);
  } finally {
    if (slot.held) releaseUploadSlot();
  }
};

async function createPage({ request, params }: Route.ActionArgs, slot: { held: boolean }) {
  const { class: classSlug } = params;

  // The gate first: the classroom is in the URL, so nobody who may not create
  // pages here gets to send this action a byte.
  const { classroom, userId, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug!,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'PAGES',
    attemptedAction: 'create_page',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  // One slot per import in flight: the body cap bounds one import, this bounds
  // how many this process holds at once. The drawer says it is an import in
  // the query string (`?intent=import`), so that is known before the body is
  // read; a blank create takes no slot and is read with a small cap instead,
  // so it never waits behind imports.
  const busy = () =>
    data(
      { error: UPLOAD_BUSY_MESSAGE },
      { status: 503, headers: { 'Retry-After': String(UPLOAD_RETRY_AFTER_SECONDS) } }
    );
  const takeSlot = () => {
    if (!acquireUploadSlot()) return false;
    slot.held = true;
    return true;
  };
  const importRequested = new URL(request.url).searchParams.get('intent') === 'import';
  if (importRequested && !takeSlot()) return busy();

  const formData = importRequested
    ? await readPageImportForm(request)
    : await readPageCreateForm(request);
  if (!formData) {
    return {
      error: importRequested ? PAGE_IMPORT_TOO_LARGE_MESSAGE : PAGE_CREATE_FORM_TOO_LARGE_MESSAGE,
    };
  }
  const intent = formData.get('intent');
  // A tab opened before the query string existed posts an import without it:
  // still an import (its body fit the small cap), and it takes its slot now.
  if (intent === 'import' && !slot.held && !takeSlot()) return busy();

  // Use git_organization.login for GitHub API calls, not the classroom slug
  const gitOrgLogin = classroom.git_organization?.login;
  if (!gitOrgLogin) {
    return { error: 'No Github organization or Gitlab group configured' };
  }

  // Stored, user-editable content repo name. Never re-derive it.
  const repoName = classroom.content_repo;
  if (!repoName) {
    return { error: `Classroom content repo not configured` };
  }

  // Single page import/create
  const title = formData.get('title') as string;

  // Flat content path: pages/{slug}
  const contentPath = await ClassmojiService.page.freePageContentPath(classroom.id, title);

  try {
    // The page's blocks, converted from the markdown; undefined = blank page
    let pageBlocks: unknown[] | undefined;
    // Extra files (import-flow images) committed alongside content.json
    const files: PageImportFile[] = [];
    const assetsFolder = `${contentPath}/assets`;

    if (intent === 'import') {
      // The conversion runs on Trigger.dev; without it the drawer offers
      // Create Blank only, and a post here anyway is refused.
      if (!ClassmojiService.pageImport.isPageImportAvailable()) {
        return { error: ClassmojiService.pageImport.PAGE_IMPORT_MESSAGES.unavailable };
      }

      // Import flow: process markdown and images
      const markdownFile = formData.get('markdown');
      const imageFiles = formData.getAll('images');

      if (!markdownFile || typeof markdownFile === 'string') {
        return { error: 'Please select a markdown file to import' };
      }

      // Every image goes to GitHub in one commit with the page — one over the
      // repository's cap would refuse them all, so it is refused here, by name.
      const oversized = oversizedImportFileMessage(imageFiles);
      if (oversized) return { error: oversized };

      const markdownText = await markdownFile.text();
      if (!markdownText.trim()) {
        return { error: 'The markdown file is empty. Please add content and try again' };
      }

      // The checks createPage would refuse it with (page limit, a title whose
      // path is taken), before a run is spent on the conversion. Thrown the
      // same way createPage throws them, so the message shown is the same.
      // A title the conversion would refuse is refused first, with a sentence.
      ClassmojiService.pageImport.assertImportTitle(title);
      await ClassmojiService.page.preflightCreatePage({ classroomId: classroom.id, title });

      // Markdown -> blocks on Trigger.dev, which sees the images' names only
      // and says where each goes. A conversion that fails or times out throws
      // a PageImportError whose message is shown; nothing is created.
      const uploads = imageFiles.filter((file): file is File => typeof file !== 'string');
      const conversion = await ClassmojiService.pageImport.convertMarkdown({
        markdown: markdownText,
        title,
        imageNames: uploads.map(file => file.name),
        options: {
          org: gitOrgLogin,
          repo: repoName,
          contentPath,
          assetsFolder,
          provider: classroom.git_organization?.provider,
        },
      });

      files.push(...(await markdownImportFiles(conversion, uploads, contentPath)));
      pageBlocks = conversion.blocks;
    }

    // Orchestrated create: content-repo ensure + upload (content.json + assets)
    // + DB row + manifest refresh (packages/services page.createPage).
    const page = await ClassmojiService.page.createPage({
      classroomId: classroom.id,
      title,
      blocks: pageBlocks,
      files,
      createdBy: userId,
      ...(intent === 'import' ? { commitMessage: `Import page: ${title}` } : {}),
    });

    // Audited after the page exists, with the same 'PAGES'/'CREATE' shape the
    // MCP page_create tool writes. The two creation flows this action serves
    // differ in what they put on disk, so `tool` distinguishes them — and,
    // because the audit service dedups on it, keeps two quick creates apart.
    await addClassroomAuditLog({
      classroomId: classroom.id,
      userId,
      role: membership!.role,
      action: 'CREATE',
      resourceType: 'PAGES',
      resourceId: page.id,
      metadata: {
        tool: intent === 'import' ? 'web:pages.create_import' : 'web:pages.create_blank',
        title,
        ...(intent === 'import' ? { imported_files: files.length } : {}),
      },
    });

    return { created: true, page };
  } catch (error: unknown) {
    console.error('Failed to create page:', error);
    return { error: error instanceof Error ? error.message : 'Failed to create page' };
  }
}

interface BatchProgress {
  current: number;
  total: number;
  errors: BatchImportFailure[];
}

/** A finished batch that left pages out: how many made it, and each that did not. */
interface BatchResult {
  total: number;
  failures: BatchImportFailure[];
}

/**
 * Shown in place of the form when a batch finished with failures, so each page
 * that did not import is named with the reason the server gave — the pages
 * that did import are already created, and "2 failed" alone leaves nothing to
 * act on.
 */
function BatchImportFailures({ result, onDone }: { result: BatchResult; onDone: () => void }) {
  return (
    <div>
      <div className="text-sm font-semibold text-ink-0">
        {batchImportSummary(result.total, result.failures)}
      </div>
      <ul className="mt-3 rounded-lg bg-red-50 dark:bg-red-950/30 ring-1 ring-red-200 dark:ring-red-900/60 divide-y divide-red-200 dark:divide-red-900/60">
        {result.failures.map((failure, index) => (
          <li key={index} className="px-3 py-2 text-sm">
            <div className="font-medium text-ink-0">{failure.title}</div>
            <div className="mt-0.5 break-words text-red-700 dark:text-red-300">{failure.error}</div>
          </li>
        ))}
      </ul>
      <div className="flex justify-end mt-6">
        <Button type="primary" onClick={onDone}>
          Go to pages
        </Button>
      </div>
    </div>
  );
}

interface BatchPage {
  title: string;
  repository?: string;
  assignmentId?: string;
  markdownContent: string;
  imageFiles: File[];
}

export default function NewPage(props: Route.ComponentProps) {
  return props.loaderData.limitMessage ? (
    <PageLimitReached
      message={props.loaderData.limitMessage}
      canUpgrade={props.loaderData.canUpgrade}
    />
  ) : (
    <NewPageForm {...props} />
  );
}

function PageLimitReached({ message, canUpgrade }: { message: string; canUpgrade: boolean }) {
  const { opened, close } = useRouteDrawer({});
  return (
    <ContentLimitModal open={opened} message={message} canUpgrade={canUpgrade} onClose={close} />
  );
}

function NewPageForm({ loaderData }: Route.ComponentProps) {
  const { classroom, importAvailable } = loaderData;
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const { opened, close } = useRouteDrawer({});
  const callout = useCallout();
  // Served under every prefix the loader and action already allow (/admin and
  // /teacher), so the redirect targets and the submit target follow the prefix
  // the user arrived on. Posting to the wrong prefix would miss this action.
  const rolePrefix = useLocation().pathname.split('/')[1];
  const [form] = Form.useForm();
  const [activeTab, setActiveTab] = useState('create-blank');
  const [importFiles, setImportFiles] = useState<{ markdown: File | null; images: File[] }>({
    markdown: null,
    images: [],
  });
  const [batchPages, setBatchPages] = useState<BatchPage[]>([]);

  // Batch import progress state
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  // A finished batch with failures, listed in place of the form
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);

  // Get progress-based loading message
  const getProgressMessage = () => {
    if (!batchProgress) return '';
    const percent = (batchProgress.current / batchProgress.total) * 100;

    if (percent === 0) return '🎬 Warming up the upload machine...';
    if (percent <= 15) return '🧙‍♂️ Casting markdown spells...';
    if (percent <= 30) return '🦄 Teaching unicorns to carry your files...';
    if (percent <= 45) return '🤝 Convincing the server this is important...';
    if (percent <= 60) return '🐙 Negotiating with the git octocats...';
    if (percent <= 75) return '🏃‍♂️ Your content is sprinting to the cloud...';
    if (percent <= 90) return '💅 Making everything look fabulous...';
    return '🎊 Victory is near!';
  };

  const isCreating = fetcher.state !== 'idle' || batchProgress !== null;
  const createError = fetcher.data?.error;

  // Repository is now optional for all pages - no validation needed

  // Redirect on success (single page only - batch handled separately)
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.created && fetcher.data.page && !batchProgress) {
      callout.show({ variant: 'success', title: 'Page created successfully!' });
      // Replace, not push: the editor lives on the pages app, and a /pages/new
      // left in history reopens this form when the user comes back.
      navigate(`/${rolePrefix}/${classroom.slug}/pages/${fetcher.data.page.id}`, { replace: true });
    }
  }, [fetcher.state, fetcher.data, navigate, classroom.slug, batchProgress, rolePrefix]);

  // Handle batch import - process pages one by one with progress
  const handleBatchImport = async () => {
    const total = batchPages.length;
    setBatchProgress({ current: 0, total, errors: [] });

    try {
      // Step 1: Initialize (create repo if needed)
      // The classroom rides in the query string so the server can authorize
      // before it reads the body.
      const batchUrl = `/api/pages/batch?classSlug=${encodeURIComponent(classroom.slug)}`;
      const initFormData = new FormData();
      initFormData.append('intent', 'batch-init');

      const initResponse = await fetch(batchUrl, {
        method: 'POST',
        body: initFormData,
      });
      const initResult = await initResponse.json();

      if (initResult.error) {
        callout.show({ variant: 'error', title: initResult.error });
        setBatchProgress(null);
        return;
      }

      // Step 2: Import each page sequentially
      const errors: BatchImportFailure[] = [];
      for (let i = 0; i < batchPages.length; i++) {
        const page = batchPages[i];
        setBatchProgress(prev => (prev ? { ...prev, current: i + 1 } : prev));

        const formData = new FormData();
        formData.append('intent', 'batch-import-single');
        formData.append('title', page.title);
        if (page.repository) formData.append('repository', page.repository);
        if (page.assignmentId) formData.append('assignmentId', page.assignmentId);

        // Add markdown
        const mdBlob = new Blob([page.markdownContent], { type: 'text/markdown' });
        const mdFile = new File([mdBlob], 'content.md', { type: 'text/markdown' });
        formData.append('markdown', mdFile);

        // Add images
        page.imageFiles.forEach(file => {
          formData.append('images', file);
        });

        try {
          const response = await fetch(batchUrl, {
            method: 'POST',
            body: formData,
          });
          const result = await response.json();

          if (result.error) {
            errors.push({ title: page.title, error: result.error });
          }
        } catch (err: unknown) {
          errors.push({
            title: page.title,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Done
      setBatchProgress(null);

      if (errors.length > 0) {
        // Stay here and name each page that did not import, with its reason.
        setBatchResult({ total, failures: errors });
        return;
      }
      callout.show({
        variant: 'success',
        title: `Successfully imported ${total} page${total !== 1 ? 's' : ''}!`,
      });
      navigate(`/${rolePrefix}/${classroom.slug}/pages`);
    } catch (err: unknown) {
      console.error('Batch import failed:', err);
      callout.show({
        variant: 'error',
        title: 'Batch import failed: ' + (err instanceof Error ? err.message : String(err)),
      });
      setBatchProgress(null);
    }
  };

  const handleSubmit = (values: Record<string, string>) => {
    const formData = new FormData();

    if (activeTab === 'batch') {
      // Handle batch import with progress
      handleBatchImport();
      return;
    } else if (activeTab === 'import') {
      formData.append('intent', 'import');
      formData.append('title', values.title);

      // Add markdown and images from state
      if (importFiles.markdown) {
        formData.append('markdown', importFiles.markdown);
      }

      importFiles.images.forEach(file => {
        formData.append('images', file);
      });
    } else {
      formData.append('intent', 'create-blank');
      formData.append('title', values.title);
    }

    // An import says so in the query string too, so the action knows before
    // reading the body that it needs an upload slot (a blank create needs none).
    fetcher.submit(formData, {
      method: 'post',
      encType: 'multipart/form-data',
      action: `/${rolePrefix}/${classroom.slug}/pages/new${activeTab === 'import' ? '?intent=import' : ''}`,
    });
  };

  const tabItems = [
    {
      key: 'create-blank',
      label: 'Create Blank',
      children: <CreateBlankTab />,
    },
    ...(importAvailable
      ? [
          {
            key: 'import',
            label: 'Import',
            children: <ImportTab form={form} onFilesChange={setImportFiles} />,
          },
          {
            key: 'batch',
            label: 'Batch Import',
            children: <BatchImportTab onPagesChange={setBatchPages} />,
          },
        ]
      : []),
  ];

  return (
    <Modal
      open={opened}
      onCancel={close}
      title={null}
      footer={null}
      width={700}
      centered
      closable={false}
      maskClosable={!isCreating}
      styles={{
        container: { padding: 0, borderRadius: 16, overflow: 'hidden', maxWidth: '90vw' },
        body: { padding: 0 },
        header: { display: 'none' },
        footer: { display: 'none' },
      }}
    >
      {/* Gmail-style header */}
      <div className="flex items-center justify-between gap-3 px-5 py-3 bg-stone-50 dark:bg-neutral-800/60 border-b border-line">
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-ink-0">New page</span>
          <span className="text-xs font-normal text-ink-3">
            {importAvailable
              ? 'Create a blank page, import from markdown, or batch import.'
              : 'Create a blank page.'}
          </span>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          disabled={isCreating}
          className="p-1 rounded hover:bg-line text-ink-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="max-h-[75vh] overflow-y-auto px-6 py-5">
        {/* A finished batch that left pages out */}
        {!isCreating && batchResult && (
          <BatchImportFailures
            result={batchResult}
            onDone={() => navigate(`/${rolePrefix}/${classroom.slug}/pages`)}
          />
        )}

        {/* Show form when not loading */}
        {!isCreating && !batchResult && (
          <>
            {createError && (
              <Alert
                message="Error"
                description={createError}
                type="error"
                closable
                className="mb-4"
              />
            )}

            <Form form={form} layout="vertical" onFinish={handleSubmit} initialValues={{}}>
              <span data-tour="pages-new-mode" className="block">
                <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />
              </span>

              <div className="flex justify-end gap-3 mt-6 items-center">
                <Button type="default" onClick={close}>
                  Cancel
                </Button>
                <Button
                  data-tour="pages-new-submit"
                  type="primary"
                  htmlType={activeTab === 'batch' ? 'button' : 'submit'}
                  onClick={activeTab === 'batch' ? () => handleSubmit({}) : undefined}
                  disabled={activeTab === 'batch' && batchPages.length === 0}
                  icon={
                    activeTab === 'import' || activeTab === 'batch' ? (
                      <UploadOutlined />
                    ) : (
                      <FileTextOutlined />
                    )
                  }
                >
                  {activeTab === 'batch'
                    ? `Import ${batchPages.length} Page${batchPages.length !== 1 ? 's' : ''}`
                    : activeTab === 'import'
                      ? 'Import & Create'
                      : 'Create Page'}
                </Button>
              </div>
            </Form>
          </>
        )}

        {/* Show loader when loading */}
        {isCreating && (
          <div className="flex items-center justify-center py-12">
            <div className="flex flex-col items-center gap-5 min-w-[320px]">
              {/* Bouncing dots loader */}
              <div className="flex gap-2">
                <div
                  className="w-4 h-4 rounded-full animate-bounce"
                  style={{ backgroundColor: '#10b981', animationDelay: '0ms' }}
                />
                <div
                  className="w-4 h-4 rounded-full animate-bounce"
                  style={{ backgroundColor: '#10b981', animationDelay: '150ms' }}
                />
                <div
                  className="w-4 h-4 rounded-full animate-bounce"
                  style={{ backgroundColor: '#10b981', animationDelay: '300ms' }}
                />
              </div>
              {batchProgress ? (
                <>
                  <p className="text-gray-800 font-semibold text-center text-lg">
                    {getProgressMessage()}
                  </p>
                  <div className="flex flex-col items-center gap-2 w-full">
                    {/* Progress bar */}
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="h-2 rounded-full transition-all duration-500 ease-out"
                        style={{
                          width: `${(batchProgress.current / batchProgress.total) * 100}%`,
                          backgroundColor: '#10b981',
                        }}
                      />
                    </div>
                    <p className="text-gray-500 text-sm">
                      Page {batchProgress.current} of {batchProgress.total}
                    </p>
                  </div>
                </>
              ) : (
                <p className="text-gray-700 font-medium">Creating page...</p>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
