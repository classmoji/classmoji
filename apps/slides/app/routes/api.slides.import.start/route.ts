/**
 * Import Start Endpoint - Initiates async slide import
 *
 * This endpoint starts the import process asynchronously and returns immediately
 * with an importId. The client subscribes to the SSE stream using this importId
 * to receive real-time progress updates.
 *
 * Flow:
 * 1. Validate form data and authorization
 * 2. Generate a unique importId for SSE routing
 * 3. Start processZipImport async with onProgress callback
 * 4. Return importId immediately (client uses this for SSE subscription)
 * 5. When import completes, the 'done' event includes the actual slideId
 */

import { randomUUID } from 'crypto';
import getPrisma from '@classmoji/database';
import { requireClassroomStaff } from '@classmoji/auth/server';
import { generateTermString } from '@classmoji/utils';
import { processZipImport } from '~/utils/slidesComImporter.server';
import { importStreamManager } from '~/utils/importStreamManager';

// Max file size for ZIP uploads (in bytes)
const MAX_FILE_SIZE = 150 * 1024 * 1024; // 150MB

export const action = async ({ request }: { request: Request }) => {
  const formData = await request.formData();

  const zipFile = formData.get('zip');
  const title = formData.get('title') as string | null;
  const moduleId = (formData.get('moduleId') as string | null) || null;
  const themeOption = formData.get('themeOption') as string | null;
  const saveThemeAs = (formData.get('saveThemeAs') as string | null)?.trim() || null;
  const useSavedTheme = (formData.get('useSavedTheme') as string | null) || null;
  const classroomSlug = formData.get('classroomSlug') as string;

  // Parse Cloudinary video paths
  let cloudinaryVideoPaths: string[] = [];
  try {
    const cloudinaryVideoPathsRaw = formData.get('cloudinaryVideoPaths') as string | null;
    if (cloudinaryVideoPathsRaw) {
      cloudinaryVideoPaths = JSON.parse(cloudinaryVideoPathsRaw);
    }
  } catch (e: unknown) {
    console.warn('Failed to parse cloudinaryVideoPaths:', e);
  }

  // Determine theme settings
  const importTheme = themeOption === 'import';

  // Validate required fields
  if (!zipFile || !(zipFile instanceof File) || zipFile.size === 0) {
    return Response.json({ error: 'Please select a ZIP file to import' }, { status: 400 });
  }

  if (!title?.trim()) {
    return Response.json({ error: 'Please enter a title for the slides' }, { status: 400 });
  }

  if (zipFile.size > MAX_FILE_SIZE) {
    const maxMB = MAX_FILE_SIZE / 1024 / 1024;
    return Response.json(
      { error: `ZIP file is too large. Maximum size is ${maxMB}MB.` },
      { status: 400 }
    );
  }

  if (!zipFile.name.endsWith('.zip') && zipFile.type !== 'application/zip') {
    return Response.json({ error: 'Please upload a ZIP file' }, { status: 400 });
  }

  // Authorization: require OWNER or TEACHER role
  let userId;
  try {
    const auth = await requireClassroomStaff(request, classroomSlug, {
      resourceType: 'SLIDE_CONTENT',
    });
    userId = auth.userId;
  } catch (_authError: unknown) {
    return Response.json({ error: 'Unauthorized' }, { status: 403 });
  }

  // Get classroom with git_organization
  const classroom = await getPrisma().classroom.findUnique({
    where: { slug: classroomSlug },
    include: { git_organization: true },
  });

  if (!classroom) {
    return Response.json({ error: `Classroom not found: ${classroomSlug}` }, { status: 404 });
  }

  const gitOrgLogin = classroom.git_organization?.login;
  if (!gitOrgLogin) {
    return Response.json(
      { error: 'Git organization not configured for this classroom' },
      { status: 400 }
    );
  }

  const term = generateTermString(classroom.term ?? undefined, classroom.year ?? undefined);

  // Generate unique import ID for SSE routing
  // This is returned immediately while the actual slideId is created during import
  const importId = randomUUID();

  // Define progress callback that publishes to the stream manager
  const onProgress = (event: {
    type: string;
    step?: string;
    current?: number;
    total?: number;
    filename?: string;
    slideId?: string;
    message?: string;
  }) => {
    importStreamManager.publish(importId, event);
  };

  // Start import asynchronously (fire and forget)
  processZipImport({
    zipFile,
    title: title.trim(),
    moduleId,
    importTheme,
    useSavedTheme: themeOption === 'saved' ? useSavedTheme : null,
    saveThemeAs: themeOption === 'import' ? saveThemeAs : null,
    org: gitOrgLogin,
    classroomSlug,
    classroomId: classroom.id,
    term: term!,
    userId,
    cloudinaryVideoPaths,
    onProgress,
  }).catch(err => {
    console.error('[import.start] Import failed:', err);
    importStreamManager.publish(importId, {
      type: 'error',
      message: err.message || 'Import failed',
    });
  });

  // Return importId immediately - client subscribes to SSE stream with this ID
  // The 'done' event from processZipImport will include the actual slideId
  return Response.json({ importId });
};
