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
 *
 * ## What is checked before the body is read
 *
 * The classroom arrives as a FORM FIELD (the import page posts a FormData built
 * from its own form), so the per-classroom gate cannot run until the body has
 * been parsed. Two things can, and do:
 *
 *   - a SESSION. An anonymous caller is refused before 150 MB are buffered;
 *     the classroom gate below still decides whether this particular signed-in
 *     user may import into this particular classroom.
 *   - the SIZE, through `readLimitedFormData`. `request.formData()` trusts the
 *     sender to stop; that counts the bytes as they arrive and cancels the
 *     stream the moment they cross the cap, so a missing or lying
 *     `Content-Length` cannot over-buffer.
 */

import { randomUUID } from 'crypto';
import getPrisma from '@classmoji/database';
import { getAuthSession, requireClassroomStaff } from '@classmoji/auth/server';
import { processZipImport } from '~/utils/slidesComImporter.server';
import { importStreamManager } from '~/utils/importStreamManager';
import {
  UploadTooLargeError,
  readLimitedFormData,
  uploadBodyLimit,
} from '@classmoji/utils/upload-limit';
import { SLIDES_IMPORT_MAX_BYTES, SLIDES_IMPORT_MAX_LABEL } from '~/utils/importLimits';

export const action = async ({ request }: { request: Request }) => {
  // A session first — the cheapest thing that can be checked without the body,
  // and the one that keeps a stranger from spending 150 MB of this process.
  // Same answer as the classroom gate below, so which of the two refused is not
  // something an unauthenticated caller can tell apart.
  const authData = await getAuthSession(request);
  if (!authData) {
    return Response.json({ error: 'Unauthorized' }, { status: 403 });
  }

  let formData: FormData;
  try {
    formData = await readLimitedFormData(request, uploadBodyLimit(SLIDES_IMPORT_MAX_BYTES));
  } catch (error: unknown) {
    if (error instanceof UploadTooLargeError) {
      return Response.json(
        { error: `ZIP file is too large. Maximum size is ${SLIDES_IMPORT_MAX_LABEL}.` },
        { status: 413 }
      );
    }
    throw error;
  }

  const zipFile = formData.get('zip');
  const title = formData.get('title') as string | null;
  const repositoryId = (formData.get('repositoryId') as string | null) || null;
  const themeOption = formData.get('themeOption') as string | null;
  const saveThemeAs = (formData.get('saveThemeAs') as string | null)?.trim() || null;
  const useSavedTheme = (formData.get('useSavedTheme') as string | null) || null;
  const classroomSlug = formData.get('classroomSlug') as string;

  // Determine theme settings
  const importTheme = themeOption === 'import';

  // Validate required fields
  if (!zipFile || !(zipFile instanceof File) || zipFile.size === 0) {
    return Response.json({ error: 'Please select a ZIP file to import' }, { status: 400 });
  }

  if (!title?.trim()) {
    return Response.json({ error: 'Please enter a title for the slides' }, { status: 400 });
  }

  if (zipFile.size > SLIDES_IMPORT_MAX_BYTES) {
    return Response.json(
      { error: `ZIP file is too large. Maximum size is ${SLIDES_IMPORT_MAX_LABEL}.` },
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

  const contentNamespace = classroom.content_namespace;
  if (!contentNamespace) {
    return Response.json({ error: 'Classroom content namespace not configured' }, { status: 400 });
  }

  // Where the ZIP's videos go is not a choice this form offers: the importer
  // asks the storage router per entry, with the capability it builds from the
  // classroom row — media on a classroom that has it, the content repo
  // everywhere else. Nothing the client sends decides it.

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
    warnings?: string[];
  }) => {
    importStreamManager.publish(importId, event);
  };

  // Start import asynchronously (fire and forget)
  processZipImport({
    zipFile,
    title: title.trim(),
    repositoryId,
    importTheme,
    useSavedTheme: themeOption === 'saved' ? useSavedTheme : null,
    saveThemeAs: themeOption === 'import' ? saveThemeAs : null,
    org: gitOrgLogin,
    classroomSlug,
    classroomId: classroom.id,
    contentNamespace,
    userId,
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
