import { useState, useEffect } from 'react';
import { useLoaderData, useNavigate, useFetcher } from 'react-router';
import { Form, Button, Alert, Modal, Tabs } from 'antd';
import { FileTextOutlined, UploadOutlined } from '@ant-design/icons';
import { toast } from 'react-toastify';
import { assertClassroomAccess } from '~/utils/helpers';
import { ClassmojiService } from '@classmoji/services';
import { getGitProvider } from '@classmoji/services';
import { ContentService } from '@classmoji/content';
import { processMarkdownImport } from '~/utils/markdownImporter.server';
import { wrapHtmlContent } from '~/utils/htmlWrapper';
import ImportTab from './ImportTab';
import CreateBlankTab from './CreateBlankTab';
import BatchImportTab from './BatchImportTab';
import { generateTermString } from '@classmoji/utils';
import { generatePageTemplate } from './utils';

export const loader = async ({ request, params }) => {
  const { class: classSlug } = params;

  const { classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'PAGES',
    attemptedAction: 'create_page',
  });

  // Generate term from classroom settings
  const term = generateTermString(classroom.term, classroom.year);

  // Include slug for navigation and gitOrgLogin for API calls
  return {
    term,
    classroom: {
      ...classroom,
      slug: classroom.slug, // For navigation URLs
      gitOrgLogin: classroom.git_organization?.login, // For GitHub API calls via batch endpoint
    },
  };
};

export const action = async ({ request, params }) => {
  const { class: classSlug } = params;
  const formData = await request.formData();
  const intent = formData.get('intent');

  const { classroom, userId } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: ['OWNER', 'TEACHER'],
    resourceType: 'PAGES',
    attemptedAction: 'create_page',
  });

  // Use git_organization.login for GitHub API calls, not the classroom slug
  const gitOrgLogin = classroom.git_organization?.login;
  if (!gitOrgLogin) {
    return { error: 'Git organization not configured' };
  }

  const term = formData.get('term');

  // Single page import/create
  const title = formData.get('title');

  // Generate slug from title
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  // Content repo name: content-{gitOrgLogin}-{term}
  const repoName = `content-${gitOrgLogin}-${term}`;

  // Flat content path: pages/{slug}
  const contentPath = `pages/${slug}`;

  try {
    // Step 1: Check if content repo exists, create if not
    const gitProvider = getGitProvider(classroom.git_organization);
    const repoExists = await gitProvider.repositoryExists(gitOrgLogin, repoName);
    if (!repoExists) {
      try {
        await gitProvider.createPublicRepository(
          gitOrgLogin,
          repoName,
          `Course content for ${classroom.name || gitOrgLogin} - ${term}`
        );

        // Give GitHub a moment to initialize the repo
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (repoError) {
        console.error('Failed to create GitHub repository:', repoError);
        return {
          error:
            'Failed to create GitHub repository. Please check your GitHub organization permissions',
        };
      }
    }

    // Always try to enable GitHub Pages (idempotent - skips if already enabled)
    try {
      await gitProvider.enableGitHubPages(gitOrgLogin, repoName);
    } catch (pagesError) {
      // Pages API requires special permission - log but continue
      console.warn(`Could not auto-enable GitHub Pages: ${pagesError.message}`);
    }

    let pageHtml;
    const assetsFolder = `${contentPath}/assets`;

    if (intent === 'import') {
      // Import flow: process markdown and images
      const markdownFile = formData.get('markdown');
      const imageFiles = formData.getAll('images');

      if (!markdownFile || typeof markdownFile === 'string') {
        return { error: 'Please select a markdown file to import' };
      }

      const markdownText = await markdownFile.text();
      if (!markdownText.trim()) {
        return { error: 'The markdown file is empty. Please add content and try again' };
      }

      // Process markdown and images
      const { html, imageMap, unmatchedImages } = await processMarkdownImport(
        markdownText,
        imageFiles,
        {
          org: gitOrgLogin,
          repo: repoName,
          contentPath,
          assetsFolder,
        }
      );

      // Prepare files to upload
      const filesToUpload = [];

      // Add all matched images
      imageMap.forEach(imageInfo => {
        filesToUpload.push({
          path: imageInfo.newPath,
          content: imageInfo.file,
          encoding: 'binary',
        });
      });

      // Add unmatched images
      unmatchedImages.forEach(file => {
        const timestamp = Date.now();
        const sanitizedName = file.name
          .toLowerCase()
          .replace(/[^a-z0-9.-]/g, '-')
          .replace(/-+/g, '-');
        const newFilename = `${sanitizedName.split('.')[0]}-${timestamp}.${sanitizedName.split('.').pop()}`;
        const newPath = `${contentPath}/assets/${newFilename}`;

        filesToUpload.push({
          path: newPath,
          content: file,
          encoding: 'binary',
        });
      });

      // Convert File objects to buffers
      const uploadFiles = await Promise.all(
        filesToUpload.map(async file => ({
          path: file.path,
          content: Buffer.from(await file.content.arrayBuffer()).toString('base64'),
          encoding: 'base64',
        }))
      );

      // Wrap HTML content
      const wrappedHtml = wrapHtmlContent(html, 2); // Default width
      pageHtml = wrappedHtml;

      // Add HTML content
      const htmlPath = `${contentPath}/index.html`;
      uploadFiles.push({
        path: htmlPath,
        content: wrappedHtml,
        encoding: 'utf-8',
      });

      // Upload all files in a single batch
      if (uploadFiles.length > 0) {
        try {
          await ContentService.uploadBatch({
            gitOrganization: classroom.git_organization,
            repo: repoName,
            files: uploadFiles,
            branch: 'main',
            message: `Import page: ${title}`,
          });
        } catch (uploadError) {
          console.error('Failed to upload files to GitHub:', uploadError);
          return { error: `Failed to upload files to GitHub: ${uploadError.message}` };
        }
      }
    } else {
      // Create blank flow: use template
      pageHtml = generatePageTemplate(title);
      const filePath = `${contentPath}/index.html`;

      try {
        await ContentService.put({
          gitOrganization: classroom.git_organization,
          repo: repoName,
          path: filePath,
          content: pageHtml,
          message: `Create page: ${title}`,
        });
      } catch (uploadError) {
        console.error('Failed to upload file to GitHub:', uploadError);
        return { error: `Failed to upload file to GitHub: ${uploadError.message}` };
      }
    }

    // Step 3: Create the database record
    try {
      const page = await ClassmojiService.page.create({
        classroom_id: classroom.id,
        title,
        content_path: contentPath,
        created_by: userId,
      });

      // Update manifest after creating page
      await ClassmojiService.contentManifest.saveManifest(classroom.id);

      return { created: true, page };
    } catch (dbError) {
      console.error('Failed to save page to database:', dbError);
      return { error: `Page created in GitHub but failed to save to database: ${dbError.message}` };
    }
  } catch (error) {
    console.error('Failed to create page:', error);
    return { error: error.message || 'Failed to create page' };
  }
};

export default function NewPage() {
  const loaderData = useLoaderData();
  const { term, classroom } = loaderData;
  const fetcher = useFetcher();
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const [activeTab, setActiveTab] = useState('create-blank');
  const [importFiles, setImportFiles] = useState({ markdown: null, images: [] });
  const [batchPages, setBatchPages] = useState([]);

  // Batch import progress state
  const [batchProgress, setBatchProgress] = useState(null); // { current: 0, total: 0, errors: [] }

  // Get progress-based loading message
  const getProgressMessage = () => {
    if (!batchProgress) return '';
    const percent = (batchProgress.current / batchProgress.total) * 100;

    if (percent === 0) return '🎬 Warming up the upload machine...';
    if (percent <= 15) return '🧙‍♂️ Casting markdown spells...';
    if (percent <= 30) return '🦄 Teaching unicorns to carry your files...';
    if (percent <= 45) return '🤝 Convincing the server this is important...';
    if (percent <= 60) return '🐙 Negotiating with the GitHub octocats...';
    if (percent <= 75) return '🏃‍♂️ Your content is sprinting to the cloud...';
    if (percent <= 90) return '💅 Making everything look fabulous...';
    return '🎊 Victory is near!';
  };

  const isCreating = fetcher.state !== 'idle' || batchProgress !== null;
  const createError = fetcher.data?.error;

  // Module is now optional for all pages - no validation needed

  // Redirect on success (single page only - batch handled separately)
  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data?.created && fetcher.data.page && !batchProgress) {
      toast.success('Page created successfully!');
      navigate(`/admin/${classroom.slug}/pages/${fetcher.data.page.id}`);
    }
  }, [fetcher.state, fetcher.data, navigate, classroom.slug, batchProgress]);

  // Handle batch import - process pages one by one with progress
  const handleBatchImport = async () => {
    const total = batchPages.length;
    setBatchProgress({ current: 0, total, errors: [] });

    try {
      // Step 1: Initialize (create repo if needed)
      const initFormData = new FormData();
      initFormData.append('intent', 'batch-init');
      initFormData.append('classSlug', classroom.slug);
      initFormData.append('term', term);

      const initResponse = await fetch('/api/pages/batch', {
        method: 'POST',
        body: initFormData,
      });
      const initResult = await initResponse.json();

      if (initResult.error) {
        toast.error(initResult.error);
        setBatchProgress(null);
        return;
      }

      // Step 2: Import each page sequentially
      const errors = [];
      for (let i = 0; i < batchPages.length; i++) {
        const page = batchPages[i];
        setBatchProgress(prev => ({ ...prev, current: i + 1 }));

        const formData = new FormData();
        formData.append('intent', 'batch-import-single');
        formData.append('classSlug', classroom.slug);
        formData.append('term', term);
        formData.append('title', page.title);
        if (page.module) formData.append('module', page.module);
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
          const response = await fetch('/api/pages/batch', {
            method: 'POST',
            body: formData,
          });
          const result = await response.json();

          if (result.error) {
            errors.push({ title: page.title, error: result.error });
          }
        } catch (err) {
          errors.push({ title: page.title, error: err.message });
        }
      }

      // Done
      setBatchProgress(null);

      if (errors.length > 0) {
        toast.warning(
          `Imported ${total - errors.length} of ${total} pages. ${errors.length} failed.`
        );
      } else {
        toast.success(`Successfully imported ${total} page${total !== 1 ? 's' : ''}!`);
      }
      navigate(`/admin/${classroom.slug}/pages`);
    } catch (err) {
      console.error('Batch import failed:', err);
      toast.error('Batch import failed: ' + err.message);
      setBatchProgress(null);
    }
  };

  const handleSubmit = values => {
    const formData = new FormData();
    formData.append('term', term);

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

    fetcher.submit(formData, {
      method: 'post',
      encType: 'multipart/form-data',
      action: `/admin/${classroom.slug}/pages/new`,
    });
  };

  const tabItems = [
    {
      key: 'create-blank',
      label: 'Create Blank',
      children: <CreateBlankTab />,
    },
    {
      key: 'import',
      label: 'Import',
      children: <ImportTab form={form} onFilesChange={setImportFiles} />,
    },
    {
      key: 'batch',
      label: 'Batch Import',
      children: <BatchImportTab term={term} onPagesChange={setBatchPages} />,
    },
  ];

  return (
    <Modal
      title="New Page"
      open={true}
      onCancel={() => navigate(`/admin/${classroom.slug}/pages`)}
      footer={null}
      width={700}
      closable={!isCreating}
    >
      {/* Show form when not loading */}
      {!isCreating && (
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
            <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />

            <div className="flex justify-end gap-3 mt-6 items-center">
              <Button type="default" onClick={() => navigate(`/admin/${classroom.slug}/pages`)}>
                Cancel
              </Button>
              <Button
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
    </Modal>
  );
}
