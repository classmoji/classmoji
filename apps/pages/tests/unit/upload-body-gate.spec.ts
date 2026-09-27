/**
 * Every multipart upload into a page reads its body only after the gate that
 * decides who may upload, and through the byte-counting reader.
 *
 * The routes need Postgres and a content repo to run, so what is pinned here is
 * their ORDER, read from source — the same approach the slides app takes for
 * its upload routes. Getting it wrong is silent: an action that parsed the
 * body first still passes every functional test, and buffers whatever a
 * stranger sends before refusing them.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const UPLOAD_SOURCE = source('../../app/routes/api.upload/route.ts');
const PAGE_ACTION_SOURCE = source('../../app/routes/$classroomSlug.$pageId/route.server.ts');
const EDITOR_SOURCE = source('../../app/components/editor/PageEditor.tsx');

test.describe('page uploads read the body after the gate', () => {
  test('api.upload names the page in the URL and authorizes before reading', () => {
    const pageFromUrl = UPLOAD_SOURCE.indexOf("new URL(request.url).searchParams.get('pageId')");
    const gate = UPLOAD_SOURCE.indexOf(
      "await assertPageAccess({ request, page, accessType: 'edit' })"
    );
    const status = UPLOAD_SOURCE.indexOf('pageMutationBlocked(');
    const read = UPLOAD_SOURCE.indexOf('await readLimitedFormData(request, uploadBodyLimit(');

    for (const at of [pageFromUrl, gate, status, read]) expect(at).toBeGreaterThan(-1);
    expect(pageFromUrl).toBeLessThan(gate);
    expect(gate).toBeLessThan(read);
    expect(status).toBeLessThan(read);
    expect(UPLOAD_SOURCE).not.toContain('await request.formData()');
  });

  test('the editor toasts every refusal before BlockNote swallows it', () => {
    // BlockNote's upload tab turns any thrown error into "Upload failed", so
    // the reason reaches the person only through the toast. Every refusal —
    // the router's (size, type), the repository route's, media's — arrives as
    // an `UploadRefused` carrying its sentence, and is toasted on the way out.
    const upload = EDITOR_SOURCE.slice(EDITOR_SOURCE.indexOf('const uploadFile = useCallback('));
    expect(upload).toContain(
      'if (error instanceof UploadRefused) toast.error(error.message);\n        throw error;'
    );
    expect(upload).toContain(
      "throw new UploadRefused(typeof body?.error === 'string' ? body.error : 'Upload failed');"
    );
    expect(upload).toContain(
      'throw new UploadRefused(mediaUploadMessage(error, uploadCapability));'
    );
    // The size cap is refused before a byte is sent (the router, via
    // `placeUpload`), never after a large file has spent a minute uploading.
    expect(upload).toContain('await placeUpload(file, uploadCapability, ports)');
  });

  test('the editor sends the page in the query string, not the form', () => {
    expect(EDITOR_SOURCE).toContain('/api/upload?pageId=${encodeURIComponent(pageId)}');
    expect(EDITOR_SOURCE).not.toContain("formData.append('pageId'");
  });

  test('the page action reads a multipart body only after membership and status', () => {
    const action = PAGE_ACTION_SOURCE.slice(PAGE_ACTION_SOURCE.indexOf('export const action'));
    const membership = action.indexOf('classroomMembership.findByClassroomAndUser(');
    const status = action.indexOf('pageMutationBlocked(page.classroom, membership.role)');
    const read = action.indexOf('await readLimitedFormData(request, uploadBodyLimit(');

    for (const at of [membership, status, read]) expect(at).toBeGreaterThan(-1);
    expect(membership).toBeLessThan(read);
    expect(status).toBeLessThan(read);
    expect(action).not.toContain('await request.formData()');
  });

  test('the page action reads a JSON save capped, after the same gates', () => {
    const action = PAGE_ACTION_SOURCE.slice(PAGE_ACTION_SOURCE.indexOf('export const action'));
    const status = action.indexOf('pageMutationBlocked(page.classroom, membership.role)');
    const read = action.indexOf('data = await readPageJsonBody(request);');

    for (const at of [status, read]) expect(at).toBeGreaterThan(-1);
    expect(status).toBeLessThan(read);
    expect(action).not.toContain('await request.json()');
    // Twice the repository's file cap: the document rides as an escaped string.
    expect(PAGE_ACTION_SOURCE).toContain(
      'const PAGE_JSON_BODY_MAX_BYTES = 2 * REPO_REST_MAX_BYTES + MULTIPART_OVERHEAD_BYTES;'
    );
    expect(PAGE_ACTION_SOURCE).toContain(
      'const bytes = await readLimitedBody(request.body, PAGE_JSON_BODY_MAX_BYTES);'
    );
  });
});

test.describe('page uploads take an upload slot', () => {
  test('api.upload takes one after the gate, before the read, and gives it back', () => {
    const gate = UPLOAD_SOURCE.indexOf('pageMutationBlocked(');
    const slot = UPLOAD_SOURCE.indexOf('if (!acquireUploadSlot()) {');
    const read = UPLOAD_SOURCE.indexOf('await readLimitedFormData(');

    for (const at of [gate, slot, read]) expect(at).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(slot);
    expect(slot).toBeLessThan(read);
    expect(UPLOAD_SOURCE).toContain('} finally {\n    releaseUploadSlot();');
    expect(UPLOAD_SOURCE).toContain(
      "{ status: 503, headers: { 'Retry-After': String(UPLOAD_RETRY_AFTER_SECONDS) } }"
    );
  });

  test('the cover upload takes one after the gates, before the read, released by the action', () => {
    const action = PAGE_ACTION_SOURCE.slice(
      PAGE_ACTION_SOURCE.indexOf('async function pageAction')
    );
    const status = action.indexOf('pageMutationBlocked(page.classroom, membership.role)');
    const slot = action.indexOf('if (!acquireUploadSlot()) {');
    const read = action.indexOf('await readLimitedFormData(request, uploadBodyLimit(');

    for (const at of [status, slot, read]) expect(at).toBeGreaterThan(-1);
    expect(status).toBeLessThan(slot);
    expect(slot).toBeLessThan(read);
    expect(action).toContain('slot.held = true;');
    expect(PAGE_ACTION_SOURCE).toContain('} finally {\n    if (slot.held) releaseUploadSlot();');
  });
});

test.describe('page uploads answer a refusal as a 4xx', () => {
  // `ContentService.upload` throws `FileRefusedError` for a type, extension or
  // name it will not take, and `RepoFileTooLargeError` for size. Both are the
  // uploader's to fix; `uploadRefusalStatus` is the one mapping (415/400/413),
  // and it has to run before the catch-all that answers 500 and logs a fault.
  test('api.upload maps refusals before its 500', () => {
    const handler = UPLOAD_SOURCE.slice(UPLOAD_SOURCE.indexOf('await uploadPageAsset(page, file)'));
    const refusal = handler.indexOf('const refused = uploadRefusalStatus(error);');
    const fault = handler.indexOf("console.error('[upload] Failed:', error);");

    expect(refusal).toBeGreaterThan(-1);
    expect(fault).toBeGreaterThan(refusal);
    expect(handler).toContain('{ status: refused }');
    expect(handler).not.toContain("code === 'REPO_FILE_TOO_LARGE'");
  });

  test('api.upload answers a file the router sends to media with 409 USE_MEDIA, first', () => {
    const handler = UPLOAD_SOURCE.slice(UPLOAD_SOURCE.indexOf('await uploadPageAsset(page, file)'));
    const routed = handler.indexOf('ClassmojiService.media.mediaRoutingResponse(error)');
    const refusal = handler.indexOf('const refused = uploadRefusalStatus(error);');

    expect(routed).toBeGreaterThan(-1);
    expect(routed).toBeLessThan(refusal);
  });

  test('the cover upload checks USE_MEDIA before its own 409', () => {
    const cover = PAGE_ACTION_SOURCE.slice(
      PAGE_ACTION_SOURCE.indexOf("intent === 'upload-header-image'")
    );
    const routed = cover.indexOf('ClassmojiService.media.mediaRoutingResponse(error)');
    const conflict = cover.indexOf('?.status === 409');

    expect(routed).toBeGreaterThan(-1);
    expect(conflict).toBeGreaterThan(routed);
  });

  test('the cover upload maps them the same way', () => {
    const cover = PAGE_ACTION_SOURCE.slice(
      PAGE_ACTION_SOURCE.indexOf("intent === 'upload-header-image'")
    );
    const refusal = cover.indexOf('const refused = uploadRefusalStatus(error);');
    const fault = cover.indexOf("console.error('Failed to upload header image:', error);");

    expect(refusal).toBeGreaterThan(-1);
    expect(fault).toBeGreaterThan(refusal);
  });
});
